import { Connection } from '@solana/web3.js';
import { logger } from './logger';

export async function getDynamicComputeUnitPrice(
  connection: Connection,
  fallbackMicroLamports: number,
  multiplier: number,
  maxMicroLamports: number,
): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees();
    const samples = fees
      .map((item) => item.prioritizationFee)
      .filter((fee) => Number.isFinite(fee) && fee > 0)
      .sort((a, b) => a - b);

    if (samples.length === 0) {
      return clampFee(fallbackMicroLamports, maxMicroLamports);
    }

    const p75 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.75))];
    const boosted = Math.ceil(Math.max(p75, fallbackMicroLamports) * multiplier);
    return clampFee(boosted, maxMicroLamports);
  } catch (error) {
    logger.debug({ error }, 'Failed to fetch recent prioritization fees, using fallback');
    return clampFee(fallbackMicroLamports, maxMicroLamports);
  }
}

function clampFee(value: number, maxMicroLamports: number): number {
  return Math.max(1, Math.min(Math.floor(value), maxMicroLamports));
}
