// ─── Layer 1.5: Signal Aggregator ────────────────────────────────────────────
// Accumulates whale micro-trades per conditionId:side.
// Whales split large positions into 10-20 micro-trades ($1-$6 each).
// This module accumulates them and emits one aggregated signal when
// the total USD reaches the threshold (default $20).
//
// Key: conditionId:side (cross-wallet aggregation)
// VWAP: volume-weighted average price across all micro-trades
// Best wallet: highest tier whale's metadata used for the aggregated signal

import { EventEmitter } from "events";
import { WhaleSignal, Side } from "./types";
import { getRuntime } from "./config";
import { logger } from "./logger";

// ─── Constants ───────────────────────────────────────────────────────────────

const CLEANUP_INTERVAL_MS = 30_000;    // cleanup stale buckets every 30s

// ─── Aggregation Bucket ─────────────────────────────────────────────────────

interface AggBucket {
  conditionId: string;
  side: Side;
  totalUsd: number;
  totalValue: number;       // sum(price * usdcSize) for VWAP
  tradeCount: number;
  signals: WhaleSignal[];
  firstTs: number;          // timestamp of first trade in window
  triggeredAtUsd: number;   // last USD threshold that fired (0 = not yet triggered, re-fires every $minAggregatedSize increment)
}

// ─── Module State ────────────────────────────────────────────────────────────

const emitter = new EventEmitter();
emitter.setMaxListeners(20);

const buckets = new Map<string, AggBucket>();
let cleanupTimer: NodeJS.Timeout | null = null;
let totalIngested = 0;
let totalTriggered = 0;
let totalExpired = 0;

// ─── Public API ──────────────────────────────────────────────────────────────

export function on(event: string, handler: (...args: any[]) => void): void {
  emitter.on(event, handler);
}

export function off(event: string, handler: (...args: any[]) => void): void {
  emitter.off(event, handler);
}

export function start(): void {
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  logger.info("aggregator", `Signal aggregator started (threshold: $${getRuntime().minAggregatedSize}, window: ${getRuntime().aggregationWindowMs / 1000}s)`);
}

export function stop(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export function getStats(): { ingested: number; triggered: number; expired: number; activeBuckets: number } {
  return {
    ingested: totalIngested,
    triggered: totalTriggered,
    expired: totalExpired,
    activeBuckets: buckets.size,
  };
}

// ─── Ingest a Whale Trade ────────────────────────────────────────────────────
// Called for EVERY whale-trade event. Accumulates per conditionId:side.
// When accumulated total reaches threshold, emits 'aggregated-signal'.

export function ingest(signal: WhaleSignal): void {
  const runtime = getRuntime();
  const key = `${signal.conditionId}:${signal.side}`;
  totalIngested++;

  let bucket = buckets.get(key);

  // Create new bucket or reset if window expired
  if (!bucket || (Date.now() - bucket.firstTs > runtime.aggregationWindowMs)) {
    if (bucket && bucket.triggeredAtUsd === 0) {
      totalExpired++;
      logger.debug("aggregator",
        `Expired bucket ${signal.conditionId.slice(0, 8)} ${bucket.side}: $${bucket.totalUsd.toFixed(0)} from ${bucket.tradeCount} trades (didn't reach $${runtime.minAggregatedSize})`
      );
    }

    bucket = {
      conditionId: signal.conditionId,
      side: signal.side,
      totalUsd: 0,
      totalValue: 0,
      tradeCount: 0,
      signals: [],
      firstTs: Date.now(),
      triggeredAtUsd: 0,
    };
    buckets.set(key, bucket);
  }

  // Accumulate
  bucket.totalUsd += signal.usdcSize;
  bucket.totalValue += signal.price * signal.usdcSize;
  bucket.tradeCount++;
  bucket.signals.push(signal);

  logger.debug("aggregator",
    `${signal.walletLabel} +$${signal.usdcSize.toFixed(0)} on ${signal.conditionId.slice(0, 8)} ${signal.side} → cumulative $${bucket.totalUsd.toFixed(0)}/${runtime.minAggregatedSize} (${bucket.tradeCount} trades)`
  );

  // Check threshold — re-triggers at every $minAggregatedSize increment
  // e.g. at $20, $40, $60... so heavy whale activity gets multiple evaluations
  const nextThreshold = bucket.triggeredAtUsd + runtime.minAggregatedSize;
  if (bucket.totalUsd >= nextThreshold) {
    bucket.triggeredAtUsd = Math.floor(bucket.totalUsd / runtime.minAggregatedSize) * runtime.minAggregatedSize;
    totalTriggered++;

    // Build aggregated signal
    const bestSignal = selectBestSignal(bucket.signals);
    const vwap = bucket.totalValue / bucket.totalUsd;

    const aggregatedSignal: WhaleSignal = {
      ...bestSignal,
      usdcSize: bucket.totalUsd,     // override with accumulated total
      price: vwap,                    // VWAP across all micro-trades
      // Keep bestSignal.detectedAt (original whale-monitor detection time) for truthful latency
      aggregatedAt: Date.now(),       // when aggregator threshold was crossed
    };

    logger.info("aggregator",
      `TRIGGERED ${signal.conditionId.slice(0, 8)} ${signal.side}: ` +
      `$${bucket.totalUsd.toFixed(0)} from ${bucket.tradeCount} trades ` +
      `(VWAP ${vwap.toFixed(4)}, best wallet: ${bestSignal.walletLabel} T${bestSignal.tier})`
    );

    emitter.emit("aggregated-signal", aggregatedSignal);
  }
}

// ─── Select Best Signal ──────────────────────────────────────────────────────
// Pick the highest-tier whale (lowest tier number = best).
// Tie-break: largest individual trade.

function selectBestSignal(signals: WhaleSignal[]): WhaleSignal {
  return signals.reduce((best, s) => {
    if (s.tier < best.tier) return s;
    if (s.tier === best.tier && s.usdcSize > best.usdcSize) return s;
    return best;
  });
}

// ─── Cleanup Stale Buckets ───────────────────────────────────────────────────

function cleanup(): void {
  const runtime = getRuntime();
  const cutoff = Date.now() - runtime.aggregationWindowMs;

  for (const [key, bucket] of buckets) {
    if (bucket.firstTs < cutoff) {
      if (bucket.triggeredAtUsd === 0) {
        totalExpired++;
      }
      buckets.delete(key);
    }
  }
}
