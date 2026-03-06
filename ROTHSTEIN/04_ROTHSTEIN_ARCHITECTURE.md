# ROTHSTEIN — Architecture Document
## Independent Prediction Bot for Polymarket 5-Minute BTC/ETH Contracts

---

## Design Principles

1. **TypeScript, not Python** — Share infrastructure with spy server. Reuse proven WS connections, Black-Scholes pricing, and CLOB integration.
2. **One file, one job** — Every module has a single responsibility. No god objects.
3. **Score-based, not binary** — Continuous confidence scoring replaces pass/fail filters.
4. **Data-first** — Every decision is logged. Every candidate is scored even if not traded. Build the training dataset from day one.
5. **Independent-first, whale-boosted** — Scan contracts without waiting for whales. Whale activity is a bonus signal, not a trigger.
6. **Fail gracefully** — Every external call can fail. Every module can degrade without crashing the system.

---

## Lessons from V1 and V2 Failures

### V1 (GP Bot OG) Problems We WILL NOT Repeat
- **God object executor**: handled positions, execution, settings, stats, logging, mode switching all in one file. ROTHSTEIN splits these into 7+ focused modules.
- **Listener callback pattern**: error in one listener kills all processing. ROTHSTEIN uses explicit sequential orchestration.
- **No side-aware PnL**: BUY/SELL PnL computed identically. ROTHSTEIN isolates PnL as pure functions.
- **O(n) concurrent whale scan**: scanning 5000 trades per evaluation. ROTHSTEIN uses pre-indexed Maps.

### V2 Problems We WILL NOT Repeat
- **Incomplete inactive hours**: referenced but never fully implemented. ROTHSTEIN has explicit hour-of-day scoring.
- **Take-profit race condition**: both resolution check and TP check could fire SELL simultaneously. ROTHSTEIN uses atomic position state transitions.
- **First-poll seeding opacity**: impossible to verify boot completed correctly. ROTHSTEIN logs explicit "ready" events.
- **No independent scanning**: still required whale trigger. ROTHSTEIN scans by default.

### V1/V2 Things We WILL Keep
- V2's layered architecture (with layer comments)
- V1's battle-tested Binance WS reconnection with exponential backoff
- V1's Polymarket WS + REST book fallback chain
- V1's Black-Scholes fair value computation
- V2's centralized PnL pure functions
- V2's version-gated dashboard broadcasts
- V1's comprehensive CSV decision logging

---

## Module Structure

```
ROTHSTEIN/
  src/
    index.ts              # Boot + graceful shutdown (Layer 4 - wiring only)
    config.ts             # All constants, thresholds, env vars (Layer 0)
    types.ts              # TypeScript interfaces & enums (Layer 0)
    logger.ts             # Structured event logging (Layer 0)

    # --- Data Layer ---
    binance-feed.ts       # Binance WS connection + price/delta/vol tracking (Layer 1)
    polymarket-book.ts    # Polymarket WS + REST book + subscription management (Layer 1)
    contract-scanner.ts   # Gamma API: find active 5m/15m contracts, metadata (Layer 1)
    whale-listener.ts     # Connect to spy server WS, receive whale events (Layer 1)

    # --- Computation Layer ---
    pricing.ts            # Black-Scholes fair value, edgeVsSpot, midEdge (Layer 2)
    features.ts           # Feature vector assembly for any contract (Layer 2)
    scorer.ts             # Score computation: features -> 0-100 score (Layer 2)
    pnl.ts                # Pure PnL functions (Layer 0)

    # --- Decision Layer ---
    scanner.ts            # Main loop: scan contracts, compute scores, emit candidates (Layer 3)
    trader.ts             # Execute trades: FOK order placement, paper/live (Layer 3)
    positions.ts          # Position state: open, resolved, expired (Layer 3)
    risk.ts               # Portfolio constraints, circuit breakers, session limits (Layer 2)

    # --- Persistence Layer ---
    persistence.ts        # JSONL append, CSV rotation, file I/O (Layer 1)
    decisions-log.ts      # Log EVERY scored opportunity, traded or not (Layer 2)

    # --- Interface Layer ---
    server.ts             # HTTP + WS server for dashboard (Layer 4)
    clob.ts               # Polymarket CLOB API wrapper (Layer 1)

  dashboard/
    index.html            # ROTHSTEIN dashboard (separate folder, clean)

  package.json
  tsconfig.json
  .env.example
  .gitignore
```

