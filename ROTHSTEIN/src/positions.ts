// ─── Layer 3: Position Tracker ──────────────────────────────────────────────
// Tracks open positions, checks for resolution, handles conditional TP exits.
// Atomic state transitions: OPEN → RESOLVED_WIN | RESOLVED_LOSS | EXITED_TP
// Persists to JSONL for crash recovery.

import { Position, TradeExecution, PositionStatus } from "./types";
import { CONFIG, getRuntime } from "./config";
import { appendJsonl, readJsonl } from "./persistence";
import { logger } from "./logger";
import * as risk from "./risk";
import * as pnl from "./pnl";
import * as polyBook from "./polymarket-book";
import * as pricing from "./pricing";
import * as binance from "./binance-feed";
import { backfillResolution } from "./decisions-log";
import axios from "axios";

// ─── State ──────────────────────────────────────────────────────────────────

const openPositions: Map<string, Position> = new Map();
const closedPositions: Position[] = [];
const MAX_CLOSED = 500;

// ─── Public API ─────────────────────────────────────────────────────────────

export function getOpen(): Position[] {
  return [...openPositions.values()];
}

export function getClosed(limit?: number): Position[] {
  const n = limit || 100;
  return closedPositions.slice(-n);
}

export function clearClosed(): number {
  const count = closedPositions.length;
  closedPositions.length = 0;
  logger.info("positions", `Cleared ${count} closed positions from memory`);
  return count;
}

export function getOpenCount(): number {
  return openPositions.size;
}

export function getTotalRiskUsd(): number {
  let total = 0;
  for (const pos of openPositions.values()) {
    total += pnl.computeRisk(pos.trade.entryPrice, pos.trade.shares);
  }
  return total;
}

/**
 * Check if we already have an open position for this contract+side.
 */
export function hasPosition(conditionId: string, side: string): boolean {
  for (const pos of openPositions.values()) {
    if (pos.trade.conditionId === conditionId && pos.trade.side === side) {
      return true;
    }
  }
  return false;
}

// ─── Open Position ──────────────────────────────────────────────────────────

export function openPosition(trade: TradeExecution): Position {
  const position: Position = {
    id: trade.id,
    trade,
    status: "OPEN",
    openedAt: trade.ts,
  };

  openPositions.set(position.id, position);

  // Persist
  appendJsonl(CONFIG.positionsFile, {
    type: "OPEN",
    ts: Date.now(),
    position,
  });

  logger.event("positions", "OPENED", {
    id: position.id,
    conditionId: trade.conditionId,
    side: trade.side,
    asset: trade.asset,
    entryPrice: trade.entryPrice,
    sizeUsd: trade.sizeUsd,
    shares: trade.shares,
    score: trade.score,
  });

  return position;
}

// ─── Resolution Check ──────────────────────────────────────────────────────
// Called periodically to check if open positions have resolved.

export async function checkResolutions(): Promise<void> {
  const now = Date.now();

  for (const [id, pos] of openPositions) {
    const contract = pos.trade;
    const tokenId = contract.tokenId;
    const book = polyBook.getBook(tokenId);

    // Contract expired check — endTs is in milliseconds
    const contractExpired = contract.endTs > 0
      ? contract.endTs < now
      : (contract.ts + 5 * 60 * 1000) < now;

    if (!contractExpired) continue;

    const ageSinceExpiry = Math.round((now - (contract.endTs || (contract.ts + 300_000))) / 1000);

    // ─── Method 1 (PRIMARY): Binance spot price vs strike ──────────────
    // For 5-min binary options, Binance spot is available immediately and
    // correct in the vast majority of cases.
    const spotPrice = binance.getPrice(contract.asset);
    if (spotPrice && contract.strikePrice > 0) {
      const spotAboveStrike = spotPrice > contract.strikePrice;
      const won = (contract.side === "Up" && spotAboveStrike) ||
                  (contract.side === "Down" && !spotAboveStrike);

      logger.debug("positions",
        `Binance resolution: ${id} ${contract.asset} ${contract.side} strike=${contract.strikePrice.toFixed(2)} spot=${spotPrice.toFixed(2)} → ${won ? "WIN" : "LOSS"} (expired ${ageSinceExpiry}s ago)`
      );

      resolvePosition(id, won ? "RESOLVED_WIN" : "RESOLVED_LOSS", won, won ? 1.0 : 0.0);
      continue;
    }

    // ─── Method 2: Book shows clear resolution ─────────────────────────
    if (book && book.mid > 0) {
      if (book.mid >= 0.95) {
        resolvePosition(id, "RESOLVED_WIN", true, book.mid);
        continue;
      }
      if (book.mid <= 0.05) {
        resolvePosition(id, "RESOLVED_LOSS", false, book.mid);
        continue;
      }
    }

    // ─── Method 3 (FALLBACK): CLOB API — official Polymarket resolution ─
    // Only uses the explicit winner field (no price fallback — dead market
    // prices are unreliable). Checked last as winner field may not be set
    // immediately after expiry.
    const apiResult = await fetchResolutionFromApi(contract.conditionId, contract.side);
    if (apiResult !== null) {
      logger.debug("positions",
        `CLOB API resolution: ${id} ${contract.asset} ${contract.side} → ${apiResult ? "WIN" : "LOSS"} (expired ${ageSinceExpiry}s ago)`
      );
      resolvePosition(id, apiResult ? "RESOLVED_WIN" : "RESOLVED_LOSS", apiResult, apiResult ? 1.0 : 0.0);
      continue;
    }

    // ─── Method 4: Absolute timeout (30 min) — last resort ─────────────
    if (now - pos.openedAt > 1_800_000) {
      logger.warn("positions", `Position ${id} aged out (>30 min), marking expired`);
      resolvePosition(id, "EXPIRED", false, 0);
      continue;
    }

    logger.debug("positions",
      `Unresolved: ${id} expired ${ageSinceExpiry}s ago, no spot/strike/book/API data`
    );
  }
}

