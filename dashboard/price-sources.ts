/**
 * Historical price (OHLCV) sources for the paper dashboard — READ-ONLY, public market data.
 *
 * Order tried per mint (first one that returns candles wins; results are merged + cached on disk):
 *   1. Local imports: backtest/data/<mint>-<N>m.jsonl (from `npm run backtest:fetch`) and
 *      .bot-state/paper-ohlcv-import/<mint>.json  ({ source, candles: [{t,o,h,l,c,v,i}] }).
 *   2. GeckoTerminal (keyless) — best DexScreener pool, then GeckoTerminal's own top pool for the token.
 *   3. CoinGecko on-chain API (same data as GeckoTerminal, separate quota) — only if COINGECKO_API_KEY
 *      is set (demo key; COINGECKO_API_PLAN=pro for a paid key).
 *   4. Birdeye /defi/ohlcv — only if BIRDEYE_API_KEY is set.
 *
 * API keys are read from process.env or .env (whitelisted names only), used solely as request
 * headers and NEVER returned by any endpoint or written to disk. Axiom has no documented public
 * price API, so it is intentionally not supported.
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fetchOhlcv, resolvePool } from '../backtest/fetch_ohlcv';

export interface Candle {
  t: number; // unix seconds (candle start)
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
  i: number; // interval seconds
}

export interface CandleResult {
  candles: Candle[];
  pool: string | null;
  sources: string[];
  errors: string[];
}

const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, '.env');
const CACHE_DIR = path.join(ROOT, '.bot-state', 'paper-ohlcv');
const IMPORT_DIR = path.join(ROOT, '.bot-state', 'paper-ohlcv-import');
const BACKTEST_DATA_DIR = path.join(ROOT, 'backtest', 'data');

export const CANDLE_MIN = 15;
const CANDLE_SEC = CANDLE_MIN * 60;
const OK_TTL_MS = 5 * 60_000;
const ERR_TTL_MS = 60_000;
const GT_SPACING_MS = 6_000;

const KEY_NAMES = ['COINGECKO_API_KEY', 'COINGECKO_API_PLAN', 'BIRDEYE_API_KEY'] as const;
type KeyName = (typeof KEY_NAMES)[number];

/** Read ONLY the whitelisted price-API variables. Values never leave this module. */
function readKey(name: KeyName): string | null {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    if (!fs.existsSync(ENV_FILE)) return null;
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith(`${name}=`)) continue;
      const v = t
        .slice(name.length + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      return v || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function priceSourcesStatus(): Record<string, boolean | string> {
  return {
    geckoterminal: true,
    coingeckoKeyConfigured: !!readKey('COINGECKO_API_KEY'),
    birdeyeKeyConfigured: !!readKey('BIRDEYE_API_KEY'),
    localImports: true,
    axiom: 'no soportado (sin API pública documentada)',
  };
}

// ------------------------------------------------------------------ helpers

function safeName(mint: string): string {
  return mint.replace(/[^A-Za-z0-9]/g, '');
}

function mergeCandles(...lists: Candle[][]): Candle[] {
  const m = new Map<string, Candle>();
  for (const list of lists) for (const c of list) m.set(`${c.t}|${c.i}`, c); // later lists win
  return [...m.values()].sort((a, b) => a.t - b.t || a.i - b.i);
}

function valid(c: Partial<Candle>): c is Candle {
  return (
    [c.t, c.o, c.h, c.l, c.c, c.i].every((x) => typeof x === 'number' && Number.isFinite(x)) && (c.c as number) > 0
  );
}

function readImports(mint: string): { candles: Candle[]; sources: string[] } {
  const out: Candle[] = [];
  const sources: string[] = [];
  // 1a. JSON imports
  try {
    const f = path.join(IMPORT_DIR, `${safeName(mint)}.json`);
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const cs = (d.candles || []).filter(valid);
      if (cs.length) {
        out.push(...cs);
        sources.push(`import:${d.source || 'manual'}`);
      }
    }
  } catch {
    /* ignore */
  }
  // 1b. backtest/data/<mint>-<N>m.jsonl written by backtest/fetch_ohlcv.ts
  try {
    if (fs.existsSync(BACKTEST_DATA_DIR)) {
      for (const name of fs.readdirSync(BACKTEST_DATA_DIR)) {
        const m = name.match(/^(.+)-(\d+)m\.jsonl$/);
        if (!m || m[1] !== mint) continue;
        const i = Number(m[2]) * 60;
        const cs: Candle[] = [];
        for (const line of fs.readFileSync(path.join(BACKTEST_DATA_DIR, name), 'utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            if (r.type === 'candle') {
              const c = { t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, i };
              if (valid(c)) cs.push(c);
            }
          } catch {
            /* skip */
          }
        }
        if (cs.length) {
          out.push(...cs);
          sources.push(`backtest/data (${m[2]}m)`);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { candles: out, sources };
}

// ------------------------------------------------------------------ remote sources

let lastGtCall = 0;
let gtBackoffUntil = 0;
let gtBackoffMs = 60_000;

async function gtThrottle(): Promise<void> {
  const wait = lastGtCall + GT_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGtCall = Date.now();
}

function toCandles(list: { t: number; o: number; h: number; l: number; c: number; v?: number }[], i: number): Candle[] {
  return list.map((c) => ({ ...c, i })).filter(valid);
}

async function fromGeckoTerminal(mint: string, pool: string | null, earliestSec: number, sinceSec: number | null) {
  if (Date.now() < gtBackoffUntil) throw new Error('GeckoTerminal en pausa por 429');
  const pools: string[] = [];
  if (pool) pools.push(pool);
  const errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let p = pools[attempt];
    try {
      if (!p) {
        // Pool address → token-resolved pool (GeckoTerminal's own top pool for the mint)
        await gtThrottle();
        p = (await resolvePool(mint)).pool;
        if (pools.includes(p)) break;
        pools.push(p);
      }
      const candles = await fetchRange(
        async (limit, before) => {
          await gtThrottle();
          return toCandles(
            await fetchOhlcv(p as string, CANDLE_MIN, limit, { token: mint, beforeTimestamp: before }),
            CANDLE_SEC,
          );
        },
        earliestSec,
        sinceSec,
      );
      gtBackoffMs = 60_000;
      if (candles.length) return { candles, pool: p as string };
      errors.push(`sin velas en pool ${p.slice(0, 6)}…`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/429/.test(msg)) {
        gtBackoffUntil = Date.now() + gtBackoffMs;
        gtBackoffMs = Math.min(gtBackoffMs * 2, 10 * 60_000);
        throw new Error('GeckoTerminal 429 (rate limit)');
      }
      errors.push(msg);
    }
  }
  throw new Error(`GeckoTerminal: ${errors.join('; ') || 'sin datos'}`);
}

/** Fetch newest→older in pages of up to 1000 until `earliestSec` is covered, or just since `sinceSec`. */
async function fetchRange(
  page: (limit: number, before?: number) => Promise<Candle[]>,
  earliestSec: number,
  sinceSec: number | null,
): Promise<Candle[]> {
  if (sinceSec) {
    const need = Math.min(1000, Math.max(10, Math.ceil((Date.now() / 1000 - sinceSec) / CANDLE_SEC) + 2));
    return page(need);
  }
  let acc: Candle[] = [];
  let before: number | undefined;
  for (let batch = 0; batch < 3; batch++) {
    const got = (await page(1000, before)).sort((a, b) => a.t - b.t);
    if (!got.length) break;
    acc = [...got, ...acc];
    if (got[0].t <= earliestSec - CANDLE_SEC || got.length < 1000) break;
    before = got[0].t;
  }
  return acc;
}

async function fromCoinGecko(mint: string, pool: string | null, earliestSec: number, sinceSec: number | null) {
  const key = readKey('COINGECKO_API_KEY');
  if (!key) throw new Error('COINGECKO_API_KEY no configurada');
  if (!pool) throw new Error('sin pool');
  const pro = (readKey('COINGECKO_API_PLAN') || '').toLowerCase() === 'pro';
  const base = pro ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  const header = pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';
  const candles = await fetchRange(
    async (limit, before) => {
      let url = `${base}/onchain/networks/solana/pools/${pool}/ohlcv/minute?aggregate=${CANDLE_MIN}&limit=${limit}&currency=usd&token=${mint}`;
      if (before) url += `&before_timestamp=${before}`;
      const res = await axios.get(url, {
        headers: { [header]: key, Accept: 'application/json' },
        timeout: 15_000,
        validateStatus: () => true,
      });
      if (res.status !== 200) throw new Error(`CoinGecko HTTP ${res.status}`);
      const list: number[][] = res.data?.data?.attributes?.ohlcv_list || [];
      return list.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], i: CANDLE_SEC })).filter(valid);
    },
    earliestSec,
    sinceSec,
  );
  return { candles, pool };
}

