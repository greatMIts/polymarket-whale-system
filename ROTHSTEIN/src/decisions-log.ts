// ─── Layer 3: Decision Logger ───────────────────────────────────────────────
// Logs EVERY scored opportunity to JSONL — traded or not.
// This is the ML training data pipeline. Every decision becomes a labeled row.
// Resolution is backfilled when positions resolve.

import { DecisionLogEntry, ScoringResult, ContractInfo, FeatureVector, Side, Asset } from "./types";
import { CONFIG } from "./config";
import { appendJsonl, readJsonl } from "./persistence";
import { logger } from "./logger";

// ─── In-memory buffer for recent decisions (for dashboard + backfill) ───────

const recentDecisions: DecisionLogEntry[] = [];
const MAX_RECENT = 200;

// ─── Log a Decision ─────────────────────────────────────────────────────────

export function logDecision(
  contract: ContractInfo,
  side: Side,
  features: FeatureVector,
  scoring: ScoringResult,
  action: "SKIP" | "LOG_ONLY" | "TRADE",
  sizeUsd: number
): DecisionLogEntry {
  const entry: DecisionLogEntry = {
    ts: Date.now(),
    conditionId: contract.conditionId,
    title: contract.title,
    side,
    asset: contract.asset,
    score: scoring.totalScore,
    components: scoring.components,
    features,
    action,
    sizeUsd,
    entryPrice: features.entryPrice,
    secsRemaining: features.secsRemaining,
  };

  // Persist to JSONL
  appendJsonl(CONFIG.decisionsFile, entry);

  // In-memory buffer
  recentDecisions.push(entry);
  if (recentDecisions.length > MAX_RECENT) {
    recentDecisions.splice(0, recentDecisions.length - MAX_RECENT);
  }

  // Log to console
  logger.decision({
    conditionId: entry.conditionId,
    side: entry.side,
    asset: entry.asset,
    score: entry.score,
    action: entry.action,
    edgeVsSpot: features.edgeVsSpot.toFixed(4),
    midEdge: features.midEdge.toFixed(4),
    entryPrice: features.entryPrice.toFixed(4),
    secsRemaining: Math.round(features.secsRemaining),
    sizeUsd: entry.sizeUsd,
  });

  return entry;
}

// ─── Backfill Resolution ────────────────────────────────────────────────────
// Called when a position resolves. Updates matching decisions with outcome.

export function backfillResolution(
  conditionId: string,
  resolution: string,
  won: boolean,
  pnl: number
): void {
  for (const d of recentDecisions) {
    if (d.conditionId === conditionId && d.resolution === undefined) {
      d.resolution = resolution;
      d.won = won;
      d.pnl = pnl;
    }
  }

  // Also append a resolution event to JSONL
  appendJsonl(CONFIG.decisionsFile, {
    type: "RESOLUTION",
    ts: Date.now(),
    conditionId,
    resolution,
    won,
    pnl,
  });
}

// ─── Get Recent Decisions (for dashboard) ──────────────────────────────────

export function getRecentDecisions(limit?: number): DecisionLogEntry[] {
  const n = limit || 50;
  return recentDecisions.slice(-n);
}

// ─── Load decisions from disk (crash recovery) ─────────────────────────────
// Populates recentDecisions in-memory buffer so dashboard shows history on restart.

export function loadDecisionsFromDisk(): void {
  const entries = readJsonl<any>(CONFIG.decisionsFile);
  // Filter to only actual decision entries (skip RESOLUTION events)
  const decisions = entries.filter((e: any) => e.ts && e.conditionId && e.score !== undefined && !e.type);
  // Take the last MAX_RECENT entries
  const recent = decisions.slice(-MAX_RECENT);
  recentDecisions.push(...recent);
  if (recentDecisions.length > MAX_RECENT) {
    recentDecisions.splice(0, recentDecisions.length - MAX_RECENT);
  }
  if (recent.length > 0) {
    logger.info("decisions", `Loaded ${recent.length} recent decisions from disk`);
  }
}
