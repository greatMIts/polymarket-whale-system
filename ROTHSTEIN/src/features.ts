// ─── Layer 2: Feature Assembly ───────────────────────────────────────────────
// Combines all data sources into a single FeatureVector.
// Pure snapshot function — grabs state from all Layer 1 modules at call time.
// NO async, NO side effects. Returns features ALWAYS (even on rejection).
// Diagnostic logging on every gate rejection (throttled) for debugging.

import { FeatureVector, ContractInfo, Side, Direction, Asset } from "./types";
import { CONFIG, getRuntime } from "./config";
import { logger } from "./logger";
import * as binance from "./binance-feed";
import * as polyBook from "./polymarket-book";
import * as pricing from "./pricing";
import * as whales from "./whale-monitor";

// ─── Diagnostic Counters (reset every 60s, logged as summary) ─────────────

const gateStats = {
  total: 0,
  noSpot: 0,
  assetStale: 0,
  noBook: 0,
  timing: 0,
  badEntry: 0,
  priceRange: 0,
  spread: 0,
  lowEdge: 0,
  passed: 0,
  lastReset: Date.now(),
};

function logGateSummary(): void {
  if (Date.now() - gateStats.lastReset < 60_000) return;
  if (gateStats.total === 0) { gateStats.lastReset = Date.now(); return; }

  const rejected = gateStats.total - gateStats.passed;
  if (rejected > 0) {
    logger.info("features", `Gate summary (60s): ${gateStats.total} checks, ${gateStats.passed} passed | ` +
      `Rejected: spot=${gateStats.noSpot} stale=${gateStats.assetStale} book=${gateStats.noBook} ` +
      `timing=${gateStats.timing} entry=${gateStats.badEntry} price=${gateStats.priceRange} ` +
      `spread=${gateStats.spread} edge=${gateStats.lowEdge}`);
  }

  // Reset
  gateStats.total = 0;
  gateStats.noSpot = 0;
  gateStats.assetStale = 0;
  gateStats.noBook = 0;
  gateStats.timing = 0;
  gateStats.badEntry = 0;
  gateStats.priceRange = 0;
  gateStats.spread = 0;
  gateStats.lowEdge = 0;
  gateStats.passed = 0;
  gateStats.lastReset = Date.now();
}

// ─── Build Feature Vector ──────────────────────────────────────────────────
// Returns { features, rejectReason } — features is ALWAYS populated with
// whatever data was available (even on rejection). rejectReason is null
// when all gates pass. This ensures the decision log always has real data.

export type FeatureResult = {
  features: FeatureVector;
  rejectReason: string | null;
};

