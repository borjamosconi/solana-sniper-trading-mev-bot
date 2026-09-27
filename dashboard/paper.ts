/**
 * Paper (dry-run) performance tracker for the READ-ONLY dashboard.
 *
 * - Reads logs/decisions.jsonl (promesa_handoff format + legacy bot format).
 * - Every DRY_RUN_ENTER opens a paper position; a duplicate ENTER for a mint that is
 *   still open adds NO size (treated as HOLD).
 * - Entry price: OHLCV near the decision ts from ./price-sources (GeckoTerminal → CoinGecko
 *   on-chain / Birdeye if keyed → local imports); last resort = first observed DexScreener
 *   price, flagged "entry approx".
 * - Current price: DexScreener (batched, cached ~60s, backs off on 429).
 * - Exit rules: TAKE_PROFIT / STOP_LOSS (%) like the bot, scanned over candles after entry.
 *
 * Never sends transactions, never reads PRIVATE_KEY / Telegram token (only whitelisted
 * numeric keys are parsed from env files). Only writes price caches under .bot-state/ (gitignored).
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { Candle, CANDLE_MIN, cleanTimeline, getCandles, priceNear, priceSourcesStatus } from './price-sources';

const ROOT = process.cwd();
const DECISIONS_FILE = path.join(ROOT, 'logs', 'decisions.jsonl');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_DEFAULTS_FILE = path.join(ROOT, '.env.copy');
const APPROX_CACHE_FILE = path.join(ROOT, '.bot-state', 'paper-entry-approx.json');
const KILL_SWITCH_FILE = path.join(ROOT, '.bot-state', 'daily-loss.json');

const DEX_TTL_MS = 60_000;
const SNAPSHOT_TTL_MS = 60_000;

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
  change1h: number | null;
  change24h: number | null;
  volume24h: number | null;
}
const dexCache = new Map<string, { at: number; pair: DexPair | null }>();
let dexBackoffUntil = 0;
let dexBackoffMs = 30_000;
let lastDexError: string | null = null;

const DEX_CACHE_FILE = path.join(ROOT, '.bot-state', 'paper-dex-cache.json');
let dexDiskLoaded = false;

async function refreshDexPrices(mints: string[]): Promise<void> {
  if (!dexDiskLoaded) {
    // Last known prices survive restarts (used only until a fresh DexScreener answer arrives).
    dexDiskLoaded = true;
    try {
      const d = JSON.parse(fs.readFileSync(DEX_CACHE_FILE, 'utf8')) as Record<
        string,
        { at: number; pair: DexPair | null }
      >;
      for (const [m, v] of Object.entries(d)) if (!dexCache.has(m)) dexCache.set(m, v);
    } catch {
      /* no disk cache */
    }
  }
  try {
    await refreshDexPricesInner(mints);
  } finally {
    try {
      fs.mkdirSync(path.dirname(DEX_CACHE_FILE), { recursive: true });
      fs.writeFileSync(DEX_CACHE_FILE, JSON.stringify(Object.fromEntries(dexCache)));
    } catch {
      /* non-fatal */
    }
  }
}

async function refreshDexPricesInner(mints: string[]): Promise<void> {
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
            change1h: Number.isFinite(Number(p?.priceChange?.h1)) ? Number(p.priceChange.h1) : null,
            change24h: Number.isFinite(Number(p?.priceChange?.h24)) ? Number(p.priceChange.h24) : null,
            volume24h: Number.isFinite(Number(p?.volume?.h24)) ? Number(p.volume.h24) : null,
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

// ---------------------------------------------------------------- live/paper status

/** LIVE_TRADING / DRY_RUN as booleans only (process.env → .env → .env.copy). Nothing else is read. */
function readBoolFlag(name: 'LIVE_TRADING' | 'DRY_RUN'): { value: boolean | null; source: string } {
  const pe = process.env[name];
  if (pe === 'true' || pe === 'false') return { value: pe === 'true', source: 'process.env' };
  for (const [file, label] of [
    [ENV_FILE, '.env'],
    [ENV_DEFAULTS_FILE, '.env.copy'],
  ] as const) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith(`${name}=`)) continue;
        const v = t
          .slice(name.length + 1)
          .trim()
          .replace(/^['"]|['"]$/g, '')
          .toLowerCase();
        if (v === 'true' || v === 'false') return { value: v === 'true', source: label };
      }
    } catch {
      /* ignore */
    }
  }
  return { value: null, source: 'desconocido' };
}

