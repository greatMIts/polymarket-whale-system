// ─── Layer 3: Trade Executor ────────────────────────────────────────────────
// Executes trades in PAPER or LIVE mode.
// PAPER mode: simulate fills at current ask price.
// LIVE mode: submit FOK limit orders to Polymarket CLOB.
// Returns a TradeExecution on success, null on failure.

import { TradeExecution, ScoringResult, ContractInfo, FeatureVector, Side, Mode } from "./types";
import { CONFIG, getRuntime } from "./config";
import { logger } from "./logger";
import * as positions from "./positions";
import * as pnl from "./pnl";
import * as risk from "./risk";

let tradeCounter = 0;

// ─── Generate Trade ID ─────────────────────────────────────────────────────

function generateTradeId(): string {
  tradeCounter++;
  const ts = Date.now().toString(36);
  const count = tradeCounter.toString(36).padStart(4, "0");
  return `R-${ts}-${count}`;
}

// ─── Execute Trade ──────────────────────────────────────────────────────────

export async function executeTrade(
  contract: ContractInfo,
  side: Side,
  tokenId: string,
  features: FeatureVector,
  scoring: ScoringResult
): Promise<TradeExecution | null> {

  // ─── Pre-flight checks ──────────────────────────────────────────────────

  // 1. Risk check: can we trade?
  const blockReason = risk.canTrade();
  if (blockReason) {
    logger.debug("trader", `Trade blocked: ${blockReason}`);
    return null;
  }

  // 2. Already have a position on this contract+side?
  if (positions.hasPosition(contract.conditionId, side)) {
    logger.debug("trader", `Already positioned on ${contract.conditionId} ${side}`);
    return null;
  }

  // 3. Position limit
  const runtime = getRuntime();
  if (positions.getOpenCount() >= runtime.maxConcurrentPositions) {
    logger.debug("trader", `Max concurrent positions reached (${runtime.maxConcurrentPositions})`);
    return null;
  }

  // 4. Compute final size with risk multiplier
  const effectiveMultiplier = risk.getEffectiveSizingMultiplier();
  const sizeUsd = Math.max(1, Math.round(scoring.suggestedSize * effectiveMultiplier * 100) / 100);

  // 5. Total risk check
  const shares = pnl.computeShares(sizeUsd, features.entryPrice);
  const additionalRisk = pnl.computeRisk(features.entryPrice, shares);
  if (!risk.checkTotalRisk(positions.getTotalRiskUsd(), additionalRisk)) {
    logger.warn("trader", `Total risk limit exceeded. Current: $${positions.getTotalRiskUsd().toFixed(2)}, Additional: $${additionalRisk.toFixed(2)}`);
    return null;
  }

  // ─── Execute ──────────────────────────────────────────────────────────────

  const tradeId = generateTradeId();
  let orderId: string | undefined;

  if (CONFIG.mode === "LIVE") {
    const result = await executeLiveOrder(tokenId, side, sizeUsd, features.entryPrice);
    if (!result) {
      logger.error("trader", "Live order FAILED — no fill");
      return null;
    }
    orderId = result;
  }

  // ─── Record ──────────────────────────────────────────────────────────────

  const trade: TradeExecution = {
    id: tradeId,
    ts: Date.now(),
    conditionId: contract.conditionId,
    tokenId,
    title: contract.title,
    side,
    asset: contract.asset,
    entryPrice: features.entryPrice,
    sizeUsd,
    shares,
    score: scoring.totalScore,
    components: scoring.components,
    features,
    mode: CONFIG.mode,
    orderId,
    endTs: contract.endTs,
    strikePrice: contract.strikePrice || features.spotPrice,
  };

  // Open position
  positions.openPosition(trade);

  logger.trade({
    id: trade.id,
    mode: trade.mode,
    conditionId: trade.conditionId,
    side: trade.side,
    asset: trade.asset,
    entryPrice: trade.entryPrice.toFixed(4),
    sizeUsd: trade.sizeUsd,
    shares: trade.shares.toFixed(4),
    score: trade.score,
    edgeVsSpot: features.edgeVsSpot.toFixed(4),
    midEdge: features.midEdge.toFixed(4),
    momentum: features.momentumAligned,
  });

  return trade;
}

// ─── Live Order Execution (CLOB FOK Limit Order) ───────────────────────────
// Fill-or-Kill limit order at the ask price. If it doesn't fill, we move on.

async function executeLiveOrder(
  tokenId: string,
  side: Side,
  sizeUsd: number,
  limitPrice: number
): Promise<string | null> {
  // NOTE: Live trading requires py-clob-client equivalent in Node.js
  // or direct HTTP signing with Polymarket's EIP-712 order format.
  // For now, this is a placeholder that will be wired up for live mode.
  //
  // The spy server's clob-client.ts has a working implementation we can port.
  // Key steps:
  //   1. Build EIP-712 order object
  //   2. Sign with POLY_PRIVATE_KEY
  //   3. POST to clob.polymarket.com/order
  //   4. Include orderType: "FOK" (fill-or-kill)
  //
  // For PAPER mode this is never called.

  logger.warn("trader", "LIVE ORDER EXECUTION NOT YET IMPLEMENTED");
  logger.warn("trader", "Falling back to PAPER simulation");

  // Return a simulated order ID
  return `PAPER-${Date.now().toString(36)}`;
}
