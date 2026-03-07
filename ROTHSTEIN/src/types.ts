// ─── Layer 0: Types ─────────────────────────────────────────────────────────
// All TypeScript interfaces & enums for ROTHSTEIN.
// No logic, no imports — pure type definitions.

export type Mode = "PAPER" | "LIVE";
export type Side = "Up" | "Down";
export type Asset = "BTC" | "ETH";
export type Direction = "UP" | "DOWN" | "FLAT";

export type ScoreRecommendation =
  | "SKIP"
  | "LOG_ONLY"
  | "SMALL"
  | "STANDARD"
  | "ELEVATED"
  | "HIGH"
  | "MAXIMUM";

export type PositionStatus = "OPEN" | "RESOLVED_WIN" | "RESOLVED_LOSS" | "EXPIRED" | "EXITED_TP";

// ─── Market Data ────────────────────────────────────────────────────────────

export interface PricePoint {
  ts: number;
  price: number;
}

export interface AssetState {
  price: number;
  history: PricePoint[];   // last 10 minutes of ticks
  lastUpdate: number;
}

export interface BookState {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  lastUpdate: number;
}

// ─── Contracts ──────────────────────────────────────────────────────────────

export interface ContractInfo {
  conditionId: string;
  title: string;
  startTs: number;
  endTs: number;
  windowStartTs: number;
  durationMs: number;
  clobTokenIds: string[];      // parallel with outcomes array
  outcomes: string[];          // parallel with clobTokenIds, e.g. ["Up", "Down"]
  binanceSymbol: string;       // "BTCUSDT" | "ETHUSDT"
  asset: Asset;
  strikePrice: number | null;
  contractDurationMinutes: number;
  fetchedAt: number;
}

// ─── Features ───────────────────────────────────────────────────────────────

export interface FeatureVector {
  // Market state (from binance-feed)
  spotPrice: number;
  delta30s: number;
  delta5m: number;
  vol1h: number | null;
  priceDirection: Direction;

  // Contract state (from polymarket-book + contract-scanner)
  polyMid: number;
  bookSpread: number;
  secsRemaining: number;

  // Derived (from pricing.ts)
  fairValue: number;
  edgeVsSpot: number;
  midEdge: number;
  entryPrice: number;          // best ask for Up, best bid for Down

  // Alignment
  momentumAligned: boolean;

  // Temporal
  hourOfDay: number;

  // Whale (from whale-listener)
  concurrentWhales: number;
  bestWalletTier: number;      // 0=none, 1=tier1, 2=tier2, 3=tier3
  whaleMaxSize: number;
  whaleAgreement: boolean;     // all whales bet same side?
}

// ─── Scoring ────────────────────────────────────────────────────────────────

export interface ScoreComponents {
  edgeScore: number;           // 0-40 (+10 from midEdge redistribution)
  midEdgeScore: number;        // always 0 (disabled — whale conviction metric unavailable in independent mode)
  momentumScore: number;       // 0-20 (+5 from midEdge redistribution)
  timingScore: number;         // 0-10
  activityScore: number;       // 0-15 (+5 from midEdge redistribution)
  whaleBonus: number;          // 0-15
  hourBonus: number;           // -5 to +5
}

export interface ScoringResult {
  totalScore: number;          // 0-100
  components: ScoreComponents;
  recommendation: ScoreRecommendation;
  suggestedSize: number;       // USD
}

// ─── Trading ────────────────────────────────────────────────────────────────

export interface TradeExecution {
  id: string;
  ts: number;
  conditionId: string;
  tokenId: string;
  title: string;
  side: Side;
  asset: Asset;
  entryPrice: number;
  sizeUsd: number;
  shares: number;
  score: number;
  components: ScoreComponents;
  features: FeatureVector;
  mode: Mode;
  orderId?: string;
  endTs: number;            // contract expiry timestamp — MUST be stored for position timing
  strikePrice: number;      // Binance price at contract window start — needed for conditional TP
}

export interface Position {
  id: string;
  trade: TradeExecution;
  status: PositionStatus;
  openedAt: number;
  closedAt?: number;
  exitPrice?: number;
  pnl?: number;
  resolution?: string;
}

// ─── Whale Signals ──────────────────────────────────────────────────────────

export interface WhaleSignal {
  ts: number;
  wallet: string;
  walletLabel: string;
  side: Side;
  outcome: string;
  price: number;
  usdcSize: number;
  conditionId: string;
  tier: number;                // 1, 2, or 3
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export interface DashboardPayload {
  mode: Mode;
  uptime: number;
  lastScanTime: number;
  lastTradeTime: number;

  btcPrice: number;
  ethPrice: number;
  btcDelta30s: number;
  ethDelta30s: number;

  activeContracts: ContractInfo[];
  recentScores: DecisionLogEntry[];
  openPositions: Position[];
  closedPositions: Position[];
  sessionStats: SessionStats;
  circuitBreaker: CircuitBreakerState;
  whaleActivity: WhaleSignal[];
  deadHours: number[];
  paused: boolean;
  runtimeConfig: RuntimeConfig;

  subsystemHealth: SubsystemHealth;
}

export interface SessionStats {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  maxDrawdown: number;
  peakPnl: number;
  winRate: number;
  consecutiveLosses: number;
  startedAt: number;
}

export interface CircuitBreakerState {
  active: boolean;
  reason: string;
  resumeAt: number;
  sizingMultiplier: number;    // 1.0 normal, 0.5 throttled, 0 paused
}

export interface SubsystemHealth {
  binanceWs: { connected: boolean; lastHeartbeat: number; stale: boolean };
  polymarketWs: { connected: boolean; lastHeartbeat: number; stale: boolean };
  whalePoller: { active: boolean; lastPoll: number; walletsPolled: number };
  scanner: { running: boolean; lastScan: number };
}

// ─── Decision Log ───────────────────────────────────────────────────────────

export interface DecisionLogEntry {
  ts: number;
  conditionId: string;
  title: string;
  side: Side;
  asset: Asset;
  score: number;
  components: ScoreComponents;
  features: FeatureVector;
  action: "SKIP" | "LOG_ONLY" | "TRADE";
  sizeUsd: number;
  entryPrice: number;
  secsRemaining: number;
  // Filled after resolution:
  resolution?: string;
  won?: boolean;
  pnl?: number;
}

// ─── Runtime Config (hot-reloadable) ────────────────────────────────────────

export interface RuntimeConfig {
  deadHours: number[];         // UTC hours to skip trading (e.g. [15, 16])
  minTradeScore: number;       // default 60
  sizingMultiplier: number;    // default 1.0
  maxConcurrentPositions: number;
  paused: boolean;             // manual pause from dashboard

  // Hard gates (hot-reloadable from Settings)
  minEdgeVsSpot: number;       // default 0.05
  minPrice: number;            // default 0.45
  maxPrice: number;            // default 0.85
  maxBookSpread: number;       // default 0.04
  minSecsRemaining: number;    // default 90
  maxSecsRemaining: number;    // default 300

  // Risk
  maxTotalAtRisk: number;      // default 50
  consecutiveLossThrottle: number;  // default 5

  // Sizing
  betSizeUsdc: number;             // fixed USDC per trade (default 10)

  // Conditional TP
  conditionalTpMinPrice: number;    // default 0.85
  conditionalTpEdgeThreshold: number;  // default 0
}
