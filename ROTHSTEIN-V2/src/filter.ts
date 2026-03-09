// ─── ROTHSTEIN V2 Copy Filter ─────────────────────────────────────────────────
// THE key module. Data-driven filter that evaluates every whale signal against
// momentum, edge, timing, and risk gates. Returns FilterResult with all derived
// metrics always populated (even on reject) for decision logging.
//
// Fair value: simplified Black-Scholes binary option pricing
//   P(Up) = Phi((ln(S/K) + 0.5*sigma^2*T) / (sigma*sqrt(T)))
//   where S=spot, K=strike, sigma=annualized vol, T=time in years

import { WhaleSignal, Contract, FilterResult, Side, Asset } from "./types";
import { getFilter } from "./config";
import { createLogger } from "./log";
import * as binance from "./binance";
import * as book from "./book";
import * as whales from "./whales";

const log = createLogger("FILTER");

// ─── Constants ───────────────────────────────────────────────────────────────

// Annualized volatility estimates for 5-min crypto contracts
const ANNUALIZED_VOL: Record<Asset, number> = {
  BTC: 0.50, // ~50% annualized vol for BTC
  ETH: 0.65, // ~65% annualized vol for ETH
};

const STALE_PRICE_MS = 15_000; // Price older than 15s = stale

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Evaluate a whale signal against all filter gates.
 * Returns FilterResult with pass/fail, reason, and ALL derived metrics populated.
 */
export function evaluate(
  signal: WhaleSignal,
  contract: Contract | undefined
): FilterResult {
  const cfg = getFilter();
  const now = Date.now();

  // Initialize all metrics with defaults (populated even on early rejection)
  const metrics = buildDefaultMetrics(signal, contract, now);

  // ─── Gate A: Blocked wallet ──────────────────────────────────────────
  if (cfg.blockedWallets.some((bw) => signal.wallet.toLowerCase().includes(bw.toLowerCase()))) {
    return { ...metrics, pass: false, reason: `Blocked wallet: ${signal.walletLabel}` };
  }

  // ─── Gate B: Min whale size ──────────────────────────────────────────
  if (signal.usdcSize < cfg.minWhaleSize) {
    return { ...metrics, pass: false, reason: `Whale size $${signal.usdcSize.toFixed(2)} < min $${cfg.minWhaleSize}` };
  }

  // ─── Gate C: Contract must exist + be BTC/ETH 5min ───────────────────
  if (!contract) {
    return { ...metrics, pass: false, reason: "No matching contract found" };
  }

  // ─── Gate D: Timing — seconds remaining 150-300 ──────────────────────
  const secsRemaining = (contract.endTs - now) / 1000;
  metrics.secsRemaining = secsRemaining;
  if (secsRemaining < cfg.minSecsRemaining || secsRemaining > cfg.maxSecsRemaining) {
    return { ...metrics, pass: false, reason: `Secs remaining ${secsRemaining.toFixed(0)} outside [${cfg.minSecsRemaining}, ${cfg.maxSecsRemaining}]` };
  }

  // ─── Gate E: Spot price available (not stale) ────────────────────────
  const spotPrice = binance.getPrice(contract.asset);
  metrics.spotPrice = spotPrice;
  const binanceStatus = binance.getStatus();
  if (spotPrice <= 0 || now - binanceStatus.lastUpdate > STALE_PRICE_MS) {
    return { ...metrics, pass: false, reason: "Spot price unavailable or stale" };
  }

  // Compute deltas now that we have price
  metrics.delta30s = binance.getDelta(contract.asset, 30);
  metrics.delta5m = binance.getDelta(contract.asset, 300);

  // ─── Gate F: Book data available ─────────────────────────────────────
  const tokenId = getTokenIdForSide(contract, signal.side);
  const bookData = tokenId ? book.getBook(tokenId) : undefined;
  if (!bookData) {
    return { ...metrics, pass: false, reason: "No book data for token" };
  }
  metrics.polyMid = bookData.mid;
  metrics.bookSpread = bookData.spread;

  // ─── Compute fair value ──────────────────────────────────────────────
  const fairValue = computeFairValue(
    spotPrice,
    contract.strikePrice,
    contract.asset,
    secsRemaining,
    signal.side
  );
  metrics.fairValue = fairValue;

  // Entry price = whale's price (what we'd pay)
  const entryPrice = signal.price;
  metrics.entryPrice = entryPrice;
  metrics.edgeVsSpot = fairValue - entryPrice;
  metrics.midEdge = bookData.mid - entryPrice;

  // ─── Gate G: Momentum alignment (THE #1 signal) ─────────────────────
  const direction = binance.getDirection(contract.asset);
  const momentumAligned =
    (signal.side === "Up" && direction === "UP") ||
    (signal.side === "Down" && direction === "DOWN");
  metrics.momentumAligned = momentumAligned;

  if (cfg.requireMomentum && !momentumAligned) {
    return { ...metrics, pass: false, reason: `Momentum misaligned: whale=${signal.side} market=${direction}` };
  }

  // ─── Gate H: Edge >= 0 (fair value - entry price >= 0) ──────────────
  const edge = fairValue - entryPrice;
  if (edge < cfg.minEdge) {
    return { ...metrics, pass: false, reason: `Edge ${edge.toFixed(4)} < min ${cfg.minEdge}` };
  }
  if (edge > cfg.maxEdge) {
    return { ...metrics, pass: false, reason: `Edge ${edge.toFixed(4)} > max ${cfg.maxEdge}` };
  }

  // ─── Gate I: FOK price cap (entry <= 0.70) ───────────────────────────
  if (entryPrice > cfg.fokMaxPrice) {
    return { ...metrics, pass: false, reason: `Entry price ${entryPrice.toFixed(4)} > FOK cap ${cfg.fokMaxPrice}` };
  }

  // ─── Concurrent whales ───────────────────────────────────────────────
  metrics.concurrentWhales = whales.getConcurrentWhales(signal.conditionId);

  // ─── All gates passed ────────────────────────────────────────────────
  log.info(`PASS: ${signal.walletLabel} ${signal.side} on ${contract.asset} | edge=${edge.toFixed(4)} fv=${fairValue.toFixed(4)} entry=${entryPrice.toFixed(4)}`);

  return { ...metrics, pass: true, reason: "All gates passed" };
}

