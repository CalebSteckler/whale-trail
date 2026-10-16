// Scout: find Polymarket wallets worth paper-copying.
//   node scout.mjs            writes data/watchlist.json + prints a ranked table
// Candidate pool = leaderboard (all-time + month, by PnL). Each wallet is scored on its
// recent resolved positions; market makers, one-hit wonders, dormant wallets and
// 5-minute crypto bots are filtered out because none of them can be copied profitably.
import { mkdirSync, writeFileSync } from 'node:fs';

const API = 'https://data-api.polymarket.com';
const POOL_PER_BOARD = 200;
const PAGES = 6; // x50 most recent closed positions per wallet
const MIN_RESOLVED = 30;
const ACTIVE_DAYS = 14;
const KEEP = 20;

const get = async (path, tries = 3) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(API + path);
      if (r.ok) return r.json();
      if (i >= tries) throw new Error(`${r.status} ${path}`);
    } catch (e) { if (i >= tries) throw e; }
    await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
  }
};

async function pool() {
  const seen = new Map();
  for (const period of ['ALL', 'MONTH']) {
    for (let off = 0; off < POOL_PER_BOARD; off += 50) {
      for (const u of await get(`/v1/leaderboard?timePeriod=${period}&orderBy=PNL&limit=50&offset=${off}`)) {
        if (!seen.has(u.proxyWallet)) seen.set(u.proxyWallet, { wallet: u.proxyWallet, name: u.userName, lbPnl: u.pnl, lbVol: u.vol });
      }
    }
  }
  return [...seen.values()];
}

async function closed(wallet) {
  const out = [];
  for (let p = 0; p < PAGES; p++) {
    const page = await get(`/closed-positions?user=${wallet}&limit=50&offset=${p * 50}&sortBy=TIMESTAMP&sortDirection=DESC`);
    out.push(...page);
    if (page.length < 50) break;
  }
  return out;
}

// Losing bets are never redeemed, so they never reach /closed-positions. They sit in
// /positions as redeemable at curPrice 0. Without them every wallet looks like a 95% winner.
async function settled(wallet) {
  const out = [];
  for (let off = 0; off < 3000; off += 500) {
    const page = await get(`/positions?user=${wallet}&limit=500&offset=${off}&sizeThreshold=0&redeemable=true`);
    out.push(...page);
    if (page.length < 500) break;
  }
  return out.filter((p) => p.redeemable);
}

function merge(closedPos, open) {
  if (!closedPos.length) return closedPos;
  const since = new Date(Math.min(...closedPos.map((p) => p.timestamp)) * 1000).toISOString().slice(0, 10);
  const extra = open
    .filter((p) => p.endDate && p.endDate >= since)
    .map((p) => ({ ...p, realizedPnl: p.cashPnl + p.realizedPnl, timestamp: Date.parse(p.endDate) / 1000, settledLoss: true }));
  return [...closedPos, ...extra];
}

function score(c, pos) {
  const now = Date.now() / 1000;
  const bot = pos.filter((p) => /updown|up-or-down/.test(p.slug || '')).length;
  const real = pos.filter((p) => !/updown|up-or-down/.test(p.slug || ''));
  const n = real.length;
  if (!n) return { ...c, n: 0, reject: 'no resolved markets' };
  const staked = real.reduce((s, p) => s + p.totalBought * p.avgPrice, 0);
  const pnl = real.reduce((s, p) => s + p.realizedPnl, 0);
  const wins = real.filter((p) => p.realizedPnl > 0).length;
  const biggest = Math.max(...real.map((p) => p.realizedPnl));
  const events = new Set(real.map((p) => p.eventSlug)).size;
  const lastDays = (now - Math.max(...pos.filter((p) => !p.settledLoss).map((p) => p.timestamp))) / 86400;
  const roi = staked ? pnl / staked : 0;
  const s = {
    ...c, n, wins, winRate: wins / n, roi, pnl, staked, events,
    oneHitShare: pnl > 0 ? biggest / pnl : 1, lastDays, botShare: bot / pos.length,
  };
  if (s.botShare > 0.5) s.reject = 'mostly 5-min crypto bot';
  else if (n < MIN_RESOLVED) s.reject = `only ${n} resolved`;
  else if (lastDays > ACTIVE_DAYS) s.reject = `dormant ${lastDays.toFixed(0)}d`;
  else if (pnl <= 0) s.reject = 'recent PnL negative';
  else if (roi < 0.03) s.reject = 'market maker (ROI < 3%)'; // own fills, not the leaderboard's undocumented windows
  else if (s.oneHitShare > 0.6) s.reject = 'one-hit wonder';
  else if (events < 10) s.reject = 'too concentrated';
  // Rewards edge per dollar and consistency, damped for small samples.
  s.score = roi * Math.sqrt(Math.min(n, 300)) * (0.5 + s.winRate) * (1 - s.oneHitShare / 2);
  return s;
}

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const candidates = await pool();
console.error(`pool: ${candidates.length} wallets`);
let done = 0;
const scored = await mapLimit(candidates, 6, async (c) => {
  try { const [cl, op] = await Promise.all([closed(c.wallet), settled(c.wallet)]); return score(c, merge(cl, op)); }
  catch (e) { return { ...c, reject: 'fetch failed: ' + e.message }; }
  finally { if (++done % 25 === 0) console.error(`scored ${done}/${candidates.length}`); }
});

const kept = scored.filter((s) => !s.reject).sort((a, b) => b.score - a.score).slice(0, KEEP);
const reasons = {};
for (const s of scored) if (s.reject) { const k = s.reject.replace(/\d+/g, 'N'); reasons[k] = (reasons[k] || 0) + 1; }

mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
writeFileSync(new URL('./data/watchlist.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), kept, reasons }, null, 2));
writeFileSync(new URL('./data/scored.json', import.meta.url), JSON.stringify(scored, null, 2));

const $ = (x) => (Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : (x / 1e3).toFixed(0) + 'k');
console.log('rank name                      resolved  win%   ROI   pnl(recent)  events  topHit  lastTrade');
kept.forEach((s, i) => console.log(
  `${String(i + 1).padStart(4)} ${(s.name || s.wallet.slice(0, 10)).slice(0, 24).padEnd(25)} ${String(s.n).padStart(8)} ${(s.winRate * 100).toFixed(0).padStart(5)} ${(s.roi * 100).toFixed(0).padStart(5)}% ${$(s.pnl).padStart(11)} ${String(s.events).padStart(7)} ${(s.oneHitShare * 100).toFixed(0).padStart(6)}% ${s.lastDays.toFixed(1).padStart(8)}d`));
console.log('\nrejected:', reasons);
