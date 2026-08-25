import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { Filter, FilterResult } from './pool-filters';
import { logger } from '../helpers';

export class HolderFilter implements Filter {
  constructor(
    private readonly connection: Connection,
    private readonly maxTopHolderPercent: number,
  ) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const [supply, largest] = await Promise.all([
        this.connection.getTokenSupply(poolKeys.baseMint, this.connection.commitment),
        this.connection.getTokenLargestAccounts(poolKeys.baseMint, this.connection.commitment),
      ]);

      const total = supply.value.uiAmount;
      if (!total || total <= 0) {
        return { ok: false, message: 'Holder -> token supply unavailable' };
      }

      const lpAccounts = new Set([poolKeys.baseVault.toBase58()]);
      const nonLp = largest.value.filter((account) => !lpAccounts.has(account.address.toBase58()));
      const top = nonLp[0];
      if (!top?.uiAmount) {
        return { ok: true };
      }

      const percent = (top.uiAmount / total) * 100;
      const ok = percent <= this.maxTopHolderPercent;
      return {
        ok,
        message: ok
          ? undefined
          : `Holder -> top non-LP wallet holds ${percent.toFixed(1)}% > ${this.maxTopHolderPercent}%`,
      };
    } catch (error) {
      logger.error({ mint: poolKeys.baseMint, error }, 'Failed to check top holder concentration');
      return { ok: false, message: 'Holder -> failed to check holder concentration' };
    }
  }
}
