/**
 * filter-engine.ts — Unified settings-driven filter for whale copy-trading.
 *
 * ONE filter function reads all thresholds from BotSettings (dashboard-controllable).
 * Per-bot defaults are set in config.ts (DEFAULT_FILTER + BOT_FILTER_OVERRIDES).
 *
 * Filter logic:
 *   BUY && BTC/ETH && duration in [5, 15] (hardcoded)
 *   && price >= floor && (ceiling >= 1.0 || price <= ceiling)
 *   && midEdge matches any configured range (e.g. <-0.05)
 *   && (!momentumRequired || aligned)
 *   && (!edgeEnabled || edge > threshold)
 *   && secsRanges check (ANY range match for that duration)
 *   && usdcSize >= gate
 */

import type { WhaleTrade, BotSettings, MidEdgeRange } from "./types";
import type { FilterPresetName } from "./config";
import { BOT_ID } from "./config";
import { isBinanceStale } from "./market-data";

// ─── FILTER STATS TRACKING ──────────────────────────────────────────────────

export const filterStats: Record<FilterPresetName, { passed: number; total: number }> = {
  NEW_BEST:  { passed: 0, total: 0 },
  BALANCED:  { passed: 0, total: 0 },
  GOLD_PLUS: { passed: 0, total: 0 },
};

// ─── UNIFIED FILTER ─────────────────────────────────────────────────────────

/**
 * Check if secsRemaining falls in ANY of the configured ranges for this duration.
 * secsRanges are [min, max) — min inclusive, max exclusive.
 */
function isTimingValid(secs: number, durationMin: number, s: BotSettings): boolean {
  const ranges = durationMin === 5 ? s.secsRanges5m : s.secsRanges15m;
  if (!ranges || ranges.length === 0) return false;
  for (const range of ranges) {
    if (range.length >= 2 && secs >= range[0] && secs < range[1]) return true;
  }
  return false;
}

/**
 * Check if a midEdge value falls in ANY of the configured ranges.
 * Any range match = pass. No match = fail.
 */
export function matchesMidEdgeRanges(value: number, ranges: MidEdgeRange[]): boolean {
  if (!ranges || ranges.length === 0) return false;
  for (const r of ranges) {
    switch (r.operator) {
      case "lt":      if (value < r.value) return true; break;
      case "gt":      if (value > r.value) return true; break;
      case "lte":     if (value <= r.value) return true; break;
      case "gte":     if (value >= r.value) return true; break;
      case "between": if (r.min !== undefined && r.max !== undefined && value >= r.min && value < r.max) return true; break;
    }
  }
  return false;
}

/**
 * Unified filter — reads ALL thresholds from settings (dashboard-controllable).
 * Hardcoded: allowed durations [5, 15], allowed sides [BUY], allowed assets [BTC, ETH].
 */
export function unifiedFilter(trade: WhaleTrade, s: BotSettings): boolean {
  // Side: BUY only
  if (trade.side !== "BUY") return false;

  // Asset: BTC/ETH only (hardcoded)
  if (!["BTC", "ETH"].includes(trade.assetLabel)) return false;

  // Duration: 5 or 15 min only (hardcoded)
  if (trade.contractDurationMinutes !== 5 && trade.contractDurationMinutes !== 15) return false;

  // Price floor
  if (trade.price < s.priceFloor) return false;

  // Price ceiling — skip check when ceiling >= 1.0 (effectively no ceiling)
  if (s.priceCeiling < 1.0 && trade.price > s.priceCeiling) return false;

  // Mid edge signal (range-based)
  if (trade.midEdge === null) return false;
  if (!matchesMidEdgeRanges(trade.midEdge, s.midEdgeRanges)) return false;

  // Momentum
  if (s.momentumRequired && !trade.momentumAligned) return false;

  // Edge vs spot
  if (s.edgeVsSpotEnabled && (trade.edgeVsSpot === null || trade.edgeVsSpot <= s.edgeVsSpotThreshold)) return false;

  // Timing: secsRemaining must fall in at least one configured range for this duration
  if (!isTimingValid(trade.secondsRemainingInContract, trade.contractDurationMinutes, s)) return false;

  // Whale size gate
  if (trade.usdcSize < s.whaleSizeGate) return false;

  return true;
}

// ─── EVALUATE A TRADE AGAINST THE UNIFIED FILTER ────────────────────────────

export interface FilterResult {
  passed: boolean;
  presetName: FilterPresetName;
  reasons: string[];  // why it passed or failed
}

