// ─── ROTHSTEIN V2 Decision Logger ─────────────────────────────────────────────
// Appends every whale trade evaluation to data/decisions.csv.
// File rotation at 50K lines. All metrics logged regardless of pass/fail.

import * as fs from "fs";
import * as path from "path";
import { Decision, WhaleSignal, FilterResult, Contract, Asset } from "./types";
import { ENV } from "./config";
import { createLogger } from "./log";

const log = createLogger("DECISIONS");

// ─── State ───────────────────────────────────────────────────────────────────

const MAX_LINES = 50_000;

let decisionsFile: string;
let lineCount = 0;
let initialized = false;

/** In-memory ring buffer of recent decisions for the dashboard. */
const recentDecisions: Decision[] = [];
const MAX_RECENT = 100;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Log a filter evaluation as a decision.
 * Called for EVERY whale trade — both copies and skips.
 */
export function logDecision(
  signal: WhaleSignal,
  result: FilterResult,
  contract: Contract | undefined
): Decision {
  const decision: Decision = {
    ts: Date.now(),
    conditionId: signal.conditionId,
    title: contract?.title || signal.conditionId.slice(0, 16),
    asset: contract?.asset || ("?" as Asset),
    side: signal.side,
    action: result.pass ? "COPY" : "SKIP",
    reason: result.reason,
    // Whale info
    whaleWallet: signal.wallet,
    whaleLabel: signal.walletLabel,
    whaleSize: signal.usdcSize,
    whalePrice: signal.price,
    // Derived metrics (always populated)
    spotPrice: result.spotPrice,
    delta30s: result.delta30s,
    delta5m: result.delta5m,
    edgeVsSpot: result.edgeVsSpot,
    polyMid: result.polyMid,
    midEdge: result.midEdge,
    entryPrice: result.entryPrice,
    secsRemaining: result.secsRemaining,
    momentumAligned: result.momentumAligned,
    concurrentWhales: result.concurrentWhales,
    fairValue: result.fairValue,
    bookSpread: result.bookSpread,
    // Latency
    latencyMs: Date.now() - signal.detectedAt,
  };

  // Add to in-memory ring buffer
  recentDecisions.unshift(decision);
  if (recentDecisions.length > MAX_RECENT) recentDecisions.length = MAX_RECENT;

  // Persist to file
  appendDecision(decision);

  return decision;
}

/** Recent decisions for dashboard display (newest first). */
export function getRecentDecisions(): Decision[] {
  return recentDecisions;
}

// ─── CSV Helpers ─────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  "ts", "datetime", "conditionId", "title", "asset", "side", "action", "reason",
  "whaleWallet", "whaleLabel", "whaleSize", "whalePrice",
  "spotPrice", "delta30s", "delta5m", "edgeVsSpot", "polyMid", "midEdge",
  "entryPrice", "secsRemaining", "momentumAligned", "concurrentWhales",
  "fairValue", "bookSpread", "latencyMs",
];

function csvEscape(val: any): string {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function decisionToCsvRow(d: Decision): string {
  const dt = new Date(d.ts).toISOString();
  const vals = [
    d.ts, dt, d.conditionId, d.title, d.asset, d.side, d.action, d.reason,
    d.whaleWallet, d.whaleLabel, d.whaleSize, d.whalePrice,
    d.spotPrice, d.delta30s, d.delta5m, d.edgeVsSpot, d.polyMid, d.midEdge,
    d.entryPrice, d.secsRemaining, d.momentumAligned, d.concurrentWhales,
    d.fairValue, d.bookSpread, d.latencyMs,
  ];
  return vals.map(csvEscape).join(",");
}

// ─── File Persistence ────────────────────────────────────────────────────────

function appendDecision(decision: Decision): void {
  try {
    if (!initialized) return;

    const row = decisionToCsvRow(decision);
    fs.appendFileSync(decisionsFile, row + "\n");
    lineCount++;

    // Rotate if over the limit
    if (lineCount >= MAX_LINES) {
      rotate();
    }
  } catch (err: any) {
    log.error("Failed to append decision", err.message);
  }
}

function rotate(): void {
  try {
    const dir = path.dirname(decisionsFile);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveName = `decisions-${ts}.csv`;
    const archivePath = path.resolve(dir, archiveName);

    fs.renameSync(decisionsFile, archivePath);
    lineCount = 0;
    // Write headers to new file
    fs.writeFileSync(decisionsFile, CSV_HEADERS.join(",") + "\n");
    log.info(`Rotated decisions log → ${archiveName}`);
  } catch (err: any) {
    log.error("Decision log rotation failed", err.message);
    lineCount = 0;
  }
}

function countLines(): number {
  try {
    if (!fs.existsSync(decisionsFile)) return 0;
    const content = fs.readFileSync(decisionsFile, "utf8");
    // Subtract 1 for the header line
    return Math.max(0, content.split("\n").filter((l) => l.trim().length > 0).length - 1);
  } catch {
    return 0;
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function start(): void {
  const dir = path.resolve(ENV.dataDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  decisionsFile = path.resolve(dir, "decisions.csv");
  // Write CSV header if file doesn't exist or is empty
  if (!fs.existsSync(decisionsFile) || fs.statSync(decisionsFile).size === 0) {
    fs.writeFileSync(decisionsFile, CSV_HEADERS.join(",") + "\n");
  }
  lineCount = countLines();
  initialized = true;
  log.info(`Decision logger started (${lineCount} existing lines)`);
}

export function stop(): void {
  initialized = false;
  log.info("Decision logger stopped");
}
