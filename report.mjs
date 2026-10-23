// Report: paper results so far.   node report.mjs
// Open positions are marked to the live bid, so the total reflects what we could exit for now.
// Judge on edge, not win %: edge per share = payout per share minus the price we paid. A 60% win rate
// at 57c is barely +3c. The +/- is one standard error; an edge inside it could still be luck.
import { readFileSync } from 'node:fs';

const s = JSON.parse(readFileSync(new URL('./data/state.json', import.meta.url), 'utf8'));
const BENCH_MIN_CLOSED = 20; // keep in step with trail.mjs
const bid = async (asset) => {
  try {
    const b = await (await fetch(`https://clob.polymarket.com/book?token_id=${asset}`)).json();
    return Math.max(0, ...(b.bids || []).map((x) => +x.price));
  } catch { return 0; }
};

const open = Object.values(s.open);
for (const p of open) p.mark = p.shares * (await bid(p.asset)) - p.stake;
const realized = s.closed.reduce((t, p) => t + p.pnl, 0);
const unreal = open.reduce((t, p) => t + p.mark, 0);
const all = [...s.closed.map((p) => ({ ...p, r: p.pnl })), ...open.map((p) => ({ ...p, r: p.mark }))];
// Median, not mean: one live-game copy (45c -> 15c) otherwise swamps the rest.
const slips = all.map((p) => p.ourPrice / p.whalePrice - 1).sort((a, b) => a - b);
const slip = slips.length ? slips[Math.floor(slips.length / 2)] : 0;
const lag = all.length ? all.reduce((t, p) => t + p.lagS, 0) / all.length : 0;

const days = (a, b) => (Date.parse(b ?? new Date().toISOString()) - Date.parse(a)) / 864e5;
const lock = all.length ? all.reduce((t, p) => t + days(p.openedAt, p.closedAt), 0) / all.length : 0;
const exposure = open.reduce((t, p) => t + p.stake, 0);
// Peak money out at once: the bankroll a real version would need at this stake size.
const steps = all.flatMap((p) => [[Date.parse(p.openedAt), p.stake], ...(p.closedAt ? [[Date.parse(p.closedAt), -p.stake]] : [])]).sort((a, b) => a[0] - b[0]);
let cur = 0, peak = 0;
for (const [, d] of steps) peak = Math.max(peak, (cur += d));

const $ = (x) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(0)}`;
const edge = (ps) => {
  const e = ps.map((p) => p.pnl / p.shares), n = e.length;
  if (!n) return { n, txt: '      n/a' };
  const m = e.reduce((a, b) => a + b, 0) / n;
  const se = n > 1 ? Math.sqrt(e.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) / n) : 0;
  const sig = n >= 10 && Math.abs(m) > 2 * se ? (m > 0 ? '  REAL+' : '  REAL-') : '';
  return { n, m, txt: `${(m * 100 >= 0 ? '+' : '') + (m * 100).toFixed(1)}c ±${(se * 100).toFixed(1)}c${sig}` };
};
const roi = (ps) => { const st = ps.reduce((t, p) => t + p.stake, 0); return st ? `${((100 * ps.reduce((t, p) => t + p.pnl, 0)) / st).toFixed(1)}%` : 'n/a'; };
const cat = (p) => {
  const t = `${p.slug || ''} ${p.title}`.toLowerCase();
  if (/^(lol|cs2|csgo|dota|val)-|counter-strike|valorant|dota|lol:|esports/.test(t)) return 'esports';
  if (/bitcoin|btc|eth|solana|crypto|xrp/.test(t)) return 'crypto';
  if (/election|senate|house|trump|president|governor|mayor|party|vote|parliament/.test(t)) return 'politics';
  if (/nfl|nba|mlb|nhl|epl|ucl|soccer| fc |vs\.?|spread|o\/u|atp|wta|ufc|win on 20/.test(t)) return 'sports';
  return 'other';
};
const table = (title, rows, keyOf) => {
  const m = {};
  for (const p of rows) (m[keyOf(p)] ??= []).push(p);
  console.log(`\n${title}`);
  for (const [k, ps] of Object.entries(m).sort((a, b) => b[1].length - a[1].length))
    console.log(`  ${k.padEnd(26)} ${String(ps.length).padStart(4)} closed  ${$(ps.reduce((t, p) => t + p.pnl, 0)).padStart(6)}  roi ${roi(ps).padStart(6)}  edge ${edge(ps).txt}`);
};

console.log(`Paper copies: ${all.length} ($${all.reduce((t, p) => t + p.stake, 0)} staked) | closed ${s.closed.length}, open ${open.length}`);
console.log(`Realized ${$(realized)} | open marked to bid ${$(unreal)} | total ${$(realized + unreal)}`);
console.log(`Median price vs whale: ${Math.abs(slip * 100).toFixed(1)}% ${slip > 0 ? 'worse' : 'better'} | avg detection lag ${lag.toFixed(0)}s`);
console.log(`Capital tied up now: $${exposure} in ${open.length} positions | peak at once $${peak} | avg days locked per copy ${lock.toFixed(1)}`);
console.log(`Wins/losses closed: ${s.closed.filter((p) => p.pnl > 0).length}/${s.closed.filter((p) => p.pnl <= 0).length}`);
const best = [...s.closed].sort((a, b) => b.pnl - a.pnl).slice(0, 5);
console.log(`Without the 5 best trades: ${$(realized - best.reduce((t, p) => t + p.pnl, 0))} (is it a strategy or a few lucky long shots?)`);

table('By rules version (v2 = out of sample, frozen 2026-10-23):', s.closed, (p) => `v${p.rules ?? 1}`);
table('By category:', s.closed, cat);
table('By entry price:', s.closed, (p) => (p.ourPrice < 0.3 ? 'a <30c' : p.ourPrice < 0.5 ? 'b 30-50c' : p.ourPrice < 0.7 ? 'c 50-70c' : p.ourPrice < 0.85 ? 'd 70-85c' : 'e 85c+'));

const per = {};
for (const p of all) { const r = (per[p.name] ??= { closed: [], open: 0, mark: 0 }); if (p.closedAt) r.closed.push(p); else { r.open++; r.mark += p.r; } }
console.log('\nBy whale (benched = 20+ closed with negative edge, no longer copied):');
for (const [n, r] of Object.entries(per).sort((a, b) => b[1].closed.reduce((t, p) => t + p.pnl, 0) - a[1].closed.reduce((t, p) => t + p.pnl, 0))) {
  const e = edge(r.closed), bench = e.n >= BENCH_MIN_CLOSED && e.m < 0 ? '  BENCHED' : '';
  console.log(`  ${n.padEnd(26)} ${String(r.closed.length).padStart(3)} closed ${$(r.closed.reduce((t, p) => t + p.pnl, 0)).padStart(6)}  edge ${e.txt.padEnd(14)} | ${String(r.open).padStart(2)} open ${$(r.mark)}${bench}`);
}

// Shadows: skipped bets paper-tracked to resolution. If a skip reason's shadows make money, that rule is costing us.
const sc = s.shadowClosed ?? [];
const label = (p) => `${p.reason}${p.note ? ` (${p.note})` : ''}`;
console.log(`\nSkipped bets, had we taken them (${Object.keys(s.shadow ?? {}).length} still open, held to resolution):`);
if (!sc.length) console.log('  none resolved yet');
else table('', sc, label);