function readLiveStatus() {
  const live = readBoolFlag('LIVE_TRADING');
  const dry = readBoolFlag('DRY_RUN');
  let killSwitch: Record<string, unknown> = { present: false, tripped: false };
  try {
    if (fs.existsSync(KILL_SWITCH_FILE)) {
      const k = JSON.parse(fs.readFileSync(KILL_SWITCH_FILE, 'utf8'));
      let lossPercent: number | null = null;
      try {
        const start = BigInt(k.startingCapitalRaw || '0');
        const pnl = BigInt(k.realizedPnlRaw || '0');
        if (start > 0n) lossPercent = pnl < 0n ? Number((-pnl * 10000n) / start) / 100 : 0;
      } catch {
        lossPercent = null;
      }
      killSwitch = {
        present: true,
        tripped: !!k.tripped,
        tripReason: typeof k.tripReason === 'string' ? k.tripReason : null,
        trippedAt: typeof k.trippedAt === 'number' ? new Date(k.trippedAt).toISOString() : null,
        windowStartedAt: typeof k.windowStartedAt === 'number' ? new Date(k.windowStartedAt).toISOString() : null,
        maxDailyLossPercent: typeof k.maxDailyLossPercent === 'number' ? k.maxDailyLossPercent : null,
        lossPercent,
      };
    }
  } catch {
    killSwitch = { present: false, tripped: false, error: 'estado ilegible' };
  }
  // Bot semantics: anything other than LIVE_TRADING=true means dry-run.
  const effectiveMode = live.value === true && dry.value !== true ? 'LIVE' : 'DRY-RUN';
  return { liveTrading: live.value, liveTradingSource: live.source, dryRun: dry.value, effectiveMode, killSwitch };
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
  priceSources: string[];
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
  maxUpPct: number | null;
  maxDownPct: number | null;
  notes: string[];
  chart: [number, number][]; // [unix sec, close] downsampled, for line charts
  candles: [number, number, number, number, number][]; // [t,o,h,l,c] last candles since entry (bar sparkline)
  change1h: number | null;
  change24h: number | null;
  volume24h: number | null;
  slTpPosition: number | null; // 0 = at SL, 1 = at TP (current/exit price)
  priceAt: string | null; // when the DexScreener price was fetched
}

export interface PaperSnapshot {
  readOnly: true;
  mode: 'dry-run';
  banner: string;
  disclaimer: string;
  config: PaperConfig;
  status: ReturnType<typeof readLiveStatus>;
  pipeline: Record<string, Record<string, unknown>>;
  priceSources: Record<string, boolean | string>;
  open: Position[];
  closed: Position[];
  totals: Record<string, unknown>;
  equity: { t: number; pnlSol: number }[];
  timeline: Record<string, unknown>[];
  sources: string[];
  gaps: string[];
  computedAt: string;
  computeMs: number;
}

function downsample(points: [number, number][], max: number): [number, number][] {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out: [number, number][] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out[out.length - 1] = points[points.length - 1];
  return out;
}

