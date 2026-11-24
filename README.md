# pump-fun-sprint-01

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Shayidinadapa/pump-fun-sprint-01/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Shayidinadapa/pump-fun-sprint-01/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A simple momentum paper-trading bot for pump.fun, built for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It speaks the `agent-fun/replay/v2` protocol over NDJSON stdin/stdout: the harness sends `hello`, then `batch` messages (slot, events, marks, fills, account), and the bot answers each batch with one `reply` carrying its orders.

## Strategy

- **Buy:** a mint whose mark price is up ≥ 6% from the first price seen, with ≥ 0.2 SOL of buy volume behind it. Size is 0.1 SOL per coin, capped at the protocol's max order size (1% of real quote reserves). At most 5 open positions; no re-buy within 2000 slots of a sell.
- **Sell:** the whole position on take-profit (+35%), stop-loss (−12%), a trailing stop (sell after giving back 10 points from a +20% peak), or a stale exit (held > ~2h of slots and still under +5%).
- **Deterministic:** every decision comes only from harness messages — no randomness, no wall clock — so two runs on the same window produce byte-identical action logs.

## Run it

```sh
node main.ts
```

Node 22.18+ (runs TypeScript as-is). No dependencies, no network, no secrets.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1bz6mt7h&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
