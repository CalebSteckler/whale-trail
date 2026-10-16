# Whale Trail

Paper-trades copying profitable Polymarket wallets. No real money, no keys, public APIs only.

1. `node scout.mjs`: scores ~370 leaderboard wallets and writes the top 20 to `data/watchlist.json`
2. `node trail.mjs`: runs forever. Polls those wallets every 60s and paper-copies new bets ($100 each, filled against the live order book)
3. `node report.mjs`: shows paper P&L, slippage against the whale's price, and results per whale

## The trap the scout corrects for

`/closed-positions` only lists positions that were sold or redeemed. Nobody redeems a loser worth $0, so losses never appear there. They stay in `/positions` as `redeemable` with `curPrice: 0`. If you skip them, every wallet looks like a 95%+ winner. `scout.mjs` merges them back in for the same time window.

## Filters

A wallet is dropped if any of these apply: fewer than 30 resolved bets, no trade in the last 14 days, net loss, PnL/volume under 1% (market maker), one bet accounting for over 60% of profit, under 10 distinct events, or mostly 5-minute crypto up/down markets.

## Files

`data/state.json` holds open and closed paper positions. `data/events.jsonl` has every copy, skip and close. `data/trail.log` is console output.
