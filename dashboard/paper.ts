/**
 * Paper (dry-run) performance tracker for the READ-ONLY dashboard.
 *
 * - Reads logs/decisions.jsonl (promesa_handoff format + legacy bot format).
 * - Every DRY_RUN_ENTER opens a paper position; a duplicate ENTER for a mint that is
 *   still open adds NO size (treated as HOLD).
 * - Entry price: GeckoTerminal OHLCV near the decision ts (reuses backtest/fetch_ohlcv.ts);
 *   fallback = first observed DexScreener price, flagged "entry approx".
 * - Current price: DexScreener (batched, cached ~60s, backs off on 429).
 * - Exit rules: TAKE_PROFIT / STOP_LOSS (%) like the bot, scanned over candles after entry.
 *
 * Never sends transactions, never reads PRIVATE_KEY / Telegram token (only whitelisted
 * numeric keys are parsed from env files). Only writes price caches under .bot-state/ (gitignored).
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { Candle, fetchOhlcv, resolvePool } from '../backtest/fetch_ohlcv';

const ROOT = process.cwd();
const DECISIONS_FILE = path.join(ROOT, 'logs', 'decisions.jsonl');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_DEFAULTS_FILE = path.join(ROOT, '.env.copy');
const APPROX_CACHE_FILE = path.join(ROOT, '.bot-state', 'paper-entry-approx.json');
const OHLCV_CACHE_DIR = path.join(ROOT, '.bot-state', 'paper-ohlcv');

const CANDLE_MIN = 15;
const CANDLE_SEC = CANDLE_MIN * 60;
const DEX_TTL_MS = 60_000;
const OHLCV_TTL_MS = 5 * 60_000;
const SNAPSHOT_TTL_MS = 60_000;
const GT_SPACING_MS = 6_000; // GeckoTerminal free tier (~30 req/min nominal, stricter in practice)

const WHITELIST = ['TAKE_PROFIT', 'STOP_LOSS', 'MAX_POSITION_PERCENT', 'PAPER_BANKROLL_SOL'] as const;
type WhitelistKey = (typeof WHITELIST)[number];

/** Parse ONLY whitelisted numeric keys from an env file. Everything else is ignored. */
function readWhitelistedKeys(file: string): Partial<Record<WhitelistKey, number>> {
  const out: Partial<Record<WhitelistKey, number>> = {};
  let raw: string;
  try {
    if (!fs.existsSync(file)) return out;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim() as WhitelistKey;
    if (!(WHITELIST as readonly string[]).includes(key)) continue;
    const v = Number(
      t
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, ''),
    );
    if (Number.isFinite(v)) out[key] = v;
  }
  return out;
}

export interface PaperConfig {
  takeProfitPct: number;
  stopLossPct: number;
  exitRulesSource: string;
  bankrollSol: number;
  positionPercent: number;
  candleMinutes: number;
}

function readConfig(): PaperConfig {
  const envFile = readWhitelistedKeys(ENV_FILE);
  const defaults = readWhitelistedKeys(ENV_DEFAULTS_FILE);
  const pick = (k: WhitelistKey): { v: number; src: string } | null => {
    const p = Number(process.env[k]);
    if (process.env[k] !== undefined && Number.isFinite(p)) return { v: p, src: 'process.env' };
    if (envFile[k] !== undefined) return { v: envFile[k] as number, src: '.env' };
    if (defaults[k] !== undefined) return { v: defaults[k] as number, src: '.env.copy' };
    return null;
  };
  const tp = pick('TAKE_PROFIT');
  const sl = pick('STOP_LOSS');
  const bank = pick('PAPER_BANKROLL_SOL');
  const pos = pick('MAX_POSITION_PERCENT');
  return {
    takeProfitPct: tp && tp.v > 0 ? tp.v : 100,
    stopLossPct: sl && sl.v > 0 ? sl.v : 30,
    exitRulesSource: `TP ${tp && tp.v > 0 ? tp.src : 'default +100%'} / SL ${sl && sl.v > 0 ? sl.src : 'default -30%'}`,
    bankrollSol: bank && bank.v > 0 ? bank.v : 1,
    positionPercent: pos && pos.v > 0 ? pos.v : 2.5,
    candleMinutes: CANDLE_MIN,
  };
}