// ─── Fair Value: Simplified Black-Scholes Binary Option ──────────────────────
//
// P(Up) = Phi((ln(S/K) + 0.5 * sigma^2 * T) / (sigma * sqrt(T)))
// P(Down) = 1 - P(Up)
//
// S = current spot price
// K = strike price (contract open price)
// sigma = annualized volatility
// T = time remaining in years

function computeFairValue(
  spot: number,
  strike: number | null,
  asset: Asset,
  secsRemaining: number,
  side: Side
): number {
  if (!strike || strike <= 0 || spot <= 0 || secsRemaining <= 0) {
    return 0.5; // No data → coin flip
  }

  const sigma = ANNUALIZED_VOL[asset];
  const T = secsRemaining / (365.25 * 24 * 3600); // seconds → years
  const sqrtT = Math.sqrt(T);

  if (sqrtT * sigma === 0) return 0.5;

  const d = (Math.log(spot / strike) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const pUp = cumulativeNormal(d);

  return side === "Up" ? pUp : 1 - pUp;
}

/**
 * Cumulative normal distribution approximation (Abramowitz & Stegun 26.2.17).
 * Accurate to ~1e-5.
 */
function cumulativeNormal(x: number): number {
  if (x > 6) return 1;
  if (x < -6) return 0;

  const isNeg = x < 0;
  const z = isNeg ? -x : x;
  const t = 1 / (1 + 0.2316419 * z);

  const d = 0.3989422804014327; // 1 / sqrt(2*PI)
  const pdf = d * Math.exp(-0.5 * z * z);

  const poly =
    t * (0.319381530 +
    t * (-0.356563782 +
    t * (1.781477937 +
    t * (-1.821255978 +
    t * 1.330274429))));

  const cdf = 1 - pdf * poly;
  return isNeg ? 1 - cdf : cdf;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get the token ID corresponding to the whale's side. */
function getTokenIdForSide(contract: Contract, side: Side): string | undefined {
  // outcomes[0] = "Up" → clobTokenIds[0], outcomes[1] = "Down" → clobTokenIds[1]
  const idx = contract.outcomes.findIndex(
    (o) => o.toLowerCase() === side.toLowerCase()
  );
  return idx >= 0 ? contract.clobTokenIds[idx] : undefined;
}

/** Build default metrics (all zeroed out) for early-rejection cases. */
function buildDefaultMetrics(
  signal: WhaleSignal,
  contract: Contract | undefined,
  now: number
): FilterResult {
  const spotPrice = contract ? binance.getPrice(contract.asset) : 0;
  const secsRemaining = contract ? (contract.endTs - now) / 1000 : 0;

  return {
    pass: false,
    reason: "",
    spotPrice,
    delta30s: 0,
    delta5m: 0,
    edgeVsSpot: 0,
    polyMid: 0,
    midEdge: 0,
    entryPrice: signal.price,
    secsRemaining,
    momentumAligned: false,
    concurrentWhales: whales.getConcurrentWhales(signal.conditionId),
    fairValue: 0.5,
    bookSpread: 0,
  };
}
