// ─── ROTHSTEIN V2 Position Tracker ────────────────────────────────────────────
// Opens/closes positions, tracks PnL and session stats.
// Polls Gamma API for contract resolution.
// Persists trades to data/trades.jsonl (append-only).

import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { Trade, Position, SessionStats, Contract } from "./types";
import { ENV, URLS, getFilter } from "./config";
import { createLogger } from "./log";

const log = createLogger("POSITIONS");

// ─── State ───────────────────────────────────────────────────────────────────

const RESOLUTION_CHECK_MS = 5_000; // Check for resolved contracts every 5s

const openPositions: Position[] = [];
const closedPositions: Position[] = [];

const stats: SessionStats = {
  trades: 0,
  wins: 0,
  losses: 0,
  pnl: 0,
  maxDrawdown: 0,
  peakPnl: 0,
  consecutiveLosses: 0,
  startedAt: Date.now(),
};

let resolutionTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let tradesFile: string;

// ─── Public API ──────────────────────────────────────────────────────────────

/** Open a new position from a completed trade. */
export function openPosition(trade: Trade): Position {
  const position: Position = { trade, status: "OPEN" };
  openPositions.push(position);
  stats.trades++;

  persistTrade(trade, "OPEN");
  log.info(
    `Position opened: ${trade.side} ${trade.asset} $${trade.sizeUsd.toFixed(2)} @ ${trade.entryPrice.toFixed(4)} | ` +
    `${openPositions.length} open`
  );

  return position;
}

/** Get all open positions. */
export function getOpenPositions(): Position[] {
  return openPositions;
}

/** Get closed positions (most recent first). */
export function getClosedPositions(): Position[] {
  return closedPositions;
}

/** Current session stats. */
export function getStats(): Readonly<SessionStats> {
  return stats;
}

/** Total USD at risk in open positions. */
export function getTotalRisk(): number {
  return openPositions.reduce((sum, p) => sum + p.trade.sizeUsd, 0);
}

/** Count of open positions for a given conditionId:side. */
export function getOpenCount(conditionId: string, side: string): number {
  return openPositions.filter(
    (p) => p.trade.conditionId === conditionId && p.trade.side === side
  ).length;
}

/** Whether we can take another position given risk limits. */
export function canTakePosition(conditionId: string, side: string): boolean {
  const cfg = getFilter();
  if (getOpenCount(conditionId, side) >= cfg.maxPositionsPerContract) return false;
  if (getTotalRisk() + cfg.betSize > cfg.maxTotalRisk) return false;
  return true;
}

// ─── Resolution Checking ─────────────────────────────────────────────────────

async function checkResolutions(): Promise<void> {
  const now = Date.now();
  // Only check positions whose contracts have expired
  const expired = openPositions.filter((p) => p.trade.endTs <= now);
  if (expired.length === 0) return;

  for (const pos of expired) {
    try {
      const resolved = await fetchResolution(pos.trade.conditionId);
      if (resolved !== null) {
        closePosition(pos, resolved);
      }
    } catch (err: any) {
      log.debug(`Resolution check failed for ${pos.trade.conditionId.slice(0, 10)}`, err.message);
    }
  }
}

async function fetchResolution(conditionId: string): Promise<string | null> {
  try {
    const res = await axios.get(`${URLS.gammaApi}/markets`, {
      params: { condition_id: conditionId, limit: 1 },
      timeout: 5000,
    });

    const markets: any[] = res.data || [];
    if (markets.length === 0) return null;

    const m = markets[0];
    // Check if the market has resolved
    if (m.resolved === true || m.closed === true) {
      // Determine the winning outcome
      const outcomes: string[] = m.outcomes ? JSON.parse(m.outcomes) : [];
      const prices: string[] = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];

      for (let i = 0; i < outcomes.length; i++) {
        const price = parseFloat(prices[i] || "0");
        if (price >= 0.95) {
          return outcomes[i]; // e.g., "Up" or "Down"
        }
      }

      // If we can't determine the winner from prices, check the winner field
      if (m.winner) return m.winner;
    }

    return null; // Not yet resolved
  } catch {
    return null;
  }
}