function shortAddress(a: string): string {
  return a && a.length > 9 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '';
}

// ---------------------------------------------------------------- decisions

type Action = 'DRY_RUN_ENTER' | 'SKIP' | 'HOLD' | 'EXIT' | 'LIVE_IGNORED' | 'OTHER';

interface Decision {
  ts: string;
  tsMs: number;
  source: string;
  symbol: string | null;
  mint: string;
  action: Action;
  rawAction: string;
  reason: string;
  maxPositionPercent: number | null;
  handoffLocal: string | null;
}

function normalizeDecision(o: Record<string, unknown>): Decision | null {
  const ts = typeof o.ts === 'string' ? o.ts : null;
  const tsMs = ts ? Date.parse(ts) : NaN;
  const mint = typeof o.mint === 'string' ? o.mint : '';
  if (!ts || !Number.isFinite(tsMs) || !mint) return null;
  let action: Action = 'OTHER';
  let rawAction = '';
  const liveFlag = o.live_trading === true || o.live === true || o.dryRun === false;
  if (typeof o.action === 'string') {
    rawAction = o.action.toUpperCase();
    if (rawAction === 'DRY_RUN_ENTER' || rawAction === 'SKIP' || rawAction === 'HOLD') action = rawAction;
    else if (rawAction === 'EXIT' || rawAction === 'DRY_RUN_EXIT') action = 'EXIT';
  } else if (typeof o.side === 'string') {
    // Legacy bot format: { side: enter|exit|skip, dryRun, live }
    rawAction = o.side.toLowerCase();
    if (rawAction === 'enter') action = liveFlag ? 'LIVE_IGNORED' : 'DRY_RUN_ENTER';
    else if (rawAction === 'exit') action = liveFlag ? 'LIVE_IGNORED' : 'EXIT';
    else if (rawAction === 'skip') action = 'SKIP';
  }
  if (action === 'DRY_RUN_ENTER' && liveFlag) action = 'LIVE_IGNORED';
  return {
    ts,
    tsMs,
    source: typeof o.source === 'string' ? o.source : 'bot',
    symbol: typeof o.symbol === 'string' ? o.symbol : null,
    mint,
    action,
    rawAction,
    reason: typeof o.reason === 'string' ? o.reason : '',
    maxPositionPercent: typeof o.max_position_percent === 'number' ? o.max_position_percent : null,
    handoffLocal: typeof o.handoff_local === 'string' ? o.handoff_local : null,
  };
}

function readAllDecisions(): Decision[] {
  let raw = '';
  try {
    raw = fs.existsSync(DECISIONS_FILE) ? fs.readFileSync(DECISIONS_FILE, 'utf8') : '';
  } catch {
    raw = '';
  }
  const out: Decision[] = [];
  raw.split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    try {
      const d = normalizeDecision(JSON.parse(line));
      if (d) out.push(d);
    } catch {
      /* skip malformed */
    }
  });
  return out.sort((a, b) => a.tsMs - b.tsMs);
}

// ---------------------------------------------------------------- prices

interface DexPair {
  pairAddress: string;
  dexId: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
}
const dexCache = new Map<string, { at: number; pair: DexPair | null }>();
let dexBackoffUntil = 0;
let dexBackoffMs = 30_000;
let lastDexError: string | null = null;

