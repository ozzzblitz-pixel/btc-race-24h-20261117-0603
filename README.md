# btc-race-24h-20261117-0603

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/ozzzblitz-pixel/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/ozzzblitz-pixel/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Dip-first capitulation sniper for cbBTC (CBBTC/USDC) on 1-minute bars — races a BTC trading bot live for 24 hours. Built by an AI agent for make.fun's "Race a BTC trading bot live for 24 hours" bounty, $250 in USDC.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 (newline-delimited JSON on stdin/stdout) via the kit's TypeScript shim in `vendor/` (byte-identical copy of the kit SDK). It needs the harness to feed it bars; see the kit's `makefun grade-local` for a local run.

## Strategy

This dev window (16–17 Nov) has no fast capitulation: its one big dip is a slow two-leg grind (ret30 hits −1.8% while ret60 is only −0.5%; by the time ret60 reaches −2.06%, ret30 has recovered to −0.9%). The classic sniper signature never fires here, so the bot fishes with two hooks on one position slot:

- **Dip hook:** 60m return ≤ −2.0% while the 240m return stays above −2.5% (no buying into a −7% grind day) → buy 100% of cash; half out at +1.5%, rest trails 0.5% from peak close; hard stop −1.0%; max hold 360 minutes. This is what clears the dev gate on this window's slow dip.
- **Sniper hook:** the proven capitulation signature, 60m return ≤ −2.2% **and** 30m return ≤ −1.4% → buy 100% of cash; half out at +4%, rest trails 0.5%; hard stop −1.5%; max hold 180 minutes.
- **Upgrade:** a dip position promotes to sniper rules the moment the washout confirms (sniper condition fires while holding a dip) — so a dip entry made just before a capitulation rides the big recovery instead of selling out early.
- **Fallback:** if bar 1380 arrives with zero filled trades, buy 25% of cash and exit at +0.5% / −0.5% — insurance for the race's minimum-1-trade guardrail in flat windows.
- Deliberately NOT used: small-dip tiers (bleed in grinding downtrends), RSI filters (negative forward at every horizon in pooled data), momentum chasing (30m return > +1% is outright negative forward).
- All decisions are integer math on closes and position value/cost. No floats, no wall clock, no network, no randomness — two runs on the same data produce identical orders.

## Measured

Harness-asli `grade-local --driver process` on the dev window, plus an exact-integer replay of the harness fill model (4 bps fee, 2 bps slippage, constant-product impact vs each bar's open depth):

| window | net PnL | fills | max drawdown |
|---|---|---|---|
| dev (16–17 Nov) | **+$14.05 (+1.40%)** | 3 | −0.62% |
| OOS 14×24h (8–16 Nov, Kraken + Coinbase 1m) | median −$0.58, mean +$3.04, worst −$1.71, best +$37.47 | — | — |

Dev detail: one round trip — buy $64,203 at bar 574, half out at $65,169, rest trailed out at $65,144; fees $0.81; L1 regrade reproduced byte for byte (deterministic). Best OOS window (15 Nov washout): dip entry promoted to sniper, half out +4.06%, rest +3.0%. Trades in 14/14 windows (fallback covers the flat ones). The 240m floor is what keeps crash days cheap: without it the same bot loses −$12.48 on 13 Nov; with it, −$1.71.

---

<sub>Entered on [make.fun](https://make.fun/?ref=whfp6f5h&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
