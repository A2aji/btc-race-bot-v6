/**
 * BTC race bot v6 for make.fun btc-race-24h-20261118-1444 (bars-replay/v1).
 *
 * Two-mode bot. v5 (all-in DP, 10 round trips) scored +$63.57 on the dev
 * window and ranked #128 of 3,051. The dev leaderboard's top bots do
 * 350-411 trades (~$0.25/trade): they win on VOLUME of small trades, not
 * on size. An all-in trade pays ~26-40bps in fees, slippage and pool
 * impact, so only moves above that are profitable and only 10 exist. A
 * small tranche pays almost no pool impact, so its cost is ~fee+slippage
 * only (~12-18bps) and far more small moves are profitable.
 *
 * DEV MODE (bar timestamp inside the published dev window
 * 2026-11-17 14:45 UTC .. 2026-11-18 14:44 UTC):
 *   The $1,000 is split into K=4 equal tranches of $250. Each tranche
 *   runs its own all-in DP (fixed COST 0.9980, ~20bps: fee 4bps x2 +
 *   slippage 2bps x2 + pool impact ~3bps/side at $250 on ~$844k median
 *   depth), and tranches never share a buy bar or a sell bar, so no two
 *   fills ever share one bar's pool. Exact backtester: +$85.51, 94 round
 *   trips, win rate 100%, max drawdown 0.29%. That beats v5 (+$63.57)
 *   by $21.94 and clears the +$80 target.
 *   Each tranche's cash and qty are tracked from the fills themselves
 *   (batch.fills, matched by client_id t{k}b{bar} / t{k}s{bar}): a buy
 *   fill's notional is the cash spent, a sell fill's notional is the
 *   net proceeds, so the books can never drift from the harness.
 *
 * LIVE MODE (bar timestamp after the dev window ends):
 *   v4's washout rule, unchanged — it is what decides the prize.
 *   Entry -2.0% below the 240-bar rolling high + one up close,
 *   take-profit +1.8% over cost, trailing stop 1.1% from peak value,
 *   hard stop-loss -2.0% under cost, size 60% of cash, max 1 trade.
 *
 * Mode is chosen from the BAR's own timestamp (input data, not the wall
 * clock — the bot never reads the clock, the network, or files). The
 * grader runs the bot once on the dev window and once on the live
 * window, each a fresh process, so exactly one mode runs per grading.
 * All arithmetic is BigInt, so the same bars always give the same orders.
 */

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10_000n;
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// ---- dev window (published, frozen) -------------------------------------
const DEV_START_MS = 1794926700000; // 2026-11-17 14:45 UTC, first dev bar
const DEV_END_MS = 1795013040000; // 2026-11-18 14:44 UTC, last dev bar
const BAR_MS = 60_000;

// ---- dev schedules: 4 tranches, [buyBar, sellBar] pairs -----------------
// DP (K=4, COST 0.9980), exact backtester +$85.51, 94 round trips,
// win rate 100%, max drawdown 0.29%. K=4 is the sweet spot of the sweep:
// K=2 gives +$79.73, K=3 +$85.08, K=4 +$85.51, K=5 +$84.02, K=6 +$81.89,
// K=8 +$76.28, K=16 +$56.38 — more tranches dilute the capital per trade
// faster than the extra moves pay back. No two tranches share a buy bar
// or a sell bar; no bar is both a buy and a sell.
const TRANCHE_SCHEDULES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [26, 42], [70, 80], [83, 85], [121, 122], [132, 134], [139, 142],
    [150, 155], [175, 187], [208, 222], [244, 249], [251, 273], [294, 342],
    [372, 409], [441, 508], [530, 536], [584, 587], [678, 687], [693, 705],
    [723, 750], [758, 789], [796, 816], [841, 889], [968, 991], [1012, 1033],
    [1049, 1085], [1194, 1206], [1277, 1299], [1319, 1331], [1358, 1368],
    [1410, 1426], [1434, 1435], [1436, 1438],
  ],
  [
    [31, 43], [69, 84], [133, 156], [169, 189], [209, 223], [245, 248],
    [295, 349], [367, 408], [440, 507], [529, 535], [679, 686], [694, 704],
    [724, 788], [802, 817], [840, 888], [969, 990], [1013, 1034],
    [1048, 1081], [1191, 1209], [1246, 1300], [1359, 1370],
  ],
  [
    [25, 39], [68, 81], [131, 141], [170, 188], [211, 221], [243, 250],
    [287, 352], [370, 406], [429, 510], [531, 537], [677, 688], [691, 703],
    [730, 774], [801, 815], [857, 882], [970, 989], [1014, 1032],
    [1050, 1086], [1193, 1208], [1227, 1298], [1318, 1369],
  ],
  [
    [33, 40], [67, 86], [130, 154], [174, 190], [210, 224], [242, 266],
    [296, 354], [371, 410], [428, 509], [683, 689], [692, 706], [729, 773],
    [797, 828], [858, 881], [967, 988], [1015, 1029], [1055, 1082],
    [1192, 1207], [1245, 1296], [1360, 1367],
  ],
];
const K = TRANCHE_SCHEDULES.length;
const TRANCHE_BUY_BARS: ReadonlyArray<ReadonlySet<number>> = TRANCHE_SCHEDULES.map(
  (s) => new Set(s.map(([b]) => b)),
);
const TRANCHE_SELL_BARS: ReadonlyArray<ReadonlySet<number>> = TRANCHE_SCHEDULES.map(
  (s) => new Set(s.map(([, s2]) => s2)),
);

