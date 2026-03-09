// ─── Layer 2: Feature Assembly ───────────────────────────────────────────────
// Combines all data sources into a single FeatureVector.
// Pure snapshot function — grabs state from all Layer 1 modules at call time.
// NO async, NO side effects. Returns null if data is insufficient.
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
// Returns { features, rejectReason } — features is null when a gate blocks,
// with rejectReason giving the specific gate name for the score feed.

export type FeatureResult =
  | { features: FeatureVector; rejectReason: null }
  | { features: null; rejectReason: string };

export function buildFeatureVector(
  contract: ContractInfo,
  side: Side,
  tokenId: string,
  whalePrice?: number
): FeatureResult {
  gateStats.total++;
  logGateSummary();

  // 1. Spot price from Binance
  const spotPrice = binance.getPrice(contract.asset);
  if (!spotPrice || spotPrice === 0) { gateStats.noSpot++; return { features: null, rejectReason: "NO_SPOT_PRICE" }; }

  // 1b. Per-asset staleness check (Bug 9 fix)
  if (binance.isAssetStale(contract.asset)) { gateStats.assetStale++; return { features: null, rejectReason: "ASSET_STALE" }; }

  // 2. Book state from Polymarket
  const book = polyBook.getBook(tokenId);
  if (!book || book.mid === 0) { gateStats.noBook++; return { features: null, rejectReason: "NO_BOOK" }; }

  // 3. Timing
  const now = Date.now();
  const secsRemaining = Math.max(0, (contract.endTs - now) / 1000);
  const runtime = getRuntime();

  // Hard gate: must have enough time (uses runtime config for hot-reload)
  if (secsRemaining < runtime.minSecsRemaining) {
    gateStats.timing++;
    return { features: null, rejectReason: `TIMING_TOO_LATE_${Math.round(secsRemaining)}s` };
  }
  if (secsRemaining > runtime.maxSecsRemaining) {
    gateStats.timing++;
    return { features: null, rejectReason: `TIMING_TOO_EARLY_${Math.round(secsRemaining)}s` };
  }

  // 4. Entry price: use whale's actual price when available (book ask is stale after whale sweep)
  //    Fallback to book.ask for paper mode / when no whale price provided
  const entryPrice = (whalePrice && whalePrice > 0) ? whalePrice : book.ask;
  if (entryPrice <= 0 || entryPrice >= 1) { gateStats.badEntry++; return { features: null, rejectReason: `BAD_ENTRY_${entryPrice.toFixed(4)}` }; }

  // Hard gates: price range & spread (uses runtime config for hot-reload)
  if (entryPrice < runtime.minPrice || entryPrice > runtime.maxPrice) { gateStats.priceRange++; return { features: null, rejectReason: `PRICE_OUT_OF_RANGE_${entryPrice.toFixed(4)}` }; }
  if (book.spread > runtime.maxBookSpread) { gateStats.spread++; return { features: null, rejectReason: `SPREAD_TOO_WIDE_${book.spread.toFixed(4)}` }; }

  // 5. Deltas and direction from Binance
  const delta30s = binance.getDelta30s(contract.asset);
  const delta5m = binance.getDelta5m(contract.asset);
  const priceDirection = binance.getDirection(contract.asset);

  // 6. Realized vol (from price history)
  const history = binance.getHistory(contract.asset);
  const vol1h = history.length > 10
    ? pricing.computeRealizedVol(history, now)
    : null;

  // 7. Fair value via Black-Scholes
  const strikePrice = contract.strikePrice || spotPrice;  // fallback to current price if klines fetch failed
  const bsDirection: "UP" | "DOWN" = side === "Up" ? "UP" : "DOWN";
  const annualizedVol = vol1h || 0.60;  // default 60% annual vol if no history yet
  const fairValue = pricing.computeBinaryFairValue(
    spotPrice,
    strikePrice,
    secsRemaining,
    annualizedVol,
    bsDirection
  );

  // 8. Derived metrics
  const edgeVsSpot = pricing.computeEdgeVsSpot(fairValue, entryPrice);
  const midEdge = pricing.computeMidEdge(book.mid, entryPrice);

  // Hard gate: minimum edge (uses runtime config for hot-reload)
  if (edgeVsSpot < runtime.minEdgeVsSpot) {
    gateStats.lowEdge++;
    // Log first few edge rejections per contract to diagnose strike price issues
    if (gateStats.lowEdge <= 3) {
      const usingFallback = contract.strikePrice === null;
      logger.debug("features", `Edge reject: ${contract.asset} ${side} edge=${edgeVsSpot.toFixed(4)} fair=${fairValue.toFixed(4)} entry=${entryPrice.toFixed(4)} strike=${strikePrice.toFixed(2)}${usingFallback ? " (FALLBACK=spot)" : ""} secsRem=${secsRemaining.toFixed(0)}`);
    }
    return { features: null, rejectReason: `LOW_EDGE_${edgeVsSpot.toFixed(4)}` };
  }

  // Hard gate: maximum edge cap — edgeVsSpot > 0.30 is anti-predictive (overshoot)
  if (edgeVsSpot > runtime.maxEdgeVsSpot) {
    gateStats.lowEdge++;
    return { features: null, rejectReason: `HIGH_EDGE_${edgeVsSpot.toFixed(4)}` };
  }

  // Hard gate: midEdge must be < minMidEdge (default 0 = buying below mid)
  if (midEdge >= runtime.minMidEdge) {
    return { features: null, rejectReason: `HIGH_MID_EDGE_${midEdge.toFixed(4)}` };
  }

  // 9. Momentum alignment: does Binance direction agree with our bet?
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

  // ─── Assemble ──────────────────────────────────────────────────────────────

  gateStats.passed++;
  return {
    features: {
      spotPrice,
      delta30s,
      delta5m,
      vol1h,
      priceDirection,
      polyMid: book.mid,
      bookSpread: book.spread,
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
    },
    rejectReason: null,
  };
}