async function refreshDexPrices(mints: string[]): Promise<void> {
  const now = Date.now();
  const stale = mints.filter((m) => {
    const c = dexCache.get(m);
    return !c || now - c.at > DEX_TTL_MS;
  });
  if (!stale.length || now < dexBackoffUntil) return;
  lastDexError = null;
  // One request per mint: the batched endpoint caps the number of pairs returned and
  // silently drops tokens that have few/illiquid pairs.
  for (const mint of stale) {
    if (Date.now() < dexBackoffUntil) break;
    try {
      const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'solana-sniper-dashboard/1.0' },
        timeout: 15_000,
        validateStatus: () => true,
      });
      if (res.status === 429) {
        dexBackoffUntil = Date.now() + dexBackoffMs;
        dexBackoffMs = Math.min(dexBackoffMs * 2, 10 * 60_000);
        lastDexError = 'DexScreener 429 (rate limit) — usando precios en caché';
        break;
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      dexBackoffMs = 30_000;
      const pairs = ((res.data as { pairs?: any[] | null }).pairs || []) as any[];
      let best: DexPair | null = null;
      for (const p of pairs) {
        if (p?.chainId !== 'solana' || p?.baseToken?.address !== mint) continue;
        const price = Number(p.priceUsd);
        const liq = Number(p?.liquidity?.usd ?? 0);
        if (!Number.isFinite(price) || price <= 0) continue;
        if (!best || liq > best.liquidityUsd) {
          best = {
            pairAddress: p.pairAddress,
            dexId: p.dexId,
            symbol: p.baseToken?.symbol || '',
            priceUsd: price,
            liquidityUsd: Number.isFinite(liq) ? liq : 0,
          };
        }
      }
      dexCache.set(mint, { at: Date.now(), pair: best });
    } catch (e) {
      lastDexError = `DexScreener error: ${e instanceof Error ? e.message : String(e)}`;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

const ohlcvCache = new Map<string, { at: number; pool: string | null; candles: Candle[]; error: string | null }>();
let lastGtCall = 0;
let gtBackoffUntil = 0;
let gtBackoffMs = 60_000;

async function gtThrottle(): Promise<void> {
  const wait = lastGtCall + GT_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGtCall = Date.now();
}

function candleFile(mint: string): string {
  return path.join(OHLCV_CACHE_DIR, `${mint.replace(/[^A-Za-z0-9]/g, '')}-${CANDLE_MIN}m.json`);
}

async function getCandles(
  mint: string,
  earliestSec: number,
): Promise<{ candles: Candle[]; pool: string | null; error: string | null }> {
  let cached = ohlcvCache.get(mint);
  if (!cached) {
    // Disk cache survives restarts so we only need to fetch new candles (GeckoTerminal is strict on 429).
    try {
      const disk = JSON.parse(fs.readFileSync(candleFile(mint), 'utf8'));
      if (Array.isArray(disk.candles)) {
        cached = { at: 0, pool: disk.pool || null, candles: disk.candles, error: null };
        ohlcvCache.set(mint, cached);
      }
    } catch {
      /* no disk cache */
    }
  }
  // Failed fetches are retried sooner (60s) than successful ones (5 min).
  if (cached && Date.now() - cached.at < (cached.error ? DEX_TTL_MS : OHLCV_TTL_MS)) return cached;
  if (Date.now() < gtBackoffUntil) {
    const secs = Math.ceil((gtBackoffUntil - Date.now()) / 1000);
    return {
      candles: cached?.candles || [],
      pool: cached?.pool || null,
      error: `GeckoTerminal en pausa por 429 (reintento en ~${secs}s)`,
    };
  }
  let pool = cached?.pool || dexCache.get(mint)?.pair?.pairAddress || null;
  let candles: Candle[] = cached?.candles ? [...cached.candles] : [];
  let error: string | null = null;
  try {
    if (!pool) {
      await gtThrottle();
      pool = (await resolvePool(mint)).pool;
    }
    const covered = candles.length > 0 && candles[0].t <= earliestSec;
    if (covered) {
      // Incremental: only the candles since the last one we have.
      const lastT = candles[candles.length - 1].t;
      const need = Math.min(1000, Math.max(10, Math.ceil((Date.now() / 1000 - lastT) / CANDLE_SEC) + 2));
      await gtThrottle();
      candles = [...candles, ...(await fetchOhlcv(pool, CANDLE_MIN, need, { token: mint }))];
    } else {
      let before: number | undefined;
      const acc: Candle[] = [];
      for (let batch = 0; batch < 3; batch++) {
        await gtThrottle();
        const got = await fetchOhlcv(pool, CANDLE_MIN, 1000, { token: mint, beforeTimestamp: before });
        if (!got.length) break;
        acc.unshift(...got);
        if (got[0].t <= earliestSec - CANDLE_SEC || got.length < 1000) break;
        before = got[0].t;
      }
      candles = [...acc, ...candles];
    }
    const byT = new Map<number, Candle>();
    for (const c of candles) byT.set(c.t, c); // later fetch wins (last candle may have been partial)
    candles = [...byT.values()].sort((a, b) => a.t - b.t);
    try {
      fs.mkdirSync(OHLCV_CACHE_DIR, { recursive: true });
      fs.writeFileSync(candleFile(mint), JSON.stringify({ mint, pool, fetchedAt: new Date().toISOString(), candles }));
    } catch {
      /* non-fatal */
    }
    gtBackoffMs = 60_000;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    if (/HTTP 429/.test(error)) {
      // Stop hammering GeckoTerminal: pause all OHLCV calls, doubling up to 10 min.
      gtBackoffUntil = Date.now() + gtBackoffMs;
      gtBackoffMs = Math.min(gtBackoffMs * 2, 10 * 60_000);
      error = 'GeckoTerminal 429 (rate limit) — reintento automático más tarde';
    }
  }
  const entry = { at: Date.now(), pool, candles, error };
  ohlcvCache.set(mint, entry);
  return entry;
}

function loadApproxCache(): Record<string, { price: number; observedAt: string }> {
  try {
    return JSON.parse(fs.readFileSync(APPROX_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveApproxCache(c: Record<string, { price: number; observedAt: string }>): void {
  try {
    fs.mkdirSync(path.dirname(APPROX_CACHE_FILE), { recursive: true });
    fs.writeFileSync(APPROX_CACHE_FILE, JSON.stringify(c, null, 2));
  } catch {
    /* non-fatal */
  }
}

/** Price near ts (unix sec) from candles: open of the candle containing ts, else nearest close within 2h. */
function priceNear(candles: Candle[], sec: number): { price: number; candleT: number; exact: boolean } | null {
  const containing = candles.find((c) => c.t <= sec && sec < c.t + CANDLE_SEC);
  if (containing) return { price: containing.o, candleT: containing.t, exact: true };
  let best: Candle | null = null;
  for (const c of candles) {
    if (Math.abs(c.t - sec) <= 2 * 3600 && (!best || Math.abs(c.t - sec) < Math.abs(best.t - sec))) best = c;
  }
  return best ? { price: best.c, candleT: best.t, exact: false } : null;
}

// ---------------------------------------------------------------- simulation

interface Position {
  id: number;
  symbol: string;
  mint: string;
  mintShort: string;
  source: string;
  entryTs: string;
  entryPrice: number | null;
  entryApprox: boolean;
  entrySource: string;
  sizeSol: number;
  positionPercent: number;
  tpPrice: number | null;
  slPrice: number | null;
  duplicateEnters: number;
  holds: number;
  currentPrice: number | null;
  liquidityUsd: number | null;
  status: 'open' | 'closed';
  exitTs: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnlPct: number | null;
  pnlSol: number | null;
  notes: string[];
}

export interface PaperSnapshot {
  readOnly: true;
  mode: 'dry-run';
  banner: string;
  disclaimer: string;
  config: PaperConfig;
  open: Position[];
  closed: Position[];
  totals: Record<string, unknown>;
  timeline: Record<string, unknown>[];
  gaps: string[];
  computedAt: string;
  computeMs: number;
}

async function compute(): Promise<PaperSnapshot> {
  const started = Date.now();
  const cfg = readConfig();
  const decisions = readAllDecisions();
  const gaps: string[] = [];
  const mints = [
    ...new Set(decisions.filter((d) => d.action === 'DRY_RUN_ENTER' || d.action === 'EXIT').map((d) => d.mint)),
  ];

  await refreshDexPrices(mints);
  if (lastDexError) gaps.push(lastDexError);

  const earliest = new Map<string, number>();
  for (const d of decisions) {
    if (d.action !== 'DRY_RUN_ENTER') continue;
    const s = Math.floor(d.tsMs / 1000);
    if (!earliest.has(d.mint) || s < (earliest.get(d.mint) as number)) earliest.set(d.mint, s);
  }
  const candleMap = new Map<string, Candle[]>();
  for (const mint of earliest.keys()) {
    const r = await getCandles(mint, earliest.get(mint) as number);
    candleMap.set(mint, r.candles);
    if (r.error) gaps.push(`OHLCV ${shortAddress(mint)}: ${r.error}`);
  }

  const approx = loadApproxCache();
  let approxDirty = false;
  const nowSec = Math.floor(Date.now() / 1000);
  const positions: Position[] = [];
  const openByMint = new Map<string, Position>();
  const timeline: Record<string, unknown>[] = [];

  /** Scan candles after entry (and the live price) for TP/SL. Closes pos if hit before `untilSec`. */
  const evaluateExits = (pos: Position, untilSec: number, useLive: boolean) => {
    if (pos.status !== 'open' || pos.entryPrice == null || pos.tpPrice == null || pos.slPrice == null) return;
    const entrySec = Math.floor(Date.parse(pos.entryTs) / 1000);
    const firstT = Math.floor(entrySec / CANDLE_SEC) * CANDLE_SEC + CANDLE_SEC;
    for (const c of candleMap.get(pos.mint) || []) {
      if (c.t < firstT || c.t >= untilSec) continue;
      // Stop-loss checked first (conservative, same order as helpers/exit-strategy.ts).
      if (c.l <= pos.slPrice) {
        close(pos, c.t, Math.min(c.o, pos.slPrice), 'stop_loss');
        return;
      }
      if (c.h >= pos.tpPrice) {
        close(pos, c.t, Math.max(c.o, pos.tpPrice), 'take_profit');
        return;
      }
    }
    if (useLive && pos.currentPrice != null) {
      if (pos.currentPrice <= pos.slPrice) close(pos, nowSec, pos.currentPrice, 'stop_loss');
      else if (pos.currentPrice >= pos.tpPrice) close(pos, nowSec, pos.currentPrice, 'take_profit');
    }
  };
  const close = (pos: Position, sec: number, price: number, reason: string) => {
    pos.status = 'closed';
    pos.exitTs = new Date(sec * 1000).toISOString();
    pos.exitPrice = price;
    pos.exitReason = reason;
    if (openByMint.get(pos.mint) === pos) openByMint.delete(pos.mint);
  };

  for (const d of decisions) {
    const sec = Math.floor(d.tsMs / 1000);
    const dex = dexCache.get(d.mint)?.pair || null;
    const symbol = d.symbol || dex?.symbol || shortAddress(d.mint);
    let effect = '';
    // Before handling this decision, close any open position of the mint that hit TP/SL earlier.
    const existing = openByMint.get(d.mint);
    if (existing) evaluateExits(existing, sec, false);
    const stillOpen = openByMint.get(d.mint);

    if (d.action === 'DRY_RUN_ENTER') {
      if (stillOpen) {
        stillOpen.duplicateEnters += 1;
        effect = 'ENTER duplicado con posición abierta → HOLD (sin tamaño extra)';
      } else {
        const pct = d.maxPositionPercent ?? cfg.positionPercent;
        const pos: Position = {
          id: positions.length + 1,
          symbol,
          mint: d.mint,
          mintShort: shortAddress(d.mint),
          source: d.source,
          entryTs: d.ts,
          entryPrice: null,
          entryApprox: false,
          entrySource: '',
          sizeSol: (cfg.bankrollSol * pct) / 100,
          positionPercent: pct,
          tpPrice: null,
          slPrice: null,
          duplicateEnters: 0,
          holds: 0,
          currentPrice: dex?.priceUsd ?? null,
          liquidityUsd: dex?.liquidityUsd ?? null,
          status: 'open',
          exitTs: null,
          exitPrice: null,
          exitReason: null,
          pnlPct: null,
          pnlSol: null,
          notes: [],
        };
        const hist = priceNear(candleMap.get(d.mint) || [], sec);
        if (hist) {
          pos.entryPrice = hist.price;
          pos.entrySource = hist.exact
            ? `GeckoTerminal ${CANDLE_MIN}m open`
            : `GeckoTerminal ${CANDLE_MIN}m (vela cercana)`;
          if (!hist.exact) pos.entryApprox = true;
        } else {
          const key = `${d.mint}|${d.ts}`;
          if (!approx[key] && dex?.priceUsd) {
            approx[key] = { price: dex.priceUsd, observedAt: new Date().toISOString() };
            approxDirty = true;
          }
          if (approx[key]) {
            pos.entryPrice = approx[key].price;
            pos.entryApprox = true;
            pos.entrySource = `entry approx: primer precio DexScreener observado ${approx[key].observedAt}`;
          } else {
            pos.entrySource = 'sin precio';
            gaps.push(`${symbol}: sin precio de entrada (ni OHLCV ni DexScreener)`);
          }
        }
        if (pos.entryPrice != null) {
          pos.tpPrice = pos.entryPrice * (1 + cfg.takeProfitPct / 100);
          pos.slPrice = pos.entryPrice * (1 - cfg.stopLossPct / 100);
        }
        positions.push(pos);
        openByMint.set(d.mint, pos);
        effect = pos.entryApprox ? 'Abre posición papel (entry approx)' : 'Abre posición papel';
      }
    } else if (d.action === 'HOLD') {
      if (stillOpen) {
        stillOpen.holds += 1;
        effect = 'HOLD — mantiene posición, sin tamaño extra';
      } else {
        effect = 'HOLD sin posición abierta (ya cerrada por TP/SL o no abierta) — sin efecto';
      }
    } else if (d.action === 'EXIT') {
      if (stillOpen) {
        const hist = priceNear(candleMap.get(d.mint) || [], sec);
        const px = hist?.price ?? stillOpen.currentPrice;
        if (px != null) {
          close(stillOpen, sec, px, `log: ${d.reason || 'exit'}`);
          if (!hist) stillOpen.notes.push('precio de salida aproximado (actual)');
          effect = 'Cierra posición papel (salida registrada en log)';
        } else effect = 'EXIT sin precio disponible';
      } else effect = 'EXIT sin posición abierta — sin efecto';
    } else if (d.action === 'SKIP') {
      effect = 'SKIP — sin posición';
    } else if (d.action === 'LIVE_IGNORED') {
      effect = 'Decisión LIVE — ignorada en papel';
    } else {
      effect = 'Sin efecto en papel';
    }

    timeline.push({
      ts: d.ts,
      handoffLocal: d.handoffLocal,
      source: d.source,
      symbol,
      mint: d.mint,
      mintShort: shortAddress(d.mint),
      action: d.action,
      rawAction: d.rawAction,
      reason: d.reason,
      effect,
    });
  }
  if (approxDirty) saveApproxCache(approx);

  // Final pass: exits up to now (candles + live price), then PnL.
  for (const p of positions) {
    evaluateExits(p, nowSec + CANDLE_SEC, true);
    const ref = p.status === 'closed' ? p.exitPrice : p.currentPrice;
    if (p.entryPrice != null && ref != null && p.entryPrice > 0) {
      p.pnlPct = (ref / p.entryPrice - 1) * 100;
      p.pnlSol = (p.sizeSol * p.pnlPct) / 100;
    } else if (p.status === 'open' && p.currentPrice == null) {
      gaps.push(`${p.symbol}: precio actual no disponible en DexScreener`);
    }
    if (p.liquidityUsd != null && p.liquidityUsd < 5_000 && p.status === 'open') {
      p.notes.push(`liquidez muy baja (~$${Math.round(p.liquidityUsd)}) — salida real podría no ser posible`);
    }
  }

  const open = positions.filter((p) => p.status === 'open');
  const closed = positions.filter((p) => p.status === 'closed');
  const sum = (xs: Position[]) => xs.reduce((a, p) => a + (p.pnlSol ?? 0), 0);
  const wins = closed.filter((p) => (p.pnlPct ?? 0) > 0).length;
  const openUp = open.filter((p) => (p.pnlPct ?? 0) > 0).length;
  const priced = positions.filter((p) => p.pnlPct != null);
  const realized = sum(closed);
  const unrealized = sum(open);
  const skipReasons = decisions
    .filter((d) => d.action === 'SKIP')
    .map((d) => ({
      ts: d.ts,
      symbol: d.symbol || shortAddress(d.mint),
      mintShort: shortAddress(d.mint),
      reason: d.reason,
    }));

  const totals = {
    trades: positions.length,
    openCount: open.length,
    closedCount: closed.length,
    wins,
    losses: closed.length - wins,
    winRateClosed: closed.length ? (wins / closed.length) * 100 : null,
    winRateAllMarked: priced.length ? ((wins + openUp) / priced.length) * 100 : null,
    realizedSol: realized,
    unrealizedSol: unrealized,
    totalSol: realized + unrealized,
    totalPctBankroll: ((realized + unrealized) / cfg.bankrollSol) * 100,
    deployedSol: open.reduce((a, p) => a + p.sizeSol, 0),
    avgPnlPct: priced.length ? priced.reduce((a, p) => a + (p.pnlPct as number), 0) / priced.length : null,
    skips: skipReasons.length,
    skipReasons,
    holds: decisions.filter((d) => d.action === 'HOLD').length,
    duplicateEnters: positions.reduce((a, p) => a + p.duplicateEnters, 0),
    decisions: decisions.length,
  };

  return {
    readOnly: true,
    mode: 'dry-run',
    banner: 'DRY-RUN / papel — sin dinero real',
    disclaimer:
      'Rendimiento simulado en papel. Rentabilidades pasadas no garantizan resultados futuros. ' +
      'No incluye slippage, comisiones, MEV, fallos de red ni la liquidez real para salir.',
    config: cfg,
    open,
    closed,
    totals,
    timeline: timeline.reverse(),
    gaps: [...new Set(gaps)],
    computedAt: new Date().toISOString(),
    computeMs: Date.now() - started,
  };
}

let snapshot: PaperSnapshot | null = null;
let inflight: Promise<PaperSnapshot> | null = null;

/** Returns a cached snapshot (refreshed at most every ~60s). */
export async function getPaperSnapshot(): Promise<PaperSnapshot> {
  const fresh = snapshot && Date.now() - Date.parse(snapshot.computedAt) < SNAPSHOT_TTL_MS;
  if (fresh) return snapshot as PaperSnapshot;
  if (!inflight) {
    inflight = compute()
      .then((s) => (snapshot = s))
      .finally(() => {
        inflight = null;
      });
  }
  // Serve stale data immediately while refreshing, if we have any.
  return snapshot ?? inflight;
}
