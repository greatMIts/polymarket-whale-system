// ─── Layer 4: Copy Pipeline ──────────────────────────────────────────────────
// Event-driven whale copy pipeline. Replaces the 1s scan loop from scanner.ts.
//
// Flow: whale-monitor emits 'whale-trade' → pipeline validates → features →
//       score → risk checks → execute → open position
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

import { WhaleSignal, ContractInfo, Side } from "./types";
import { CONFIG, getRuntime } from "./config";
import { logger } from "./logger";
import * as whaleMonitor from "./whale-monitor";
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

// ─── Module State ────────────────────────────────────────────────────────────

let pendingExecutions = 0;  // in-flight orders (execution mutex)
let started = false;

// Pipeline-level dedup: conditionId:side → timestamp of last execution
// Prevents the same whale signal from triggering multiple copy trades
// when overlapping poll responses return the same recent trades
const executedKeys = new Map<string, number>();
const EXECUTED_KEY_TTL = 300_000;  // 5 min — covers full contract lifecycle

// ─── Public API ──────────────────────────────────────────────────────────────

export function start(): void {
  if (started) return;
  started = true;

  whaleMonitor.on("whale-trade", (signal: WhaleSignal) => {
    handleWhaleTrade(signal).catch(e => {
      logger.error("pipeline", `Unhandled pipeline error: ${e.message}`);
    });
  });

  logger.info("pipeline", "Copy pipeline started — listening for whale-trade events");
}

export function stop(): void {
  started = false;
  // EventEmitter listeners persist but will be ignored when started=false
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
      logger.debug("pipeline",
        `Rejected ${signal.walletLabel} ${signal.side} on ${signal.conditionId.slice(0, 8)}...: ${validation.rejectReason}`
      );
      return;
    }

    // At this point contract and tokenId are guaranteed non-null by validator
    if (!contract || !tokenId) return;

    // ─── Step 2b: Pipeline dedup (prevents duplicate executions) ─────────
    // Same conditionId:side can only execute once per 5 min window.
    // This stops overlapping poll responses from triggering 3+ copy trades
    // from a single whale trade, which also prevents circuit breaker poisoning.
    // Key is set EAGERLY here (before scoring/execution) so concurrent handlers
    // see it immediately — prevents race condition where two handlers both
    // pass the check before either sets the key.
    const execKey = `${signal.conditionId}:${signal.side}`;
    const lastExec = executedKeys.get(execKey);
    if (lastExec && (Date.now() - lastExec) < EXECUTED_KEY_TTL) {
      logger.debug("pipeline",
        `Dedup: already processed ${signal.side} on ${signal.conditionId.slice(0, 8)}... ${Math.round((Date.now() - lastExec) / 1000)}s ago`
      );
      return;
    }
    executedKeys.set(execKey, Date.now());  // eager lock

    // ─── Step 3: Build features (~8ms, sync) ──────────────────────────────

    const features = buildFeatureVector(contract, signal.side, tokenId);
    if (!features) {
      logger.debug("pipeline",
        `No features for ${signal.walletLabel} ${signal.side} on ${contract.asset} ${contract.conditionId.slice(0, 8)}...`
      );
      return;
    }

    // ─── Step 4: Score (~5ms, sync) ────────────────────────────────────────

    const score = computeScore(features);

    // ─── Step 5: Decision gate ────────────────────────────────────────────

    if (score.totalScore < CONFIG.minCopyScore) {
      // Log for ML training data
      decisionsLog.logDecision(contract, signal.side, features, score, "LOG_ONLY", 0, signal);
      logger.debug("pipeline",
        `Below threshold: ${signal.walletLabel} ${signal.side} score=${score.totalScore} (min=${CONFIG.minCopyScore})`
      );
      return;
    }

    // ─── Step 6: Risk checks ──────────────────────────────────────────────

    // 6a. Position limit + execution mutex (Bug #5 v1)
    const runtime = getRuntime();
    const totalInFlight = positions.getOpenCount() + pendingExecutions;
    if (totalInFlight >= runtime.maxConcurrentPositions) {
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", 0, signal);
      logger.debug("pipeline", `Position limit: ${totalInFlight}/${runtime.maxConcurrentPositions}`);
      return;
    }

    // 6b. Risk manager check (Bug #1 v3: canTrade returns string|null)
    const blockReason = risk.canTrade();
    if (blockReason !== null) {
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", 0, signal);
      logger.debug("pipeline", `Risk blocked: ${blockReason}`);
      return;
    }

    // 6c. Duplicate position guard (Bug #4 v3)
    if (positions.hasPosition(signal.conditionId, signal.side)) {
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", 0, signal);
      logger.debug("pipeline", `Already positioned on ${signal.conditionId.slice(0, 8)} ${signal.side}`);
      return;
    }

    // 6d. Total dollar risk check (Bug #3 v4)
    const sizeUsd = copyExecutor.computeSize(score);
    const shares = pnl.computeShares(sizeUsd, features.entryPrice);
    const additionalRisk = pnl.computeRisk(features.entryPrice, shares);
    if (!risk.checkTotalRisk(positions.getTotalRiskUsd(), additionalRisk)) {
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", 0, signal);
      logger.debug("pipeline",
        `Risk limit: current=$${positions.getTotalRiskUsd().toFixed(2)} + $${additionalRisk.toFixed(2)} > $${runtime.maxTotalAtRisk}`
      );
      return;
    }

    // ─── Step 7: Execute ──────────────────────────────────────────────────

    pendingExecutions++;

    try {
      const execution = await copyExecutor.executeCopy(signal, score, features, tokenId, contract);

      // ─── Step 8: Open position (Bug #1 v4 — CRITICAL) ────────────────
      // Without this, trades are placed but never tracked/resolved/persisted
      positions.openPosition(execution);

      // Cleanup old dedup keys periodically
      if (executedKeys.size > 100) {
        const cutoff = Date.now() - EXECUTED_KEY_TTL;
        for (const [k, ts] of executedKeys) {
          if (ts < cutoff) executedKeys.delete(k);
        }
      }

      const latencyMs = Date.now() - startMs;
      decisionsLog.logDecision(contract, signal.side, features, score, "TRADE", execution.sizeUsd, signal);
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
      decisionsLog.logDecision(contract, signal.side, features, score, "SKIP", 0, signal);
    } finally {
      pendingExecutions--;
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
