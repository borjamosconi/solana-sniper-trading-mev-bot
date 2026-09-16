import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { sendTelegramAlert } from './telegram';

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

function formatDecisionAlert(entry: DecisionLogEntry): string {
  const mode = entry.dryRun === true || entry.live === false ? 'DRY' : entry.live === true ? 'LIVE' : entry.dryRun === false ? 'LIVE' : 'DRY';
  const mint = entry.mint ? String(entry.mint) : 'n/a';
  const reason = entry.reason || 'n/a';
  const sizePart = entry.size !== undefined && entry.size !== '' ? ` size=${entry.size}` : '';
  const pnlVal = entry.realizedPnl ?? entry.pnl;
  const pnlPart = pnlVal !== undefined && pnlVal !== '' ? ` pnl=${pnlVal}` : '';
  const dexPart = entry.dex ? ` dex=${entry.dex}` : '';

  const prefix =
    entry.side === 'enter' ? '🟢 ENTER' : entry.side === 'exit' ? '🔴 EXIT' : '⏭️ SKIP';

  return `${prefix} mint=${mint} reason=${reason}${sizePart}${pnlPart}${dexPart} [${mode}]`;
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

  // Fire-and-forget: never block or throw into the trade path
  void sendTelegramAlert(formatDecisionAlert(entry));
}
