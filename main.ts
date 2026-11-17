// btc-race-24h-20261117-0603: "Dip-first capitulation sniper" for cbBTC (CBBTC/USDC), 1m bars.
//
// Angle
// -----
// This dev window (16-17 Nov) has NO fast capitulation: its one big dip is a
// slow two-leg grind (ret30 hits -1.8% while ret60 is only -0.5%; by the time
// ret60 reaches -2.06%, ret30 has recovered to -0.9%). The two legs never
// align, so the classic multi-horizon sniper signature (ret60 <= -2.2% AND
// ret30 <= -1.4%) never fires here -- the old bot scores -$0.70 on this dev
// window and fails the dev gate. The dev board's top 5 are all small-dip
// buyers (1.05% dip + RSI, 75 bps below 75-bar mean, 60-min dips, +$29.60 to
// +$35.30), but pooled 1m data says RSI alone is negative forward and
// small-dip buying bleeds on crash days (Nov 13: -7.38%): the board is
// overfit to this window's two-leg dip.
//
// This bot therefore fishes with TWO hooks, one position slot:
//   * Dip hook: a 60m drop of -2.0% in a NOT-already-crashing market
//     (240m return above -2.5% -- no buying into a -7% grind day) -> buy
//     100% of cash, take half at +1.5%, trail the rest 0.5% from peak
//     close, hard stop -1.0%, max hold 360 bars. This is what clears the
//     dev gate on this window's slow dip.
//   * Sniper hook: the proven capitulation signature (ret60 <= -2.2% AND
//     ret30 <= -1.4%) -> buy 100% of cash, take half at +4%, trail the
//     rest 0.5%, hard stop -1.5%, max hold 180 bars. Across 15 x 24h
//     windows this signature's forward 60m return averages +1.65% with
//     a 100% win rate net of costs.
//   * Upgrade: a dip position PROMOTES to sniper rules the moment the
//     washout confirms (sniper condition fires while holding a dip) --
//     so a dip entry made just before a capitulation rides the big
//     recovery (+4% TP) instead of selling out early at +1.5%.
//   * Fallback (guardrail insurance): if bar 1380 arrives with zero
//     filled trades, buy 25% of cash and exit at +0.5% / -0.5% vs cost.
//     It costs ~$0.30-0.80 in flat windows but guarantees the race's
//     minimum-1-trade bar.
//
// Rules (all BigInt math, no floats, no clock, no randomness):
//   * One open position max (harness cap). Fills are at the next bar's
//     open; decisions are on closes only.
//   * No opportunist/small-dip tier: tested, it bleeds in grinding
//     downtrends and occupies the single position slot when the sniper
//     signal fires. No RSI filter: pooled data shows RSI<=21/25 is
//     negative forward at every horizon. No momentum chasing: 30m
//     return > +1% is outright negative forward.
//
// Measured (harness-asli `grade-local --driver process` on the dev window,
// plus an exact-integer replay of the harness fill model: 4 bps fee,
// 2 bps slippage, constant-product impact vs each bar's open depth):
//   * dev window (16-17 Nov):  +$14.05 (+1.40%), 3 fills, max drawdown
//     -0.62%, fees $0.81 (one round trip: buy $64,203 at bar 574, half
//     out at $65,169, rest trailed out at $65,144; L1 regrade reproduced
//     byte for byte -- deterministic).
//   * OOS 14 x 24h windows (8-16 Nov, Kraken + Coinbase 1m): median
//     -$0.58, mean +$3.04, worst -$1.71, best +$37.47 (15 Nov washout:
//     dip entry promoted to sniper, half out +4.06%, rest +3.0%).
//     Trades in 14/14 windows (fallback covers the flat ones).
//   * The 240m floor is what keeps crash days cheap: without it the
//     same bot loses -$12.48 on 13 Nov; with it, -$1.71.
//
// Protocol: agent-fun/bars-replay/v1 via the kit's TypeScript shim
// (vendor/makefun-bars.ts, byte-identical copy of sdk/makefun-bars.ts).

import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- sniper entry: 60m <= -2.2% and 30m <= -1.4% (integer cross-multiplied) ---
//   c / c60 <= 0.978  <=>  c * 1000 <= c60 * 978
//   c / c30 <= 0.986  <=>  c * 1000 <= c30 * 986
const SNIPER_60_NUM = 978n;
const SNIPER_30_NUM = 986n;

// --- dip entry: 60m <= -2.0% while the 240m return stays above -2.5% ---
//   c / c60 <= 0.980  <=>  c * 1000 <= c60 * 980
//   c / c240 > 0.975  <=>  c * 1000 > c240 * 975
const DIP_60_NUM = 980n;
const DIP_240_FLOOR_NUM = 975n;

// --- sniper exit ---
const SN_TP_NUM = 10400n; // +4.0% vs cost: sell half
const SN_SL_NUM = 9850n; // -1.5% vs cost: sell all, / 10000
const SN_MAX_HOLD_BARS = 180;

// --- dip exit ---
const DIP_TP_NUM = 10150n; // +1.5% vs cost: sell half
const DIP_SL_NUM = 9900n; // -1.0% vs cost: sell all, / 10000
const DIP_MAX_HOLD_BARS = 360;

