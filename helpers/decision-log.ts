import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'decisions.jsonl');

export type DecisionSide = 'enter' | 'exit' | 'skip';

export interface DecisionLogEntry {
  ts: string;
  mint?: string;
  side: DecisionSide;
  reason: string;
  filters?: Record<string, unknown> | string[];
  size?: string | number;
  dryRun?: boolean;
  live?: boolean;
  pnl?: string | number;
  realizedPnl?: string | number;
  dex?: string;
  [key: string]: unknown;
}

export function logDecision(entry: DecisionLogEntry): void {
  const line = JSON.stringify({
    ...entry,
    ts: entry.ts || new Date().toISOString(),
  });

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (error) {
    logger.warn({ error }, 'Failed to append decision log');
  }

  logger.debug({ decision: entry }, 'decision');
}
