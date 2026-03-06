# ROTHSTEIN Filter Design
## Data-Driven Signal Filter for Independent Polymarket Trading

---

## Filter Philosophy

ROTHSTEIN operates in two modes:
1. **INDEPENDENT MODE**: Scans all active 5min BTC/ETH contracts every 15-30s. No whale trigger needed.
2. **WHALE-BOOSTED MODE**: When a whale trade is detected on a contract ROTHSTEIN is already watching, it adds bonus weight.

The filter is designed as a **scoring system**, not a binary pass/fail. Each signal contributes a score. Only trade when total score exceeds threshold.

---

## Primary Filters (Hard Gates)

These are non-negotiable. If ANY fails, the trade is rejected regardless of score.

### Gate 1: Asset
- **BTC or ETH only**
- SOL (44.65% WR) and XRP (46.24% WR) are below baseline — not worth the noise

### Gate 2: Contract Duration
- **5 minutes only** (initial phase)
- 5min: 51.54% WR, $92,936 total PnL (77% of all PnL)
- 15min: 50.84% WR — can add later once 5min is profitable
- 60min: 43.34% WR — avoid

### Gate 3: EdgeVsSpot Minimum
- **edgeVsSpot >= 0.05**
- Below 0: catastrophic (-$284k total PnL across negative buckets)
- 0-0.05: barely positive (52.66% WR)
- **>= 0.05 unlocks 58-66% WR territory**

### Gate 4: Entry Price Range
- **price >= 0.45 AND price <= 0.85**
- Below 0.45: WR under 47%, lottery tickets
- Above 0.85: WR 86%+ but payout too tiny ($0.15/share max) — not worth execution risk
- Sweet zone: 0.50-0.75 for best risk/reward