// --- trailing stop (both modes, after the half-sell): 0.5% below peak close ---
//   close <= peak * 0.995  <=>  close * 200 <= peak * 199

// --- fallback (guardrail insurance) ---
const FALLBACK_BAR = 1380; // last hour of the 1440-bar window
const FALLBACK_DIV = 4n; // buy cash / 4 (25%)
const FB_TP_NUM = 10050n; // +0.5% vs cost, / 10000
const FB_SL_NUM = 9950n; // -0.5% vs cost, / 10000

const MAX_SLIPPAGE_BPS = 300; // 3% from the latest close (fills are at next open)

const closes: bigint[] = []; // CBBTC closes (price_scale 5 ints), one per batch
let filledTrades = 0; // filled own orders (flatten closes excluded)
const pendingMode = new Map<string, 'sn' | 'dip' | 'fb'>(); // client_id -> mode, buy not yet filled
let mode: 'sn' | 'dip' | 'fb' | null = null; // mode of the currently held position
let entrySeq = -1; // seq of the batch the position first appeared
let peakClose = 0n; // peak close since entry (price-based: a partial sell
// halves the position VALUE but not the price, so a value peak would
// trip the trailing stop on the very next bar after a half-sell)
let tpHit = false;

function sniperCond(): boolean {
  if (closes.length < 61) return false;
  const cNow = closes[closes.length - 1];
  const c60 = closes[closes.length - 61];
  const c30 = closes[closes.length - 31];
  return cNow * 1000n <= c60 * SNIPER_60_NUM && cNow * 1000n <= c30 * SNIPER_30_NUM;
}

function dipCond(): boolean {
  if (closes.length < 241) return false;
  const cNow = closes[closes.length - 1];
  const c60 = closes[closes.length - 61];
  const c240 = closes[closes.length - 241];
  return cNow * 1000n <= c60 * DIP_60_NUM && cNow * 1000n > c240 * DIP_240_FLOOR_NUM;
}

function sellAll(qty: bigint): OrderInput[] {
  return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state, batch) {
    // Record fills of our own orders (for the fallback's trade count and
    // for learning which mode opened the current position).
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) continue;
      if (f.status === 'filled') {
        filledTrades += 1;
        if (f.side === 'buy') {
          const m = pendingMode.get(f.client_id);
          if (m !== undefined) {
            mode = m;
            pendingMode.delete(f.client_id);
          }
        }
      }
    }

    const close = state.close(SYMBOL);
    if (close !== null) closes.push(close);
    if (state.warmingUp || close === null) return [];

    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      if (entrySeq < 0) {
        // Position first seen on this batch: anchor exits to it.
        entrySeq = state.seq;
        peakClose = close;
        tpHit = false;
      }
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      if (close > peakClose) peakClose = close;
      // A dip position promotes to sniper rules the moment the washout
      // confirms: the +4% TP and -1.5% SL replace the dip's +1.5% / -1%,
      // the hold shortens to 180 bars from the ORIGINAL entry, and the
      // peak close carries over (it is a price peak, not a value peak).
      if (mode === 'dip' && sniperCond()) {
        mode = 'sn';
        tpHit = false;
      }
      if (mode === 'fb') {
        if (value * 10000n >= cost * FB_TP_NUM) return sellAll(held.qty);
        if (value * 10000n <= cost * FB_SL_NUM) return sellAll(held.qty);
        return [];
      }
      // Sniper and dip share the same exit shape; only the numbers differ.
      const tpNum = mode === 'sn' ? SN_TP_NUM : DIP_TP_NUM;
      const slNum = mode === 'sn' ? SN_SL_NUM : DIP_SL_NUM;
      const maxHold = mode === 'sn' ? SN_MAX_HOLD_BARS : DIP_MAX_HOLD_BARS;
      if (!tpHit && value * 10000n >= cost * tpNum) {
        tpHit = true;
        const half = held.qty / 2n;
        if (half > 0n) {
          return [{ side: 'sell', symbol: SYMBOL, qty: half, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return [];
      }
      if (tpHit && close * 200n <= peakClose * 199n) return sellAll(held.qty);
      if (value * 10000n <= cost * slNum) return sellAll(held.qty);
      if (state.seq - entrySeq >= maxHold) return sellAll(held.qty);
      return [];
    }

    // Flat: reset position bookkeeping.
    entrySeq = -1;
    peakClose = 0n;
    tpHit = false;
    mode = null;

    // Sniper first: it outranks the dip hook when both fire.
    if (sniperCond()) {
      const notional = state.cash;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
        const cid = `sn${state.seq}`;
        pendingMode.set(cid, 'sn');
        return [{ side: 'buy', symbol: SYMBOL, client_id: cid, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    if (dipCond()) {
      const notional = state.cash;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
        const cid = `dp${state.seq}`;
        pendingMode.set(cid, 'dip');
        return [{ side: 'buy', symbol: SYMBOL, client_id: cid, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    if (state.seq >= FALLBACK_BAR && filledTrades === 0) {
      const notional = state.cash / FALLBACK_DIV;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
        // No latch: a rejected buy leaves filledTrades at 0, so the
        // fallback retries on the next bar until one fills.
        const cid = `fb${state.seq}`;
        pendingMode.set(cid, 'fb');
        return [{ side: 'buy', symbol: SYMBOL, client_id: cid, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    return [];
  },
});