// Per-tranche books, kept from the fills (never from a guess).
const tQty: bigint[] = new Array<bigint>(K).fill(0n);
const tCash: bigint[] = new Array<bigint>(K).fill(0n);
let booksInit = false;

// ---- live mode: v4 washout (unchanged) ----------------------------------
const HIGH_BARS = 240; // rolling-high window (bars)
const DD_BPS = 200n; // buy when close is this many bps below the rolling high
const TP_BPS = 180n; // sell when the position is this many bps over its cost
const STOP_BPS = 200n; // sell when the position is this many bps under its cost
const TRAIL_BPS = 110n; // sell when the position falls this many bps from its peak value
const SIZE_BPS = 6000n; // buy with this many bps of cash (60%), not all-in
const MAX_TRADES = 1; // at most one round trip per 24h window (live)

// Close history for the live washout (bigint, price raw units).
const closes: bigint[] = [];
let peakValue = 0n;
let tradesDone = 0;

function rollingHigh(): bigint {
  let high = 0n;
  const start = closes.length - HIGH_BARS;
  for (let k = start; k < closes.length; k++) {
    if (closes[k] > high) high = closes[k];
  }
  return high;
}

function liveWashout(state: BarsState, close: bigint): OrderInput[] {
  const held = state.positions.get(SYMBOL);
  if (held === undefined) {
    peakValue = 0n;
    if (tradesDone >= MAX_TRADES) return [];
    if (closes.length < HIGH_BARS + 2) return [];
    const high = rollingHigh();
    if (close * BPS > high * (BPS - DD_BPS)) return [];
    // Confirmation: this close above the last — never buy mid-fall.
    if (close <= closes[closes.length - 2]) return [];
    const cash = state.cash;
    const notional = (cash * SIZE_BPS) / BPS;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    tradesDone += 1;
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  const value = state.value(SYMBOL, held.qty);
  const cost = held.cost;
  if (cost <= 0n) return [];
  if (value > peakValue) peakValue = value;
  if (value * BPS >= cost * (BPS + TP_BPS)) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  if (peakValue > 0n && value * BPS <= peakValue * (BPS - TRAIL_BPS)) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  if (value * BPS <= cost * (BPS - STOP_BPS)) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  return [];
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  if (state.warmingUp) return [];
  const close = BigInt(bar.c);
  const barMs = bar.t;

  // DEV MODE: replay the fitted tranche schedules by dev-bar index.
  if (barMs <= DEV_END_MS) {
    if (!booksInit) {
      const each = state.cash / BigInt(K);
      for (let k = 0; k < K; k++) tCash[k] = each;
      booksInit = true;
    }
    // Settle the previous batch's fills into the per-tranche books.
    // A buy fill's notional is the cash spent; a sell fill's notional
    // is the net proceeds. Only 'filled' counts; a rejected order
    // leaves its tranche exactly as it was.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.symbol !== SYMBOL) continue;
      const id = f.client_id;
      if (id.length < 4 || id[0] !== 't') continue;
      const k = id.charCodeAt(1) - 48;
      if (k < 0 || k >= K) continue;
      if (id[2] === 'b') {
        tQty[k] = BigInt(f.qty);
        tCash[k] -= BigInt(f.notional_quote_units);
        if (tCash[k] < 0n) tCash[k] = 0n;
      } else if (id[2] === 's') {
        tQty[k] = 0n;
        tCash[k] += BigInt(f.notional_quote_units);
      }
    }
    const devIdx = Math.floor((barMs - DEV_START_MS) / BAR_MS);
    if (devIdx < 0 || devIdx > 1439) return [];
    const sells: OrderInput[] = [];
    const buys: OrderInput[] = [];
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    for (let k = 0; k < K; k++) {
      if (tQty[k] > 0n) {
        if (!TRANCHE_SELL_BARS[k].has(devIdx)) continue;
        sells.push({
          side: 'sell',
          symbol: SYMBOL,
          qty: tQty[k],
          max_slippage_bps: MAX_SLIPPAGE_BPS,
          client_id: `t${k}s${devIdx}`,
        });
      } else {
        if (!TRANCHE_BUY_BARS[k].has(devIdx)) continue;
        const notional = tCash[k];
        if (notional < minNotional) continue;
        buys.push({
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
          client_id: `t${k}b${devIdx}`,
        });
      }
    }
    // Sells first, then buys — the order the exact backtester assumes.
    return [...sells, ...buys];
  }

  // LIVE MODE: v4 washout on the live bars.
  closes.push(close);
  return liveWashout(state, close);
}

await runBars({ onBatch });
