/**
 * READ-ONLY informational dashboard for the Solana sniper bot.
 * GET-only HTTP APIs + static UI. Never mutates trading/config state.
 *
 * Bind: 127.0.0.1 (localhost). Port: DASHBOARD_PORT or 8787.
 * Run: npm run dashboard
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'dashboard', 'public');
const DECISIONS_FILE = path.join(ROOT, 'logs', 'decisions.jsonl');
const KILL_SWITCH_FILE = path.join(ROOT, '.bot-state', 'daily-loss.json');
const KOLSCAN_FILE = path.join(ROOT, 'kolscan-top10-monthly.json');
const ENV_FILE = path.join(ROOT, '.env');

const SECRET_KEY_RE =
  /private[_\s-]?key|secret|seed|mnemonic|token|password|api[_\s-]?key|auth/i;

interface SafeMode {
  liveTrading: boolean | null;
  dryRun: boolean | null;
  source: 'env' | 'decisions' | 'unknown';
}

interface KillSwitchView {
  tripped: boolean;
  lossPercent: number | null;
  maxDailyLossPercent: number | null;
  realizedPnlRaw: string | null;
  startingCapitalRaw: string | null;
  windowStartedAt: number | null;
  trippedAt: number | null;
  tripReason: string | null;
  present: boolean;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function sendText(res: http.ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readFileSafe(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Parse only safe boolean flags from .env — never expose other values. */
function readSafeFlagsFromEnvFile(): { liveTrading: boolean | null; dryRun: boolean | null } {
  const raw = readFileSafe(ENV_FILE);
  let liveTrading: boolean | null = null;
  let dryRun: boolean | null = null;

  const fromProcessLive = process.env.LIVE_TRADING;
  const fromProcessDry = process.env.DRY_RUN;
  if (fromProcessLive === 'true' || fromProcessLive === 'false') {
    liveTrading = fromProcessLive === 'true';
  }
  if (fromProcessDry === 'true' || fromProcessDry === 'false') {
    dryRun = fromProcessDry === 'true';
  }

  if (!raw) return { liveTrading, dryRun };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'LIVE_TRADING' && liveTrading === null) {
      if (value === 'true' || value === 'false') liveTrading = value === 'true';
    }
    if (key === 'DRY_RUN' && dryRun === null) {
      if (value === 'true' || value === 'false') dryRun = value === 'true';
    }
  }

  // Mirror bot semantics: if LIVE_TRADING is not true, force dry-run.
  if (liveTrading === false) {
    dryRun = true;
  }

  return { liveTrading, dryRun };
}

function shortAddress(addr: string, head = 4, tail = 4): string {
  if (!addr || addr.length <= head + tail + 1) return addr || '';
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

function maskChatId(id: string): string {
  if (!id) return '';
  if (id.length <= 4) return '****';
  return `${id.slice(0, 2)}****${id.slice(-2)}`;
}

function sanitizeDecision(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (SECRET_KEY_RE.test(key)) continue;
    if (typeof value === 'string' && /PRIVATE_KEY|TELEGRAM_BOT_TOKEN/i.test(value)) continue;
    if (key === 'mint' && typeof value === 'string') {
      out.mint = value;
      out.mintShort = shortAddress(value);
      continue;
    }
    if ((key === 'wallet' || key === 'copyWallet' || key === 'trader') && typeof value === 'string') {
      out[key] = shortAddress(value);
      continue;
    }
    if (key === 'chatId' || key === 'telegramChatId') {
      out[key] = typeof value === 'string' || typeof value === 'number' ? maskChatId(String(value)) : null;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function readDecisions(limit: number): Record<string, unknown>[] {
  const raw = readFileSafe(DECISIONS_FILE);
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const slice = lines.slice(-Math.max(1, Math.min(limit, 500)));
  const parsed: Record<string, unknown>[] = [];
  for (let i = slice.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(slice[i]) as Record<string, unknown>;
      parsed.push(sanitizeDecision(obj));
    } catch {
      // skip malformed lines
    }
  }
  return parsed;
}

function countDecisionsToday(): number {
  const raw = readFileSafe(DECISIONS_FILE);
  if (!raw) return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { ts?: string };
      if (obj.ts && Date.parse(obj.ts) >= startMs) count += 1;
    } catch {
      // ignore
    }
  }
  return count;
}

function inferModeFromDecisions(decisions: Record<string, unknown>[]): SafeMode {
  for (const d of decisions) {
    if (typeof d.live === 'boolean' || typeof d.dryRun === 'boolean') {
      const dryRun =
        d.dryRun === true || d.live === false
          ? true
          : d.live === true || d.dryRun === false
            ? false
            : null;
      const liveTrading = dryRun === null ? null : !dryRun;
      return { liveTrading, dryRun, source: 'decisions' };
    }
  }
  return { liveTrading: null, dryRun: null, source: 'unknown' };
}

