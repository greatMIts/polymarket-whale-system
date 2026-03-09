// ─── ROTHSTEIN V2 Types ─────────────────────────────────────────────────────

export type Mode = "PAPER" | "LIVE";
export type Side = "Up" | "Down";
export type Asset = "BTC" | "ETH";
export type Direction = "UP" | "DOWN" | "FLAT";

// ─── Binance Price Data ─────────────────────────────────────────────────────

export interface PricePoint { ts: number; price: number; }

export interface AssetFeed {
  price: number;
  history: PricePoint[];
  lastUpdate: number;
}

// ─── Polymarket Contract ────────────────────────────────────────────────────

export interface Contract {
  conditionId: string;
  title: string;
  slug: string;
  endTs: number;
  windowStartTs: number;
  durationMs: number;
  clobTokenIds: string[];   // [upTokenId, downTokenId]
  outcomes: string[];       // ["Up", "Down"]
  asset: Asset;
  strikePrice: number | null;
  fetchedAt: number;
}

// ─── Order Book ─────────────────────────────────────────────────────────────

export interface Book {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  lastUpdate: number;
}

// ─── Whale Signal (from polling) ────────────────────────────────────────────

export interface WhaleSignal {
  ts: number;
  wallet: string;
  walletLabel: string;
  side: Side;
  outcome: string;
  price: number;
  usdcSize: number;
  conditionId: string;
  txHash?: string;
  detectedAt: number;
}

// ─── Filter Result ──────────────────────────────────────────────────────────

export interface FilterResult {
  pass: boolean;
  reason: string;
  // Derived metrics always populated (even on reject)
  spotPrice: number;
  delta30s: number;
  delta5m: number;
  edgeVsSpot: number;
  polyMid: number;
  midEdge: number;
  entryPrice: number;
  secsRemaining: number;
  momentumAligned: boolean;
  concurrentWhales: number;
  fairValue: number;
  bookSpread: number;
}

// ─── Decision Log Entry ─────────────────────────────────────────────────────

export interface Decision {
  ts: number;
  conditionId: string;
  title: string;
  asset: Asset;
  side: Side;
  action: "COPY" | "SKIP";
  reason: string;
  // Whale info
  whaleWallet: string;
  whaleLabel: string;
  whaleSize: number;
  whalePrice: number;
  // Derived metrics
  spotPrice: number;
  delta30s: number;
  delta5m: number;
  edgeVsSpot: number;
  polyMid: number;
  midEdge: number;
  entryPrice: number;
  secsRemaining: number;
  momentumAligned: boolean;
  concurrentWhales: number;
  fairValue: number;
  bookSpread: number;
  // Latency
  latencyMs: number;
}

// ─── Trade Execution ────────────────────────────────────────────────────────

export interface Trade {
  id: string;
  ts: number;
  conditionId: string;
  tokenId: string;
  title: string;
  asset: Asset;
  side: Side;
  entryPrice: number;
  sizeUsd: number;
  shares: number;
  mode: Mode;
  orderId?: string;
  // Whale copy context
  whaleWallet: string;
  whaleLabel: string;
  whalePrice: number;
  whaleSize: number;
  slippage: number;        // our entry - whale entry
  pipelineLatencyMs: number;
  // Contract context
  endTs: number;
  strikePrice: number;
}

// ─── Position ───────────────────────────────────────────────────────────────

export interface Position {
  trade: Trade;
  status: "OPEN" | "WON" | "LOST";
  closedAt?: number;
  exitPrice?: number;
  pnl?: number;
  resolution?: string;
}

// ─── Session Stats ──────────────────────────────────────────────────────────

export interface SessionStats {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  maxDrawdown: number;
  peakPnl: number;
  consecutiveLosses: number;
  startedAt: number;
}

// ─── Dashboard Payload ──────────────────────────────────────────────────────

export interface DashboardState {
  mode: Mode;
  uptime: number;
  paused: boolean;
  // Prices
  btcPrice: number;
  ethPrice: number;
  btcDelta30s: number;
  ethDelta30s: number;
  // Price chart data
  btcHistory: PricePoint[];
  ethHistory: PricePoint[];
  // Contracts
  activeContracts: Contract[];
  // Feed
  recentDecisions: Decision[];
  whaleSignals: WhaleSignal[];
  // Positions
  openPositions: Position[];
  closedPositions: Position[];
  // Stats
  stats: SessionStats;
  // Health
  health: {
    binanceWs: { connected: boolean; lastUpdate: number };
    polymarketWs: { connected: boolean; lastUpdate: number };
    whaleMonitor: { active: boolean; lastPoll: number; polls: number };
  };
  // Filter config
  filter: FilterConfig;
}

// ─── Filter Configuration ───────────────────────────────────────────────────

export interface FilterConfig {
  // Wallets
  blockedWallets: string[];
  // Whale signal
  minWhaleSize: number;     // $3
  // Momentum (THE #1 signal: 60% vs 44% WR)
  requireMomentum: boolean;
  // Edge vs spot (fair value - entry)
  minEdge: number;          // 0.0  (positive edge required)
  maxEdge: number;          // 1.0  (no cap)
  // Timing
  minSecsRemaining: number; // 150
  maxSecsRemaining: number; // 300
  // FOK limit price
  fokMaxPrice: number;      // 0.70 — won't pay more than this
  // Risk
  maxPositionsPerContract: number; // 1 per conditionId:side
  maxTotalRisk: number;     // $500
  betSize: number;          // $10 flat
  // Paused
  paused: boolean;
}
