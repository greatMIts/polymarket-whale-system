/**
 * types.ts — All interfaces and type definitions for the V7.5 bot system.
 *
 * Layer 0 — Zero imports from bot modules.
 * Every interface used across modules is defined here.
 */

// ── Bot Identity ──
export type FilterPresetName = 'BALANCED' | 'GOLD_PLUS' | 'NEW_BEST';

// ── Wallet Info ──
export interface WalletInfo {
  label: string;
  shortAddress: string;
}

// ── Settings ──
export interface MidEdgeRange {
  operator: 'lt' | 'gt' | 'lte' | 'gte';
  value: number;
}

export interface BotSettings {
  mode: "PAPER" | "LIVE";
  botEnabled: boolean;
  takeProfitEnabled: boolean;
  takeProfitPrice: number;
  standardSize: number;               // USDC to spend per standard trade (dashboard: "Bet Size")
  highConvictionSize: number;          // USDC to spend per HC trade (dashboard: "HC Bet")
  highConvictionThreshold: number;
  maxOpenPositions: number;
  maxExposureUSD: number;
  maxLossPerHour: number;
  maxLossPerSession: number;
  cooldownMs: number;
  maxEntriesPerContract: number;
  minStackSize: number;
  priceFloor: number;
  priceCeiling: number;
  midEdgeRanges: MidEdgeRange[];
  edgeVsSpotEnabled: boolean;
  edgeVsSpotThreshold: number;
  edgeVsSpotCeiling: number;
  momentumRequired: boolean;
  whaleSizeGate: number;
  secsRanges5m: number[][];
  secsRanges15m: number[][];
  inactiveHoursUTC: [number, number];
  allowedAssets: string[];
  allowedSides: ("BUY" | "SELL")[];
  enabledWallets: string[];
}

// ── Trade Signal ──
export interface TradeSignal {
  conditionId: string;
  asset: string;                       // CLOB token ID (for order placement)
  assetLabel: string;                  // V7.5 C1: human label ("BTC"/"ETH") — for filter + Binance price
  side: 'BUY' | 'SELL';
  entryPrice: number;
  edge: number;
  midEdge: number;
  whaleSize: number;
  walletAddress: string;
  contractDuration: '5m' | '15m';
  secsRemaining5m: number;
  secsRemaining15m: number;
  momentum: boolean;
}

export interface FilterResult {
  pass: boolean;
  reason?: string;
}

// ── Orders ──
// V7.4 M1+M2+S1: tokenId + negRisk + corrected size docs
export interface SellOrder {
  tokenId: string;                     // V7.4 M1: CLOB token ID (not conditionId)
  side: 'SELL' | 'BUY';               // BUY allowed (closing SELL positions via TP)
  size: number;                        // V7.4 S1: SELL = token count, BUY = USDC. Caller converts.
  price: number;
  negRisk: boolean;                    // V7.4 M2: required by CLOB SDK
  timeout: number;
}

export interface SellResult {
  status: 'FILLED' | 'FAILED' | 'TIMEOUT';
  fillPrice?: number;
  fillSize?: number;                   // Mirrors SellOrder.size unit per side
  reason?: string;
}

// ── Trades ──
export interface BotTrade {
  id: string;
  conditionId: string;                               // Market condition ID (for resolution, tracking)
  asset: string;                                     // CLOB token ID (for TP CLOB calls)
  assetLabel: string;
  title: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;                                      // USDC spent — "bet size" (shares = size / entryPrice)
  shares: number;                                    // Token count received = size / entryPrice
  status: 'OPEN' | 'WON' | 'LOST' | 'TP_FILLED' | 'EXPIRED';
  pnl?: number;
  exitPrice?: number;
  resolvedAt?: number;
  resolutionSource?: 'GAMMA' | 'STALE_FALLBACK' | 'TAKE_PROFIT' | 'EXPIRED';
  createdAt: number;
  mode: 'PAPER' | 'LIVE';
  walletAddress: string;
  whaleSize: number;
  negRisk: boolean;                                  // V7.4 M2: stored at creation for TP reuse
  // Analytics (11 fields including negRisk)
  latencyMs: number;
  polyMidAtDecision: number;
  bookSpread: number;
  sizeReason: 'STANDARD' | 'HIGH_CONVICTION';
  stackEntry: number;
  contractDuration: '5m' | '15m';
  filterPreset: FilterPresetName;
  whaleTxHash: string;
  midEdge: number;
}

export interface Decision {
  conditionId: string;
  asset: string;
  side: 'BUY' | 'SELL';
  reason: string;
  timestamp: number;
}

export interface ContractOutcome {
  resolved: boolean;
  outcome: 'YES' | 'NO';
  resolvedAt: number;
}

export interface WhaleTrade {
  conditionId: string;
  asset: string;                      // CLOB token ID
  assetLabel: string;
  title: string;
  side: 'BUY' | 'SELL';
  usdcSize: number;
  walletAddress: string;
  txHash: string;
  midEdge: number;
  momentumAligned: boolean;
  contractDuration: '5m' | '15m';
  secsRemaining5m: number;
  secsRemaining15m: number;
  detectedAt: number;
}
