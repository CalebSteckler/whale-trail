// Report: paper results so far.   node report.mjs
// Open positions are marked to the live bid, so the total reflects what we could exit for now.
import { readFileSync } from 'node:fs';

const s = JSON.parse(readFileSync(new URL('./data/state.json', import.meta.url), 'utf8'));
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

const per = {};
for (const p of all) { const r = (per[p.name] ??= { n: 0, pnl: 0 }); r.n++; r.pnl += p.r; }
const $ = (x) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;

console.log(`Paper copies: ${all.length} ($${all.reduce((t, p) => t + p.stake, 0)} staked) | closed ${s.closed.length}, open ${open.length}`);
console.log(`Realized ${$(realized)} | open marked to bid ${$(unreal)} | total ${$(realized + unreal)}`);
console.log(`Median price vs whale: ${Math.abs(slip * 100).toFixed(1)}% ${slip > 0 ? 'worse' : 'better'} | avg detection lag ${lag.toFixed(0)}s`);
console.log(`Capital tied up now: $${exposure} in ${open.length} positions | avg days locked per copy ${lock.toFixed(1)}`);
console.log(`Wins/losses closed: ${s.closed.filter((p) => p.pnl > 0).length}/${s.closed.filter((p) => p.pnl <= 0).length}`);
console.log('\nBy whale:');
for (const [n, r] of Object.entries(per).sort((a, b) => b[1].pnl - a[1].pnl)) console.log(`  ${n.padEnd(26)} ${String(r.n).padStart(3)} copies  ${$(r.pnl)}`);
