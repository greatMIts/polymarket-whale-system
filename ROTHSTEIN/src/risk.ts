// ─── Layer 3: Risk Management ───────────────────────────────────────────────
// Session stats tracking and total risk check.
// Circuit breaker REMOVED — bot trades non-stop without throttling.

import { SessionStats } from "./types";
import { getRuntime } from "./config";
import { logger } from "./logger";

// ─── Session Stats ─────────────────────────────────────────────────────────

const stats: SessionStats = {
  trades: 0,
  wins: 0,
  losses: 0,
  pnl: 0,
  maxDrawdown: 0,
  peakPnl: 0,
  winRate: 0,
  consecutiveLosses: 0,
  startedAt: Date.now(),
};

// ─── Public API ─────────────────────────────────────────────────────────────

export function getStats(): Readonly<SessionStats> {
  return { ...stats };
}

/**
 * Check if trading is allowed right now.
 * Returns null if OK, or a reason string if blocked.
 * Only checks: manual pause and dead hours. No circuit breaker.
 */
export function canTrade(): string | null {
  const runtime = getRuntime();

  // 1. Manual pause from dashboard
  if (runtime.paused) return "PAUSED_BY_USER";

  // 2. Dead hours
  const currentHour = new Date().getUTCHours();
  if (runtime.deadHours.includes(currentHour)) return `DEAD_HOUR_${currentHour}`;

  return null;
}

/**
 * Get effective sizing multiplier.
 * Just returns the runtime multiplier (no circuit breaker throttle).
 */
export function getEffectiveSizingMultiplier(): number {
  const runtime = getRuntime();
  return runtime.sizingMultiplier;
}

/**
 * Record a trade result. Tracks stats only — no circuit breaker triggers.
 */
export function recordResult(pnlAmount: number, won: boolean): void {
  stats.trades++;
  stats.pnl += pnlAmount;

  if (won) {
    stats.wins++;
    stats.consecutiveLosses = 0;
  } else {
    stats.losses++;
    stats.consecutiveLosses++;
  }

  stats.winRate = stats.trades > 0 ? stats.wins / stats.trades : 0;

  // Track peak and drawdown
  if (stats.pnl > stats.peakPnl) {
    stats.peakPnl = stats.pnl;
  }
  const drawdown = stats.peakPnl - stats.pnl;
  if (drawdown > stats.maxDrawdown) {
    stats.maxDrawdown = drawdown;
  }
}

/**
 * Check if total capital at risk is within limits.
 */
export function checkTotalRisk(currentRiskUsd: number, additionalRiskUsd: number): boolean {
  const runtime = getRuntime();
  return (currentRiskUsd + additionalRiskUsd) <= runtime.maxTotalAtRisk;
}

/**
 * Reset session stats (e.g. on new day).
 */
export function resetSession(): void {
  stats.trades = 0;
  stats.wins = 0;
  stats.losses = 0;
  stats.pnl = 0;
  stats.maxDrawdown = 0;
  stats.peakPnl = 0;
  stats.winRate = 0;
  stats.consecutiveLosses = 0;
  stats.startedAt = Date.now();
  logger.event("risk", "SESSION_RESET");
}
