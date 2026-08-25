import { logger } from '../helpers/logger';

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private pausedUntil = 0;

  constructor(
    private readonly maxConsecutiveFailures: number,
    private readonly pauseMs: number,
  ) {}

  get isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  get pauseRemainingMs(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(context?: string): void {
    this.consecutiveFailures++;
    logger.warn(
      { consecutiveFailures: this.consecutiveFailures, context },
      'Circuit breaker recorded a failure',
    );

    if (this.maxConsecutiveFailures > 0 && this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.pausedUntil = Date.now() + this.pauseMs;
      this.consecutiveFailures = 0;
      logger.error({ pauseMs: this.pauseMs, context }, 'Circuit breaker tripped — pausing new trades');
    }
  }

  assertCanTrade(action: string): boolean {
    if (!this.isPaused) return true;
    logger.warn({ action, pauseRemainingMs: this.pauseRemainingMs }, 'Skipping trade because circuit breaker is paused');
    return false;
  }
}
