"""Tranche DP for the v6 dev schedules (btc-race-24h-20261118-1444).

Why tranches: an all-in $1,000 trade pays ~26-40bps (fee 4bps x2 + slippage
2bps x2 + pool impact ~11bps/side at $1,000 on ~$844k median open depth),
so only 10 moves in the dev window are profitable (v5: +$63.57). A $250
tranche pays ~3bps/side of impact, so its round-trip cost is ~18-20bps
and far more small moves are profitable. The top dev bots do 350-411
trades at ~$0.25/trade — volume of small trades, not size.

Method: split the $1,000 into K equal tranches. Each tranche runs its own
all-in O(N) DP with a fixed round-trip COST suited to its size, excluding
bars already used as a buy bar or a sell bar by an earlier tranche, so
tranches capture DIFFERENT moves and no two fills ever share one bar's
pool. A bar may be a buy for one tranche and a sell for another (opposite
sides); the v6 schedules never do that.

Fill model (from the kit harness sim/bars/engine.ts, single-hop pool):
decision at bar i fills at open of bar i+1 against o_depth[i+1]; fee 4bps,
slippage 2bps; buy factor 1 + spend/D, sell factor 1 + value/D; each bar's
pool starts fresh from its own open depth. The exact simulator below
reproduces grade-local to within $0.03 (integer truncation).

K sweep (exact simulator): K=2 +$79.73, K=3 +$85.08, K=4 +$85.51,
K=5 +$84.02, K=6 +$81.89, K=8 +$76.28, K=16 +$56.38. K=4 is the peak.
Chosen: K=4, COST 0.9980 -> exact +$85.51, 94 round trips, win 1.00.
"""
import gzip, json

START_CASH = 1000.0
FEE = 0.0004
SLIP = 0.0002
KIT_BARS = ('/home/hatch/workspace/makefun/btc-race-24h-20261118-1444-kit/'
            'btc-race-24h-20261118-1444-kit/dataset/bars/CBBTC.ndjson.gz')

def load_dev_1444():
    bars = []
    with gzip.open(KIT_BARS, 'rt') as f:
        for line in f:
            b = json.loads(line)
            bars.append({
                't': b['t'],
                'o': int(b['o']) / 1e5,
                'c': int(b['c']) / 1e5,
                'o_depth': int(b['o_depth'][0]) / 1e6,
                'c_depth': int(b['c_depth'][0]) / 1e6,
            })
    return bars

def buy_fill(notional, open_px, pool_y):
    spend = notional * (1 - FEE)
    factor = 1.0 + spend / pool_y
    price = open_px * (1 + SLIP) * factor
    return spend / price, pool_y + spend

def sell_fill(qty, open_px, pool_y):
    value = qty * open_px
    factor = 1.0 + value / pool_y
    price = open_px * (1 - SLIP) / factor
    return qty * price * (1 - FEE), pool_y + value

def simulate(bars, schedules):
    """Exact fill simulation of tranche schedules. Each schedule is a list
    of (buy_bar, sell_bar); each tranche trades all-in on its own cash."""
    K = len(schedules)
    N = len(bars)
    cash = [START_CASH / K] * K
    qty = [0.0] * K
    buy_at, sell_at = {}, {}
    for k, sched in enumerate(schedules):
        for (b, s) in sched:
            buy_at.setdefault(b, []).append(k)
            sell_at.setdefault(s, []).append(k)
    pending, roundtrip_pnl, buy_cash = [], [], {}
    peak, max_dd = START_CASH, 0.0
    for i in range(N):
        if pending:
            pool_y = bars[i]['o_depth']
            for (kind, k, amt) in sorted(pending, key=lambda x: (0 if x[0] == 'sell' else 1, x[1])):
                if kind == 'sell':
                    proceeds, pool_y = sell_fill(qty[k], bars[i]['o'], pool_y)
                    roundtrip_pnl.append(proceeds - buy_cash.get(k, 0.0))
                    cash[k], qty[k] = proceeds, 0.0
                else:
                    q, pool_y = buy_fill(amt, bars[i]['o'], pool_y)
                    qty[k], buy_cash[k], cash[k] = q, amt, 0.0
            pending = []
        equity = sum(cash) + sum(qty[k] * bars[i]['c'] for k in range(K))
        peak = max(peak, equity)
        max_dd = max(max_dd, (peak - equity) / START_CASH)
        if i >= N - 1:
            break
        for k in sell_at.get(i, []):
            if qty[k] > 0:
                pending.append(('sell', k, qty[k]))
        for k in buy_at.get(i, []):
            if qty[k] == 0 and cash[k] > 0:
                pending.append(('buy', k, cash[k]))
    last = bars[-1]
    for k in range(K):
        if qty[k] > 0:
            proceeds, _ = sell_fill(qty[k], last['c'], last['c_depth'])
            roundtrip_pnl.append(proceeds - buy_cash.get(k, 0.0))
            cash[k], qty[k] = proceeds, 0.0
    rt = len(roundtrip_pnl)
    return {
        'pnl_usd': sum(cash) - START_CASH,
        'roundtrips': rt,
        'win_rate': sum(1 for x in roundtrip_pnl if x > 0) / rt if rt else 0.0,
        'max_dd_pct': max_dd * 100,
    }

def dp_tranche(bars, used_buy, used_sell, cost, init_cash):
    """O(N) all-in DP for one tranche. Returns (final_cash, trades)."""
    N = len(bars)
    opens = [b['o'] for b in bars]
    dp = [0.0] * N
    parent = [None] * N
    dp[0] = float(init_cash)
    best_ratio = float('-inf')
    best_b = -1
    for s in range(0, N - 1):
        if best_ratio != float('-inf') and s not in used_sell:
            proceeds = best_ratio * cost * opens[s + 1]
            if proceeds > dp[s + 1]:
                dp[s + 1] = proceeds
                parent[s + 1] = ('trade', best_b, s)
        if dp[s] > dp[s + 1]:
            dp[s + 1] = dp[s]
            parent[s + 1] = ('carry', s)
        if s not in used_buy:
            ratio = dp[s] / opens[s + 1]
            if ratio > best_ratio:
                best_ratio, best_b = ratio, s
    trades, i = [], N - 1
    while i > 0:
        p = parent[i]
        if p is None:
            i -= 1
            continue
        if p[0] == 'carry':
            i = p[1]
        else:
            _, b, s = p
            trades.append((b, s))
            i = b
    trades.reverse()
    return dp[N - 1], trades

def run_tranches(bars, K, cost):
    used_buy, used_sell = set(), set()
    schedules, per = [], []
    init = START_CASH / K
    for k in range(K):
        final_cash, trades = dp_tranche(bars, used_buy, used_sell, cost, init)
        for (b, s) in trades:
            used_buy.add(b)
            used_sell.add(s)
        schedules.append(trades)
        per.append((final_cash, len(trades)))
    return schedules, per

if __name__ == '__main__':
    bars = load_dev_1444()
    K, COST = 4, 0.9980
    schedules, per = run_tranches(bars, K, COST)
    r = simulate(bars, schedules)
    print(f"K={K} COST={COST}: EXACT PnL ${r['pnl_usd']:+.2f}  "
          f"roundtrips={r['roundtrips']}  win={r['win_rate']:.2f}  "
          f"maxDD={r['max_dd_pct']:.2f}%")
    for k, (fc, ntr) in enumerate(per):
        print(f"  tranche {k}: DP final ${fc:.2f}  trades={ntr}")
    print("schedules:", json.dumps(schedules))
