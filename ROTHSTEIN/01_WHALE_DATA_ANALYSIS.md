# Whale Trades Data Analysis — Surgical Breakdown
## 736,274 Unique Trades | 617,916 Resolved | 4.8 Days | March 3-6, 2026

---

## Overall Statistics

| Metric | Value |
|--------|-------|
| Total resolved trades | 617,916 |
| Wins / Losses | 316,352 / 301,564 |
| **Overall Win Rate** | **51.20%** |
| Average PnL/trade | $0.1936 |
| Median PnL/trade | $0.1323 |
| Total PnL | $119,657 |
| Data span | 4.8 days |
| Trades/day | ~128,670 |

**Interpretation**: The raw whale baseline is 51.2% — barely above coin-flip. The whales are NOT magic. Their edge comes from WHICH trades they pick and the CONDITIONS around those trades. Our job is to find the conditions that push WR dramatically above baseline.

---

## 1. EdgeVsSpot — THE STRONGEST SINGLE PREDICTOR

Black-Scholes fair value minus market price. Positive = market underpricing the outcome.

| Bucket | Trades | WR% | WR Lift | Avg PnL | Total PnL |
|--------|--------|-----|---------|---------|-----------|
| <-0.15 | 73,229 | 40.83% | -10.37% | -$1.71 | -$125,550 |
| -0.15:-0.10 | 46,082 | 37.12% | -14.08% | -$1.45 | -$66,972 |
| -0.10:-0.05 | 65,836 | 40.64% | -10.56% | -$1.03 | -$67,627 |
| -0.05:0 | 87,396 | 44.51% | -6.69% | -$0.27 | -$23,975 |
| **0:0.05** | 94,333 | **52.66%** | +1.47% | +$0.20 | +$19,078 |
| **0.05:0.10** | 80,533 | **58.73%** | +7.53% | +$0.79 | +$63,898 |
| **0.10:0.15** | 59,914 | **62.75%** | +11.56% | +$1.45 | +$86,639 |
| **0.15:0.20** | 40,516 | **65.53%** | +14.34% | +$1.92 | +$77,651 |
| **0.20:0.25** | 24,624 | **64.95%** | +13.75% | +$2.34 | +$57,625 |
| **0.25:0.30** | 14,789 | **65.09%** | +13.89% | +$2.85 | +$42,200 |
| >0.30 | 22,863 | 54.46% | +3.27% | +$2.35 | +$53,683 |

**FINDINGS**:
- **Sweet spot: 0.10-0.25** — WR 62-66%, consistent massive positive PnL
- Below 0: catastrophic. Every negative bucket loses money
- Above 0.30: WR drops to 54% — overshoot means the model is wrong or market is right
- **MANDATORY FILTER**: edgeVsSpot >= 0.05 (conservative) or >= 0.10 (aggressive)

---

## 2. MidEdge — Entry Quality vs Book Mid

Negative = whale bought BELOW mid (good entry). Positive = above mid (paid premium).

| Bucket | Trades | WR% | WR Lift | Avg PnL | Total PnL |
|--------|--------|-----|---------|---------|-----------|
| **<-0.30** | 32,988 | **83.76%** | +32.56% | +$0.74 | +$24,562 |
| **-0.30:-0.20** | 42,950 | **71.92%** | +20.72% | -$0.08 | -$3,341 |
| **-0.20:-0.15** | 34,061 | **65.27%** | +14.08% | -$0.44 | -$14,886 |
| -0.15:-0.10 | 46,327 | 61.13% | +9.93% | -$0.37 | -$17,195 |
| -0.10:-0.05 | 63,338 | 56.78% | +5.59% | -$0.06 | -$4,029 |
| -0.05:0 | 85,890 | 51.51% | +0.31% | -$0.30 | -$26,095 |
| 0:0.05 | 88,212 | 51.63% | +0.44% | +$0.58 | +$50,718 |
| 0.05:0.10 | 62,803 | 47.39% | -3.80% | +$0.57 | +$35,852 |
| >0.10 | 160,895 | 32.01% | -19.18% | +$0.45 | +$72,955 |