function closePosition(pos: Position, winningOutcome: string): void {
  const won = pos.trade.side.toLowerCase() === winningOutcome.toLowerCase();
  pos.status = won ? "WON" : "LOST";
  pos.closedAt = Date.now();
  pos.resolution = winningOutcome;

  if (won) {
    // Won: payout = shares * 1.0 (binary) - cost
    pos.exitPrice = 1.0;
    pos.pnl = pos.trade.shares * 1.0 - pos.trade.sizeUsd;
    stats.wins++;
    stats.consecutiveLosses = 0;
  } else {
    // Lost: shares worth 0
    pos.exitPrice = 0;
    pos.pnl = -pos.trade.sizeUsd;
    stats.losses++;
    stats.consecutiveLosses++;
  }

  stats.pnl += pos.pnl;
  if (stats.pnl > stats.peakPnl) stats.peakPnl = stats.pnl;
  const drawdown = stats.peakPnl - stats.pnl;
  if (drawdown > stats.maxDrawdown) stats.maxDrawdown = drawdown;

  // Move from open to closed
  const idx = openPositions.indexOf(pos);
  if (idx >= 0) openPositions.splice(idx, 1);
  closedPositions.unshift(pos); // Most recent first

  // Keep closed list bounded
  if (closedPositions.length > 200) closedPositions.length = 200;

  persistTrade(pos.trade, pos.status, pos.pnl);
  log.info(
    `Position ${pos.status}: ${pos.trade.side} ${pos.trade.asset} | ` +
    `PnL: ${pos.pnl >= 0 ? "+" : ""}$${pos.pnl.toFixed(2)} | ` +
    `Session: $${stats.pnl.toFixed(2)} (${stats.wins}W/${stats.losses}L)`
  );
}

// ─── Persistence ─────────────────────────────────────────────────────────────
// Append-only CSV to data/trades.csv

const TRADES_CSV_HEADERS = [
  "ts", "datetime", "tradeId", "status", "pnl",
  "conditionId", "asset", "side", "entryPrice", "sizeUsd",
  "mode", "whaleLabel", "whalePrice", "slippage", "latencyMs",
];

function csvEscape(val: any): string {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function ensureDataDir(): void {
  const dir = path.resolve(ENV.dataDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  tradesFile = path.resolve(dir, "trades.csv");
  // Write CSV header if file doesn't exist or is empty
  if (!fs.existsSync(tradesFile) || fs.statSync(tradesFile).size === 0) {
    fs.writeFileSync(tradesFile, TRADES_CSV_HEADERS.join(",") + "\n");
  }
}

function persistTrade(trade: Trade, status: string, pnl?: number): void {
  try {
    const now = Date.now();
    const dt = new Date(now).toISOString();
    const vals = [
      now, dt, trade.id, status, pnl ?? "",
      trade.conditionId, trade.asset, trade.side, trade.entryPrice, trade.sizeUsd,
      trade.mode, trade.whaleLabel, trade.whalePrice, trade.slippage, trade.pipelineLatencyMs,
    ];
    fs.appendFileSync(tradesFile, vals.map(csvEscape).join(",") + "\n");
  } catch (err: any) {
    log.error("Failed to persist trade", err.message);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function start(): void {
  if (running) return;
  running = true;
  stats.startedAt = Date.now();
  ensureDataDir();
  log.info("Starting position tracker");
  resolutionTimer = setInterval(checkResolutions, RESOLUTION_CHECK_MS);
}

export function stop(): void {
  running = false;
  log.info("Stopping position tracker");
  if (resolutionTimer) {
    clearInterval(resolutionTimer);
    resolutionTimer = null;
  }
}
