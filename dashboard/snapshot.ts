/**
 * Writes a self-contained, offline-capable static HTML of the paper (dry-run) dashboard:
 *   dashboard/snapshots/paper-<YYYYMMDD-HHMMSS>.html   (gitignored)
 * Data is inlined; charts are inline SVG (no CDN), so the file can be sent and opened anywhere.
 * READ-ONLY: only reads decisions/prices; the snapshot contains no secrets.
 *
 * Run: npm run dashboard:snapshot
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { computePaperSnapshot, PaperSnapshot } from './paper';

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const root = process.cwd();
  const template = fs.readFileSync(path.join(root, 'dashboard', 'public', 'paper.html'), 'utf8');
  // Prefer the running dashboard (warm price caches, fewer 429s); otherwise compute directly.
  let snap: PaperSnapshot;
  const port = Number(process.env.DASHBOARD_PORT || 8787);
  try {
    const res = await axios.get(`http://127.0.0.1:${port}/api/paper`, { timeout: 180_000 });
    snap = res.data as PaperSnapshot;
    console.log(`Datos tomados del dashboard en marcha (127.0.0.1:${port}).`);
  } catch {
    snap = await computePaperSnapshot();
  }
  const json = JSON.stringify(snap)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  if (/PRIVATE_KEY|TELEGRAM_BOT_TOKEN|API_KEY"\s*:\s*"/i.test(json))
    throw new Error('Refusing to write snapshot: secret-like content');
  const marker = '<script>\n    const REFRESH_MS';
  if (!template.includes(marker)) throw new Error('paper.html template marker not found');
  const html = template
    .replace('<title>', '<title>[Snapshot] ')
    .replace(marker, `<script>window.__PAPER_SNAPSHOT__ = ${json};</script>\n  ${marker}`);
  const outDir = path.join(root, 'dashboard', 'snapshots');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `paper-${stamp()}.html`);
  fs.writeFileSync(out, html);
  const t = snap.totals as Record<string, number>;
  console.log(`Snapshot escrito: ${out}`);
  console.log(
    `Trades ${t.trades} (abiertas ${t.openCount}, cerradas ${t.closedCount}) · PnL total ${Number(t.totalSol).toFixed(5)} SOL · entradas reales ${t.realEntries}/${t.allPositions}`,
  );
  if (snap.gaps.length) console.log(`Huecos de datos: ${snap.gaps.length} (ver sección en el HTML)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
