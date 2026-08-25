import { logger } from './logger';
import { sleep } from './promises';

export type ExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'timeout';

export interface ExitStrategyConfig {
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  trailingStopActivationPct: number;
  intervalMs: number;
  durationMs: number;
}

export function evaluateExit(params: {
  current: bigint;
  entry: bigint;
  peak: bigint;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  trailingStopActivationPct: number;
}): { reason?: Exclude<ExitReason, 'timeout'>; peak: bigint } {
  const peak = params.current > params.peak ? params.current : params.peak;
  const takeProfit = applyPercent(params.entry, params.takeProfitPct, true);
  const stopLoss = applyPercent(params.entry, params.stopLossPct, false);

  if (params.current <= stopLoss) {
    return { reason: 'stop_loss', peak };
  }

  if (params.takeProfitPct > 0 && params.current >= takeProfit) {
    return { reason: 'take_profit', peak };
  }

  if (params.trailingStopPct > 0) {
    const activation = applyPercent(params.entry, params.trailingStopActivationPct, true);
    if (peak >= activation) {
      const trailFloor = applyPercent(peak, params.trailingStopPct, false);
      if (params.current <= trailFloor) {
        return { reason: 'trailing_stop', peak };
      }
    }
  }

  return { peak };
}

export async function waitForExitCondition(params: {
  mint: string;
  entry: bigint;
  config: ExitStrategyConfig;
  getPrice: () => Promise<bigint | null>;
}): Promise<ExitReason> {
  if (params.config.intervalMs === 0 || params.config.durationMs === 0) {
    return 'timeout';
  }

  const timesToCheck = Math.max(1, Math.floor(params.config.durationMs / params.config.intervalMs));
  let timesChecked = 0;
  let peak = 0n;

  do {
    try {
      const current = await params.getPrice();
      if (current === null) {
        break;
      }

      const decision = evaluateExit({
        current,
        entry: params.entry,
        peak,
        takeProfitPct: params.config.takeProfitPct,
        stopLossPct: params.config.stopLossPct,
        trailingStopPct: params.config.trailingStopPct,
        trailingStopActivationPct: params.config.trailingStopActivationPct,
      });
      peak = decision.peak;

      logger.debug(
        {
          mint: params.mint,
          current: current.toString(),
          entry: params.entry.toString(),
          peak: peak.toString(),
          reason: decision.reason,
        },
        'Exit strategy tick',
      );

      if (decision.reason) {
        return decision.reason;
      }

      await sleep(params.config.intervalMs);
    } catch (error) {
      logger.trace({ mint: params.mint, error }, 'Exit strategy price check failed');
    } finally {
      timesChecked++;
    }
  } while (timesChecked < timesToCheck);

  return 'timeout';
}

function applyPercent(amount: bigint, percent: number, add: boolean): bigint {
  const bps = BigInt(Math.max(0, Math.floor(percent)));
  if (add) {
    return (amount * (100n + bps)) / 100n;
  }
  const down = (amount * bps) / 100n;
  return amount > down ? amount - down : 0n;
}
