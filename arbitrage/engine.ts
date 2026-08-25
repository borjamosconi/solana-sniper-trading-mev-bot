import { Connection, Keypair } from '@solana/web3.js';
import { Currency, CurrencyAmount } from '@raydium-io/raydium-sdk';
import { JupiterClient, JupiterQuote } from '../helpers/jupiter';
import { logger } from '../helpers/logger';
import { parseMintPair, SOL_MINT } from '../helpers/mints';
import { CircuitBreaker } from '../risk/circuit-breaker';
import { TransactionExecutor } from '../transactions';
import { simulateVersionedTransaction } from '../helpers/simulation';

export interface ArbitrageConfig {
  enabled: boolean;
  intervalMs: number;
  amountSol: number;
  minProfitBps: number;
  maxDailySol: number;
  slippageBps: number;
  pairs: string[];
  dexGroupA: string;
  dexGroupB: string;
  dryRun: boolean;
  simulateBeforeSend: boolean;
  shouldSkip?: () => boolean;
}

interface ArbOpportunity {
  label: string;
  first: JupiterQuote;
  second: JupiterQuote;
  profitLamports: bigint;
  profitBps: number;
}

export class ArbitrageEngine {
  private timer?: NodeJS.Timeout;
  private running = false;
  private currentDay = new Date().toISOString().slice(0, 10);
  private dailyLamports = 0n;
  private readonly amountLamports: bigint;
  private readonly maxDailyLamports: bigint;
  private readonly feeBufferLamports: bigint;

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Keypair,
    private readonly jupiter: JupiterClient,
    private readonly txExecutor: TransactionExecutor,
    private readonly breaker: CircuitBreaker,
    private readonly config: ArbitrageConfig,
    tipSol: string,
  ) {
    this.amountLamports = BigInt(Math.floor(config.amountSol * 1_000_000_000));
    this.maxDailyLamports = BigInt(Math.floor(config.maxDailySol * 1_000_000_000));
    this.feeBufferLamports = BigInt(new CurrencyAmount(Currency.SOL, tipSol, false).raw.toNumber()) * 2n;
  }

  start(): void {
    if (!this.config.enabled) {
      logger.info('Arbitrage engine disabled');
      return;
    }
    if (this.amountLamports <= 0n) {
      logger.warn('Arbitrage engine skipped because ARB_AMOUNT_SOL is 0');
      return;
    }

    logger.info(
      {
        pairs: this.config.pairs,
        amountSol: this.config.amountSol,
        minProfitBps: this.config.minProfitBps,
        intervalMs: this.config.intervalMs,
      },
      'Arbitrage engine started',
    );

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private resetDailyIfNeeded(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (day === this.currentDay) return;
    this.currentDay = day;
    this.dailyLamports = 0n;
    logger.info('Arbitrage daily spend counter reset');
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    if (this.config.shouldSkip?.()) return;
    if (!this.breaker.assertCanTrade('arbitrage')) return;

    this.running = true;
    try {
      this.resetDailyIfNeeded();
      if (this.dailyLamports + this.amountLamports > this.maxDailyLamports) {
        logger.debug('Skipping arb tick — daily SOL budget reached');
        return;
      }

      for (const pair of this.config.pairs) {
        const opportunity = await this.findOpportunity(pair);
        if (!opportunity) continue;

        logger.info(
          {
            pair: opportunity.label,
            profitBps: opportunity.profitBps,
            profitLamports: opportunity.profitLamports.toString(),
          },
          'Cross-DEX arbitrage opportunity',
        );

        const executed = await this.executeOpportunity(opportunity);
        if (executed) break;
      }
    } catch (error) {
      logger.debug({ error }, 'Arbitrage tick failed');
    } finally {
      this.running = false;
    }
  }

  private async findOpportunity(pair: string): Promise<ArbOpportunity | undefined> {
    const parsed = parseMintPair(pair);
    if (!parsed) {
      logger.debug({ pair }, 'Skipping invalid arb pair');
      return undefined;
    }

    const { inputMint, outputMint, label } = parsed;
    const directions: Array<{ firstDex: string; secondDex: string }> = [
      { firstDex: this.config.dexGroupA, secondDex: this.config.dexGroupB },
      { firstDex: this.config.dexGroupB, secondDex: this.config.dexGroupA },
    ];

    let best: ArbOpportunity | undefined;

    for (const direction of directions) {
      const first = await this.jupiter.quote({
        inputMint,
        outputMint,
        amount: this.amountLamports,
        slippageBps: this.config.slippageBps,
        dexes: direction.firstDex,
        onlyDirectRoutes: true,
      });
      if (!first) continue;

      const second = await this.jupiter.quote({
        inputMint: outputMint,
        outputMint: inputMint,
        amount: first.outAmount,
        slippageBps: this.config.slippageBps,
        dexes: direction.secondDex,
        onlyDirectRoutes: true,
      });
      if (!second) continue;

      const outLamports = BigInt(second.outAmount);
      if (outLamports <= this.amountLamports + this.feeBufferLamports) continue;

      const profitLamports = outLamports - this.amountLamports;
      const profitBps = Number((profitLamports * 10_000n) / this.amountLamports);
      if (profitBps < this.config.minProfitBps) continue;

      if (!best || profitLamports > best.profitLamports) {
        best = { label, first, second, profitLamports, profitBps };
      }
    }

    return best;
  }

  private async executeOpportunity(opportunity: ArbOpportunity): Promise<boolean> {
    if (this.config.dryRun) {
      logger.info(
        {
          pair: opportunity.label,
          profitBps: opportunity.profitBps,
        },
        'DRY_RUN: skipping cross-DEX arbitrage execution',
      );
      return true;
    }

    const firstLeg = await this.jupiter.buildSignedSwap(opportunity.first, this.wallet);
    if (!firstLeg) return false;

    if (this.config.simulateBeforeSend) {
      const sim = await simulateVersionedTransaction(this.connection, firstLeg.transaction);
      if (!sim.ok) {
        logger.debug({ error: sim.error, pair: opportunity.label }, 'Arb first-leg simulation failed');
        return false;
      }
    }

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const firstResult = await this.txExecutor.executeAndConfirm(firstLeg.transaction, this.wallet, latestBlockhash);
    if (!firstResult.confirmed) {
      this.breaker.recordFailure('arb-leg-1');
      logger.warn({ pair: opportunity.label, error: firstResult.error }, 'Arb first leg failed');
      return false;
    }

    const secondLeg = await this.jupiter.buildSignedSwap(opportunity.second, this.wallet);
    if (!secondLeg) {
      this.breaker.recordFailure('arb-leg-2-build');
      logger.error(
        { pair: opportunity.label, signature: firstResult.signature },
        'Arb second leg could not be built — inventory may be mid-pair',
      );
      return false;
    }

    if (this.config.simulateBeforeSend) {
      const sim = await simulateVersionedTransaction(this.connection, secondLeg.transaction);
      if (!sim.ok) {
        this.breaker.recordFailure('arb-leg-2-sim');
        logger.error({ error: sim.error, pair: opportunity.label }, 'Arb second-leg simulation failed');
        return false;
      }
    }

    const secondHash = await this.connection.getLatestBlockhash();
    const secondResult = await this.txExecutor.executeAndConfirm(secondLeg.transaction, this.wallet, secondHash);
    if (!secondResult.confirmed) {
      this.breaker.recordFailure('arb-leg-2');
      logger.error({ pair: opportunity.label, error: secondResult.error }, 'Arb second leg failed');
      return false;
    }

    this.dailyLamports += this.amountLamports;
    this.breaker.recordSuccess();
    logger.info(
      {
        pair: opportunity.label,
        profitBps: opportunity.profitBps,
        first: firstResult.signature,
        second: secondResult.signature,
        inputMint: SOL_MINT,
      },
      'Cross-DEX arbitrage filled',
    );
    return true;
  }
}
