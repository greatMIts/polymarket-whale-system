/**
 * types.ts — Shared type definitions for the whale copy-trading bot.
 */

import type { FilterPresetName } from "./config";

// ─── Whale Trade (observed from spy data) ───────────────────────────────────

export interface WhaleTrade {
  id: string;
  ts: number;             // unix ms
  tsIso: string;
  wallet: string;         // full address
  walletLabel: string;    // short label e.g. "0x63ce"
  side: "BUY" | "SELL";
  outcome: string;        // "Up" | "Down"
  price: number;
  usdcSize: number;
  shares: number;
  conditionId: string;
  title: string;
  txHash: string;
  asset: string;          // CLOB token ID
  // Enriched
  spotPrice: number;              // asset's Binance price at trade time (was btcPriceAtTrade)
  assetPriceAtTrade: number;
  delta30s: number;               // 30s price delta for the trade's asset (was btcDelta30s)
  delta5m: number;                // 5-min price delta for the trade's asset (was btcDelta5m)
  priceDirection: "UP" | "DOWN" | "FLAT";  // asset direction (was btcDirection)
  secondsRemainingInContract: number;
  contractDurationMinutes: number;  // parsed from title, 0 if unknown
  edgeVsSpot: number | null;       // BS fair value edge (was edgeVsBtc)
  polyMid: number;
  midEdge: number | null;     // polyMid - price (null if polyMid unavailable)
  binanceSymbol: string;      // e.g. "BTCUSDT"
  assetLabel: string;         // e.g. "BTC"
  momentumAligned: boolean;   // whale bet matches 30s price direction
  detectedAt?: number;        // unix ms when bot first detected this trade (for latency tracking)
}

// ─── Contract Cache ─────────────────────────────────────────────────────────

export interface CachedContract {
  conditionId: string;
  title: string;
  startTs: number;
  endTs: number;
  windowStartTs: number;
  durationMs: number;
  clobTokenIds: string[];
  fetchedAt: number;
  binanceSymbol: string;
  strikePrice: number | null;
  negRisk: boolean;
}

// ─── Bot Trade (our copy trade) ─────────────────────────────────────────────

export interface BotTrade {
  id: string;
  ts: number;
  tsIso: string;
  // Source whale trade that triggered this
  whaleTradeId: string;
  walletLabel: string;
  // What we're copying
  conditionId: string;
  title: string;
  side: "BUY" | "SELL";
  outcome: string;
  // Our execution
  entryPrice: number;        // price we got (paper: whale price; live: actual fill)
  sizeUsdc: number;          // how much we risked
  shares: number;            // sizeUsdc / entryPrice
  asset: string;             // CLOB token ID
  // Filter that passed
  filterPreset: FilterPresetName;
  // Metrics at entry
  midEdge: number | null;
  edgeVsSpot: number | null;       // BS fair value edge (was edgeVsBtc)
  momentumAligned: boolean;
  secsRemaining: number;
  assetLabel: string;
  // New data columns
  botId: FilterPresetName;          // which bot made this trade
  contractDuration: number;         // in minutes (5 for 5-min)
  sizeReason: string;               // "STANDARD" or "HIGH_CONVICTION (price X >= 0.80)"
  stackEntry: number;               // which entry on this contract (1, 2, or 3)
  stackTotal: number;               // total entries at time of this trade
  stackTriggerSize: number;         // whale usdcSize that triggered this stack
  whaleTxHash: string;              // the whale's transaction hash
  latencyMs: number;                // ms from whale trade to our copy
  spotPrice: number;                // asset Binance price at decision time (was binancePrice)
  polyMidAtDecision: number;        // order book mid at OUR decision time (fresh, not whale's)
  bookSpread: number;               // ask - bid at decision time (fresh)
  // Statistical columns
  slippage: number;                  // 0 in PAPER mode; clobFillPrice - whalePrice in LIVE
  fillPriceVsMid: number | null;     // entryPrice - polyMidAtDecision (null if mid unavailable)
  vol1h: number;                     // rolling stdev of delta30s over last hour, per-asset (was btcVol1h)
  concurrentWhales: number;          // distinct wallets on same conditionId in last 60s
  sessionLabel: string;              // ASIA, EUROPE, US, LATE_US
  orderBookDepth: number;            // total USDC within 5 cents of mid, -1 if unavailable
  // Resolution
  resolution: string | null;  // "Up" | "Down" | null
  won: boolean | null;
  pnl: number | null;        // in USD
  exitPrice: number | null;   // 1 if won, 0 if lost (binary)
  resolvedAt: number | null;
  // Status
  status: "OPEN" | "WON" | "LOST" | "EXPIRED";
  mode: "PAPER" | "LIVE";
  // LIVE order confirmation — FOK filled = true, PAPER always true
  confirmed: boolean;
  // Whale context columns (for analysis — whale's raw signals at copy time)
  whaleUsdcSize: number;         // whale's original bet size (conviction signal)
  whalePrice: number;            // whale's entry price (for slippage calc: entryPrice - whalePrice)
  delta30s: number;              // raw 30s asset momentum at decision time (was btcDelta30s)
  delta5m: number;               // raw 5-min asset momentum at decision time (was btcDelta5m)
}

