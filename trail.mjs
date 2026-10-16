// Trail: watch the scout's wallets and paper-copy their new bets. No real money.
//   node trail.mjs
// Every POLL_S seconds it pulls each wallet's new trades. A whale BUY of at least
// MIN_WHALE_USD opens a paper position of STAKE_USD, filled by walking the live order book
// at the moment we notice (so slippage vs the whale's price is real, not assumed).
// A whale SELL of something we hold closes us at the live bid. Resolved markets settle at 1 or 0.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const DATA = new URL('./data/', import.meta.url);
const STATE = new URL('state.json', DATA);
const EVENTS = new URL('events.jsonl', DATA);
const POLL_S = 60;
const SETTLE_EVERY_S = 600;
const STAKE_USD = 100;
const MIN_WHALE_USD = 250;
const MAX_ENTRY_PRICE = 0.97; // above this there is almost nothing left to win
const MAX_DRIFT = 0.10; // if the price moved >10% since the whale's fill, the game changed (live sports); it is not their bet anymore
const MAX_PER_EVENT_USD = 200; // correlated whales pile into one event (Lula No + Flavio Yes); cap the book's exposure to it
// Polymarket splits one story into several events (brazil-presidential-election vs ...-second-round-margin-of-victory),
// so the cap applies to the first three slug words, not the exact event.
const topic = (slug) => (slug || '').split('-').slice(0, 3).join('-');
const RUN_MIN = +process.env.RUN_MIN || Infinity; // CI runners have a job time limit; exit cleanly before it

const DATA_API = 'https://data-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';
const BOT = /updown|up-or-down/;

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const getJson = async (url) => {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); if (i >= 2) throw new Error(`${r.status} ${url}`); }
    catch (e) { if (i >= 2) throw e; }
    await sleep(1500 * (i + 1));
  }
};
const log = (type, o) => {
  const e = { t: new Date().toISOString(), type, ...o };
  appendFileSync(EVENTS, JSON.stringify(e) + '\n');
  console.log(`${e.t.slice(11, 19)} ${type.padEnd(6)} ${o.name ?? ''} | ${o.title ?? ''} ${o.outcome ? '[' + o.outcome + ']' : ''} ${o.note ?? ''}`);
};

const watch = JSON.parse(readFileSync(new URL('watchlist.json', DATA), 'utf8')).kept;
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { since: {}, open: {}, closed: [] };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const nowS = () => Math.floor(Date.now() / 1000);
for (const w of watch) state.since[w.wallet] ??= nowS(); // never backfill: only bets placed after we start count

// Average fill for spending `usd` on the asks, or receiving for `shares` on the bids.
async function fillBuy(asset, usd) {
  const b = await getJson(`${CLOB}/book?token_id=${asset}`);
  const asks = (b.asks || []).map((a) => ({ p: +a.price, s: +a.size })).sort((x, y) => x.p - y.p);
  let left = usd, shares = 0;
  for (const a of asks) { const take = Math.min(left, a.p * a.s); shares += take / a.p; left -= take; if (left <= 1e-9) break; }
  return left > 0.01 ? null : { shares, avg: usd / shares, best: asks[0]?.p };
}
async function fillSell(asset, shares) {
  const b = await getJson(`${CLOB}/book?token_id=${asset}`);
  const bids = (b.bids || []).map((a) => ({ p: +a.price, s: +a.size })).sort((x, y) => y.p - x.p);
  let left = shares, usd = 0;
  for (const a of bids) { const take = Math.min(left, a.s); usd += take * a.p; left -= take; if (left <= 1e-9) break; }
  return { usd, avg: usd / (shares - left || 1), unfilled: left };
}