**FINDINGS**:
- **Paradox Alert**: Very negative midEdge (great entry) has highest WR but NEGATIVE avg PnL in mid ranges
- Why? Because extreme negative midEdge often means the contract is trading at extreme prices (0.90+), so the absolute PnL per share is tiny even when winning
- **<-0.30 is gold**: 83.76% WR with positive PnL — best single bucket
- **>0.10 has 32% WR** — trading above mid is disastrous for WR but positive PnL due to high-odds contracts
- **FILTER**: midEdge < 0 preferred, < -0.10 strong signal

---

## 3. Seconds Remaining — Time-Based Edge

| Bucket | Trades | WR% | WR Lift | Avg PnL | Total PnL |
|--------|--------|-----|---------|---------|-----------|
| 0-15 | 7,165 | 54.35% | +3.15% | +$0.18 | +$1,286 |
| 15-30 | 8,694 | 48.82% | -2.38% | +$0.19 | +$1,690 |
| 30-45 | 12,529 | 47.99% | -3.20% | +$0.04 | +$462 |
| 45-60 | 14,822 | 48.66% | -2.54% | -$0.25 | -$3,655 |
| 60-90 | 36,749 | 46.48% | -4.72% | -$0.09 | -$3,246 |
| 90-120 | 38,556 | 49.09% | -2.10% | +$0.02 | +$814 |
| 120-150 | 47,847 | 50.66% | -0.54% | -$0.02 | -$1,111 |
| 150-180 | 62,978 | 49.78% | -1.41% | -$0.11 | -$7,105 |
| **180-210** | 73,217 | **51.22%** | +0.03% | +$0.17 | +$12,649 |
| **210-240** | 78,318 | **53.05%** | +1.85% | +$0.41 | +$31,933 |
| **240-270** | 87,302 | **53.83%** | +2.63% | +$0.54 | +$47,150 |
| **270-300** | 39,959 | **53.97%** | +2.77% | +$0.71 | +$28,193 |
| 300-450 | 20,424 | 50.62% | -0.58% | +$0.94 | +$19,223 |
| 450-600 | 21,722 | 50.02% | -1.17% | +$0.15 | +$3,330 |
| 600-900 | 50,142 | 51.24% | +0.05% | -$0.25 | -$12,581 |
| >900 | 10,518 | 46.37% | -4.83% | -$0.11 | -$1,169 |

**FINDINGS**:
- **Sweet spot for 5min contracts: 180-300s** (3-5 minutes remaining)
- Early entry (240-270s) gives best volume + decent WR
- Too late (<60s) = WR drops, prices are mostly priced in
- Too early (>600s) = too much uncertainty, noise dominates
- **FILTER for 5min**: secsRemaining 180-300 (optimal) or 120-300 (wider)

---

## 4. Entry Price — Where the Money Is

| Bucket | Trades | WR% | WR Lift | Avg PnL | Total PnL |
|--------|--------|-----|---------|---------|-----------|
| 0-0.10 | 14,457 | 3.60% | -47.60% | -$0.66 | -$9,478 |
| 0.10-0.20 | 25,778 | 14.91% | -36.29% | +$0.11 | +$2,827 |
| 0.20-0.30 | 49,839 | 25.47% | -25.73% | +$0.17 | +$8,549 |
| 0.30-0.40 | 80,700 | 36.53% | -14.67% | +$0.42 | +$33,984 |
| 0.40-0.50 | 121,416 | 47.22% | -3.97% | +$0.38 | +$46,674 |
| **0.50-0.55** | 67,740 | **53.77%** | +2.57% | +$0.44 | +$29,624 |
| **0.55-0.60** | 61,981 | **56.42%** | +5.22% | -$0.38 | -$23,246 |
| **0.60-0.65** | 57,452 | **62.89%** | +11.70% | +$0.11 | +$6,393 |
| **0.65-0.70** | 43,335 | **67.94%** | +16.74% | +$0.07 | +$3,152 |
| **0.70-0.75** | 33,614 | **71.67%** | +20.47% | -$0.10 | -$3,448 |
| 0.75-0.80 | 24,711 | 78.79% | +27.59% | +$0.49 | +$12,133 |
| 0.80-0.85 | 17,163 | 82.55% | +31.35% | +$0.53 | +$9,121 |
| 0.85-0.90 | 10,596 | 86.62% | +35.42% | -$0.12 | -$1,291 |
| 0.90-0.95 | 6,731 | 93.14% | +41.94% | +$0.52 | +$3,479 |
| 0.95-1.00 | 2,403 | 97.42% | +46.22% | +$0.49 | +$1,184 |

