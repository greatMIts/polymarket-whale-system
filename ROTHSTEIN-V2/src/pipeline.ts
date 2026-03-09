// ─── ROTHSTEIN V2 Copy Pipeline ───────────────────────────────────────────────
// Main orchestrator: listens for whale-trade events, runs through the filter,
// executes if passed, and opens positions.
//
// Flow: whale signal → filter → execute → open position
// In-flight lock per conditionId:side prevents duplicate entries.
// Tracks end-to-end latency from whale trade time → our execution.

import { WhaleSignal } from "./types";
import { getFilter } from "./config";
import { createLogger } from "./log";
import * as whales from "./whales";
import * as contracts from "./contracts";
import * as filter from "./filter";
import * as executor from "./executor";
import * as positions from "./positions";
import * as decisions from "./decisions";

const log = createLogger("PIPELINE");

// ─── State ───────────────────────────────────────────────────────────────────

/** In-flight locks: conditionId:side → timestamp. Prevents concurrent duplicate entries. */
const inflight = new Map<string, number>();

const INFLIGHT_TIMEOUT_MS = 10_000; // Release lock after 10s

let running = false;

// ─── Pipeline Handler ────────────────────────────────────────────────────────

async function handleWhaleSignal(signal: WhaleSignal): Promise<void> {
  const pipelineStart = Date.now();
  const cfg = getFilter();

  // ─── Paused check ────────────────────────────────────────────────────
  if (cfg.paused) return;

  // ─── Look up contract ────────────────────────────────────────────────
  const contract = contracts.getContract(signal.conditionId);

  // ─── Run filter ──────────────────────────────────────────────────────
  const result = filter.evaluate(signal, contract);

  // ─── Log decision (always, pass or fail) ─────────────────────────────
  decisions.logDecision(signal, result, contract);

  if (!result.pass) return;

  // ─── Contract must exist at this point (filter passed gate C) ────────
  if (!contract) return;

  // ─── In-flight lock ──────────────────────────────────────────────────
  const lockKey = `${signal.conditionId}:${signal.side}`;
  const now = Date.now();
  const existingLock = inflight.get(lockKey);
  if (existingLock && now - existingLock < INFLIGHT_TIMEOUT_MS) {
    log.debug(`In-flight lock active for ${lockKey}, skipping`);
    return;
  }
  inflight.set(lockKey, now);

  // ─── Position limit check ────────────────────────────────────────────
  if (!positions.canTakePosition(signal.conditionId, signal.side)) {
    log.debug(`Position limit reached for ${lockKey}`);
    inflight.delete(lockKey);
    return;
  }

  // ─── Execute trade ───────────────────────────────────────────────────
  try {
    const trade = await executor.execute(signal, contract, pipelineStart);

    if (trade) {
      positions.openPosition(trade);
      const latency = Date.now() - pipelineStart;
      log.info(
        `PIPELINE COMPLETE: ${trade.side} ${trade.asset} $${trade.sizeUsd.toFixed(2)} @ ${trade.entryPrice.toFixed(4)} | ` +
        `latency=${latency}ms whale=${signal.walletLabel}`
      );
    }
  } catch (err: any) {
    log.error(`Pipeline execution error: ${err.message}`);
  } finally {
    // Release lock after execution
    inflight.delete(lockKey);
  }
}

// ─── Inflight Cleanup ────────────────────────────────────────────────────────

function cleanupInflight(): void {
  const now = Date.now();
  for (const [key, ts] of inflight) {
    if (now - ts > INFLIGHT_TIMEOUT_MS) {
      inflight.delete(key);
    }
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function start(): void {
  if (running) return;
  running = true;
  log.info("Starting copy pipeline");

  // Listen for whale trade signals
  whales.emitter.on("whale-trade", handleWhaleSignal);

  // Periodic cleanup of stale in-flight locks
  cleanupTimer = setInterval(cleanupInflight, INFLIGHT_TIMEOUT_MS);
}

export function stop(): void {
  running = false;
  log.info("Stopping copy pipeline");

  whales.emitter.removeListener("whale-trade", handleWhaleSignal);

  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  inflight.clear();
}