/** Last close at or before `sec` from a sorted clean timeline. */
function closeAt(tl: Candle[], sec: number): number | null {
  let lo = 0;
  let hi = tl.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tl[mid].t + tl[mid].i <= sec) {
      ans = tl[mid].c;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export async function computePaperSnapshot(): Promise<PaperSnapshot> {
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
  const candleMap = new Map<string, Candle[]>(); // all candles (mixed intervals)
  const timelineMap = new Map<string, Candle[]>(); // clean, non-overlapping
  const sourceMap = new Map<string, string[]>();
  const allSources = new Set<string>();
  const staleMints: string[] = [];
  for (const mint of earliest.keys()) {
    const r = await getCandles(mint, earliest.get(mint) as number, dexCache.get(mint)?.pair?.pairAddress || null);
    candleMap.set(mint, r.candles);
    timelineMap.set(mint, cleanTimeline(r.candles));
    sourceMap.set(mint, r.sources);
    r.sources.forEach((s) => allSources.add(s));
    const covered = r.candles.length > 0 && r.candles[0].t <= (earliest.get(mint) as number);
    if (r.errors.length && covered) staleMints.push(mint);
    else for (const e of r.errors) gaps.push(`OHLCV ${shortAddress(mint)}: ${e}`);
  }

  if (staleMints.length) {
    gaps.push(
      `OHLCV remoto no disponible ahora (429/sin clave) para ${staleMints.length} token(s): se usan velas en caché/importadas; los precios actuales siguen viniendo de DexScreener`,
    );
  }
  const approx = loadApproxCache();
  let approxDirty = false;
  const nowSec = Math.floor(Date.now() / 1000);
  const positions: Position[] = [];
  const openByMint = new Map<string, Position>();
  const entryCandleEnd = new Map<number, number>();
  const timeline: Record<string, unknown>[] = [];

  const close = (pos: Position, sec: number, price: number, reason: string) => {
    pos.status = 'closed';
    pos.exitTs = new Date(sec * 1000).toISOString();
    pos.exitPrice = price;
    pos.exitReason = reason;
    if (openByMint.get(pos.mint) === pos) openByMint.delete(pos.mint);
  };

  /** Scan candles after the entry candle (and optionally the live price) for TP/SL before `untilSec`. */
  const evaluateExits = (pos: Position, untilSec: number, useLive: boolean) => {
    if (pos.status !== 'open' || pos.entryPrice == null || pos.tpPrice == null || pos.slPrice == null) return;
    const firstT = entryCandleEnd.get(pos.id) ?? Math.floor(Date.parse(pos.entryTs) / 1000);
    let prevEnd = firstT;
    for (const c of timelineMap.get(pos.mint) || []) {
      if (c.t < firstT || c.t >= untilSec) continue;
      // Unobserved gap before this candle: price may have crossed a level inside the gap.
      // Conservative fills: TP at the TP level (not a higher gap open), SL at the (lower) open.
      const gapped = c.t > prevEnd;
      prevEnd = c.t + c.i;
      // Stop-loss first (conservative; same order as helpers/exit-strategy.ts).
      if (c.l <= pos.slPrice) return close(pos, c.t, Math.min(c.o, pos.slPrice), 'stop_loss');
      if (c.h >= pos.tpPrice) return close(pos, c.t, gapped ? pos.tpPrice : Math.max(c.o, pos.tpPrice), 'take_profit');
    }
    if (useLive && pos.currentPrice != null) {
      if (pos.currentPrice <= pos.slPrice) close(pos, nowSec, pos.currentPrice, 'stop_loss');
      else if (pos.currentPrice >= pos.tpPrice) close(pos, nowSec, pos.currentPrice, 'take_profit');
    }
  };

  for (const d of decisions) {
    const sec = Math.floor(d.tsMs / 1000);
    const dex = dexCache.get(d.mint)?.pair || null;
    const symbol = d.symbol || dex?.symbol || shortAddress(d.mint);
    let effect = '';
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
          priceSources: sourceMap.get(d.mint) || [],
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
          maxUpPct: null,
          maxDownPct: null,
          notes: [],
          chart: [],
          candles: [],
          change1h: dex?.change1h ?? null,
          change24h: dex?.change24h ?? null,
          volume24h: dex?.volume24h ?? null,
          slTpPosition: null,
          priceAt: dexCache.get(d.mint)?.at ? new Date(dexCache.get(d.mint)!.at).toISOString() : null,
        };
        const hist = priceNear(candleMap.get(d.mint) || [], sec);
        if (hist) {
          pos.entryPrice = hist.price;
          const mins = Math.round(hist.candle.i / 60);
          pos.entrySource = hist.exact ? `OHLCV ${mins}m (apertura de la vela)` : `OHLCV ${mins}m (vela cercana)`;
          if (!hist.exact) pos.entryApprox = true;
          if (hist.candle.i > 3600) {
            // Only a coarse (e.g. 4h) candle covers the entry → its open can be far from the real fill.
            pos.entryApprox = true;
            pos.entrySource += ' — aprox. (vela gruesa)';
          }
          entryCandleEnd.set(pos.id, hist.candle.t + hist.candle.i);
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
      } else effect = 'HOLD sin posición abierta (ya cerrada por TP/SL o no abierta) — sin efecto';
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
    } else if (d.action === 'SKIP') effect = 'SKIP — sin posición';
    else if (d.action === 'LIVE_IGNORED') effect = 'Decisión LIVE — ignorada en papel';
    else effect = 'Sin efecto en papel';

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

  // Final pass: exits up to now (candles + live price), PnL, excursions and chart series.
  for (const p of positions) {
    evaluateExits(p, nowSec + 86_400, true);
    const ref = p.status === 'closed' ? p.exitPrice : p.currentPrice;
    if (p.entryPrice != null && ref != null && p.entryPrice > 0) {
      p.pnlPct = (ref / p.entryPrice - 1) * 100;
      p.pnlSol = (p.sizeSol * p.pnlPct) / 100;
    } else if (p.status === 'open' && p.currentPrice == null) {
      gaps.push(`${p.symbol}: precio actual no disponible en DexScreener`);
    }
    if (p.entryApprox) gaps.push(`${p.symbol}: precio de entrada aproximado (${p.entrySource})`);
    if (p.liquidityUsd != null && p.liquidityUsd < 5_000 && p.status === 'open') {
      p.notes.push(`liquidez muy baja (~$${Math.round(p.liquidityUsd)}) — salida real podría no ser posible`);
    }
    const tl = timelineMap.get(p.mint) || [];
    const entrySec = Math.floor(Date.parse(p.entryTs) / 1000);
    const endSec = p.exitTs ? Math.floor(Date.parse(p.exitTs) / 1000) : nowSec;
    const pts: [number, number][] = tl
      .filter((c) => c.t >= entrySec - 6 * 3600 && c.t <= Math.min(nowSec, endSec + 12 * 3600))
      .map((c) => [c.t + c.i, c.c]);
    if (p.status === 'open' && p.currentPrice != null) pts.push([nowSec, p.currentPrice]);
    p.chart = downsample(pts, 160);
    p.candles = tl
      .filter((c) => c.t + c.i > entrySec - 3600 && c.t <= endSec)
      .slice(-28)
      .map((c) => [c.t, c.o, c.h, c.l, c.c]);
    const ref2 = p.status === 'closed' ? p.exitPrice : p.currentPrice;
    if (ref2 != null && p.tpPrice != null && p.slPrice != null && p.tpPrice > p.slPrice) {
      p.slTpPosition = Math.max(0, Math.min(1, (ref2 - p.slPrice) / (p.tpPrice - p.slPrice)));
    }
    if (p.entryPrice) {
      const held = tl.filter((c) => c.t >= entrySec && c.t < endSec);
      if (held.length) {
        p.maxUpPct = (Math.max(...held.map((c) => c.h)) / p.entryPrice - 1) * 100;
        p.maxDownPct = (Math.min(...held.map((c) => c.l)) / p.entryPrice - 1) * 100;
      }
    }
  }

  // Equity curve: realized + mark-to-market (last candle close) PnL in SOL on an hourly grid.
  const priced = positions.filter((p) => p.entryPrice != null && !p.entryApprox && p.pnlSol != null);
  const equity: { t: number; pnlSol: number }[] = [];
  if (priced.length) {
    const first = Math.min(...priced.map((p) => Math.floor(Date.parse(p.entryTs) / 1000)));
    const grid: number[] = [];
    for (let t = Math.floor(first / 3600) * 3600; t < nowSec; t += 3600) grid.push(t);
    for (const p of priced) {
      grid.push(Math.floor(Date.parse(p.entryTs) / 1000));
      if (p.exitTs) grid.push(Math.floor(Date.parse(p.exitTs) / 1000));
    }
    grid.push(nowSec);
    const times = [...new Set(grid)].filter((t) => t >= first).sort((a, b) => a - b);
    for (const t of times) {
      let v = 0;
      for (const p of priced) {
        const e = Math.floor(Date.parse(p.entryTs) / 1000);
        if (t < e) continue;
        const x = p.exitTs ? Math.floor(Date.parse(p.exitTs) / 1000) : null;
        if (x != null && t >= x) v += p.pnlSol as number;
        else if (t >= nowSec) v += p.pnlSol as number;
        else {
          const c = closeAt(timelineMap.get(p.mint) || [], t);
          if (c != null && !p.entryApprox) v += p.sizeSol * (c / (p.entryPrice as number) - 1);
        }
      }
      equity.push({ t, pnlSol: v });
    }
  }
  let peak = 0;
  let maxDd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.pnlSol);
    maxDd = Math.max(maxDd, peak - e.pnlSol);
  }

  // KPIs only use positions with a real (OHLCV) entry; approximated entries are shown but excluded.
  const reliable = positions.filter((p) => p.entryPrice != null && !p.entryApprox);
  const excluded = positions.filter((p) => !(p.entryPrice != null && !p.entryApprox));
  const open = reliable.filter((p) => p.status === 'open');
  const closed = reliable.filter((p) => p.status === 'closed');
  const sum = (xs: Position[]) => xs.reduce((a, p) => a + (p.pnlSol ?? 0), 0);
  const winsL = closed.filter((p) => (p.pnlSol ?? 0) > 0);
  const lossesL = closed.filter((p) => (p.pnlSol ?? 0) <= 0);
  const grossWin = winsL.reduce((a, p) => a + (p.pnlSol as number), 0);
  const grossLoss = -lossesL.reduce((a, p) => a + (p.pnlSol ?? 0), 0);
  const openUp = open.filter((p) => (p.pnlPct ?? 0) > 0).length;
  const withPnl = reliable.filter((p) => p.pnlPct != null);
  const best = withPnl.reduce<Position | null>(
    (b, p) => (!b || (p.pnlPct as number) > (b.pnlPct as number) ? p : b),
    null,
  );
  const worst = withPnl.reduce<Position | null>(
    (b, p) => (!b || (p.pnlPct as number) < (b.pnlPct as number) ? p : b),
    null,
  );
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
    trades: reliable.length,
    excludedApprox: excluded.map((p) => ({ symbol: p.symbol, status: p.status, reason: p.entrySource })),
    openCount: open.length,
    closedCount: closed.length,
    wins: winsL.length,
    losses: lossesL.length,
    winRateClosed: closed.length ? (winsL.length / closed.length) * 100 : null,
    winRateAllMarked: withPnl.length ? ((winsL.length + openUp) / withPnl.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    profitFactorInfinite: grossLoss === 0 && grossWin > 0,
    avgWinPct: winsL.length ? winsL.reduce((a, p) => a + (p.pnlPct as number), 0) / winsL.length : null,
    avgLossPct: lossesL.length ? lossesL.reduce((a, p) => a + (p.pnlPct ?? 0), 0) / lossesL.length : null,
    maxDrawdownSol: maxDd,
    maxDrawdownPctBankroll: (maxDd / cfg.bankrollSol) * 100,
    best: best ? { symbol: best.symbol, pnlPct: best.pnlPct, pnlSol: best.pnlSol, status: best.status } : null,
    worst: worst ? { symbol: worst.symbol, pnlPct: worst.pnlPct, pnlSol: worst.pnlSol, status: worst.status } : null,
    realizedSol: realized,
    unrealizedSol: unrealized,
    totalSol: realized + unrealized,
    totalPctBankroll: ((realized + unrealized) / cfg.bankrollSol) * 100,
    deployedSol: open.reduce((a, p) => a + p.sizeSol, 0),
    avgPnlPct: withPnl.length ? withPnl.reduce((a, p) => a + (p.pnlPct as number), 0) / withPnl.length : null,
    approxEntries: excluded.length,
    realEntries: reliable.length,
    allPositions: positions.length,
    skips: skipReasons.length,
    skipReasons,
    holds: decisions.filter((d) => d.action === 'HOLD').length,
    duplicateEnters: positions.reduce((a, p) => a + p.duplicateEnters, 0),
    decisions: decisions.length,
  };

  // Pipeline actor counts for the control-room diagram (all derived from the decisions log).
  const promesa = decisions.filter((d) => d.source === 'promesa_handoff');
  const botSrc = decisions.filter((d) => d.source !== 'promesa_handoff');
  let kolscanWallets = 0;
  try {
    const k = JSON.parse(fs.readFileSync(path.join(ROOT, 'kolscan-top10-monthly.json'), 'utf8'));
    kolscanWallets = Array.isArray(k.wallets) ? k.wallets.length : 0;
  } catch {
    kolscanWallets = 0;
  }
  const liveStatus = readLiveStatus();
  const pipeline = {
    promesa: {
      handoffs: new Set(promesa.map((d) => d.ts)).size,
      decisions: promesa.length,
      enters: promesa.filter((d) => d.action === 'DRY_RUN_ENTER').length,
      skips: promesa.filter((d) => d.action === 'SKIP').length,
      holds: promesa.filter((d) => d.action === 'HOLD').length,
      lastHandoff: promesa.length ? promesa[promesa.length - 1].ts : null,
    },
    kolscan: {
      wallets: kolscanWallets,
      signals: botSrc.filter((d) => /copy-trade/i.test(d.reason)).length,
      botDecisions: botSrc.length,
    },
    filters: {
      skips: decisions.filter((d) => d.action === 'SKIP').length,
      passed: decisions.filter((d) => d.action === 'DRY_RUN_ENTER').length,
      duplicatesBlocked: positions.reduce((a, p) => a + p.duplicateEnters, 0),
    },
    risk: {
      killSwitchTripped: !!liveStatus.killSwitch.tripped,
      killSwitchPresent: !!liveStatus.killSwitch.present,
      stopLosses: closed.filter((p) => p.exitReason === 'stop_loss').length,
      takeProfits: closed.filter((p) => p.exitReason === 'take_profit').length,
      maxPositionPercent: cfg.positionPercent,
    },
    executor: {
      mode: liveStatus.effectiveMode,
      paperFills: positions.length + positions.filter((p) => p.status === 'closed').length,
      paperEntries: positions.length,
      paperExits: positions.filter((p) => p.status === 'closed').length,
    },
  };

  return {
    readOnly: true,
    mode: 'dry-run',
    pipeline,
    banner: 'DRY-RUN / papel — sin dinero real',
    disclaimer:
      'Rendimiento simulado en papel. Rentabilidades pasadas no garantizan resultados futuros. ' +
      'No incluye slippage, comisiones, MEV, fallos de red ni la liquidez real para salir.',
    config: cfg,
    status: liveStatus,
    priceSources: priceSourcesStatus(),
    open: positions.filter((p) => p.status === 'open'),
    closed: positions.filter((p) => p.status === 'closed'),
    totals,
    equity,
    timeline: timeline.reverse(),
    sources: [...allSources],
    gaps: [...new Set(gaps)],
    computedAt: new Date().toISOString(),
    computeMs: Date.now() - started,
  };
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

let snapshot: PaperSnapshot | null = null;
let inflight: Promise<PaperSnapshot> | null = null;

/** Returns a cached snapshot (refreshed at most every ~60s; stale data served while refreshing). */
export async function getPaperSnapshot(): Promise<PaperSnapshot> {
  const fresh = snapshot && Date.now() - Date.parse(snapshot.computedAt) < SNAPSHOT_TTL_MS;
  if (fresh) return snapshot as PaperSnapshot;
  if (!inflight) {
    inflight = computePaperSnapshot()
      .then((s) => (snapshot = s))
      .finally(() => {
        inflight = null;
      });
  }
  return snapshot ?? inflight;
}
