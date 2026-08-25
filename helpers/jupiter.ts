import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { logger } from './logger';

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct?: string;
  routePlan?: unknown[];
  [key: string]: unknown;
}

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: bigint | number | string;
  slippageBps: number;
  dexes?: string;
  excludeDexes?: string;
  onlyDirectRoutes?: boolean;
}

export class JupiterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  get enabled(): boolean {
    return this.baseUrl.length > 0;
  }

  async quote(params: JupiterQuoteParams): Promise<JupiterQuote | undefined> {
    const query = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      slippageBps: Math.max(1, Math.floor(params.slippageBps)).toString(),
      restrictIntermediateTokens: 'true',
    });

    if (params.dexes) query.set('dexes', params.dexes);
    if (params.excludeDexes) query.set('excludeDexes', params.excludeDexes);
    if (params.onlyDirectRoutes) query.set('onlyDirectRoutes', 'true');

    try {
      const response = await fetch(`${this.baseUrl}/quote?${query.toString()}`, {
        headers: this.headers(),
      });

      if (!response.ok) {
        logger.debug({ status: response.status, url: query.toString() }, 'Jupiter quote HTTP error');
        return undefined;
      }

      const data = (await response.json()) as JupiterQuote & { error?: string };
      if (!data?.outAmount || data.error) {
        logger.debug({ error: data?.error }, 'Jupiter quote missing outAmount');
        return undefined;
      }

      return data;
    } catch (error) {
      logger.debug({ error }, 'Jupiter quote request failed');
      return undefined;
    }
  }

  async buildSwapTransaction(quote: JupiterQuote, userPublicKey: string): Promise<VersionedTransaction | undefined> {
    try {
      const response = await fetch(`${this.baseUrl}/swap`, {
        method: 'POST',
        headers: {
          ...this.headers(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              maxLamports: 10_000_000,
              priorityLevel: 'veryHigh',
            },
          },
        }),
      });

      if (!response.ok) {
        logger.debug({ status: response.status }, 'Jupiter swap HTTP error');
        return undefined;
      }

      const data = (await response.json()) as { swapTransaction?: string; error?: string };
      if (!data.swapTransaction) {
        logger.debug({ error: data.error }, 'Jupiter swap response missing transaction');
        return undefined;
      }

      const tx = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
      return tx;
    } catch (error) {
      logger.debug({ error }, 'Jupiter swap build failed');
      return undefined;
    }
  }

  async buildSignedSwap(
    quote: JupiterQuote,
    wallet: Keypair,
  ): Promise<{ transaction: VersionedTransaction; outAmount: bigint } | undefined> {
    const transaction = await this.buildSwapTransaction(quote, wallet.publicKey.toBase58());
    if (!transaction) return undefined;

    transaction.sign([wallet]);
    return { transaction, outAmount: BigInt(quote.outAmount) };
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) return {};
    return { 'x-api-key': this.apiKey };
  }
}