async function fromBirdeye(mint: string, earliestSec: number, sinceSec: number | null) {
  const key = readKey('BIRDEYE_API_KEY');
  if (!key) throw new Error('BIRDEYE_API_KEY no configurada');
  const from = sinceSec ?? earliestSec - 2 * 3600;
  const to = Math.floor(Date.now() / 1000);
  const url = `https://public-api.birdeye.so/defi/ohlcv?address=${mint}&type=${CANDLE_MIN}m&time_from=${from}&time_to=${to}`;
  const res = await axios.get(url, {
    headers: { 'X-API-KEY': key, 'x-chain': 'solana', Accept: 'application/json' },
    timeout: 15_000,
    validateStatus: () => true,
  });
  if (res.status !== 200) throw new Error(`Birdeye HTTP ${res.status}`);
  const items: any[] = res.data?.data?.items || [];
  const candles = items
    .map((r) => ({
      t: Number(r.unixTime),
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
      v: Number(r.v),
      i: CANDLE_SEC,
    }))
    .filter(valid);
  return { candles, pool: null };
}

// ------------------------------------------------------------------ public API

const memo = new Map<string, { at: number; res: CandleResult; ok: boolean }>();

/**
 * Candles for `mint` covering at least `earliestSec` → now. Uses disk cache + imports, and asks the
 * remote sources only for what is missing (incremental). Never throws.
 */