export function buildFeatureVector(
  contract: ContractInfo,
  side: Side,
  tokenId: string,
  whalePrice?: number
): FeatureResult {
  gateStats.total++;
  logGateSummary();

  const runtime = getRuntime();
  const now = Date.now();

  // ─── Phase 1: Gather all data sources ─────────────────────────────────
  // Compute as much as possible before checking gates.

  // 1. Spot price from Binance
  const spotPrice = binance.getPrice(contract.asset) || 0;
  const assetStale = binance.isAssetStale(contract.asset);

  // 2. Book state from Polymarket
  const book = polyBook.getBook(tokenId);
  const bookMid = book?.mid || 0;
  const bookSpread = book?.spread || 0;
  const bookAsk = book?.ask || 0;

  // 3. Timing
  const secsRemaining = Math.max(0, (contract.endTs - now) / 1000);

  // 4. Entry price: use whale's actual price when available
  const entryPrice = (whalePrice && whalePrice > 0) ? whalePrice : bookAsk;

  // 5. Deltas and direction from Binance
  const delta30s = binance.getDelta30s(contract.asset);
  const delta5m = binance.getDelta5m(contract.asset);
  const priceDirection = binance.getDirection(contract.asset);

  // 6. Realized vol (from price history)
  const history = binance.getHistory(contract.asset);
  const vol1h = history.length > 10
    ? pricing.computeRealizedVol(history, now)
    : null;

  // 7. Fair value via Black-Scholes (only if we have spotPrice)
  const strikePrice = contract.strikePrice || spotPrice;
  const bsDirection: "UP" | "DOWN" = side === "Up" ? "UP" : "DOWN";
  const annualizedVol = vol1h || 0.60;
  const fairValue = spotPrice > 0 && secsRemaining > 0
    ? pricing.computeBinaryFairValue(spotPrice, strikePrice, secsRemaining, annualizedVol, bsDirection)
    : 0;

  // 8. Derived metrics (only if we have the inputs)
  const edgeVsSpot = (fairValue > 0 && entryPrice > 0)
    ? pricing.computeEdgeVsSpot(fairValue, entryPrice)
    : 0;
  const midEdge = (bookMid > 0 && entryPrice > 0)
    ? pricing.computeMidEdge(bookMid, entryPrice)
    : 0;

  // 9. Momentum alignment
  const momentumAligned = (side === "Up" && priceDirection === "UP") ||
                          (side === "Down" && priceDirection === "DOWN");

  // 10. Hour of day (UTC)
  const hourOfDay = new Date().getUTCHours();

  // 11. Whale signals for this contract
  const whaleActivity = whales.getWhaleActivity(contract.conditionId);
  const sameDirection = whaleActivity.filter(w => w.side === side);
  const concurrentWhales = sameDirection.length;
  const bestWalletTier = concurrentWhales > 0
    ? Math.min(...sameDirection.map(w => w.tier))
    : 0;
  const whaleMaxSize = concurrentWhales > 0
    ? Math.max(...sameDirection.map(w => w.usdcSize))
    : 0;
  const opposingWhales = whaleActivity.filter(w => w.side !== side);
  const whaleAgreement = concurrentWhales > 0 && opposingWhales.length === 0;

  // ─── Assemble features (always complete) ──────────────────────────────

  const features: FeatureVector = {
    spotPrice,
    delta30s,
    delta5m,
    vol1h,
    priceDirection,
    polyMid: bookMid,
    bookSpread,
    secsRemaining,
    fairValue,
    edgeVsSpot,
    midEdge,
    entryPrice,
    momentumAligned,
    hourOfDay,
    concurrentWhales,
    bestWalletTier,
    whaleMaxSize,
    whaleAgreement,
  };

  // ─── Phase 2: Check gates (features always returned) ──────────────────

  // Gate 1: Spot price
  if (spotPrice === 0) {
    gateStats.noSpot++;
    return { features, rejectReason: "NO_SPOT_PRICE" };
  }

  // Gate 1b: Per-asset staleness
  if (assetStale) {
    gateStats.assetStale++;
    return { features, rejectReason: "ASSET_STALE" };
  }

  // Gate 2: Book data
  if (!book || bookMid === 0) {
    gateStats.noBook++;
    return { features, rejectReason: "NO_BOOK" };
  }

  // Gate 3: Timing
  if (secsRemaining < runtime.minSecsRemaining) {
    gateStats.timing++;
    return { features, rejectReason: `TIMING_TOO_LATE_${Math.round(secsRemaining)}s` };
  }
  if (secsRemaining > runtime.maxSecsRemaining) {
    gateStats.timing++;
    return { features, rejectReason: `TIMING_TOO_EARLY_${Math.round(secsRemaining)}s` };
  }

  // Gate 4: Entry price sanity
  if (entryPrice <= 0 || entryPrice >= 1) {
    gateStats.badEntry++;
    return { features, rejectReason: `BAD_ENTRY_${entryPrice.toFixed(4)}` };
  }

  // Gate 5: Price range
  if (entryPrice < runtime.minPrice || entryPrice > runtime.maxPrice) {
    gateStats.priceRange++;
    return { features, rejectReason: `PRICE_OUT_OF_RANGE_${entryPrice.toFixed(4)}` };
  }

  // Gate 6: Book spread
  if (bookSpread > runtime.maxBookSpread) {
    gateStats.spread++;
    return { features, rejectReason: `SPREAD_TOO_WIDE_${bookSpread.toFixed(4)}` };
  }

  // Gate 7: Minimum edge
  if (edgeVsSpot < runtime.minEdgeVsSpot) {
    gateStats.lowEdge++;
    if (gateStats.lowEdge <= 3) {
      const usingFallback = contract.strikePrice === null;
      logger.debug("features", `Edge reject: ${contract.asset} ${side} edge=${edgeVsSpot.toFixed(4)} fair=${fairValue.toFixed(4)} entry=${entryPrice.toFixed(4)} strike=${strikePrice.toFixed(2)}${usingFallback ? " (FALLBACK=spot)" : ""} secsRem=${secsRemaining.toFixed(0)}`);
    }
    return { features, rejectReason: `LOW_EDGE_${edgeVsSpot.toFixed(4)}` };
  }

  // Gate 8: Maximum edge cap
  if (edgeVsSpot > runtime.maxEdgeVsSpot) {
    gateStats.lowEdge++;
    return { features, rejectReason: `HIGH_EDGE_${edgeVsSpot.toFixed(4)}` };
  }

  // Gate 9: midEdge must be < minMidEdge (default 0 = buying below mid)
  if (midEdge >= runtime.minMidEdge) {
    return { features, rejectReason: `HIGH_MID_EDGE_${midEdge.toFixed(4)}` };
  }

  // ─── All gates passed ─────────────────────────────────────────────────

  gateStats.passed++;
  return { features, rejectReason: null };
}
