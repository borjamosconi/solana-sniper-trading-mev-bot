/**
 * Download historical OHLCV for a Solana token via GeckoTerminal.
 * DexScreener public API has no candle endpoint — we only use it optionally to list pairs.
 *
 * Usage:
 *   npx ts-node backtest/fetch_ohlcv.ts --mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
 *   npx ts-node backtest/fetch_ohlcv.ts --mint <MINT> --aggregate 1 --limit 1000
 *
 * Writes: backtest/data/<mint>-<aggregate>m.jsonl
 * Candle format: { t, o, h, l, c, v }  (t = unix seconds, prices in USD)
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const GT = 'https://api.geckoterminal.com/api/v2';

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function getJson(url: string, retries = 3): Promise<any> {
  // axios instead of global fetch: the pinned @types/node has no fetch typings (ts-node fails).
  for (let attempt = 0; ; attempt++) {
    const res = await axios.get(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'solana-sniper-backtest/1.0' },
      timeout: 15_000,
      validateStatus: () => true,
    });
    // GeckoTerminal free tier is ~30 req/min: back off on 429 and retry a couple of times.
    if (res.status === 429 && attempt < retries) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.data;
  }
}

export async function resolvePool(mint: string): Promise<{ pool: string; name: string; symbol: string }> {
  const body = await getJson(`${GT}/networks/solana/tokens/${mint}/pools?page=1`);
  const pools: any[] = body?.data || [];
  if (!pools.length) {
    throw new Error(`No pools found on GeckoTerminal for mint ${mint}`);
  }
  // Prefer highest reserve / first result
  const top = pools[0];
  const pool = top.attributes?.address;
  const name = top.attributes?.name || mint.slice(0, 8);
  const base = body?.included?.find?.(() => false);
  void base;
  const symbol = (top.attributes?.name || '').split(' / ')[0] || 'TOKEN';
  if (!pool) throw new Error('Pool address missing in GeckoTerminal response');
  return { pool, name, symbol };
}

export async function fetchOhlcv(
  pool: string,
  aggregate: number,
  limit: number,
  opts: { token?: string; beforeTimestamp?: number } = {},
): Promise<Candle[]> {
  // GeckoTerminal: /ohlcv/minute?aggregate=1|5|15...
  // opts.token: token address to price (pool base by default); opts.beforeTimestamp: unix seconds.
  let url =
    `${GT}/networks/solana/pools/${pool}/ohlcv/minute` +
    `?aggregate=${aggregate}&limit=${Math.min(limit, 1000)}&currency=usd`;
  if (opts.token) url += `&token=${encodeURIComponent(opts.token)}`;
  if (opts.beforeTimestamp) url += `&before_timestamp=${Math.floor(opts.beforeTimestamp)}`;
  const body = await getJson(url);
  const list: number[][] = body?.data?.attributes?.ohlcv_list || [];
  // API returns newest-first: [timestamp, open, high, low, close, volume]
  const candles: Candle[] = list
    .map((row) => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    }))
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c))
    .sort((a, b) => a.t - b.t);
  return candles;
}

async function main() {
  const mint = arg('mint');
  if (!mint) {
    console.error('Missing --mint <SOLANA_TOKEN_MINT>');
    process.exit(1);
  }
  const aggregate = Number(arg('aggregate', '5'));
  const limit = Number(arg('limit', '500'));

  console.log(`Resolving pool for ${mint}…`);
  const { pool, name, symbol } = await resolvePool(mint);
  console.log(`Pool ${pool} (${name} / ${symbol}), fetching ${aggregate}m candles (limit ${limit})…`);

  const candles = await fetchOhlcv(pool, aggregate, limit);
  if (!candles.length) {
    throw new Error('No candles returned');
  }

  const outDir = path.join(process.cwd(), 'backtest', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${mint}-${aggregate}m.jsonl`);
  const meta = {
    mint,
    pool,
    name,
    symbol,
    aggregateMinutes: aggregate,
    source: 'geckoterminal',
    fetchedAt: new Date().toISOString(),
    candleCount: candles.length,
    from: candles[0].t,
    to: candles[candles.length - 1].t,
    note:
      'Past performance does not guarantee future results. Backtests omit slippage, network failures, MEV, and faster competing bots.',
  };

  const lines = [JSON.stringify({ type: 'meta', ...meta }), ...candles.map((c) => JSON.stringify({ type: 'candle', ...c }))];
  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`Wrote ${candles.length} candles → ${outFile}`);
  console.log(
    `Range: ${new Date(candles[0].t * 1000).toISOString()} → ${new Date(candles[candles.length - 1].t * 1000).toISOString()}`,
  );
}

// Only run the CLI when executed directly (the dashboard imports the helpers above).
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
