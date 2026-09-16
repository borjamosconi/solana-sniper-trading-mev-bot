import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, PumpFunCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import {
  computeSolOutForTokens,
  computeTokensOutForSol,
  createPoolKeys,
  createPumpFunBuyInstruction,
  createPumpFunSellInstruction,
  decodeBondingCurve,
  getAssociatedBondingCurve,
  getBondingCurvePDA,
  getDynamicComputeUnitPrice,
  JupiterClient,
  logger,
  NETWORK,
  simulateVersionedTransaction,
  sleep,
  SOL_MINT,
  waitForExitCondition,
} from './helpers';
import { Mutex } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { CircuitBreaker } from './risk/circuit-breaker';
import { DailyLossKillSwitch } from './risk/daily-loss-kill-switch';
import { PositionBook } from './risk/positions';
import { logDecision } from './helpers/decision-log';

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
  pumpFunBuyAmountSol?: number;
  pumpFunMaxCurveProgress?: number;
  dryRun: boolean;
  liveTrading: boolean;
  maxOpenPositions: number;
  maxDailyRaydiumBuys: number;
  maxDailyPumpFunBuySol: number;
  maxPositionPercent: number;
  minPoolAgeSeconds: number;
  trailingStop: number;
  trailingStopActivation: number;
  takeProfitSellPercent: number;
  buyCooldownMs: number;
  dynamicPriorityFee: boolean;
  priorityFeeMultiplier: number;
  maxComputeUnitPrice: number;
  simulateBeforeSend: boolean;
  enableJupiterSell: boolean;
  enableJupiterCopyBuy: boolean;
}

export class Bot {
  private readonly poolFilters: PoolFilters;
  private readonly snipeListCache?: SnipeListCache;
  private readonly mutex: Mutex;
  private readonly positions: PositionBook;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;
  private currentDay = this.getUtcDayKey();
  private dailyRaydiumBuys = 0;
  private dailyPumpFunBuyLamports = 0n;

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
    private readonly pumpFunStorage: PumpFunCache = new PumpFunCache(),
    private readonly jupiter: JupiterClient = new JupiterClient(''),
    private readonly breaker: CircuitBreaker = new CircuitBreaker(4, 300_000),
    private readonly killSwitch: DailyLossKillSwitch = new DailyLossKillSwitch(10, false),
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.mutex = new Mutex();
    this.positions = new PositionBook(this.config.buyCooldownMs);
    this.poolFilters = new PoolFilters(connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  public isBusy(): boolean {
    return this.mutex.isLocked() || this.sellExecutionCount > 0;
  }

  public snapshot() {
    return {
      openPositions: this.positions.size,
      mints: this.positions.openMints,
      dailyRaydiumBuys: this.dailyRaydiumBuys,
      circuitPaused: this.breaker.isPaused,
      killSwitchTripped: this.killSwitch.isTripped,
      killSwitch: this.killSwitch.snapshot,
      dryRun: this.config.dryRun,
      liveTrading: this.config.liveTrading,
    };
  }

  async validate() {
    if (!this.config.liveTrading) {
      logger.warn('LIVE_TRADING is not enabled — forcing dry-run. Set LIVE_TRADING=true to broadcast real transactions.');
    }
    if (this.config.dryRun) {
      logger.warn('DRY_RUN is enabled, skipping startup wallet ATA validation and network execution.');
      return true;
    }

    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4) {
    logger.trace({ mint: poolState.baseMint }, `Processing new pool...`);
    const baseMint = poolState.baseMint.toString();

    if (!(await this.assertBuyAllowed('raydium-buy', baseMint))) return;

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(baseMint)) {
      logger.debug({ mint: baseMint }, `Skipping buy because token is not in a snipe list`);
      this.skipDecision(baseMint, 'not_in_snipe_list', 'raydium');
      return;
    }

    if (this.positions.isOnCooldown(baseMint)) {
      logger.debug({ mint: baseMint }, 'Skipping buy because mint is in post-sell cooldown');
      this.skipDecision(baseMint, 'buy_cooldown', 'raydium');
      return;
    }

    this.resetDailyRiskCountersIfNeeded();
    if (!this.canOpenNewPosition(baseMint)) {
      this.skipDecision(baseMint, 'max_open_positions', 'raydium');
      return;
    }
    if (this.dailyRaydiumBuys >= this.config.maxDailyRaydiumBuys) {
      logger.warn(
        { maxDailyRaydiumBuys: this.config.maxDailyRaydiumBuys },
        'Skipping buy because max daily Raydium buys limit was reached',
      );
      this.skipDecision(baseMint, 'max_daily_raydium_buys', 'raydium');
      return;
    }

    if (!(await this.waitForMinPoolAge(poolState.poolOpenTime.toString(), baseMint))) {
      this.skipDecision(baseMint, 'min_pool_age', 'raydium');
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug(
          { mint: poolState.baseMint.toString() },
          `Skipping buy because one token at a time is turned on and token is already being processed`,
        );
        return;
      }

      await this.mutex.acquire();
    }

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      if (!this.config.useSnipeList) {
        const match = await this.filterMatch(poolKeys);
        if (!match) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
          this.skipDecision(poolKeys.baseMint.toString(), 'filters_mismatch', 'raydium');
          return;
        }
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: poolState.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const buyAmount = await this.capBuyAmount(this.config.quoteAmount);
          if (buyAmount.isZero()) {
            this.skipDecision(baseMint, 'position_size_zero', 'raydium');
            return;
          }
          const result = await this.swap(
            poolKeys,
            this.config.quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            buyAmount,
            this.config.buySlippage,
            this.config.wallet,
            'buy',
            true,
          );