async function pollWallet(w) {
  const trades = await getJson(`${DATA_API}/trades?user=${w.wallet}&limit=100`);
  const fresh = trades.filter((t) => t.timestamp > state.since[w.wallet]).sort((a, b) => a.timestamp - b.timestamp);
  if (!fresh.length) return;
  state.since[w.wallet] = fresh.at(-1).timestamp;
  // Collapse many small fills of the same order into one decision per asset+side.
  const groups = new Map();
  for (const t of fresh) {
    const k = t.asset + t.side, g = groups.get(k);
    if (g) { g.usd += t.size * t.price; g.size += t.size; } else groups.set(k, { ...t, usd: t.size * t.price });
  }
  for (const t of groups.values()) {
    const key = `${w.wallet}:${t.asset}`, name = w.name || w.wallet.slice(0, 10);
    const whalePrice = t.usd / t.size;
    if (BOT.test(t.slug || '')) continue;
    if (t.side === 'BUY') {
      if (state.open[key] || t.usd < MIN_WHALE_USD) continue;
      if (whalePrice > MAX_ENTRY_PRICE) { log('skip', { name, title: t.title, outcome: t.outcome, note: `whale paid ${whalePrice.toFixed(3)}` }); continue; }
      const onEvent = Object.values(state.open).filter((p) => p.eventSlug && topic(p.eventSlug) === topic(t.eventSlug)).reduce((s, p) => s + p.stake, 0);
      if (onEvent + STAKE_USD > MAX_PER_EVENT_USD) { log('skip', { name, title: t.title, outcome: t.outcome, note: `already $${onEvent} on ${topic(t.eventSlug)}` }); continue; }
      const f = await fillBuy(t.asset, STAKE_USD);
      if (!f) { log('skip', { name, title: t.title, outcome: t.outcome, note: 'book too thin' }); continue; }
      if (Math.abs(f.avg / whalePrice - 1) > MAX_DRIFT) { log('skip', { name, title: t.title, outcome: t.outcome, note: `price moved ${whalePrice.toFixed(3)} -> ${f.avg.toFixed(3)} before we saw it` }); continue; }
      const lagS = nowS() - t.timestamp;
      state.open[key] = { wallet: w.wallet, name, asset: t.asset, conditionId: t.conditionId, outcomeIndex: t.outcomeIndex,
        title: t.title, outcome: t.outcome, slug: t.slug, eventSlug: t.eventSlug, whalePrice, whaleUsd: t.usd, ourPrice: f.avg, shares: f.shares,
        stake: STAKE_USD, lagS, openedAt: new Date().toISOString() };
      log('copy', { name, title: t.title, outcome: t.outcome,
        note: `whale $${t.usd.toFixed(0)} @${whalePrice.toFixed(3)} -> us @${f.avg.toFixed(3)} (${Math.abs(((f.avg / whalePrice) - 1) * 100).toFixed(1)}% ${f.avg > whalePrice ? 'worse' : 'better'}, ${lagS}s lag)` });
    } else if (state.open[key]) {
      const p = state.open[key], f = await fillSell(t.asset, p.shares);
      close(key, f.usd, `whale sold @${whalePrice.toFixed(3)}, we exit @${f.avg.toFixed(3)}`);
    }
  }
}

function close(key, proceeds, note) {
  const p = state.open[key]; delete state.open[key];
  const pnl = proceeds - p.stake;
  state.closed.push({ ...p, proceeds, pnl, closedAt: new Date().toISOString(), note });
  log('close', { name: p.name, title: p.title, outcome: p.outcome, note: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${note})` });
}

async function settle() {
  const byCond = new Map();
  for (const [k, p] of Object.entries(state.open)) (byCond.get(p.conditionId) ?? byCond.set(p.conditionId, []).get(p.conditionId)).push(k);
  for (const [cond, keys] of byCond) {
    try {
      const m = (await getJson(`${GAMMA}/markets?closed=true&condition_ids=${cond}`))[0];
      if (!m?.closed) continue;
      const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
      for (const k of keys) {
        const px = prices[state.open[k].outcomeIndex];
        if (px === 0 || px === 1) close(k, state.open[k].shares * px, px ? 'resolved WIN' : 'resolved LOSS');
      }
    } catch (e) { console.log('settle error', e.message); }
  }
}

console.log(`trail: watching ${watch.length} wallets, poll ${POLL_S}s, $${STAKE_USD}/copy, ${Object.keys(state.open).length} open`);
let lastSettle = 0;
const started = Date.now();
while ((Date.now() - started) / 60000 < RUN_MIN) {
  const t0 = Date.now();
  for (const w of watch) {
    try { await pollWallet(w); } catch (e) { console.log(`poll error ${w.name}: ${e.message}`); }
  }
  if (Date.now() / 1000 - lastSettle > SETTLE_EVERY_S) { await settle(); lastSettle = Date.now() / 1000; }
  save();
  await sleep(Math.max(5000, POLL_S * 1000 - (Date.now() - t0)));
}