---

## Data Flow

```
                    ┌─────────────────┐
                    │  Binance WS     │ BTC/ETH ticks every ~100ms
                    │  (binance-feed) │
                    └────────┬────────┘
                             │ price, delta30s, delta5m, vol1h, direction
                             ▼
┌───────────────┐   ┌────────────────────┐   ┌──────────────────┐
│ Contract      │   │  UNIFIED STATE     │   │ Polymarket WS    │
│ Scanner       │──▶│                    │◀──│ (polymarket-book) │
│ (Gamma API)   │   │  assetPrices{}     │   │                  │
│ every 30s     │   │  contracts{}       │   │ bid/ask per token │
└───────────────┘   │  books{}           │   └──────────────────┘
                    │  whaleActivity{}   │
┌───────────────┐   │  positions{}       │
│ Whale         │──▶│  sessionStats{}    │
│ Listener      │   └────────┬───────────┘
│ (spy server)  │            │
└───────────────┘            │ every 15-30 seconds
                             ▼
                    ┌────────────────────┐
                    │  SCANNER           │
                    │                    │
                    │  For each active   │
                    │  5min contract:    │
                    │  1. features.ts    │──▶ Assemble 20-feature vector
                    │  2. scorer.ts      │──▶ Compute 0-100 score
                    │  3. decisions-log  │──▶ LOG every candidate
                    │  4. risk.ts check  │──▶ Portfolio constraints
                    │  5. If score >= 60 │
                    │     → trader.ts    │──▶ Place order
                    └────────────────────┘
                             │
                    ┌────────▼───────────┐
                    │  POSITIONS         │
                    │                    │
                    │  Track open bets   │
                    │  Check resolution  │
                    │  Compute P&L       │
                    │  Trigger TP/exit   │
                    └────────────────────┘
```

---

## Module Specifications

### `binance-feed.ts` (Layer 1)

**Responsibility**: Single persistent Binance WS connection. Track BTC + ETH prices with rolling 10-minute history.

**Exports**:
```typescript
getPrice(symbol: 'BTC' | 'ETH'): number | null
getDelta30s(symbol: 'BTC' | 'ETH'): number
getDelta5m(symbol: 'BTC' | 'ETH'): number
getDirection(symbol: 'BTC' | 'ETH'): 'UP' | 'DOWN' | 'FLAT'
getVol1h(symbol: 'BTC' | 'ETH'): number | null
isStale(): boolean  // >30s since last tick
```

**Key Design**:
- Exponential backoff on disconnect (100ms -> 1s -> 5s -> 30s max)
- REST fallback if WS dead for >60s
- Emit 'ready' event after first price received
- Per-asset price history (not shared BTC history like v1 initially had)

### `polymarket-book.ts` (Layer 1)

**Responsibility**: Maintain order books for all subscribed tokens.

**Exports**:
```typescript
subscribe(tokenIds: string[]): void
getBook(tokenId: string): { bid: number, ask: number, mid: number, spread: number, lastUpdate: number } | null
isBookFresh(tokenId: string, maxAgeMs?: number): boolean
```

**Key Design**:
- Only update book on messages with actual asks/bids arrays (learned from v1 bug)
- REST fallback for empty books (rate-limited per token, 10s minimum)
- Proactive refresh every 15s for empty books
- Track lastUpdate timestamp per token

### `contract-scanner.ts` (Layer 1)

**Responsibility**: Find active 5min BTC/ETH contracts via Gamma API.

