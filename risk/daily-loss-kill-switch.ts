import fs from 'fs';
import path from 'path';
import { logger } from '../helpers/logger';
import { sendTelegramAlert } from '../helpers/telegram';

const STATE_DIR = path.join(process.cwd(), '.bot-state');
const STATE_FILE = path.join(STATE_DIR, 'daily-loss.json');
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DailyLossState {
  windowStartedAt: number;
  startingCapitalRaw: string;
  realizedPnlRaw: string;
  tripped: boolean;
  trippedAt?: number;
  tripReason?: string;
}

export class DailyLossKillSwitch {
  private state: DailyLossState;

  constructor(
    private readonly maxDailyLossPercent: number,
    private readonly resetRequested: boolean,
    private readonly statePath: string = STATE_FILE,
  ) {
    this.state = this.load();
    this.rotateWindowIfNeeded();
    if (this.resetRequested && this.state.tripped) {
      logger.warn('RESET_KILL_SWITCH=true — clearing daily loss kill switch trip');
      this.state.tripped = false;
      this.state.trippedAt = undefined;
      this.state.tripReason = undefined;
      this.persist();
    }
  }

  get isTripped(): boolean {
    this.rotateWindowIfNeeded();
    return this.state.tripped;
  }

  get snapshot() {
    return {
      ...this.state,
      maxDailyLossPercent: this.maxDailyLossPercent,
      realizedPnl: this.state.realizedPnlRaw,
      startingCapital: this.state.startingCapitalRaw,
    };
  }

  /**
   * Snapshot wallet quote capital (raw integer units) at the start of the rolling window.
   * Also refreshes starting capital when the window rolls.
   */
  ensureCapitalSnapshot(capitalRaw: bigint): void {
    this.rotateWindowIfNeeded();
    if (this.state.startingCapitalRaw === '0' || this.state.startingCapitalRaw === '') {
      this.state.startingCapitalRaw = capitalRaw.toString();
      this.persist();
      logger.info(
        { startingCapitalRaw: this.state.startingCapitalRaw },
        'Daily loss kill switch: captured starting capital snapshot',
      );
    }
  }

  /** Record realized PnL in raw quote units (can be negative). */
  recordRealizedPnl(pnlRaw: bigint): void {
    this.rotateWindowIfNeeded();
    const next = BigInt(this.state.realizedPnlRaw || '0') + pnlRaw;
    this.state.realizedPnlRaw = next.toString();
    this.evaluate();
    this.persist();
  }

  /**
   * Optional unrealized mark: if open position MTM loss pushes total loss past the cap, trip.
   * unrealizedPnlRaw is typically negative when underwater.
   */
  evaluateWithUnrealized(unrealizedPnlRaw: bigint = 0n): void {
    this.rotateWindowIfNeeded();
    this.evaluate(unrealizedPnlRaw);
  }

  assertCanBuy(action: string): boolean {
    this.rotateWindowIfNeeded();
    if (!this.state.tripped) return true;
    logger.error(
      {
        action,
        maxDailyLossPercent: this.maxDailyLossPercent,
        realizedPnlRaw: this.state.realizedPnlRaw,
        startingCapitalRaw: this.state.startingCapitalRaw,
        trippedAt: this.state.trippedAt,
        tripReason: this.state.tripReason,
      },
      'Daily loss kill switch TRIPped — refusing new buys. Clear .bot-state/daily-loss.json or set RESET_KILL_SWITCH=true once, then restart.',
    );
    return false;
  }

  private evaluate(unrealizedPnlRaw: bigint = 0n): void {
    if (this.maxDailyLossPercent <= 0) return;
    if (this.state.tripped) return;

    const starting = BigInt(this.state.startingCapitalRaw || '0');
    if (starting <= 0n) return;

    const realized = BigInt(this.state.realizedPnlRaw || '0');
    const totalPnl = realized + unrealizedPnlRaw;
    if (totalPnl >= 0n) return;

    const lossAbs = -totalPnl;
    const lossPercent = Number((lossAbs * 10000n) / starting) / 100;
    if (lossPercent >= this.maxDailyLossPercent) {
      this.state.tripped = true;
      this.state.trippedAt = Date.now();
      this.state.tripReason = `loss ${lossPercent.toFixed(2)}% >= max ${this.maxDailyLossPercent}%`;
      this.persist();
      logger.error(
        {
          lossPercent,
          maxDailyLossPercent: this.maxDailyLossPercent,
          realizedPnlRaw: this.state.realizedPnlRaw,
          unrealizedPnlRaw: unrealizedPnlRaw.toString(),
          startingCapitalRaw: this.state.startingCapitalRaw,
        },
        'Daily loss kill switch TRIPped — new buys disabled until manual reset + restart',
      );
      void sendTelegramAlert(
        `🛑 KILL SWITCH tripped — ${this.state.tripReason}. New buys disabled until RESET_KILL_SWITCH=true + restart (or clear .bot-state/daily-loss.json).`,
      );
    }
  }

  private rotateWindowIfNeeded(): void {
    const now = Date.now();
    if (!this.state.windowStartedAt || now - this.state.windowStartedAt >= WINDOW_MS) {
      // Trip stays sticky across window rolls — resume only via RESET_KILL_SWITCH or
      // clearing .bot-state/daily-loss.json, then process restart.
      const keepTrip = this.state.tripped;
      const trippedAt = this.state.trippedAt;
      const tripReason = this.state.tripReason;
      this.state = {
        windowStartedAt: now,
        startingCapitalRaw: '0',
        realizedPnlRaw: '0',
        tripped: keepTrip,
        trippedAt: keepTrip ? trippedAt : undefined,
        tripReason: keepTrip ? tripReason : undefined,
      };
      this.persist();
      logger.info(
        { tripped: keepTrip },
        'Daily loss kill switch: started new 24h PnL window (trip remains sticky until manual reset)',
      );
    }
  }

  private load(): DailyLossState {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as DailyLossState;
        return {
          windowStartedAt: raw.windowStartedAt || Date.now(),
          startingCapitalRaw: raw.startingCapitalRaw || '0',
          realizedPnlRaw: raw.realizedPnlRaw || '0',
          tripped: !!raw.tripped,
          trippedAt: raw.trippedAt,
          tripReason: raw.tripReason,
        };
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to load daily loss kill switch state; starting fresh');
    }
    return {
      windowStartedAt: Date.now(),
      startingCapitalRaw: '0',
      realizedPnlRaw: '0',
      tripped: false,
    };
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      logger.error({ error }, 'Failed to persist daily loss kill switch state');
    }
  }
}
