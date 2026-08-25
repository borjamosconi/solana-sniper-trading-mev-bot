import { Connection, VersionedTransaction } from '@solana/web3.js';
import { logger } from './logger';

export async function simulateVersionedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<{ ok: boolean; error?: string; unitsConsumed?: number }> {
  try {
    const result = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });

    if (result.value.err) {
      const error = JSON.stringify(result.value.err);
      logger.debug({ error, logs: result.value.logs?.slice(-8) }, 'Transaction simulation failed');
      return { ok: false, error };
    }

    return { ok: true, unitsConsumed: result.value.unitsConsumed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