          if (result.confirmed) {
            this.positions.open({
              mint: baseMint,
              dex: 'raydium',
              entryQuoteAmount: BigInt(buyAmount.raw.toString()),
              tokenAmount: 0n,
              openedAt: Date.now(),
              scaledOut: false,
            });
            this.dailyRaydiumBuys++;
            this.breaker.recordSuccess();
            logDecision({
              ts: new Date().toISOString(),
              mint: baseMint,
              side: 'enter',
              reason: 'raydium_buy_confirmed',
              size: buyAmount.toFixed(),
              dryRun: this.config.dryRun,
              live: this.config.liveTrading && !this.config.dryRun,
              dex: 'raydium',
              signature: result.signature,
            });
            logger.info(
              {
                mint: poolState.baseMint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );
            break;
          }

          logger.info(
            {
              mint: poolState.baseMint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          logger.debug({ mint: poolState.baseMint.toString(), error }, `Error confirming buy transaction`);
        }
      }
    } catch (error) {
      this.breaker.recordFailure('raydium-buy');
      logger.error({ mint: poolState.baseMint.toString(), error }, `Failed to buy token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    const mint = rawAccount.mint.toString();
    if (!this.positions.tryLockSell(mint)) {
      logger.debug({ mint }, 'Skipping sell because a sell is already in progress for this mint');
      return;
    }

    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    try {
      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      const poolData = await this.poolStorage.get(mint);
      if (!poolData) {
        if (this.config.enableJupiterSell) {
          logger.info({ mint }, 'No Raydium pool cache entry — attempting Jupiter sell');
          await this.sellViaJupiter(mint, BigInt(rawAccount.amount.toString()), true);
          return;
        }
        logger.trace({ mint }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);
      if (tokenAmountIn.isZero()) {
        logger.info({ mint }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);
      const reason = await this.waitForRaydiumExit(tokenAmountIn, poolKeys);
      logger.info({ mint, reason }, 'Raydium exit condition reached');

      const scaleOut =
        reason === 'take_profit' &&
        this.config.takeProfitSellPercent < 100 &&
        !(this.positions.get(mint)?.scaledOut ?? false);

      if (scaleOut) {
        const partial = this.scaleTokenAmount(tokenAmountIn, this.config.takeProfitSellPercent);
        const partialResult = await this.executeRaydiumSell(poolKeys, accountId, tokenIn, partial, false);
        if (partialResult) {
          this.positions.markScaledOut(mint);
          const remainingRaw = BigInt(tokenAmountIn.raw.toString()) - BigInt(partial.raw.toString());
          if (remainingRaw > 0n) {
            const remaining = new TokenAmount(tokenIn, new BN(remainingRaw.toString()), true);
            const restReason = await this.waitForRaydiumExit(remaining, poolKeys, true);
            logger.info({ mint, restReason }, 'Remaining position exit condition reached');
            await this.executeRaydiumSell(poolKeys, accountId, tokenIn, remaining, true);
          } else {
            this.recordExitAndClose(mint, undefined, 'raydium_scaleout_complete');
          }
          return;
        }
      }

      await this.executeRaydiumSell(poolKeys, accountId, tokenIn, tokenAmountIn, true);
    } catch (error) {
      this.breaker.recordFailure('raydium-sell');
      logger.error({ mint, error }, `Failed to sell token`);
    } finally {
      this.positions.unlockSell(mint);
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  public async copyBuy(mint: PublicKey) {
    if (!this.config.enableJupiterCopyBuy || !this.jupiter.enabled) return;

    const mintStr = mint.toString();
    if (mint.equals(this.config.quoteToken.mint) || mintStr === SOL_MINT) return;
    if (!(await this.assertBuyAllowed('copy-buy', mintStr))) return;
    if (this.config.useSnipeList && !this.snipeListCache?.isInList(mintStr)) {
      this.skipDecision(mintStr, 'not_in_snipe_list', 'copy');
      return;
    }
    if (this.positions.isOnCooldown(mintStr) || this.positions.has(mintStr)) {
      this.skipDecision(mintStr, 'cooldown_or_open', 'copy');
      return;
    }

    this.resetDailyRiskCountersIfNeeded();
    if (!this.canOpenNewPosition(mintStr)) {
      this.skipDecision(mintStr, 'max_open_positions', 'copy');
      return;
    }
    if (this.dailyRaydiumBuys >= this.config.maxDailyRaydiumBuys) {
      this.skipDecision(mintStr, 'max_daily_raydium_buys', 'copy');
      return;
    }

    const buyAmount = await this.capBuyAmount(this.config.quoteAmount);
    if (buyAmount.isZero()) {
      this.skipDecision(mintStr, 'position_size_zero', 'copy');
      return;
    }

    logger.info({ mint: mintStr }, 'Copy-trade buy via Jupiter');
    const quote = await this.jupiter.quote({
      inputMint: this.config.quoteToken.mint.toBase58(),
      outputMint: mintStr,
      amount: buyAmount.raw.toString(),
      slippageBps: Math.floor(this.config.buySlippage * 100),
    });
    if (!quote) {
      logger.debug({ mint: mintStr }, 'Copy-trade skipped — no Jupiter route yet');
      this.skipDecision(mintStr, 'no_jupiter_route', 'copy');
      return;
    }

    const filled = await this.executeJupiterQuote(quote, 'copy-buy');
    if (filled) {
      this.positions.open({
        mint: mintStr,
        dex: 'copy',
        entryQuoteAmount: BigInt(buyAmount.raw.toString()),
        tokenAmount: BigInt(quote.outAmount),
        openedAt: Date.now(),
        scaledOut: false,
      });
      this.dailyRaydiumBuys++;
      logDecision({
        ts: new Date().toISOString(),
        mint: mintStr,
        side: 'enter',
        reason: 'copy_buy_confirmed',
        size: buyAmount.toFixed(),
        dryRun: this.config.dryRun,
        live: this.config.liveTrading && !this.config.dryRun,
        dex: 'copy',
      });
    }
  }

  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
    closeAtaOnSell: boolean,
  ) {
    if (!this.config.liveTrading || this.config.dryRun) {
      logger.info(
        {
          mint: poolKeys.baseMint.toString(),
          direction,
          amountIn: amountIn.toFixed(),
          slippage,
          liveTrading: this.config.liveTrading,
          dryRun: this.config.dryRun,
        },
        'DRY_RUN: skipping on-chain Raydium swap transaction',
      );
      return { confirmed: true, signature: 'dry-run' };
    }

    const slippagePercent = new Percent(slippage, 100);
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const unitPrice = await this.resolveUnitPrice();
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' && closeAtaOnSell
          ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)]
          : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    if (this.config.simulateBeforeSend) {
      const simulation = await simulateVersionedTransaction(this.connection, transaction);
      if (!simulation.ok) {
        return { confirmed: false, error: `simulation failed: ${simulation.error}` };
      }
    }

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async executeRaydiumSell(
    poolKeys: LiquidityPoolKeysV4,
    accountId: PublicKey,
    tokenIn: Token,
    tokenAmountIn: TokenAmount,
    closeAta: boolean,
  ): Promise<boolean> {
    const mint = poolKeys.baseMint.toString();
    const jupiterBetter = await this.shouldPreferJupiterSell(mint, tokenAmountIn, poolKeys);

    if (jupiterBetter) {
      const sold = await this.sellViaJupiter(mint, BigInt(tokenAmountIn.raw.toString()), closeAta);
      if (sold) return true;
      logger.warn({ mint }, 'Jupiter sell failed, falling back to Raydium');
    }

    for (let i = 0; i < this.config.maxSellRetries; i++) {
      try {
        logger.info({ mint }, `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`);
        const result = await this.swap(
          poolKeys,
          accountId,
          this.config.quoteAta,
          tokenIn,
          this.config.quoteToken,
          tokenAmountIn,
          this.config.sellSlippage,
          this.config.wallet,
          'sell',
          closeAta,
        );

        if (result.confirmed) {
          if (closeAta) {
            this.recordExitAndClose(mint, undefined, 'raydium_sell');
          }
          this.breaker.recordSuccess();
          logger.info(
            {
              dex: `https://dexscreener.com/solana/${mint}?maker=${this.config.wallet.publicKey}`,
              mint,
              signature: result.signature,
              url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
            },
            `Confirmed sell tx`,
          );
          return true;
        }

        logger.info({ mint, signature: result.signature, error: result.error }, `Error confirming sell tx`);
      } catch (error) {
        logger.debug({ mint, error }, `Error confirming sell transaction`);
      }
    }

    this.breaker.recordFailure('raydium-sell-retries');
    return false;
  }

  private async shouldPreferJupiterSell(
    mint: string,
    tokenAmountIn: TokenAmount,
    poolKeys: LiquidityPoolKeysV4,
  ): Promise<boolean> {
    if (!this.config.enableJupiterSell || !this.jupiter.enabled) return false;

    try {
      const [jupiterQuote, poolInfo] = await Promise.all([
        this.jupiter.quote({
          inputMint: mint,
          outputMint: this.config.quoteToken.mint.toBase58(),
          amount: tokenAmountIn.raw.toString(),
          slippageBps: Math.floor(this.config.sellSlippage * 100),
        }),
        Liquidity.fetchInfo({ connection: this.connection, poolKeys }),
      ]);
      if (!jupiterQuote) return false;

      const raydiumOut = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn: tokenAmountIn,
        currencyOut: this.config.quoteToken,
        slippage: new Percent(this.config.sellSlippage, 100),
      }).amountOut;

      const jupiterOut = BigInt(jupiterQuote.outAmount);
      const raydiumRaw = BigInt(raydiumOut.raw.toString());
      const better = jupiterOut > (raydiumRaw * 10030n) / 10000n;
      if (better) {
        logger.info(
          { mint, jupiterOut: jupiterOut.toString(), raydiumOut: raydiumRaw.toString() },
          'Jupiter route beats direct Raydium sell',
        );
      }
      return better;
    } catch (error) {
      logger.debug({ mint, error }, 'Failed to compare Jupiter vs Raydium sell quotes');
      return false;
    }
  }

  private async sellViaJupiter(mint: string, amount: bigint, closePosition: boolean): Promise<boolean> {
    if (!this.jupiter.enabled || amount <= 0n) return false;

    const quote = await this.jupiter.quote({
      inputMint: mint,
      outputMint: this.config.quoteToken.mint.toBase58(),
      amount,
      slippageBps: Math.floor(this.config.sellSlippage * 100),
    });
    if (!quote) return false;

    const filled = await this.executeJupiterQuote(quote, `jupiter-sell:${mint}`);
    if (filled && closePosition) {
      const proceeds = BigInt(quote.outAmount);
      this.recordExitAndClose(mint, proceeds, 'jupiter_sell');
    }
    return filled;
  }

  private async executeJupiterQuote(quote: { outAmount: string; [key: string]: unknown }, context: string): Promise<boolean> {
    if (!this.config.liveTrading || this.config.dryRun) {
      logger.info(
        { context, outAmount: quote.outAmount, liveTrading: this.config.liveTrading, dryRun: this.config.dryRun },
        'DRY_RUN: skipping Jupiter swap',
      );
      return true;
    }

    const built = await this.jupiter.buildSignedSwap(quote as Parameters<JupiterClient['buildSignedSwap']>[0], this.config.wallet);
    if (!built) return false;

    if (this.config.simulateBeforeSend) {
      const simulation = await simulateVersionedTransaction(this.connection, built.transaction);
      if (!simulation.ok) {
        logger.debug({ context, error: simulation.error }, 'Jupiter swap simulation failed');
        return false;
      }
    }

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const result = await this.txExecutor.executeAndConfirm(built.transaction, this.config.wallet, latestBlockhash);
    if (!result.confirmed) {
      this.breaker.recordFailure(context);
      logger.info({ context, signature: result.signature, error: result.error }, 'Jupiter swap failed');
      return false;
    }

    this.breaker.recordSuccess();
    logger.info(
      {
        context,
        signature: result.signature,
        url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
      },
      'Confirmed Jupiter swap',
    );
    return true;
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await this.poolFilters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;
          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  public isPumpFunMint(mint: string): boolean {
    return !!this.pumpFunStorage.get(mint);
  }

  public async buyPumpFun(mint: PublicKey) {
    const mintStr = mint.toString();
    logger.trace({ mint: mintStr }, `Processing new pump.fun token...`);

    if (!(await this.assertBuyAllowed('pumpfun-buy', mintStr))) return;
    if (this.config.useSnipeList && !this.snipeListCache?.isInList(mintStr)) {
      logger.debug({ mint: mintStr }, `Skipping pump.fun buy (not on snipe list)`);
      this.skipDecision(mintStr, 'not_in_snipe_list', 'pumpfun');
      return;
    }
    if (this.positions.isOnCooldown(mintStr)) {
      this.skipDecision(mintStr, 'buy_cooldown', 'pumpfun');
      return;
    }

    this.resetDailyRiskCountersIfNeeded();
    if (!this.canOpenNewPosition(mintStr)) {
      this.skipDecision(mintStr, 'max_open_positions', 'pumpfun');
      return;
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug({ mint: mintStr }, `Skipping pump.fun buy (one-at-a-time busy)`);
        return;
      }
      await this.mutex.acquire();
    }

    try {
      const bondingCurve = getBondingCurvePDA(mint);
      const associatedBondingCurve = getAssociatedBondingCurve(bondingCurve, mint);
      const associatedUser = await getAssociatedTokenAddress(mint, this.config.wallet.publicKey);

      const info = await this.connection.getAccountInfo(bondingCurve, this.connection.commitment);
      if (!info?.data) {
        logger.debug({ mint: mintStr }, `Bonding curve not found`);
        return;
      }
      const curve = decodeBondingCurve(info.data);
      if (curve.complete) {
        logger.debug({ mint: mintStr }, `Bonding curve complete, skipping`);
        return;
      }

      const progressPct =
        curve.tokenTotalSupply > 0n
          ? Number(((curve.tokenTotalSupply - curve.realTokenReserves) * 10000n) / curve.tokenTotalSupply) / 100
          : 0;
      const maxProgress = this.config.pumpFunMaxCurveProgress ?? 100;
      if (progressPct > maxProgress) {
        logger.debug({ mint: mintStr, progressPct }, `Curve progress too high, skipping`);
        return;
      }

      const requestedSol = this.config.pumpFunBuyAmountSol ?? 0.001;
      const cappedSol = await this.capPumpFunBuySol(requestedSol);
      if (cappedSol <= 0) {
        this.skipDecision(mintStr, 'position_size_zero', 'pumpfun');
        return;
      }
      const solInLamports = BigInt(Math.floor(cappedSol * 1_000_000_000));
      const nextDailyPumpFunTotal = this.dailyPumpFunBuyLamports + solInLamports;
      const maxDailyPumpFunLamports = BigInt(Math.floor(this.config.maxDailyPumpFunBuySol * 1_000_000_000));
      if (nextDailyPumpFunTotal > maxDailyPumpFunLamports) {
        logger.warn(
          {
            mint: mintStr,
            maxDailyPumpFunBuySol: this.config.maxDailyPumpFunBuySol,
          },
          `Skipping pump.fun buy because max daily SOL budget was reached`,
        );
        return;
      }
      const expectedTokens = computeTokensOutForSol(curve, solInLamports);
      if (expectedTokens <= 0n) {
        logger.debug({ mint: mintStr }, `Expected tokens out is zero`);
        return;
      }
      const slippageBps = BigInt(Math.floor(this.config.buySlippage * 100));
      const maxSolCost = (solInLamports * (10000n + slippageBps)) / 10000n;
      const maxSolCostWithFee = (maxSolCost * 101n) / 100n;

      this.pumpFunStorage.save({
        mint,
        bondingCurve,
        associatedBondingCurve,
        state: curve,
      });

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info({ mint: mintStr }, `Send pump.fun buy tx attempt: ${i + 1}/${this.config.maxBuyRetries}`);
          const result = await this.executePumpFunBuy({
            mint,
            bondingCurve,
            associatedBondingCurve,
            associatedUser,
            amount: expectedTokens,
            maxSolCost: maxSolCostWithFee,
          });

          if (result.confirmed) {
            this.positions.open({
              mint: mintStr,
              dex: 'pumpfun',
              entryQuoteAmount: solInLamports,
              tokenAmount: expectedTokens,
              openedAt: Date.now(),
              scaledOut: false,
            });
            this.dailyPumpFunBuyLamports = nextDailyPumpFunTotal;
            this.breaker.recordSuccess();
            logDecision({
              ts: new Date().toISOString(),
              mint: mintStr,
              side: 'enter',
              reason: 'pumpfun_buy_confirmed',
              size: cappedSol,
              dryRun: this.config.dryRun,
              live: this.config.liveTrading && !this.config.dryRun,
              dex: 'pumpfun',
              signature: result.signature,
            });
            logger.info(
              {
                mint: mintStr,
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed pump.fun buy`,
            );
            break;
          }
          logger.info(
            { mint: mintStr, signature: result.signature, error: result.error },
            `Error confirming pump.fun buy`,
          );
        } catch (error) {
          logger.debug({ mint: mintStr, error }, `Error sending pump.fun buy`);
        }
      }
    } catch (error) {
      this.breaker.recordFailure('pumpfun-buy');
      logger.error({ mint: mint.toString(), error }, `Failed to buy pump.fun token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  public async sellPumpFun(userAta: PublicKey, rawAccount: RawAccount) {
    const mintStr = rawAccount.mint.toString();
    if (!this.positions.tryLockSell(mintStr)) return;

    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    try {
      const entry = this.pumpFunStorage.get(mintStr);
      if (!entry) return;

      const tokensIn = BigInt(rawAccount.amount.toString());
      if (tokensIn === 0n) {
        logger.info({ mint: mintStr }, `Empty pump.fun balance`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        await sleep(this.config.autoSellDelay);
      }

      const reason = await this.waitForPumpFunExit(entry.mint, tokensIn);
      logger.info({ mint: mintStr, reason }, 'pump.fun exit condition reached');

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          const curveInfo = await this.connection.getAccountInfo(entry.bondingCurve, this.connection.commitment);
          if (!curveInfo?.data) break;
          const curve = decodeBondingCurve(curveInfo.data);
          if (curve.complete) {
            logger.info({ mint: mintStr }, `Curve graduated; selling via Jupiter instead of pump.fun`);
            const sold = await this.sellViaJupiter(mintStr, tokensIn, true);
            if (!sold) {
              logger.warn({ mint: mintStr }, 'Graduated token Jupiter sell failed');
            }
            break;
          }

          const solOut = computeSolOutForTokens(curve, tokensIn);
          const slippageBps = BigInt(Math.floor(this.config.sellSlippage * 100));
          const minSolOutput = (solOut * (10000n - slippageBps)) / 10000n;

          logger.info({ mint: mintStr }, `Send pump.fun sell tx attempt: ${i + 1}/${this.config.maxSellRetries}`);
          const result = await this.executePumpFunSell({
            mint: entry.mint,
            bondingCurve: entry.bondingCurve,
            associatedBondingCurve: entry.associatedBondingCurve,
            associatedUser: userAta,
            amount: tokensIn,
            minSolOutput,
          });

          if (result.confirmed) {
            this.recordExitAndClose(mintStr, solOut, 'pumpfun_sell');
            this.breaker.recordSuccess();
            logger.info(
              {
                mint: mintStr,
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed pump.fun sell`,
            );
            break;
          }
          logger.info(
            { mint: mintStr, signature: result.signature, error: result.error },
            `Error confirming pump.fun sell`,
          );
        } catch (error) {
          logger.debug({ mint: mintStr, error }, `Error pump.fun sell`);
        }
      }
    } catch (error) {
      this.breaker.recordFailure('pumpfun-sell');
      logger.error({ mint: mintStr, error }, `Failed to sell pump.fun token`);
    } finally {
      this.positions.unlockSell(mintStr);
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  private async executePumpFunBuy(params: {
    mint: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    associatedUser: PublicKey;
    amount: bigint;
    maxSolCost: bigint;
  }) {
    if (!this.config.liveTrading || this.config.dryRun) {
      logger.info(
        { mint: params.mint.toString(), liveTrading: this.config.liveTrading, dryRun: this.config.dryRun },
        'DRY_RUN: skipping on-chain pump.fun buy transaction',
      );
      return { confirmed: true, signature: 'dry-run' };
    }

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const unitPrice = await this.resolveUnitPrice();
    const ixs = [
      ...(this.isWarp || this.isJito
        ? []
        : [
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: unitPrice }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
          ]),
      createAssociatedTokenAccountIdempotentInstruction(
        this.config.wallet.publicKey,
        params.associatedUser,
        this.config.wallet.publicKey,
        params.mint,
      ),
      createPumpFunBuyInstruction({
        mint: params.mint,
        user: this.config.wallet.publicKey,
        bondingCurve: params.bondingCurve,
        associatedBondingCurve: params.associatedBondingCurve,
        associatedUser: params.associatedUser,
        amount: params.amount,
        maxSolCost: params.maxSolCost,
      }),
    ];
    const messageV0 = new TransactionMessage({
      payerKey: this.config.wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    tx.sign([this.config.wallet]);

    if (this.config.simulateBeforeSend) {
      const simulation = await simulateVersionedTransaction(this.connection, tx);
      if (!simulation.ok) {
        return { confirmed: false, error: `simulation failed: ${simulation.error}` };
      }
    }

    return this.txExecutor.executeAndConfirm(tx, this.config.wallet, latestBlockhash);
  }

  private async executePumpFunSell(params: {
    mint: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    associatedUser: PublicKey;
    amount: bigint;
    minSolOutput: bigint;
  }) {
    if (!this.config.liveTrading || this.config.dryRun) {
      logger.info(
        { mint: params.mint.toString(), liveTrading: this.config.liveTrading, dryRun: this.config.dryRun },
        'DRY_RUN: skipping on-chain pump.fun sell transaction',
      );
      return { confirmed: true, signature: 'dry-run' };
    }

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const unitPrice = await this.resolveUnitPrice();
    const ixs = [
      ...(this.isWarp || this.isJito
        ? []
        : [
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: unitPrice }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
          ]),
      createPumpFunSellInstruction({
        mint: params.mint,
        user: this.config.wallet.publicKey,
        bondingCurve: params.bondingCurve,
        associatedBondingCurve: params.associatedBondingCurve,
        associatedUser: params.associatedUser,
        amount: params.amount,
        minSolOutput: params.minSolOutput,
      }),
      createCloseAccountInstruction(params.associatedUser, this.config.wallet.publicKey, this.config.wallet.publicKey),
    ];
    const messageV0 = new TransactionMessage({
      payerKey: this.config.wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    tx.sign([this.config.wallet]);

    if (this.config.simulateBeforeSend) {
      const simulation = await simulateVersionedTransaction(this.connection, tx);
      if (!simulation.ok) {
        return { confirmed: false, error: `simulation failed: ${simulation.error}` };
      }
    }

    return this.txExecutor.executeAndConfirm(tx, this.config.wallet, latestBlockhash);
  }

  private async waitForPumpFunExit(mint: PublicKey, tokensIn: bigint) {
    const buyAmountSol = this.config.pumpFunBuyAmountSol ?? 0.001;
    const entry = BigInt(Math.floor(buyAmountSol * 1_000_000_000));
    const bondingCurve = getBondingCurvePDA(mint);

    return waitForExitCondition({
      mint: mint.toString(),
      entry,
      config: this.exitConfig(),
      getPrice: async () => {
        const info = await this.connection.getAccountInfo(bondingCurve, this.connection.commitment);
        if (!info?.data) return null;
        const curve = decodeBondingCurve(info.data);
        if (curve.complete) return null;
        return computeSolOutForTokens(curve, tokensIn);
      },
    });
  }

  private async waitForRaydiumExit(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4, trailOnly = false) {
    return waitForExitCondition({
      mint: poolKeys.baseMint.toString(),
      entry: BigInt(this.config.quoteAmount.raw.toString()),
      config: trailOnly ? { ...this.exitConfig(), takeProfitPct: 0 } : this.exitConfig(),
      getPrice: async () => {
        const poolInfo = await Liquidity.fetchInfo({ connection: this.connection, poolKeys });
        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn,
          currencyOut: this.config.quoteToken,
          slippage: new Percent(this.config.sellSlippage, 100),
        }).amountOut;
        return BigInt(amountOut.raw.toString());
      },
    });
  }

  private exitConfig() {
    return {
      takeProfitPct: this.config.takeProfit,
      stopLossPct: this.config.stopLoss,
      trailingStopPct: this.config.trailingStop,
      trailingStopActivationPct: this.config.trailingStopActivation,
      intervalMs: this.config.priceCheckInterval,
      durationMs: this.config.priceCheckDuration,
    };
  }

  private scaleTokenAmount(amount: TokenAmount, percent: number): TokenAmount {
    const scaled = (BigInt(amount.raw.toString()) * BigInt(Math.min(100, Math.max(1, percent)))) / 100n;
    return new TokenAmount(amount.token, new BN(scaled.toString()), true);
  }

  private async resolveUnitPrice(): Promise<number> {
    if (!this.config.dynamicPriorityFee) return this.config.unitPrice;
    return getDynamicComputeUnitPrice(
      this.connection,
      this.config.unitPrice,
      this.config.priorityFeeMultiplier,
      this.config.maxComputeUnitPrice,
    );
  }

  private canOpenNewPosition(mint: string): boolean {
    if (this.positions.has(mint)) {
      return true;
    }
    if (this.positions.size >= this.config.maxOpenPositions) {
      logger.warn(
        { maxOpenPositions: this.config.maxOpenPositions, openPositions: this.positions.size, mint },
        'Skipping buy because max open positions limit was reached',
      );
      return false;
    }
    return true;
  }

  private resetDailyRiskCountersIfNeeded(): void {
    const nowDay = this.getUtcDayKey();
    if (nowDay === this.currentDay) return;

    this.currentDay = nowDay;
    this.dailyRaydiumBuys = 0;
    this.dailyPumpFunBuyLamports = 0n;
    logger.info('Daily risk counters reset');
  }

  private getUtcDayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async assertBuyAllowed(action: string, mint: string): Promise<boolean> {
    if (!this.breaker.assertCanTrade(action)) {
      this.skipDecision(mint, 'circuit_breaker', action);
      return false;
    }
    if (!this.killSwitch.assertCanBuy(action)) {
      this.skipDecision(mint, 'daily_loss_kill_switch', action);
      return false;
    }
    try {
      const capital = await this.estimateQuoteCapitalRaw();
      this.killSwitch.ensureCapitalSnapshot(capital);
      // Conservative unrealized: treat open exposure as mark-to-zero risk floor (no MTM).
      this.killSwitch.evaluateWithUnrealized(0n);
      if (!this.killSwitch.assertCanBuy(action)) {
        this.skipDecision(mint, 'daily_loss_kill_switch', action);
        return false;
      }
    } catch (error) {
      logger.debug({ error, action }, 'Failed to refresh kill-switch capital snapshot');
    }
    return true;
  }

  private async waitForMinPoolAge(poolOpenTimeRaw: string, mint: string): Promise<boolean> {
    const minAge = this.config.minPoolAgeSeconds ?? 0;
    if (minAge <= 0) return true;

    const poolOpenTime = Number(poolOpenTimeRaw);
    if (!Number.isFinite(poolOpenTime) || poolOpenTime <= 0) {
      logger.debug({ mint }, 'poolOpenTime missing — skipping min pool age check');
      return true;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const age = nowSec - poolOpenTime;
    if (age >= minAge) return true;

    // Pool is younger than required: wait until it ages in (keeps sniping viable with a delay).
    const waitMs = (minAge - age) * 1000;
    // Cap wait at 5 minutes to avoid hanging forever on bad timestamps.
    if (waitMs > 5 * 60 * 1000) {
      logger.warn({ mint, age, minAge, waitMs }, 'Min pool age wait too long — rejecting');
      return false;
    }

    logger.info({ mint, age, minAge, waitMs }, 'Waiting for MIN_POOL_AGE_SECONDS before buy');
    await sleep(waitMs);
    return true;
  }

  private async estimateQuoteCapitalRaw(): Promise<bigint> {
    let capital = 0n;
    try {
      const ata = await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
      capital += BigInt(ata.amount.toString());
    } catch {
      // ATA may not exist yet in dry-run / fresh wallets
    }

    // If quoting in WSOL, also count native SOL balance (lamports).
    if (this.config.quoteToken.mint.toBase58() === SOL_MINT) {
      const lamports = BigInt(await this.connection.getBalance(this.config.wallet.publicKey, this.connection.commitment));
      capital += lamports;
    }

    capital += this.positions.totalOpenExposure;
    return capital;
  }

  private async capBuyAmount(requested: TokenAmount): Promise<TokenAmount> {
    const pct = this.config.maxPositionPercent ?? 0;
    if (pct <= 0) return requested;

    const capital = await this.estimateQuoteCapitalRaw();
    this.killSwitch.ensureCapitalSnapshot(capital > this.positions.totalOpenExposure ? capital - this.positions.totalOpenExposure : capital);

    if (capital <= 0n) {
      logger.warn('Quote capital estimate is zero — refusing buy (position size cap)');
      return new TokenAmount(requested.token, new BN(0), true);
    }

    const maxRaw = (capital * BigInt(Math.floor(pct * 100))) / 10000n;
    const requestedRaw = BigInt(requested.raw.toString());
    if (requestedRaw <= maxRaw) return requested;

    logger.warn(
      {
        requested: requestedRaw.toString(),
        maxRaw: maxRaw.toString(),
        maxPositionPercent: pct,
        capital: capital.toString(),
      },
      'Capping buy size to MAX_POSITION_PERCENT of estimated quote capital',
    );
    return new TokenAmount(requested.token, new BN(maxRaw.toString()), true);
  }

  private async capPumpFunBuySol(requestedSol: number): Promise<number> {
    const pct = this.config.maxPositionPercent ?? 0;
    if (pct <= 0) return requestedSol;

    const capital = await this.estimateQuoteCapitalRaw();
    if (capital <= 0n) {
      logger.warn('Quote capital estimate is zero — refusing pump.fun buy (position size cap)');
      return 0;
    }

    const maxLamports = (capital * BigInt(Math.floor(pct * 100))) / 10000n;
    const maxSol = Number(maxLamports) / 1_000_000_000;
    if (requestedSol <= maxSol) return requestedSol;

    logger.warn(
      { requestedSol, maxSol, maxPositionPercent: pct },
      'Capping pump.fun buy size to MAX_POSITION_PERCENT of estimated capital',
    );
    return Math.max(0, maxSol);
  }

  private recordExitAndClose(mint: string, proceedsRaw: bigint | undefined, reason: string): void {
    const position = this.positions.get(mint);
    const entry = position?.entryQuoteAmount ?? 0n;
    const proceeds = proceedsRaw ?? entry; // unknown proceeds => treat as flat (0 pnl)
    const pnl = proceeds - entry;
    if (position) {
      this.killSwitch.recordRealizedPnl(pnl);
    }
    this.positions.close(mint);
    logDecision({
      ts: new Date().toISOString(),
      mint,
      side: 'exit',
      reason,
      size: entry.toString(),
      dryRun: this.config.dryRun,
      live: this.config.liveTrading && !this.config.dryRun,
      pnl: pnl.toString(),
      realizedPnl: pnl.toString(),
      proceeds: proceeds.toString(),
      dex: position?.dex,
    });
  }

  private skipDecision(mint: string, reason: string, dex?: string): void {
    logDecision({
      ts: new Date().toISOString(),
      mint,
      side: 'skip',
      reason,
      dryRun: this.config.dryRun,
      live: this.config.liveTrading && !this.config.dryRun,
      dex,
    });
  }
}
