export type DexVenue = 'raydium' | 'pumpfun' | 'jupiter' | 'copy';

export interface Position {
  mint: string;
  dex: DexVenue;
  entryQuoteAmount: bigint;
  tokenAmount: bigint;
  openedAt: number;
  scaledOut: boolean;
}

export class PositionBook {
  private readonly positions = new Map<string, Position>();
  private readonly sellLocks = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(private readonly buyCooldownMs: number) {}

  get size(): number {
    return this.positions.size;
  }

  get openMints(): string[] {
    return [...this.positions.keys()];
  }

  /** Sum of entry quote amounts across open positions (raw units). */
  get totalOpenExposure(): bigint {
    let total = 0n;
    for (const position of this.positions.values()) {
      total += position.entryQuoteAmount;
    }
    return total;
  }

  has(mint: string): boolean {
    return this.positions.has(mint);
  }

  get(mint: string): Position | undefined {
    return this.positions.get(mint);
  }

  open(position: Position): void {
    this.positions.set(position.mint, position);
  }

  close(mint: string): void {
    this.positions.delete(mint);
    if (this.buyCooldownMs > 0) {
      this.cooldownUntil.set(mint, Date.now() + this.buyCooldownMs);
    }
  }

  markScaledOut(mint: string): void {
    const position = this.positions.get(mint);
    if (position) position.scaledOut = true;
  }

  isOnCooldown(mint: string): boolean {
    const until = this.cooldownUntil.get(mint);
    if (!until) return false;
    if (Date.now() >= until) {
      this.cooldownUntil.delete(mint);
      return false;
    }
    return true;
  }

  tryLockSell(mint: string): boolean {
    if (this.sellLocks.has(mint)) return false;
    this.sellLocks.add(mint);
    return true;
  }

  unlockSell(mint: string): void {
    this.sellLocks.delete(mint);
  }
}