export function evaluateTrade(trade: WhaleTrade, settings: BotSettings): FilterResult {
  const presetName = BOT_ID;  // determined by env var, not user selection

  // Track stats — run unified filter with this bot's effective settings
  const stats = filterStats[presetName];
  stats.total++;
  const passed = unifiedFilter(trade, settings);
  if (passed) stats.passed++;

  const reasons: string[] = [];

  // Binance staleness guard: if data is stale >30s, skip with explicit reason
  if (isBinanceStale()) {
    reasons.push("BINANCE_STALE: Binance price data stale >30s — skipping to avoid false momentum/midEdge");
    return { passed: false, presetName, reasons };
  }

  // Pre-filters: asset, side (applied BEFORE the unified filter)
  if (!settings.allowedSides.includes(trade.side)) {
    reasons.push(`Side ${trade.side} not allowed`);
    return { passed: false, presetName, reasons };
  }

  const assetLabel = trade.assetLabel.toUpperCase();
  if (settings.allowedAssets.length > 0 && !settings.allowedAssets.includes(assetLabel)) {
    reasons.push(`Asset ${assetLabel} not in allowed list [${settings.allowedAssets.join(",")}]`);
    return { passed: false, presetName, reasons };
  }

  // Run the unified filter
  const filterPassed = unifiedFilter(trade, settings);

  if (filterPassed) {
    reasons.push(`Passed ${presetName} filter (unified)`);
    if (trade.midEdge !== null) reasons.push(`midEdge: ${trade.midEdge.toFixed(4)} (ranges: ${JSON.stringify(settings.midEdgeRanges)})`);
    if (trade.edgeVsSpot !== null) reasons.push(`edgeVsSpot: ${trade.edgeVsSpot.toFixed(4)}`);
    reasons.push(`momentum: ${trade.momentumAligned ? "YES" : "NO"}`);
    reasons.push(`size: $${trade.usdcSize.toFixed(2)}`);
    reasons.push(`secsRemaining: ${trade.secondsRemainingInContract.toFixed(0)}`);
    reasons.push(`duration: ${trade.contractDurationMinutes}min`);
    reasons.push(`price: ${trade.price.toFixed(3)} [floor=${settings.priceFloor}, ceil=${settings.priceCeiling}]`);
  } else {
    // Explain why it failed — check each condition
    if (trade.side !== "BUY") {
      reasons.push(`Side ${trade.side} !== BUY`);
    }
    if (!["BTC", "ETH"].includes(trade.assetLabel)) {
      reasons.push(`Asset ${trade.assetLabel} not in [BTC, ETH]`);
    }
    if (trade.contractDurationMinutes !== 5 && trade.contractDurationMinutes !== 15) {
      reasons.push(`contractDuration ${trade.contractDurationMinutes}min not in [5, 15]`);
    }
    if (trade.price < settings.priceFloor) {
      reasons.push(`price ${trade.price.toFixed(3)} < floor ${settings.priceFloor}`);
    }
    if (settings.priceCeiling < 1.0 && trade.price > settings.priceCeiling) {
      reasons.push(`price ${trade.price.toFixed(3)} > ceiling ${settings.priceCeiling}`);
    }
    if (trade.midEdge === null || !matchesMidEdgeRanges(trade.midEdge, settings.midEdgeRanges)) {
      reasons.push(`midEdge ${trade.midEdge !== null ? trade.midEdge.toFixed(4) : "null"} outside ranges ${JSON.stringify(settings.midEdgeRanges)}`);
    }
    if (settings.momentumRequired && !trade.momentumAligned) {
      reasons.push(`Momentum NOT aligned`);
    }
    if (settings.edgeVsSpotEnabled && (trade.edgeVsSpot === null || trade.edgeVsSpot <= settings.edgeVsSpotThreshold)) {
      reasons.push(`edgeVsSpot ${trade.edgeVsSpot !== null ? trade.edgeVsSpot.toFixed(4) : "null"} <= ${settings.edgeVsSpotThreshold}`);
    }
    if (!isTimingValid(trade.secondsRemainingInContract, trade.contractDurationMinutes, settings)) {
      const ranges = trade.contractDurationMinutes === 5 ? settings.secsRanges5m : settings.secsRanges15m;
      reasons.push(`secsRemaining ${trade.secondsRemainingInContract.toFixed(0)} outside ranges ${JSON.stringify(ranges)} for ${trade.contractDurationMinutes}min`);
    }
    if (trade.usdcSize < settings.whaleSizeGate) {
      reasons.push(`Whale size $${trade.usdcSize.toFixed(2)} < $${settings.whaleSizeGate} minimum`);
    }
  }

  return { passed: filterPassed, presetName, reasons };
}