**Exports**:
```typescript
getActiveContracts(): ContractInfo[]
scanForNewContracts(): Promise<ContractInfo[]>  // called every 30s
```

**Key Design**:
- Fetch from Gamma `/events` API with appropriate filters
- Cache contract metadata (conditionId, tokenIds, startTs, endTs, strikePrice, duration)
- Pre-subscribe token IDs to polymarket-book before contract starts
- Parse window start/end from title (reuse spy server's regex logic)

### `whale-listener.ts` (Layer 1)

**Responsibility**: Connect to spy server's WS and receive whale trade events as bonus signals.

**Exports**:
```typescript
getRecentWhaleActivity(conditionId: string): WhaleSignal | null
onWhaleEvent(callback: (event: WhaleEvent) => void): void
```

**Key Design**:
- Connect to spy server at localhost:3333 (or configurable)
- Extract: wallet, side, outcome, size, price, conditionId
- Index by conditionId for O(1) lookup
- Expire entries after 120s (whale signal goes stale fast)
- If spy server is down, ROTHSTEIN continues without whale signals (graceful degradation)

### `pricing.ts` (Layer 2)

**Responsibility**: Black-Scholes binary option pricing and edge computation.

**Exports**:
```typescript
computeFairValue(params: PricingParams): number  // 0-1 probability
computeEdgeVsSpot(fairValue: number, marketPrice: number): number
computeRealizedVol(priceHistory: PricePoint[], windowMs?: number): number
```

**Key Design**:
- Reuse spy server's proven Black-Scholes implementation
- Standard normal CDF via Abramowitz & Stegun approximation
- Volatility: 5-min window, 5s resampling, 20-200% floor/cap
- Near-expiry handling (<1s: deterministic 0.99/0.01)

### `features.ts` (Layer 2)

**Responsibility**: Assemble the complete feature vector for any contract.

**Exports**:
```typescript
computeFeatures(contract: ContractInfo, side: 'Up' | 'Down'): FeatureVector | null
```

**Feature Vector** (20 fields):
```typescript
interface FeatureVector {
  // Market state (from binance-feed)
  spotPrice: number
  delta30s: number
  delta5m: number
  vol1h: number
  priceDirection: 'UP' | 'DOWN' | 'FLAT'

  // Contract state (from polymarket-book + contract-scanner)
  polyMid: number
  bookSpread: number
  orderBookDepth: number
  secsRemaining: number

  // Derived (from pricing.ts)
  edgeVsSpot: number
  midEdge: number  // for independent scanning: polyMid - bestAsk/bestBid

  // Alignment
  momentumAligned: boolean
  priceAcceleration: number  // delta5m - delta30s

  // Temporal
  hourOfDay: number
  contractAge: number  // duration - secsRemaining

  // Whale (from whale-listener, 0 if no whale)
  concurrentWhales: number
  bestWalletTier: number  // 0=none, 1=tier1, 2=tier2, 3=tier3
  whaleMaxSize: number
  whaleAgreement: boolean  // all same side?
}
```

### `scorer.ts` (Layer 2)

**Responsibility**: Convert feature vector to 0-100 confidence score.

**Exports**:
```typescript
computeScore(features: FeatureVector): ScoringResult
```

```typescript
interface ScoringResult {
  totalScore: number          // 0-100
  components: {
    edgeScore: number         // 0-30
    midEdgeScore: number      // 0-20
    momentumScore: number     // 0-15
    timingScore: number       // 0-10
    activityScore: number     // 0-10
    whaleBonus: number        // 0-15
    hourBonus: number         // -5 to +5
  }
  recommendation: 'SKIP' | 'LOG_ONLY' | 'SMALL' | 'STANDARD' | 'ELEVATED' | 'HIGH' | 'MAXIMUM'
  suggestedSize: number       // USD bet size
}
```

**Key Design**:
- Pure function, no side effects
- All thresholds from config.ts (easy to adjust)
- Deterministic: same inputs = same score
- Returns full breakdown for logging/debugging

### `scanner.ts` (Layer 3)

**Responsibility**: Main scanning loop. Evaluates all active contracts periodically.

**Logic**:
```
Every 15 seconds:
  contracts = contractScanner.getActiveContracts()
  for each contract:
    for each side ['Up', 'Down']:
      features = features.computeFeatures(contract, side)
      if features is null: skip (missing data)

      // Hard gates
      if features.edgeVsSpot < 0.05: skip
      if features.polyMid == 0: skip
      if features.bookSpread > 0.04: skip
      if features.secsRemaining < 90 or > 300: skip

      scoring = scorer.computeScore(features)
      decisionsLog.log(contract, side, features, scoring)  // LOG EVERYTHING

      if scoring.totalScore < 60: continue
      if risk.canTrade(scoring.suggestedSize):
        trader.execute(contract, side, scoring)
```

**Key Design**:
- Runs on a fixed interval (configurable, default 15s)
- Evaluates BOTH sides (Up and Down) independently
- Logs every candidate, not just traded ones — builds training data
- Whale events can trigger an immediate rescan of that contract

### `positions.ts` (Layer 3)

**Responsibility**: Track open positions, check resolution, compute realized PnL.

**Exports**:
```typescript
openPosition(trade: TradeExecution): void
getOpenPositions(): Position[]
checkResolutions(): Promise<void>  // polls Gamma API every 30s
getStats(): SessionStats
```

**Key Design**:
- Atomic state transitions: OPEN -> RESOLVED | EXPIRED
- Mutex on state changes (no race conditions between TP and resolution)
- Side-aware PnL: BUY wins when outcome matches, SELL wins when it doesn't
- Session stats: wins, losses, PnL, current drawdown
- Persist to JSONL for crash recovery

### `risk.ts` (Layer 2)

**Responsibility**: Portfolio-level constraints and circuit breakers.

**Exports**:
```typescript
canTrade(sizeUsd: number): { allowed: boolean, reason?: string }
recordTrade(pnl: number): void
getCircuitBreakerState(): CircuitState
```

**Rules**:
- Max 1 position per contract
- Max 5 concurrent positions
- Max $50 total at risk
- Session loss > -$30: pause 30 minutes
- Hourly loss > -$15: reduce sizing 50% for 15 minutes
- 5 consecutive losses: reduce sizing 50% until next win
- Hour 15-16 UTC: reduce scoring threshold to 70 (harder to trigger)

### `decisions-log.ts` (Layer 2)

**Responsibility**: Log EVERY scored opportunity for training data.

**CSV Fields**:
```
ts, conditionId, side, outcome, score, edgeScore, midEdgeScore, momentumScore,
timingScore, activityScore, whaleBonus, hourBonus, edgeVsSpot, midEdge,
polyMid, bookSpread, price, secsRemaining, delta30s, delta5m, vol1h,
momentumAligned, hourOfDay, concurrentWhales, walletTier, whaleMaxSize,
action, sizeUsd, entryPrice, resolution, won, pnl, asset, contractDuration
```

**Key Design**:
- Append to JSONL in real-time
- Rotate to CSV every 50,000 lines
- Archive with timestamp
- EVERY candidate is logged (traded AND skipped)
- This is the training dataset for Phase 2 ML models

### `server.ts` (Layer 4)

**Responsibility**: HTTP server + WS dashboard updates.

**Endpoints**:
- `GET /` — serve dashboard
- `GET /api/status` — bot state JSON
- `GET /api/export-decisions.csv` — decision log export
- `GET /api/export-trades.csv` — trade log export
- `WS /` — real-time dashboard updates (version-gated, 500ms max)

**Dashboard Payload**:
```typescript
{
  btcPrice, ethPrice, btcDelta30s, ethDelta30s,
  activeContracts: ContractInfo[],
  recentScores: ScoringResult[],  // last 50 scored candidates
  openPositions: Position[],
  closedPositions: Position[],  // last 20
  sessionStats: { trades, wins, losses, pnl, drawdown },
  circuitBreaker: { active, reason, resumeAt },
  whaleActivity: WhaleSignal[],  // recent whale events
  mode: 'PAPER' | 'LIVE',
  uptime, lastScanTime, lastTradeTime
}
```

---

## Dashboard Design

### Header Bar
- ROTHSTEIN name + mode (PAPER/LIVE) + uptime
- BTC price + delta | ETH price + delta
- Session: trades / wins / WR% / PnL

### Active Contracts Panel
- List of currently active 5min contracts
- For each: title, time remaining (progress bar), best score (Up/Down), action taken

### Score Feed (main panel)
- Real-time feed of ALL scored candidates
- Columns: Time, Contract, Side, Score, Edge, MidEdge, Momentum, Action, Size
- Color-coded: green (traded), yellow (logged), gray (skipped)
- Click to expand: full feature vector + score breakdown

### Open Positions Panel
- Each position: contract, side, entry price, current polyMid, unrealized PnL, time remaining
- Status indicators: green (winning), red (losing), blue (resolving)

### Performance Chart
- Rolling PnL line chart (last 6 hours)
- Win rate rolling window (last 50 trades)
- Score distribution histogram

### Circuit Breaker Status
- Current state: ACTIVE / PAUSED / THROTTLED
- Reason and resume time if not active

---

## Boot Sequence

```
1. Load config + validate env vars
2. Initialize persistence (create dirs, load state)
3. Start Binance WS feed -> wait for first price ('ready' event)
4. Start Polymarket WS book connection
5. Run initial contract scan -> subscribe token IDs
6. Attempt spy server WS connection (non-blocking, retry on fail)
7. Restore open positions from JSONL (if any)
8. Start scanner loop (15s interval)
9. Start resolution checker (30s interval)
10. Start contract rescanner (30s interval)
11. Start HTTP/WS server
12. Log "ROTHSTEIN READY" with all subsystem statuses
```

---

## Graceful Shutdown

```
1. Stop scanner loop (no new trades)
2. Cancel pending orders (if any)
3. Flush all JSONL buffers
4. Log session summary
5. Close WS connections
6. Close HTTP server
7. Exit
```

---

## Configuration (`config.ts`)

```typescript
export const CONFIG = {
  // Server
  port: 3334,  // Different from spy server (3333)
  spyServerUrl: 'ws://localhost:3333',

  // Scanning
  scanIntervalMs: 15_000,
  resolutionCheckMs: 30_000,
  contractScanMs: 30_000,

  // Hard Gates
  minEdgeVsSpot: 0.05,
  minPrice: 0.45,
  maxPrice: 0.85,
  maxBookSpread: 0.04,
  minSecsRemaining: 90,
  maxSecsRemaining: 300,
  allowedAssets: ['BTC', 'ETH'],
  allowedDurations: [5],

  // Score Thresholds
  minTradeScore: 60,

  // Sizing
  sizingTiers: {
    50: 2,   // score 50-59: $2
    60: 5,   // score 60-69: $5
    70: 10,  // score 70-79: $10
    80: 15,  // score 80-89: $15
    90: 20,  // score 90+: $20
  },

  // Risk
  maxConcurrentPositions: 5,
  maxTotalAtRisk: 50,
  sessionLossCircuitBreaker: -30,
  hourlyLossThrottle: -15,
  consecutiveLossThrottle: 5,

  // Persistence
  rotationMaxLines: 50_000,
  maxArchives: 20,

  // Mode
  mode: 'PAPER' as 'PAPER' | 'LIVE',
}
```

---

## Why "ROTHSTEIN"?

Named after Arnold Rothstein, the man who allegedly fixed the 1919 World Series. Not because we're fixing markets — because we're finding fixed probabilities. While the market prices at 50/50, ROTHSTEIN knows the real odds are 65/35. Like the original, ROTHSTEIN doesn't gamble. He calculates.