// ─── Conditional Take-Profit Check ─────────────────────────────────────────
// Exits when edge deteriorates while position is in profit.
// Based on MARKET PRICE (polyMid), not limit order price.

export async function checkConditionalTp(): Promise<void> {
  for (const [id, pos] of openPositions) {
    const tokenId = pos.trade.tokenId;
    const book = polyBook.getBook(tokenId);
    if (!book || book.mid === 0) continue;

    const currentMarketPrice = book.mid;

    // Only consider TP if market price is high enough (in profit territory)
    const runtime = getRuntime();
    if (currentMarketPrice < runtime.conditionalTpMinPrice) continue;

    // Check if edge has deteriorated
    // Re-compute fair value with current data
    const spotPrice = binance.getPrice(pos.trade.asset);
    if (!spotPrice) continue;

    // Use actual contract endTs for time remaining, NOT trade.ts + 5min
    const secsRemaining = Math.max(0, (pos.trade.endTs - Date.now()) / 1000);
    if (secsRemaining <= 0) continue;

    const history = binance.getHistory(pos.trade.asset);
    const volResult = history.length > 10
      ? pricing.computeRealizedVol(history, Date.now())
      : null;
    const vol: number = volResult ?? 0.60;

    // Use stored strikePrice (Binance price at window start), NOT current spotPrice
    const strike = pos.trade.strikePrice || spotPrice;  // fallback for legacy positions
    const fairValue = pricing.computeBinaryFairValue(
      spotPrice,
      strike,
      secsRemaining,
      vol,
      pos.trade.side === "Up" ? "UP" : "DOWN"
    );

    const currentEdge = pricing.computeEdgeVsSpot(fairValue, currentMarketPrice);

    // EXIT CONDITION: Market price >= 0.85 AND edge has gone negative
    // This means the model says the position is overpriced — take the profit
    if (currentEdge < runtime.conditionalTpEdgeThreshold) {
      const exitPnl = pnl.computeExitPnl(
        pos.trade.entryPrice,
        currentMarketPrice * 0.99,  // assume ~1% slippage on exit
        pos.trade.shares
      );

      logger.event("positions", "CONDITIONAL_TP_EXIT", {
        id,
        conditionId: pos.trade.conditionId,
        entryPrice: pos.trade.entryPrice,
        currentMarketPrice,
        currentEdge: currentEdge.toFixed(4),
        estimatedPnl: exitPnl.toFixed(4),
      });

      resolvePosition(id, "EXITED_TP", true, currentMarketPrice);
    }
  }
}

// ─── Internal: Resolve a Position ──────────────────────────────────────────

function resolvePosition(
  id: string,
  status: PositionStatus,
  won: boolean,
  exitPrice: number
): void {
  const pos = openPositions.get(id);
  if (!pos) return;

  let positionPnl: number;
  if (status === "EXITED_TP") {
    positionPnl = pnl.computeExitPnl(pos.trade.entryPrice, exitPrice * 0.99, pos.trade.shares);
  } else if (won) {
    positionPnl = pnl.computePnl(pos.trade.entryPrice, pos.trade.shares, true);
  } else {
    positionPnl = pnl.computePnl(pos.trade.entryPrice, pos.trade.shares, false);
  }

  pos.status = status;
  pos.closedAt = Date.now();
  pos.exitPrice = exitPrice;
  pos.pnl = positionPnl;
  pos.resolution = won ? "WIN" : "LOSS";

  // Move to closed
  openPositions.delete(id);
  closedPositions.push(pos);
  if (closedPositions.length > MAX_CLOSED) {
    closedPositions.splice(0, closedPositions.length - MAX_CLOSED);
  }

  // Record in risk manager
  risk.recordResult(positionPnl, won);

  // Backfill decision log
  backfillResolution(pos.trade.conditionId, pos.resolution, won, positionPnl);

  // Persist
  appendJsonl(CONFIG.positionsFile, {
    type: "RESOLVED",
    ts: Date.now(),
    id,
    status,
    won,
    pnl: positionPnl,
    exitPrice,
  });

  // Log
  logger.resolution({
    id,
    conditionId: pos.trade.conditionId,
    side: pos.trade.side,
    asset: pos.trade.asset,
    entryPrice: pos.trade.entryPrice,
    exitPrice,
    pnl: positionPnl.toFixed(4),
    status,
    score: pos.trade.score,
    durationMs: (pos.closedAt! - pos.openedAt),
  });
}

