// ─── Layer 0: Types ─────────────────────────────────────────────────────────
// All TypeScript interfaces & enums for ROTHSTEIN.
// No logic, no imports — pure type definitions.

export type Mode = "PAPER" | "LIVE";
export type Side = "Up" | "Down";
export type Asset = "BTC" | "ETH";
export type Direction = "UP" | "DOWN" | "FLAT";

export type ScoreRecommendation =
  | "SKIP"
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
  edgeScore: number;           // 0-30
  midEdgeScore: number;        // 0-20
  momentumScore: number;       // 0-15
  timingScore: number;         // 0-10
  activityScore: number;       // 0-10
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
  whaleCopy?: WhaleCopyMeta;  // Whale copy metadata — present for all copy trades
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
  txHash?: string;             // Polymarket transaction hash for dedup
  detectedAt?: number;         // Timestamp when we detected this signal
}

// ─── Whale Copy Metadata ───────────────────────────────────────────────────
// Attached to every trade execution and decision log entry for copy-trade analysis.

export interface WhaleCopyMeta {
  triggeredByWallet: string;       // Wallet address that triggered the copy (e.g. "0x571c...")
  whaleWalletLabel: string;        // Human-readable label (e.g. "0x571c")
  whaleTier: number;               // Wallet tier (1, 2, or 3)
  whaleUsdcSize: number;           // How much the whale bet (USDC)
  whaleEntryPrice: number;         // Price the whale entered at
  whaleTradeTs: number;            // Timestamp of whale's original trade
  whaleDetectedAt: number;         // When we detected the whale trade
  pipelineLatencyMs: number;       // Time from detection to our execution (ms)
  whaleToExecutionMs: number;      // Time from whale trade to our execution (ms)
  slippageVsWhale: number;         // Our entry price - whale's entry price (positive = worse)
  bookSpreadAtEntry: number;       // Order book spread at the moment we entered
  concurrentWhaleSignals: number;  // How many whales traded same contract within 5s
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
  action: "SKIP" | "TRADE";
  skipReason?: string;              // Why signal was skipped (only when action=SKIP)
  sizeUsd: number;
  entryPrice: number;
  secsRemaining: number;
  // Whale copy fields (present when triggered by whale trade):
  triggeredByWallet?: string;     // Which wallet triggered this decision
  whaleWalletLabel?: string;      // Human-readable wallet label
  whaleTier?: number;             // Wallet tier (1/2/3)
  whaleUsdcSize?: number;         // How much the whale bet
  whaleEntryPrice?: number;       // What price the whale entered at
  pipelineLatencyMs?: number;     // Time from detection to decision (ms)
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
  maxTotalAtRisk: number;      // default 500

  // Sizing
  betSizeUsdc: number;             // fixed USDC per trade (default 10)

  // MidEdge gate
  minMidEdge: number;                  // default -1 (disabled)

  // Sizing tiers (score-based, managed from dashboard)
  sizingTier1Score: number;   // default 80, size = sizingTier1Size
  sizingTier1Size: number;    // default 15
  sizingTier2Score: number;   // default 70, size = sizingTier2Size
  sizingTier2Size: number;    // default 10
  sizingTier3Score: number;   // default 60, size = sizingTier3Size
  sizingTier3Size: number;    // default 5
  sizingTier4Score: number;   // default 50, size = sizingTier4Size
  sizingTier4Size: number;    // default 2

  // Conditional TP
  conditionalTpMinPrice: number;    // default 0.85
  conditionalTpEdgeThreshold: number;  // default 0
}