// ─── Settings (persisted) ───────────────────────────────────────────────────

export interface BotSettings {
  mode: "PAPER" | "LIVE";
  activeFilter: FilterPresetName;
  // Dynamic sizing
  highConvictionSize: number;        // $30 when entry >= threshold
  lowConvictionSize: number;         // $10 when entry < threshold
  highConvictionThreshold: number;   // 0.80
  // Risk limits
  maxOpenPositions: number;
  maxExposureUSD: number;
  maxLossPerHour: number;
  maxLossPerSession: number;
  // Stacking
  maxEntriesPerContract: number;     // up to 3 entries per conditionId
  minStackSize: number;              // whale must trade >= $25 to stack
  // Filters
  allowedAssets: string[];
  allowedSides: ("BUY" | "SELL")[];
  cooldownMs: number;
  botEnabled: boolean;
  // Wallet inclusion (LIVE mode only — PAPER still tracks all wallets)
  // Checked wallets = copy from; unchecked = skip in LIVE mode
  enabledWallets: string[];
  // Filter parameters (v10 — unified filter, dashboard-controllable)
  standardSize: number;               // $10 default — bet size for BAL/GP
  priceFloor: number;                 // 0.50 BAL/GP, 0.70 NB
  priceCeiling: number;               // 0.85 BAL, 1.0 GP/NB (>=1.0 = no ceiling check)
  midEdgeThreshold: number;           // -0.05
  edgeVsSpotEnabled: boolean;         // true NB/BAL, false GP
  edgeVsSpotThreshold: number;        // 0.0
  momentumRequired: boolean;          // true
  whaleSizeGate: number;              // 10 BAL/GP, 0 NB
  secsRanges5m: number[][];           // [[90,200]] BAL/NB, [[90,300]] GP — discontinuous windows
  secsRanges15m: number[][];          // [[90,300]] all
}

// ─── Dashboard State ────────────────────────────────────────────────────────

export interface DashboardState {
  // Bot identity
  botId: FilterPresetName;

  // Live prices
  prices: Record<string, number>;  // "BTCUSDT" → price
  delta30s: number;
  delta5m: number;
  priceDirection: "UP" | "DOWN" | "FLAT";

  // Recent whale trades (last 200)
  recentWhaleTrades: WhaleTrade[];

  // Bot trades
  openPositions: BotTrade[];
  closedPositions: BotTrade[];

  // Stats
  stats: BotStats;

  // Settings
  settings: BotSettings;

  // Filter metadata
  filterStats: Record<FilterPresetName, { passed: number; total: number }>;

  // System
  totalWhaleTrades: number;
  uptime: number;
  subscribedTokens: number;
  contractsCached: number;
}

export interface BotStats {
  totalCopyTrades: number;
  openPositions: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  todayPnl: number;
  todayTrades: number;
  bestTrade: number;
  worstTrade: number;
  avgPnlPerTrade: number;
  tradesPassedFilter: number;
  tradesRejectedByRisk: number;
}