// ─── Crash Recovery ─────────────────────────────────────────────────────────

export function loadFromDisk(): void {
  const entries = readJsonl<any>(CONFIG.positionsFile);
  if (entries.length === 0) return;

  // Rebuild state from JSONL
  const tempOpen = new Map<string, Position>();

  for (const entry of entries) {
    if (entry.type === "OPEN" && entry.position) {
      tempOpen.set(entry.position.id, entry.position);
    } else if (entry.type === "RESOLVED" && entry.id) {
      const pos = tempOpen.get(entry.id);
      if (pos) {
        pos.status = entry.status;
        pos.closedAt = entry.ts;
        pos.exitPrice = entry.exitPrice;
        pos.pnl = entry.pnl;
        pos.resolution = entry.won ? "WIN" : "LOSS";
        closedPositions.push(pos);
        tempOpen.delete(entry.id);
      }
    }
  }

  // Remaining open positions (not yet resolved)
  for (const [id, pos] of tempOpen) {
    // Only restore if not too old (< 30 min)
    if (Date.now() - pos.openedAt < 1_800_000) {
      openPositions.set(id, pos);
    }
  }

  logger.info("positions", `Crash recovery: ${openPositions.size} open, ${closedPositions.length} closed`);
}

// ─── CLOB API Resolution Query ──────────────────────────────────────────────
// After contract expiry, market makers pull orders and the book goes dead.
// This queries the CLOB API directly for the market's resolution.
// Returns: true = our side won, false = our side lost, null = not yet resolved.

const _apiResolutionCache = new Map<string, { ts: number; result: boolean | null }>();

// Periodic cache cleanup to prevent memory leak — remove entries older than 5 minutes
export function cleanupResolutionCache(): void {
  const now = Date.now();
  for (const [key, entry] of _apiResolutionCache) {
    if (now - entry.ts > 300_000) {
      _apiResolutionCache.delete(key);
    }
  }
}

async function fetchResolutionFromApi(conditionId: string, side: string): Promise<boolean | null> {
  // Rate-limit: don't re-query same condition+side within 5s
  // BUG FIX: cache key MUST include side — result is side-specific.
  // Using just conditionId caused BOTH Up and Down to get the same cached answer.
  const cacheKey = `${conditionId}:${side}`;
  const cached = _apiResolutionCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 5_000) return cached.result;

  try {
    const { data } = await axios.get(`${CONFIG.clobApi}/markets/${conditionId}`, {
      timeout: 5000,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });

    // CLOB API returns a market object with a nested `tokens` array:
    //   { condition_id, question, tokens: [{ token_id, outcome, price, winner }, ...] }
    // Extract the tokens array from the response.
    const tokens: any[] = Array.isArray(data?.tokens) ? data.tokens
                        : Array.isArray(data) ? data
                        : [];

    if (tokens.length === 0) {
      logger.debug("positions", `CLOB API returned no tokens for ${conditionId}`);
      _apiResolutionCache.set(cacheKey, { ts: Date.now(), result: null });
      return null;
    }

    // Find our side's token (outcomes are "Up"/"Down" matching our Side type)
    const ourToken = tokens.find((t: any) =>
      t.outcome?.toLowerCase() === side.toLowerCase()
    );

    if (!ourToken) {
      _apiResolutionCache.set(cacheKey, { ts: Date.now(), result: null });
      return null;
    }

    // ONLY use the explicit winner field — this is the official Polymarket resolution.
    // BUG FIX: Do NOT fall back to token price. After expiry, market makers pull
    // orders and BOTH Up and Down token prices drop to ~0 (dead market). Using
    // price <= 0.05 as a LOSS signal was resolving ALL positions as losses,
    // including the actual winner. The winner field is the only reliable signal.
    if (ourToken.winner === true) {
      _apiResolutionCache.set(cacheKey, { ts: Date.now(), result: true });
      return true;
    }
    if (ourToken.winner === false) {
      _apiResolutionCache.set(cacheKey, { ts: Date.now(), result: false });
      return false;
    }

    // Winner field not set yet — market not officially resolved.
    // Return null so other methods (Book, Binance) can handle it.
    _apiResolutionCache.set(cacheKey, { ts: Date.now(), result: null });
    return null;
  } catch (e: any) {
    logger.debug("positions", `CLOB API resolution check failed for ${conditionId}: ${e.message}`);
    return null;
  }
}
