/**
 * filter.ts — Signal Filters (Deterministic)
 *
 * Layer 0b — Imports only types.
 * Receives settings + signal, returns pass/fail with reason.
 * No market data access, no config imports.
 */

import { BotSettings, TradeSignal, FilterResult } from './types';

// ── Filter stats (for dashboard cross-bot analysis) ──
let filterStats = { passed: 0, total: 0 };

export function getFilterStats(): { passed: number; total: number } {
  return filterStats;
}

export function evaluateTrade(signal: TradeSignal, s: BotSettings): FilterResult {
  filterStats.total++;

  // 1. Asset check (V7.5 C1: uses assetLabel "BTC"/"ETH", NOT CLOB token ID)
  if (!s.allowedAssets.includes(signal.assetLabel))
    return { pass: false, reason: 'ASSET_BLOCKED' };

  // 2. Side check
  if (!s.allowedSides.includes(signal.side))
    return { pass: false, reason: 'SIDE_BLOCKED' };

  // 3. Wallet check
  if (!s.enabledWallets.some(w => signal.walletAddress.startsWith(w)))
    return { pass: false, reason: 'WALLET_DISABLED' };

  // 4. Price floor (LIVE CLOB mid)
  if (signal.entryPrice < s.priceFloor)
    return { pass: false, reason: 'PRICE_FLOOR' };

  // 5. Price ceiling (LIVE CLOB mid)
  if (signal.entryPrice > s.priceCeiling)
    return { pass: false, reason: 'PRICE_CEILING' };

  // 6. Timing windows — duration-aware (exhaustive: type is '5m' | '15m')
  if (signal.contractDuration === '5m') {
    if (!matchesAnyRange(signal.secsRemaining5m, s.secsRanges5m))
      return { pass: false, reason: 'TIMING_5M' };
  } else if (signal.contractDuration === '15m') {
    if (!matchesAnyRange(signal.secsRemaining15m, s.secsRanges15m))
      return { pass: false, reason: 'TIMING_15M' };
  }

  // 7. Mid edge ranges (whale's edge at their trade time)
  if (s.midEdgeRanges.length > 0) {
    const midEdgePass = s.midEdgeRanges.some(range =>
      applyOperator(signal.midEdge, range.operator, range.value)
    );
    if (!midEdgePass) return { pass: false, reason: 'MID_EDGE' };
  }

  // 8. Edge vs Spot (LIVE edge at our execution time)
  // Uses <= to match original strictness (zero edge rejected)
  if (s.edgeVsSpotEnabled) {
    if (signal.edge <= s.edgeVsSpotThreshold)
      return { pass: false, reason: 'EDGE_FLOOR' };
    if (s.edgeVsSpotCeiling > 0 && signal.edge > s.edgeVsSpotCeiling)
      return { pass: false, reason: 'EDGE_CEILING' };
  }

  // 9. Momentum (boolean — no truthy coercion ambiguity)
  if (s.momentumRequired && !signal.momentum)
    return { pass: false, reason: 'NO_MOMENTUM' };

  // 10. Whale size gate
  if (signal.whaleSize < s.whaleSizeGate)
    return { pass: false, reason: 'WHALE_SIZE' };

  filterStats.passed++;
  return { pass: true };
}

function matchesAnyRange(value: number, ranges: number[][]): boolean {
  return ranges.some(([lo, hi]) => value >= lo && value <= hi);
}

function applyOperator(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case 'lt':  return value < threshold;
    case 'gt':  return value > threshold;
    case 'lte': return value <= threshold;
    case 'gte': return value >= threshold;
    default:    return false;
  }
}