export async function getCandles(
  mint: string,
  earliestSec: number,
  preferredPool: string | null,
): Promise<CandleResult> {
  const m = memo.get(mint);
  if (m && Date.now() - m.at < (m.ok ? OK_TTL_MS : ERR_TTL_MS)) return m.res;

  const cacheFile = path.join(CACHE_DIR, `${safeName(mint)}-${CANDLE_MIN}m.json`);
  let cached: Candle[] = [];
  let cachedPool: string | null = null;
  let cachedSources: string[] = [];
  try {
    const d = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cached = (d.candles || []).map((c: Candle) => ({ ...c, i: c.i || CANDLE_SEC })).filter(valid);
    cachedPool = d.pool || null;
    cachedSources = d.sources || (cached.length ? ['geckoterminal (caché)'] : []);
  } catch {
    /* no cache */
  }
  const imports = readImports(mint);
  const pool = cachedPool || preferredPool;
  const remoteFine = cached.filter((c) => c.i === CANDLE_SEC);
  const covered = remoteFine.length > 0 && remoteFine[0].t <= earliestSec;
  const sinceSec = covered ? remoteFine[remoteFine.length - 1].t : null;

  const errors: string[] = [];
  let fetched: { candles: Candle[]; pool: string | null; source: string } | null = null;
  const attempts: [string, () => Promise<{ candles: Candle[]; pool: string | null }>][] = [
    ['geckoterminal', () => fromGeckoTerminal(mint, pool, earliestSec, sinceSec)],
    ['coingecko-onchain', () => fromCoinGecko(mint, pool, earliestSec, sinceSec)],
    ['birdeye', () => fromBirdeye(mint, earliestSec, sinceSec)],
  ];
  for (const [name, fn] of attempts) {
    try {
      const r = await fn();
      if (r.candles.length) {
        fetched = { ...r, source: name };
        break;
      }
      errors.push(`${name}: sin velas`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no configurada/.test(msg)) errors.push(`${name}: ${msg}`);
    }
  }

  const remote = mergeCandles(cached, fetched?.candles || []);
  const sources = [...new Set([...cachedSources, ...(fetched ? [fetched.source] : [])])];
  if (fetched) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({
          mint,
          pool: fetched.pool || pool,
          sources,
          fetchedAt: new Date().toISOString(),
          candles: remote,
        }),
      );
    } catch {
      /* non-fatal */
    }
  }
  const res: CandleResult = {
    candles: mergeCandles(imports.candles, remote),
    pool: fetched?.pool || pool,
    sources: [...sources, ...imports.sources],
    errors: fetched ? [] : errors,
  };
  memo.set(mint, { at: Date.now(), res, ok: !!fetched || (covered && res.candles.length > 0) });
  return res;
}

/**
 * Non-overlapping price timeline: finer candles take priority; a coarser candle is only used where
 * it does not overlap any finer candle already chosen (e.g. 15m entry candles + 4h history).
 */
export function cleanTimeline(candles: Candle[]): Candle[] {
  const byInterval = [...new Set(candles.map((c) => c.i))].sort((a, b) => a - b);
  let ranges: [number, number][] = []; // merged [start, end) of chosen candles
  const chosen: Candle[] = [];
  const overlaps = (s: number, e: number) => ranges.some(([a, b]) => s < b && e > a);
  for (const iv of byInterval) {
    const add: Candle[] = [];
    for (const c of candles) if (c.i === iv && !overlaps(c.t, c.t + c.i)) add.push(c);
    chosen.push(...add);
    ranges = mergeRanges([...ranges, ...add.map((c) => [c.t, c.t + c.i] as [number, number])]);
  }
  return chosen.sort((a, b) => a.t - b.t);
}

function mergeRanges(rs: [number, number][]): [number, number][] {
  const s = rs.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Price near `sec`: open of the finest candle containing it, else nearest close within 2h. */
export function priceNear(candles: Candle[], sec: number): { price: number; candle: Candle; exact: boolean } | null {
  const containing = candles.filter((c) => c.t <= sec && sec < c.t + c.i).sort((a, b) => a.i - b.i)[0];
  if (containing) return { price: containing.o, candle: containing, exact: true };
  let best: Candle | null = null;
  for (const c of candles) {
    const d = Math.abs(c.t - sec);
    if (d <= 2 * 3600 && (!best || d < Math.abs(best.t - sec))) best = c;
  }
  return best ? { price: best.c, candle: best, exact: false } : null;
}
