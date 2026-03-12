# ROTHSTEIN V2 - Bug Fix Summary & Architecture Reference

## File Responsibilities

### Core Pipeline

| File | Role |
|---|---|
| `src/index.ts` | Entry point. Starts all modules in order: Binance WS, book, contracts, whales, positions, pipeline, server. |
| `src/pipeline.ts` | Main orchestrator. Listens for `whale-trade` events, runs the filter, executes trades, opens positions. In-flight lock per `conditionId:side` prevents duplicates. |
| `src/filter.ts` | 9-gate filter evaluating each whale signal: wallet block, min size, contract match, timing window, momentum, edge, FOK price, book spread, concurrent whales. |
| `src/executor.ts` | Trade execution. Builds and submits FOK orders via `createAndPostMarketOrder()`. Handles PAPER (simulated) and LIVE (real) modes. Sets `endTs` and `strikePrice` on trades. |
| `src/positions.ts` | Position lifecycle. Opens/closes positions, tracks PnL and session stats. Self-resolves expired contracts via Binance klines. Persists trades to `data/trades.csv`. |
| `src/decisions.ts` | Logs every filter evaluation (COPY or SKIP) to `data/decisions.csv` with full context: prices, edge, timing, whale info. |

### Data Sources

| File | Role |
|---|---|
| `src/binance.ts` | Binance WebSocket connection for real-time BTC/ETH price feeds. Provides spot prices and delta calculations. |
| `src/book.ts` | Polymarket WebSocket for order book data. Provides mid prices and book spreads for active contracts. |
| `src/contracts.ts` | Contract scanner. Two-pass polling of Gamma API every 30s to discover 5-min updown contracts. Pass 1: active (now to now+10min). Pass 2: upcoming (now+10min to now+30min). |
| `src/whales.ts` | Whale monitor. Polls Polymarket Data API every 2s for large trades. Emits `whale-trade` events with parsed signals. |

### Infrastructure

| File | Role |
|---|---|
| `src/server.ts` | Express + WebSocket server. Serves dashboard, exposes REST API (`/api/state`, `/api/filter`, `/api/pause`, `/api/resume`, `/api/mode`, `/api/download/:file`). Pushes state via WS every 500ms. |
| `src/config.ts` | Configuration and environment variables. URLs (Gamma API, Binance klines, CLOB), filter defaults, runtime settings. |
| `src/types.ts` | TypeScript interfaces: `Trade`, `Position`, `WhaleSignal`, `Contract`, `SessionStats`, `DashboardState`, etc. |
| `src/log.ts` | Logger factory with module prefixes (`[PIPELINE]`, `[WHALES]`, etc.). |

### Dashboard

| File | Role |
|---|---|
| `dashboard/index.html` | Single-file dashboard (HTML + CSS + JS). Real-time display of prices, whale feed, decisions, open/closed positions, stats. Connects via WebSocket. |

### Data Files (on Railway volume `/app/data`)

| File | Format | Content |
|---|---|---|
| `data/decisions.csv` | CSV | Every whale signal evaluation with action (COPY/SKIP), reason, prices, edge, timing. |
| `data/trades.csv` | CSV | Every position open/close with entry price, PnL, whale info, latency. |

---

## Bug Fixes (Chronological)

### 1. LIVE Mode Execution Broken
- **File:** `src/executor.ts`
- **Symptom:** Trades worked in PAPER but failed in LIVE.
- **Cause:** Used two-step `createOrder()` + `postOrder()` which doesn't work with the CLOB API.
- **Fix:** Switched to V1's `createAndPostMarketOrder()` single-call method.

### 2. Contract Scanner Too Narrow
- **File:** `src/contracts.ts`
- **Symptom:** "No matching contract found" on nearly every whale signal. Only 2 contracts discovered per scan.
- **Cause:** Single-pass search from `now + 60s` to `now + 10min` missed contracts in their final 60 seconds and didn't pre-load upcoming ones.
- **Fix:**
  - Two-pass scan matching V1: active (`now` to `now + 10min`) + upcoming (`now + 10min` to `now + 30min`)
  - Extended prune window from 2 min to 5 min
  - Added `order: "endDate"` and `ascending: true` params
  - Fixed `conditionId` field priority (camelCase first to match Gamma API response)
- **Result:** 12 contracts found per scan instead of 2.

### 3. Timestamp Parsing — Seconds vs Milliseconds
- **File:** `src/whales.ts`
- **Symptom:** `whaleSecsRemaining` showed ~1.7 billion (56 years), failing every timing gate.
- **Cause:** Polymarket Data API returns `timestamp` as Unix seconds (e.g., `1773101133`), but code did `new Date(1773101133)` treating it as milliseconds = January 1970 date.
- **Fix:** Added detection: `rawTs < 10_000_000_000 ? rawTs * 1000 : rawTs`

### 4. Positions Never Closing — Gamma API Resolution Broken
- **File:** `src/positions.ts`
- **Symptom:** 50 open positions accumulated (hitting max limit), 0 wins, 0 losses. Bot stopped trading after 2 days.
- **Cause:** `fetchResolution()` queried Gamma API with `condition_id` param which returned wrong/unrelated markets. Contracts never appeared as resolved.
- **Fix:** Replaced Gamma API resolution with self-resolution via Binance klines. Fetch 1-second kline at `endTs`, compare to strike price, determine Up/Down winner. 15-second grace period after `endTs` for kline data availability.

### 5. Positions STILL Never Closing — Strike Price Always 0
- **File:** `src/positions.ts`
- **Symptom:** Self-resolve deployed but positions still stuck open. All `strikePrice = 0`.
- **Cause:** Contract scanner discovers contracts early (up to 30 min ahead). Strike price not available at scan time for upcoming contracts, so it stays 0. Executor copies 0 onto the trade. `selfResolve()` bailed when strike was 0.
- **Fix:** When `strikePrice` is 0 at resolution time, fetch it from Binance kline at `startTs` (= `endTs - 5min`). Compare start price vs end price to determine outcome.

### 6. Closed Positions Showing Oldest Instead of Newest
- **File:** `src/server.ts`
- **Symptom:** Dashboard showed 50 closed positions but they were stale, never updating with newer ones.
- **Cause:** Used `.slice(-50)` on a newest-first array, returning the oldest 50.
- **Fix:** Changed to `.slice(0, 100)` — sends newest 100.

### 7. Whale Feed & Decisions — Newest at Bottom
- **File:** `dashboard/index.html`
- **Symptom:** Both panels showed newest entries at the bottom, requiring constant scrolling.
- **Cause:** Render loops iterated backwards on arrays already sorted newest-first from the server.
- **Fix:** Changed both to forward iteration.

### 8. Decisions/Trades Format — JSONL to CSV
- **Files:** `src/decisions.ts`, `src/positions.ts`
- **Symptom:** Data files in JSONL format, harder to analyze.
- **Fix:** Converted both to CSV with proper headers.
