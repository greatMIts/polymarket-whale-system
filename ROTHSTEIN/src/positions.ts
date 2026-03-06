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

    // Has the contract's end time passed?
    // We check if the market has resolved by looking at current book state.
    // A resolved market typically shows price at ~0.99-1.00 (winner) or ~0.00-0.01 (loser).
    const tokenId = contract.tokenId;
    const book = polyBook.getBook(tokenId);

    // Method 1: Contract time expired + book shows resolution
    // Use actual endTs from contract, NOT trade timestamp
    const contractExpired = contract.endTs > 0
      ? contract.endTs < now
      : (contract.ts + 5 * 60 * 1000) < now;  // fallback for legacy positions without endTs

    // Method 2: Market price strongly indicates resolution
    if (book && book.mid > 0) {
      const marketPrice = book.mid;

      // Clear win: market price > 0.95 on our token
      if (marketPrice >= 0.95 && contractExpired) {
        resolvePosition(id, "RESOLVED_WIN", true, marketPrice);
        continue;
      }

      // Clear loss: market price < 0.05 on our token
      if (marketPrice <= 0.05 && contractExpired) {
        resolvePosition(id, "RESOLVED_LOSS", false, marketPrice);
        continue;
      }
    }

    // Method 3: Well past expiry (>10 min), force check
    if (now - pos.openedAt > 900_000) {  // 15 minutes, generous buffer
      // Assume loss if we can't confirm win
      logger.warn("positions", `Position ${id} aged out (>15 min), marking expired`);
      resolvePosition(id, "EXPIRED", false, 0);
      continue;
    }
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
    if (currentMarketPrice < CONFIG.conditionalTpMinPrice) continue;

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
    if (currentEdge < CONFIG.conditionalTpEdgeThreshold) {
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