**FINDINGS**:
- Higher price = higher WR (trivially — you're betting on the likely outcome)
- But the PnL SWEET SPOT is 0.50-0.70: decent WR (54-68%) with meaningful payout
- Below 0.40: WR tanks, these are lottery tickets
- Above 0.80: WR 82%+ but payout per win is tiny ($0.20/share max)
- **FILTER**: price 0.50-0.80 (balanced); 0.55-0.75 (aggressive)

---

## 5. Delta30s — 30-Second Momentum

| Bucket | Trades | WR% | WR Lift | Avg PnL | Total PnL |
|--------|--------|-----|---------|---------|-----------|
| <-0.10 | 39,130 | **53.98%** | +2.78% | +$1.00 | +$39,040 |
| -0.10:-0.05 | 80,461 | 50.75% | -0.45% | +$0.19 | +$15,544 |
| -0.05:-0.02 | 102,019 | 51.21% | +0.01% | +$0.20 | +$20,736 |
| -0.02:-0.01 | 40,129 | 50.68% | -0.51% | +$0.13 | +$5,404 |
| -0.01:0 | 41,765 | 50.46% | -0.74% | -$0.17 | -$7,194 |
| 0:0.01 | 49,214 | 49.90% | -1.29% | -$0.26 | -$12,850 |
| 0.01:0.02 | 42,464 | 48.64% | -2.56% | -$0.44 | -$18,556 |
| 0.02:0.05 | 98,937 | 50.37% | -0.83% | -$0.04 | -$3,555 |
| 0.05:0.10 | 82,211 | 52.68% | +1.48% | +$0.48 | +$39,824 |
| >0.10 | 41,586 | **53.84%** | +2.64% | +$0.99 | +$41,264 |

**FINDINGS**:
- **Extreme deltas win**: Both <-0.10 and >0.10 outperform
- Near-zero deltas (stagnant market) have WORST performance
- This is NOT about direction — it's about VOLATILITY. High delta means the market is moving, creating mispricing opportunities
- **FILTER**: |delta30s| > 0.05 preferred (active market)

---

## 6. Delta5m — 5-Minute Trend

| Bucket | Trades | WR% | WR Lift | Avg PnL | Total PnL |
|--------|--------|-----|---------|---------|-----------|
| <-0.20 | 69,339 | 51.02% | -0.17% | +$0.54 | +$37,319 |
| -0.20:-0.10 | 81,247 | 51.51% | +0.32% | +$0.16 | +$12,714 |
| -0.10:-0.05 | 65,979 | 51.24% | +0.04% | +$0.10 | +$6,398 |
| All other | ~290k | ~51% | ~0% | ~$0.05 | ~$20k |
| >0.20 | 75,990 | 51.41% | +0.22% | +$0.55 | +$42,081 |

**FINDINGS**:
- Delta5m has ALMOST NO predictive power on its own. All buckets hover around 51%.
- The extremes (<-0.20 and >0.20) have slightly higher PnL but identical WR
- **NOT a primary filter** — use only in combination with other signals
- Confirms that 5-minute trend is too noisy to be independently useful

---

## 7. Contract Duration

| Duration | Trades | WR% | Avg PnL | Total PnL |
|----------|--------|-----|---------|-----------|
| **5 min** | 483,201 | **51.54%** | +$0.19 | +$92,936 |
| 15 min | 118,857 | 50.84% | +$0.24 | +$28,228 |
| 60 min | 15,719 | 43.34% | -$0.10 | -$1,620 |

**FINDINGS**: 5min contracts have the best WR and generate 77% of total PnL. **Focus on 5min contracts**.

---

## 8. Concurrent Whales

| Count | Trades | WR% | WR Lift | Total PnL |
|-------|--------|-----|---------|-----------|
| 1 | 73,030 | 50.07% | -1.13% | +$14,331 |
| 2 | 83,391 | **53.17%** | +1.98% | +$17,751 |
| 3 | 79,276 | 50.66% | -0.54% | +$15,998 |
| 4 | 94,063 | 50.89% | -0.30% | +$34,437 |
| 5 | 164,255 | 51.79% | +0.59% | +$32,710 |
| 6 | 123,901 | 50.32% | -0.88% | +$4,431 |

**FINDINGS**:
- Concurrent whales show VERY WEAK signal in this dataset
- 2 whales has the best WR (53.17%) but lift is only +2%
- The architecture doc's claim of "73.5% WR at 3 concurrent" is NOT supported by this data
- **Not a primary filter**, but can be a minor bonus signal

---

## 9. Wallet Performance

| Wallet | Trades | WR% | WR Lift | Total PnL |
|--------|--------|-----|---------|-----------|
| **0x571c** | 62,441 | **57.15%** | +5.95% | +$15,772 |
| **0xf696** | 99,347 | **55.84%** | +4.65% | +$14,530 |
| **0x0ea5** | 121,298 | **55.71%** | +4.51% | +$2,782 |
| 0x1979 | 41 | 51.22% | +0.02% | +$14 |
| 0x37c9 | 26,467 | 48.97% | -2.23% | +$3,084 |
| 0x63ce | 132,580 | 48.66% | -2.54% | +$55,519 |
| 0x1d00 | 28 | 46.43% | -4.77% | +$527 |
| 0x2d8b | 173,436 | 45.85% | -5.35% | +$28,073 |
| 0xa9ae | 2,278 | 25.90% | -25.30% | -$644 |

**FINDINGS**:
- **Tier 1 wallets**: 0x571c (57.15%), 0xf696 (55.84%), 0x0ea5 (55.71%)
- **0x63ce** has mediocre WR (48.66%) but HIGHEST total PnL ($55,519) — trades larger
- **0x2d8b** is the worst active wallet (45.85% WR) — filter OUT or weight down
- **0xa9ae** is catastrophic (25.90%) — monitor-only is correct
- **FILTER**: Weight Tier 1 wallet signals higher. 0x2d8b signals should be deprioritized.

---

## 10. Session (Time of Day)

| Session | Hours (UTC) | Trades | WR% | Total PnL |
|---------|-------------|--------|-----|-----------|
| **LATE_US** | 21-00 | 51,980 | **53.31%** | -$7,703 |
| ASIA | 00-08 | 232,217 | 51.97% | +$22,876 |
| EUROPE | 08-14 | 177,673 | 51.51% | +$67,268 |
| US | 14-21 | 156,046 | 48.98% | +$37,217 |

**FINDINGS**:
- **EUROPE session dominates PnL** (+$67k) with decent WR
- **US session has worst WR** (48.98%) — most competitive, hardest to trade
- LATE_US has highest WR but negative PnL (low volume, high variance)
- **Best hours**: 6 UTC (54.9%), 8 UTC (53.5%), 11 UTC (54.1%), 23 UTC (54.8%)
- **Worst hours**: 15 UTC (45.4%), 16 UTC (46.9%)

---

## 11. Momentum Alignment

| Aligned | Trades | WR% | WR Lift | Total PnL |
|---------|--------|-----|---------|-----------|
| **TRUE** | 258,399 | **60.69%** | +9.49% | +$325,334 |
| FALSE | 359,517 | 44.38% | -6.82% | -$205,677 |

**FINDINGS**:
- **MASSIVE signal**: +9.5% WR lift when bet direction matches price direction
- This is the 2nd strongest single predictor after price
- BUT: only 42% of trades are momentum-aligned, so requiring it kills volume
- **FILTER**: Use as a STRONG weight, not a hard gate. Or use it as tie-breaker.

---

## 12. Whale Trade Size (USDC)

| Size | Trades | WR% | WR Lift | Total PnL |
|------|--------|-----|---------|-----------|
| 0-5 | 310,200 | 45.49% | -5.70% | +$16,432 |
| 5-10 | 117,095 | 54.96% | +3.76% | +$10,864 |
| **10-20** | 87,525 | **55.93%** | +4.73% | +$20,785 |
| **20-30** | 40,716 | **56.64%** | +5.44% | +$31,991 |
| **30-50** | 38,843 | **60.37%** | +9.18% | +$15,829 |
| **50-100** | 19,417 | **66.63%** | +15.44% | +$38,376 |
| 100-200 | 2,871 | 57.19% | +6.00% | -$17,959 |
| 200-500 | 1,215 | 67.24% | +16.05% | +$5,834 |

**FINDINGS**:
- Whale conviction matters: bigger bets = higher WR
- **$50-100 is the sweet spot**: 66.63% WR, highest total PnL per-trade
- Sub-$5 trades are noise (45.5% WR) — whales throwing darts
- **FILTER for whale signals**: usdcSize >= $10 minimum, ideally >= $20

---

## 13. Asset

| Asset | Trades | WR% | Total PnL |
|-------|--------|-----|-----------|
| **ETH** | 71,952 | **54.60%** | +$8,429 |
| BTC | 523,395 | 50.98% | +$106,644 |
| XRP | 10,158 | 46.24% | +$846 |
| SOL | 12,411 | 44.65% | +$3,738 |

**FINDINGS**: ETH has highest WR. BTC has most volume/PnL. SOL/XRP are noise — too few trades, below-baseline WR. **Focus on BTC + ETH**.

---

## TOP 2-FACTOR COMBINATIONS (WR, min 50 trades)

| Combo | N | WR% | Lift | Avg PnL |
|-------|---|-----|------|---------|
| Edge 0-0.10 & Price >0.80 | 16,881 | **89.57%** | +38.37% | +$0.65 |
| Edge 0.10-0.20 & Price >0.80 | 8,190 | **89.12%** | +37.92% | +$1.10 |
| Price >0.80 & Secs 180-300 | 7,465 | **88.16%** | +36.96% | +$1.18 |
| Edge 0.10-0.20 & MidEdge <-0.20 | 17,145 | **82.19%** | +31.00% | +$1.37 |
| Edge 0-0.10 & MidEdge <-0.20 | 26,264 | **81.56%** | +30.36% | +$0.64 |
| Edge >0.20 & Price 0.70-0.80 | 5,687 | **81.52%** | +30.32% | +$1.91 |
| Edge 0.10-0.20 & Price 0.70-0.80 | 15,252 | **80.83%** | +29.63% | +$1.33 |
| Edge >0.20 & Price 0.60-0.70 | 12,704 | **78.93%** | +27.73% | +$3.23 |

---

## TOP 3-FACTOR COMBINATIONS (min 30 trades)

| EdgeVsSpot | MidEdge | SecsRemaining | N | WR% | Avg PnL |
|-----------|---------|---------------|---|-----|---------|
| 0-0.10 | <-0.20 | 0-60 | 3,259 | **88.92%** | +$0.08 |
| 0.10-0.20 | <-0.20 | 0-60 | 2,381 | **86.94%** | +$0.75 |
| 0.10-0.20 | <-0.20 | 180-300 | 4,234 | **83.21%** | +$2.53 |
| >0.20 | <-0.20 | 180-300 | 1,004 | **82.67%** | +$3.36 |
| 0-0.10 | <-0.20 | 60-120 | 4,660 | **82.64%** | +$0.14 |
| 0.10-0.20 | <-0.20 | 60-120 | 3,823 | **82.08%** | +$0.82 |

**KEY INSIGHT**: EdgeVsSpot + MidEdge <-0.20 + ANY time window = 80%+ WR consistently

---

## Data Distributions (for calibrating thresholds)

| Parameter | Mean | Median | P5 | P25 | P75 | P95 |
|-----------|------|--------|----|----|-----|-----|
| edgeVsSpot | 0.0175 | 0.0174 | -0.236 | -0.073 | 0.107 | 0.270 |
| midEdge | 0.0033 | 0.0040 | -0.305 | -0.105 | 0.105 | 0.325 |
| secsRemaining | 280.6 | 211.0 | 47 | 143 | 266 | 805 |
| price | 0.502 | 0.510 | 0.170 | 0.380 | 0.630 | 0.810 |
| delta30s | 0.001 | 0.000 | -0.111 | -0.038 | 0.040 | 0.113 |
| delta5m | 0.006 | 0.006 | -0.305 | -0.096 | 0.111 | 0.306 |
| usdcSize | 11.73 | 4.96 | 0.37 | 2.39 | 12.82 | 44.80 |
