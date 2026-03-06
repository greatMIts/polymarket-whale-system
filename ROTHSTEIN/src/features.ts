// ─── Layer 2: Feature Assembly ───────────────────────────────────────────────
// Combines all data sources into a single FeatureVector.
// Pure snapshot function — grabs state from all Layer 1 modules at call time.
// NO async, NO side effects. Returns null if data is insufficient.

import { FeatureVector, ContractInfo, Side, Direction, Asset } from "./types";
import { CONFIG } from "./config";
import * as binance from "./binance-feed";
import * as polyBook from "./polymarket-book";
import * as pricing from "./pricing";
import * as whales from "./whale-listener";

// ─── Build Feature Vector ──────────────────────────────────────────────────

export function buildFeatureVector(
  contract: ContractInfo,
  side: Side,
  tokenId: string
): FeatureVector | null {

  // 1. Spot price from Binance
  const spotPrice = binance.getPrice(contract.asset);
  if (!spotPrice || spotPrice === 0) return null;

  // 2. Book state from Polymarket
  const book = polyBook.getBook(tokenId);
  if (!book || book.mid === 0) return null;

  // 3. Timing
  const now = Date.now();
  const secsRemaining = Math.max(0, (contract.endTs - now) / 1000);

  // Hard gate: must have enough time
  if (secsRemaining < CONFIG.minSecsRemaining || secsRemaining > CONFIG.maxSecsRemaining) {
    return null;
  }

  // 4. Entry price: we're BUYING, so use the ask (Up) or inverse (Down)
  //    For "Up" token: our entry price = best ask
  //    For "Down" token: our entry price = best ask on the down token
  const entryPrice = book.ask;
  if (entryPrice <= 0 || entryPrice >= 1) return null;

  // Hard gates: price range & spread
  if (entryPrice < CONFIG.minPrice || entryPrice > CONFIG.maxPrice) return null;
  if (book.spread > CONFIG.maxBookSpread) return null;

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
  const strikePrice = contract.strikePrice || spotPrice;  // fallback to current price
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

  // Hard gate: minimum edge
  if (edgeVsSpot < CONFIG.minEdgeVsSpot) return null;

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
