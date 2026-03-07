// ─── Layer 4: Main Scanning Loop ────────────────────────────────────────────
// Every scanIntervalMs (15s), evaluates ALL active contracts on BOTH sides.
// Atomic: snapshot all state at start of each cycle, no mid-scan mutations.
// Orchestrates: features → scorer → trader → decisions-log.

import { ContractInfo, Side, FeatureVector, ScoringResult } from "./types";
import { CONFIG, getRuntime } from "./config";
import { logger } from "./logger";
import * as binance from "./binance-feed";
import * as contractScanner from "./contract-scanner";
import { buildFeatureVector } from "./features";
import { computeScore } from "./scorer";
import * as trader from "./trader";
import * as decisionsLog from "./decisions-log";
import * as risk from "./risk";

// ─── State ──────────────────────────────────────────────────────────────────

let scanInterval: NodeJS.Timeout | null = null;
let lastScanTime = 0;
let scanCount = 0;
let running = false;
let scanning = false;  // guard against overlapping scans at 1s interval

// ─── Public API ─────────────────────────────────────────────────────────────

export function getLastScanTime(): number { return lastScanTime; }
export function isRunning(): boolean { return running; }
export function getScanCount(): number { return scanCount; }

// ─── Start / Stop ──────────────────────────────────────────────────────────

export function start(): void {
  if (scanInterval) return;

  running = true;
  logger.info("scanner-loop", `Starting scan loop (every ${CONFIG.scanIntervalMs / 1000}s)`);

  // Run immediately, then on interval
  runScanCycle();
  scanInterval = setInterval(runScanCycle, CONFIG.scanIntervalMs);
}

export function stop(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  running = false;
  logger.info("scanner-loop", "Scan loop stopped");
}

// ─── Single Scan Cycle ──────────────────────────────────────────────────────

async function runScanCycle(): Promise<void> {
  // Guard against overlapping scans (can happen at 1s interval if cycle takes >1s)
  if (scanning) return;
  scanning = true;

  const cycleStart = Date.now();
  scanCount++;

  try {
    // 1. Pre-check: is Binance data ready?
    if (!binance.isReady() || binance.isStale()) {
      logger.debug("scanner-loop", "Skipping scan: Binance data not ready or stale");
      return;
    }

    // 2. Pre-check: can we trade at all?
    const blockReason = risk.canTrade();
    const canTrade = blockReason === null;

    // 3. Get active contracts
    const contracts = contractScanner.getActiveContracts();
    if (contracts.length === 0) {
      if (scanCount % 300 === 0) {  // log every ~5 min (at 1s interval)
        logger.debug("scanner-loop", "No active contracts found");
      }
      lastScanTime = Date.now();
      return;
    }

    // 4. Evaluate each contract on BOTH sides
    let evaluated = 0;
    let traded = 0;

    for (const contract of contracts) {
      // Skip if not enough time
      const secsRemaining = (contract.endTs - Date.now()) / 1000;
      const runtime = getRuntime();
      if (secsRemaining < runtime.minSecsRemaining) continue;

      // Lazy-fetch strike price (Binance kline at contract window start).
      // Only fetches once per contract — returns cached value after first success.
      if (contract.strikePrice === null) {
        await contractScanner.fetchStrikePrice(contract);
      }

      // Evaluate both Up and Down
      const sides: Side[] = ["Up", "Down"];

      for (const side of sides) {
        // Pick the right token for this side
        const tokenId = pickTokenId(contract, side);
        if (!tokenId) continue;

        // Build feature vector (returns null if hard gates fail)
        const features = buildFeatureVector(contract, side, tokenId);
        if (!features) continue;

        evaluated++;

        // Score it
        const scoring = computeScore(features);

        // Decide action
        const runtime = getRuntime();
        const minScore = runtime.minTradeScore;

        if (scoring.totalScore >= minScore && canTrade) {
          // Mean-reversion flip: model is anti-predictive at 5-min scale,
          // bet the opposite side (3.6% WR → 96.4% WR from 138 trades)
          const tradeSide: Side = side === "Up" ? "Down" : "Up";
          const tradeTokenId = pickTokenId(contract, tradeSide);
          if (!tradeTokenId) continue;

          const execution = await trader.executeTrade(
            contract, tradeSide, tradeTokenId, features, scoring
          );

          if (execution) {
            traded++;
            decisionsLog.logDecision(contract, tradeSide, features, scoring, "TRADE", execution.sizeUsd);
            break; // one bet per contract — don't also flip the other side
          } else {
            // Trade blocked by risk/position limits — still log
            decisionsLog.logDecision(contract, side, features, scoring, "LOG_ONLY", scoring.suggestedSize);
          }
        } else if (scoring.totalScore >= 50) {
          // LOG_ONLY — worth watching
          decisionsLog.logDecision(contract, side, features, scoring, "LOG_ONLY", 0);
        } else if (scoring.totalScore >= 30) {
          // SKIP — but log for training data (every 45th cycle to reduce noise at 1s interval)
          if (scanCount % 45 === 0) {
            decisionsLog.logDecision(contract, side, features, scoring, "SKIP", 0);
          }
        }
        // Below 30: not even worth logging
      }
    }

    const elapsed = Date.now() - cycleStart;
    lastScanTime = Date.now();

    // Periodic status log (every ~2 min at 1s interval)
    if (scanCount % 120 === 0) {
      logger.info("scanner-loop", `Scan #${scanCount}: ${contracts.length} contracts, ${evaluated} evaluations, ${traded} trades (${elapsed}ms)${!canTrade ? ` [BLOCKED: ${blockReason}]` : ""}`);
    }

  } catch (e: any) {
    logger.error("scanner-loop", `Scan cycle error: ${e.message}`);
  } finally {
    scanning = false;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Pick the correct CLOB token ID for the given side.
 * Uses the `outcomes` array from Gamma API to match the correct token.
 * outcomes and clobTokenIds are parallel arrays: outcomes[i] describes clobTokenIds[i].
 * Fallback: if no outcomes data, assume [0]=Up, [1]=Down (original convention).
 */
function pickTokenId(contract: ContractInfo, side: Side): string | null {
  const tokens = contract.clobTokenIds;
  if (tokens.length === 0) return null;

  // Use outcomes array for reliable mapping
  if (contract.outcomes && contract.outcomes.length === tokens.length) {
    const idx = contract.outcomes.findIndex(o =>
      o.toLowerCase() === side.toLowerCase()
    );
    if (idx >= 0) return tokens[idx];
  }

  // Fallback: index-based convention [0]=Up, [1]=Down
  if (side === "Up") {
    return tokens[0];
  } else {
    return tokens.length > 1 ? tokens[1] : tokens[0];
  }
}
