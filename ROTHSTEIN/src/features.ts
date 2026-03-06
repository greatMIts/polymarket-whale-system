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
import * as whales from "./whale-listener";

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

export function buildFeatureVector(
  contract: ContractInfo,
  side: Side,
  tokenId: string
): FeatureVector | null {
  gateStats.total++;
  logGateSummary();

  // 1. Spot price from Binance
  const spotPrice = binance.getPrice(contract.asset);
  if (!spotPrice || spotPrice === 0) { gateStats.noSpot++; return null; }

  // 1b. Per-asset staleness check (Bug 9 fix)
  if (binance.isAssetStale(contract.asset)) { gateStats.assetStale++; return null; }

  // 2. Book state from Polymarket
  const book = polyBook.getBook(tokenId);
  if (!book || book.mid === 0) { gateStats.noBook++; return null; }

  // 3. Timing
  const now = Date.now();
  const secsRemaining = Math.max(0, (contract.endTs - now) / 1000);
  const runtime = getRuntime();

  // Hard gate: must have enough time (uses runtime config for hot-reload)
  if (secsRemaining < runtime.minSecsRemaining || secsRemaining > runtime.maxSecsRemaining) {
    gateStats.timing++;
    return null;
  }

  // 4. Entry price: we're BUYING, so use the ask (Up) or inverse (Down)
  //    For "Up" token: our entry price = best ask
  //    For "Down" token: our entry price = best ask on the down token
  const entryPrice = book.ask;
  if (entryPrice <= 0 || entryPrice >= 1) { gateStats.badEntry++; return null; }

  // Hard gates: price range & spread (uses runtime config for hot-reload)
  if (entryPrice < runtime.minPrice || entryPrice > runtime.maxPrice) { gateStats.priceRange++; return null; }
  if (book.spread > runtime.maxBookSpread) { gateStats.spread++; return null; }

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
    return null;
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
  const whaleAgreement = whaleActivity.length > 0 &&
    whaleActivity.every(w => w.side === side);

  // ─── Assemble ──────────────────────────────────────────────────────────────

  gateStats.passed++;
  return {
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
  };
}