function readKillSwitch(): KillSwitchView {
  const raw = readFileSafe(KILL_SWITCH_FILE);
  if (!raw) {
    return {
      tripped: false,
      lossPercent: null,
      maxDailyLossPercent: null,
      realizedPnlRaw: null,
      startingCapitalRaw: null,
      windowStartedAt: null,
      trippedAt: null,
      tripReason: null,
      present: false,
    };
  }
  try {
    const state = JSON.parse(raw) as {
      tripped?: boolean;
      realizedPnlRaw?: string;
      startingCapitalRaw?: string;
      windowStartedAt?: number;
      trippedAt?: number;
      tripReason?: string;
      maxDailyLossPercent?: number;
    };
    let lossPercent: number | null = null;
    try {
      const starting = BigInt(state.startingCapitalRaw || '0');
      const realized = BigInt(state.realizedPnlRaw || '0');
      if (starting > 0n && realized < 0n) {
        const lossAbs = -realized;
        lossPercent = Number((lossAbs * 10000n) / starting) / 100;
      } else if (starting > 0n) {
        lossPercent = 0;
      }
    } catch {
      lossPercent = null;
    }
    return {
      tripped: !!state.tripped,
      lossPercent,
      maxDailyLossPercent:
        typeof state.maxDailyLossPercent === 'number' ? state.maxDailyLossPercent : null,
      realizedPnlRaw: state.realizedPnlRaw ?? null,
      startingCapitalRaw: state.startingCapitalRaw ?? null,
      windowStartedAt: state.windowStartedAt ?? null,
      trippedAt: state.trippedAt ?? null,
      tripReason: state.tripReason ?? null,
      present: true,
    };
  } catch {
    return {
      tripped: false,
      lossPercent: null,
      maxDailyLossPercent: null,
      realizedPnlRaw: null,
      startingCapitalRaw: null,
      windowStartedAt: null,
      trippedAt: null,
      tripReason: null,
      present: false,
    };
  }
}

function readCopyWalletsCount(): number {
  const fromProcess = process.env.COPY_WALLETS || '';
  if (fromProcess.trim()) {
    return fromProcess
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean).length;
  }
  const raw = readFileSafe(ENV_FILE);
  if (!raw) {
    // Fall back to kolscan list length as watchlist size
    const kol = readKolscan();
    return kol.wallets.length;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('COPY_WALLETS=')) continue;
    let value = trimmed.slice('COPY_WALLETS='.length).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean).length;
  }
  const kol = readKolscan();
  return kol.wallets.length;
}

function readKolscan(): {
  source: string | null;
  timeframe_days: number | null;
  updated: string | null;
  wallets: { rank: number; name: string; wallet: string; walletShort: string }[];
} {
  const raw = readFileSafe(KOLSCAN_FILE);
  if (!raw) {
    return { source: null, timeframe_days: null, updated: null, wallets: [] };
  }
  try {
    const data = JSON.parse(raw) as {
      source?: string;
      timeframe_days?: number;
      updated?: string;
      wallets?: { rank?: number; name?: string; wallet?: string }[];
    };
    const wallets = (data.wallets || []).map((w, i) => ({
      rank: typeof w.rank === 'number' ? w.rank : i + 1,
      name: w.name || '—',
      wallet: w.wallet || '',
      walletShort: shortAddress(w.wallet || ''),
    }));
    return {
      source: data.source || null,
      timeframe_days: data.timeframe_days ?? null,
      updated: data.updated || null,
      wallets,
    };
  } catch {
    return { source: null, timeframe_days: null, updated: null, wallets: [] };
  }
}

function buildStatus() {
  const decisions = readDecisions(20);
  const envFlags = readSafeFlagsFromEnvFile();
  let mode: SafeMode = {
    liveTrading: envFlags.liveTrading,
    dryRun: envFlags.dryRun,
    source: envFlags.liveTrading !== null || envFlags.dryRun !== null ? 'env' : 'unknown',
  };
  if (mode.source === 'unknown') {
    mode = inferModeFromDecisions(decisions);
  }

  const killSwitch = readKillSwitch();
  const allRaw = readFileSafe(DECISIONS_FILE);
  const decisionsCount = allRaw
    ? allRaw.split(/\r?\n/).filter((l) => l.trim().length > 0).length
    : 0;

  return {
    liveTrading: mode.liveTrading,
    dryRun: mode.dryRun,
    modeSource: mode.source,
    killSwitch,
    decisionsCount,
    decisionsToday: countDecisionsToday(),
    lastUpdated: new Date().toISOString(),
    copyWalletsCount: readCopyWalletsCount(),
    decisionsFilePresent: !!allRaw,
    readOnly: true,
  };
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function serveStatic(reqPath: string, res: http.ServerResponse): void {
  const relative = reqPath === '/' ? '/index.html' : reqPath;
  const safeRel = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safeRel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }
  const body = readFileSafe(filePath);
  if (body === null) {
    sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return;
  }
  sendText(res, 200, body, contentTypeFor(filePath));
}

const server = http.createServer((req, res) => {
  try {
    if (!req.url || !req.method) {
      sendText(res, 400, 'Bad request', 'text/plain; charset=utf-8');
      return;
    }

    // Strict GET-only — informational dashboard must never mutate state.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end('Method Not Allowed — dashboard is read-only');
      return;
    }

    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    if (pathname === '/api/status') {
      sendJson(res, 200, buildStatus());
      return;
    }

    if (pathname === '/api/decisions') {
      const limitRaw = url.searchParams.get('limit');
      const limit = Math.max(1, Math.min(Number(limitRaw) || 100, 500));
      sendJson(res, 200, {
        decisions: readDecisions(limit),
        limit,
        lastUpdated: new Date().toISOString(),
      });
      return;
    }

    if (pathname === '/api/kolscan') {
      sendJson(res, 200, {
        ...readKolscan(),
        lastUpdated: new Date().toISOString(),
      });
      return;
    }

    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, readOnly: true });
      return;
    }

    serveStatic(pathname, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    sendJson(res, 500, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `Dashboard (solo lectura) en http://${HOST}:${PORT}  —  DASHBOARD_PORT=${PORT}`,
  );
});
