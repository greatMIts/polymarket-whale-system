// ─── Layer 4: Copy Pipeline ──────────────────────────────────────────────────
// Event-driven whale copy pipeline. Replaces the 1s scan loop from scanner.ts.
//
// Flow: whale-monitor emits 'whale-trade' → aggregator accumulates per contract →
//       aggregator emits 'aggregated-signal' at $20 threshold →
//       pipeline validates → features → score → risk checks → execute → open position
//
// All bugs from v1-v4 adversarial reviews are addressed:
//   Bug #5 v1:  Execution mutex (pendingExecutions counter)
//   Bug #6 v1:  Error boundary (try/catch on handler)
//   Bug #4 v2:  tokenId resolution via contract.outcomes
//   Bug #3 v2:  score.totalScore (not score.total)
//   Bug #1 v3:  risk.canTrade() returns string|null
//   Bug #4 v3:  Duplicate position guard
//   Bug #3 v4:  risk.checkTotalRisk() dollar risk check
//   Bug #1 v4:  positions.openPosition(execution) — CRITICAL

import { WhaleSignal, ContractInfo, Side, FeatureVector, ScoringResult } from "./types";
import { CONFIG, getRuntime } from "./config";
import { logger } from "./logger";
import * as whaleMonitor from "./whale-monitor";
import * as signalAggregator from "./signal-aggregator";
import * as contractScanner from "./contract-scanner";
import * as polyBook from "./polymarket-book";
import { buildFeatureVector } from "./features";
import { computeScore } from "./scorer";
import { validateWhaleSignal } from "./signal-validator";
import * as copyExecutor from "./copy-executor";
import * as positions from "./positions";
import * as risk from "./risk";
import * as pnl from "./pnl";
import * as decisionsLog from "./decisions-log";
import * as server from "./server";

// ─── Zero stubs for early-rejection decision logging ─────────────────────────
// Used when logging decisions BEFORE features/scoring are computed.
// Makes all early rejections visible in the score feed and decisions CSV.

const ZERO_FEATURES: FeatureVector = {
  spotPrice: 0, delta30s: 0, delta5m: 0, vol1h: null, priceDirection: "FLAT",
  polyMid: 0, bookSpread: 0, secsRemaining: 0, fairValue: 0,
  edgeVsSpot: 0, midEdge: 0, entryPrice: 0, momentumAligned: false,
  hourOfDay: 0, concurrentWhales: 0, bestWalletTier: 0, whaleMaxSize: 0, whaleAgreement: false,
};

const ZERO_SCORE: ScoringResult = {
  totalScore: 0,
  components: { edgeScore: 0, midEdgeScore: 0, momentumScore: 0, timingScore: 0, activityScore: 0, whaleBonus: 0, hourBonus: 0 },
  recommendation: "SKIP",
  suggestedSize: 0,
};

// ─── Module State ────────────────────────────────────────────────────────────

let pendingExecutions = 0;  // in-flight orders (execution mutex)
let started = false;

// In-flight lock: prevents concurrent execution on the same conditionId:side.
// Unlike the removed 5-min pipeline dedup, this only blocks SIMULTANEOUS races —
// once a position is opened, hasPosition() handles subsequent signals normally.
const inFlightLock = new Set<string>();

// ─── Public API ──────────────────────────────────────────────────────────────

export function start(): void {
  if (started) return;
  started = true;

  // Start signal aggregator
  signalAggregator.start();

  // Whale trades → aggregator (accumulates per contract:side)
  whaleMonitor.on("whale-trade", (signal: WhaleSignal) => {
    signalAggregator.ingest(signal);
  });

  // Aggregated signals → pipeline (only fires when threshold reached, e.g. $20)
  signalAggregator.on("aggregated-signal", (signal: WhaleSignal) => {
    handleWhaleTrade(signal).catch(e => {
      logger.error("pipeline", `Unhandled pipeline error: ${e.message}`);
    });
  });

  const runtime = getRuntime();
  logger.info("pipeline", `Copy pipeline started — aggregating whale trades (threshold: $${runtime.minAggregatedSize})`);
}

export function stop(): void {
  started = false;
  signalAggregator.stop();
  logger.info("pipeline", "Copy pipeline stopped");
}

