[![make.fun](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![rank](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/ahmed1813544/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/rank.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![reward](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/ahmed1813544/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/reward.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)

# Pump Sprint Bot — Early Reserve-Cross Scalper

A trading bot for the [Pump Sprint: 12-Hour Paper Trading Dash](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4) bounty. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve events (protocol `agent-fun/replay/v2`), run by the grader as `node main.ts` with no network.

## Strategy

Buy every fresh bonding curve the moment its real SOL reserves first cross ~1 SOL — the earliest moment a meaningful order is even allowed (the per-batch size cap is 1% of real reserves), and the moment the coin's first real buyers have shown up, before the pump has run away. Two filters keep it from buying tops:

- **No one-burst wonders**: a coin must have made at least 2 trades before its reserves cross (a single giant first buy is usually the creator, not a market).
- **No spent bursts**: if the coin's price already jumped more than ~3.5% inside the crossing batch, skip it — that move is over.

Then exit fast and let winners run:

- **Trailing stop** (−3% from the peak since entry) does most of the work.
- **Partial profit**: bank 70% of the position the first time it reaches +15%.
- **Stop-loss** −10%, **maximum hold** ~1500 slots, and a very high take-profit (+500%) so the trail, not a cap, decides when a runner ends.

One entry per mint, at most five open positions, every buy sized by the live per-batch order cap. Fully deterministic: a pure function of the `hello` and the `batch` messages, no clock, no environment, no randomness — two runs of the same replay produce byte-identical action logs.

## Files

- `main.ts` — the whole strategy (entrypoint, run with `node main.ts` on Node 22+).
- `vendor/makefun-bot.ts` — the kit's own `agent-fun/replay/v2` SDK shim, vendored as the kit instructs.
- `LICENSE` — MIT.

## Local grading

Dev-window grade (full 24h dev set, process driver):

```
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process
```