### Gate 5: Order Book Quality
- **bookSpread <= 0.04** (bid-ask spread)
- **orderBookDepth >= bet_size** (enough liquidity)
- If no book data available: SKIP (can't compute midEdge)

### Gate 6: Seconds Remaining
- **secsRemaining >= 90 AND secsRemaining <= 300** (for 5min contracts)
- Below 90s: prices are priced in, slippage kills you
- Above 300s: too early for 5min, uncertainty too high
- Sweet spot: 180-270s (3-4.5 minutes remaining)

---

## Scoring System (Soft Signals)

Each trade candidate receives a score from 0-100. Only trade if score >= **60**.

### Score Component 1: EdgeVsSpot (0-30 points)

| EdgeVsSpot Range | Points | Rationale |
|-----------------|--------|-----------|
| 0.05-0.10 | 10 | Minimal edge, 58.73% WR |
| 0.10-0.15 | 20 | Strong edge, 62.75% WR |
| 0.15-0.25 | 30 | Maximum edge zone, 65% WR |
| 0.25-0.30 | 25 | Still strong but diminishing |
| >0.30 | 15 | Overshoot risk — model may be wrong |

### Score Component 2: MidEdge (0-20 points)

| MidEdge Range | Points | Rationale |
|---------------|--------|-----------|
| < -0.20 | 20 | 71-84% WR territory, entry well below mid |
| -0.20 to -0.10 | 15 | 61-65% WR, solid entry |
| -0.10 to 0 | 10 | 52-57% WR, acceptable |
| 0 to 0.05 | 5 | 51.6% WR, neutral |
| > 0.05 | 0 | Above mid, no entry advantage |

### Score Component 3: Momentum Alignment (0-15 points)

| Condition | Points | Rationale |
|-----------|--------|-----------|
| Price direction matches bet direction | 15 | 60.69% WR vs 44.38% — massive signal |
| FLAT direction (delta30s near 0) | 5 | Neutral, no penalty |
| Direction opposes bet | 0 | 44.38% WR — dangerous |

### Score Component 4: Seconds Remaining (0-10 points)

| SecsRemaining | Points | Rationale |
|---------------|--------|-----------|
| 240-270 | 10 | Best volume + WR bucket (53.83%) |
| 210-240 | 8 | 53.05% WR |
| 180-210 | 6 | 51.22% WR, still good |
| 270-300 | 8 | 53.97% WR |
| 120-180 | 4 | Below sweet spot |
| 90-120 | 2 | Barely acceptable |

### Score Component 5: Market Activity / Volatility (0-10 points)

| Condition | Points | Rationale |
|-----------|--------|-----------|
| |delta30s| > 0.10 | 10 | Active market, ~54% WR, highest PnL |
| |delta30s| 0.05-0.10 | 7 | Moderate activity |
| |delta30s| 0.02-0.05 | 3 | Sluggish |
| |delta30s| < 0.02 | 0 | Dead market, worst buckets |

### Score Component 6: Whale Bonus (0-15 points, OPTIONAL)

Only applies if whale activity detected on same contract within last 60s.

| Condition | Points | Rationale |
|-----------|--------|-----------|
| Tier 1 wallet (0x571c, 0xf696, 0x0ea5), size >= $20 | 15 | Best wallets, convinced |
| Tier 1 wallet, any size | 10 | Good wallet |
| Tier 2 wallet (0x63ce, 0x37c9), size >= $20 | 8 | Decent wallet, convicted |
| Any wallet, size >= $50 | 12 | Size = conviction signal (66.63% WR) |
| 2 concurrent whales on same contract | 7 | 53.17% WR — modest boost |
| 3+ concurrent whales | 3 | Diminishing returns |

### Score Component 7: Hour-of-Day Bonus (0-5 points)

| Hour (UTC) | Points | WR% |
|------------|--------|-----|
| 6, 8, 11, 23 | 5 | 53.5-54.9% |
| 3, 4, 13, 21 | 3 | 52-53% |
| 15, 16 | -5 (penalty) | 45-47% — WORST hours |

---

## Composite Score Thresholds

| Total Score | Action | Sizing |
|-------------|--------|--------|
| < 40 | **SKIP** — insufficient edge | $0 |
| 40-49 | **LOG ONLY** — shadow mode, track for validation | $0 |
| 50-59 | **SMALL** — minimum bet for data collection | $2-3 |
| 60-69 | **STANDARD** — moderate confidence | $5-8 |
| 70-79 | **ELEVATED** — strong conviction | $10-15 |
| 80-89 | **HIGH** — multiple signals aligned | $15-20 |
| 90+ | **MAXIMUM** — everything aligned | $20-25 |

---

## Example Scoring Walkthrough

**Scenario**: BTC 5min contract, 240s remaining, price 0.62, edgeVsSpot 0.14, midEdge -0.12, delta30s -0.08 (DOWN), bet side = DOWN (momentum aligned), hour = 8 UTC, whale 0x571c just bet $30 on same contract.

| Component | Value | Points |
|-----------|-------|--------|
| EdgeVsSpot | 0.14 (0.10-0.15 range) | 20 |
| MidEdge | -0.12 (-0.20 to -0.10 range) | 15 |
| Momentum | Aligned (DOWN matches DOWN) | 15 |
| SecsRemaining | 240 (240-270 sweet spot) | 10 |
| Market Activity | |delta30s| = 0.08 (moderate) | 7 |
| Whale Bonus | 0x571c Tier 1, $30 >= $20 | 15 |
| Hour Bonus | 8 UTC (good hour) | 5 |
| **TOTAL** | | **87** |

**Action**: HIGH confidence trade, bet $15-20.

---

## Anti-Filter: Conditions to NEVER Trade

Even if score looks good, abort if:
1. **polyMid = 0** — no order book data, flying blind
2. **bookSpread > 0.06** — illiquid, will get slipped
3. **secsRemaining < 30** — contract about to resolve, no time for order
4. **Already have position on this contract** — no stacking
5. **5+ open positions** — concentration risk
6. **Session loss > -$30** — circuit breaker, pause 30 minutes
7. **Hourly loss > -$15** — throttle, reduce sizing to minimum for 15 minutes
8. **Price = 0.50 exactly** — coin flip, zero edge regardless of other signals

---

## Validation Plan

Before going live, ROTHSTEIN should run in **shadow mode** for 24-48 hours:
1. Compute scores for every candidate opportunity
2. Log: timestamp, contract, score, all components, would-have-bet amount
3. Track resolution: would this have won?
4. Compare: shadow WR vs predicted WR at each score tier
5. **Only go live if shadow WR >= 58% at score >= 60**

---

## Filter Evolution (Post-Launch)

After 1 week of live data:
1. Re-run analysis on ROTHSTEIN's own trades (not whale trades)
2. Recalibrate score weights based on actual performance
3. Add new signals if data supports them:
   - Cross-asset divergence (ETH moving while BTC flat)
   - Volume regime changes
   - Contract-specific patterns (certain titles/windows)
4. Consider logistic regression to replace hand-tuned weights