export function getPendingExecutions(): number {
  return pendingExecutions;
}

// ─── Main Handler ────────────────────────────────────────────────────────────

async function handleWhaleTrade(signal: WhaleSignal): Promise<void> {
  if (!started) return;

  const startMs = Date.now();

  try {
    // ─── Step 1: Resolve contract + tokenId + book (<1ms) ─────────────────

    const contract = contractScanner.getContractByConditionId(signal.conditionId);
    // Contract lookup — may fail if contract not in our active window
    // Validator will handle the null case

    const tokenId = contract ? resolveTokenId(contract, signal.side) : null;
    const book = tokenId ? polyBook.getBook(tokenId) : undefined;

    // ─── Step 2: Validate (<1ms, sync) ────────────────────────────────────

    const validation = validateWhaleSignal(signal, contract || undefined, book || undefined);
    if (!validation.pass) {
      // Log rejection to decisions file (was previously silent — only debug log)
      if (contract) {
        decisionsLog.logDecision(contract, signal.side, ZERO_FEATURES, ZERO_SCORE, "SKIP", signal.usdcSize, signal, validation.rejectReason);
      }
      logger.debug("pipeline",
        `Rejected ${signal.walletLabel} ${signal.side} on ${signal.conditionId.slice(0, 8)}...: ${validation.rejectReason}`
      );
      return;
    }

    // At this point contract and tokenId are guaranteed non-null by validator
    if (!contract || !tokenId) return;

    // ─── Step 3: Build features (~8ms, sync) ──────────────────────────────

    const features = buildFeatureVector(contract, signal.side, tokenId, signal.price);
    if (!features) {
      // Log rejection to decisions file (was previously silent — only debug log)
      decisionsLog.logDecision(contract, signal.side, ZERO_FEATURES, ZERO_SCORE, "SKIP", signal.usdcSize, signal, "FEATURES_UNAVAILABLE");
      logger.debug("pipeline",
        `No features for ${signal.walletLabel} ${signal.side} on ${contract.asset} ${contract.conditionId.slice(0, 8)}...`
      );
      return;
    }

    // Override entryPrice + midEdge: use whale's price as floor in LIVE mode
    // The book ask can be massively stale (whale swept the book, remaining asks are higher).
    // In LIVE mode: effective entry = max(book.ask, whale.price)
    // In PAPER mode: entry = whale.price (simulated fill)
    if (CONFIG.mode === "LIVE") {
      features.entryPrice = Math.max(features.entryPrice, signal.price);
    }
    // midEdge: use whale's entry price vs book mid (matches spy-server whale_trades logic)
    features.midEdge = features.polyMid - signal.price;
    // Re-derive edgeVsSpot with the corrected entry price
    features.edgeVsSpot = features.fairValue - features.entryPrice;

    // ─── Step 4: Score (~5ms, sync) ────────────────────────────────────────

    const score = computeScore(features);

    // ─── Step 5: Decision gate ────────────────────────────────────────────

    // Use runtime config so dashboard is the prime manager of score threshold
    const runtime = getRuntime();

    if (score.totalScore < runtime.minTradeScore) {
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", signal.usdcSize, signal, "SCORE_TOO_LOW");
      logger.debug("pipeline",
        `Below threshold: ${signal.walletLabel} ${signal.side} score=${score.totalScore} (min=${runtime.minTradeScore})`
      );
      return;
    }

    // ─── Step 6: Risk checks ──────────────────────────────────────────────

    // 6a. Position limit + execution mutex (Bug #5 v1)
    const totalInFlight = positions.getOpenCount() + pendingExecutions;
    if (totalInFlight >= runtime.maxConcurrentPositions) {
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", signal.usdcSize, signal, `POSITION_LIMIT_${totalInFlight}/${runtime.maxConcurrentPositions}`);
      logger.debug("pipeline", `Position limit: ${totalInFlight}/${runtime.maxConcurrentPositions}`);
      return;
    }

    // 6b. Risk manager check (Bug #1 v3: canTrade returns string|null)
    const blockReason = risk.canTrade();
    if (blockReason !== null) {
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", signal.usdcSize, signal, blockReason);
      logger.debug("pipeline", `Risk blocked: ${blockReason}`);
      return;
    }

    // 6c. Duplicate position guard (Bug #4 v3) + in-flight race lock
    const lockKey = `${signal.conditionId}:${signal.side}`;
    const hasPos = positions.hasPosition(signal.conditionId, signal.side);
    const isInFlight = inFlightLock.has(lockKey);
    if (hasPos || isInFlight) {
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", signal.usdcSize, signal, hasPos ? "DUPLICATE_POSITION" : "IN_FLIGHT");
      logger.debug("pipeline", `Already positioned/in-flight on ${signal.conditionId.slice(0, 8)} ${signal.side}`);
      return;
    }

    // 6d. Total dollar risk check (Bug #3 v4)
    const sizeUsd = copyExecutor.computeSize(score);
    const shares = pnl.computeShares(sizeUsd, features.entryPrice);
    const additionalRisk = pnl.computeRisk(features.entryPrice, shares);
    const currentRisk = positions.getTotalRiskUsd();
    if (!risk.checkTotalRisk(currentRisk, additionalRisk)) {
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", signal.usdcSize, signal, `RISK_LIMIT_${currentRisk.toFixed(0)}+${additionalRisk.toFixed(0)}>${runtime.maxTotalAtRisk}`);
      logger.debug("pipeline",
        `Risk limit: current=$${currentRisk.toFixed(2)} + $${additionalRisk.toFixed(2)} > $${runtime.maxTotalAtRisk}`
      );
      return;
    }

    // ─── Step 7: Execute ──────────────────────────────────────────────────

    // Acquire in-flight lock BEFORE async execution to prevent race condition
    inFlightLock.add(lockKey);
    pendingExecutions++;

    try {
      const execution = await copyExecutor.executeCopy(signal, score, features, tokenId, contract);

      // ─── Step 8: Open position (Bug #1 v4 — CRITICAL) ────────────────
      // Without this, trades are placed but never tracked/resolved/persisted
      positions.openPosition(execution);

      const latencyMs = Date.now() - startMs;
      decisionsLog.logDecision(contract, signal.side, features, score, "TRADE", signal.usdcSize, signal);
      server.setLastTradeTime(Date.now());

      logger.info("pipeline",
        `COPIED ${signal.walletLabel} T${signal.tier} → ${execution.asset} ${execution.side} ` +
        `$${execution.sizeUsd} @ ${execution.entryPrice.toFixed(4)} ` +
        `score=${execution.score} latency=${latencyMs}ms ` +
        `slippage=${(execution.whaleCopy?.slippageVsWhale || 0).toFixed(4)}`
      );
    } catch (e: any) {
      logger.error("pipeline",
        `Execution failed for ${signal.walletLabel} ${signal.side}: ${e.message}`
      );
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", signal.usdcSize, signal, `EXEC_FAILED: ${e.message}`);
    } finally {
      pendingExecutions--;
      // Release lock — hasPosition() now guards against future duplicates
      inFlightLock.delete(lockKey);
    }

  } catch (e: any) {
    // Top-level error boundary (Bug #6 v1)
    logger.error("pipeline", `Pipeline error: ${e.message}\n${e.stack}`);
  }
}

// ─── Token ID Resolution ─────────────────────────────────────────────────────
// Maps side → tokenId using contract.outcomes array (parallel with clobTokenIds)

function resolveTokenId(contract: ContractInfo, side: Side): string | null {
  const idx = contract.outcomes.findIndex(o => o.toLowerCase() === side.toLowerCase());

  if (idx !== -1 && idx < contract.clobTokenIds.length) {
    return contract.clobTokenIds[idx];
  }

  // Fallback: index convention [0]=Up, [1]=Down
  if (side === "Up" && contract.clobTokenIds.length > 0) return contract.clobTokenIds[0];
  if (side === "Down" && contract.clobTokenIds.length > 1) return contract.clobTokenIds[1];

  logger.error("pipeline",
    `Cannot resolve tokenId: side="${side}" outcomes=${JSON.stringify(contract.outcomes)} tokens=${contract.clobTokenIds.length}`
  );
  return null;
}
