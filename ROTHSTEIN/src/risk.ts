// ─── Layer 3: Risk Management ───────────────────────────────────────────────
// Circuit breakers, session limits, sizing throttle.
// Answers: "Should we trade at all right now?" and "How much?"
// No position knowledge — just pure risk state.

import { CircuitBreakerState, SessionStats } from "./types";
import { CONFIG, getRuntime } from "./config";
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

const circuitBreaker: CircuitBreakerState = {
  active: false,
  reason: "",
  resumeAt: 0,
  sizingMultiplier: 1.0,
};

// Hourly loss tracking
let hourlyPnl = 0;
let hourlyResetAt = Date.now() + 3_600_000;

// ─── Public API ─────────────────────────────────────────────────────────────

export function getStats(): Readonly<SessionStats> {
  return { ...stats };
}

export function getCircuitBreaker(): Readonly<CircuitBreakerState> {
  return { ...circuitBreaker };
}

/**
 * Check if trading is allowed right now.
 * Returns null if OK, or a reason string if blocked.
 */
export function canTrade(): string | null {
  const runtime = getRuntime();

  // 1. Manual pause from dashboard
  if (runtime.paused) return "PAUSED_BY_USER";

  // 2. Dead hours
  const currentHour = new Date().getUTCHours();
  if (runtime.deadHours.includes(currentHour)) return `DEAD_HOUR_${currentHour}`;

  // 3. Circuit breaker active
  if (circuitBreaker.active) {
    if (Date.now() < circuitBreaker.resumeAt) {
      return `CIRCUIT_BREAKER: ${circuitBreaker.reason}`;
    }
    // Time expired, auto-reset
    resetCircuitBreaker();
  }

  return null;
}

/**
 * Get effective sizing multiplier.
 * Combines: runtime multiplier × circuit breaker throttle.
 */
export function getEffectiveSizingMultiplier(): number {
  const runtime = getRuntime();
  return runtime.sizingMultiplier * circuitBreaker.sizingMultiplier;
}

/**
 * Record a trade result. Automatically triggers circuit breakers if needed.
 */
export function recordResult(pnl: number, won: boolean): void {
  stats.trades++;
  stats.pnl += pnl;

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

  // Hourly PnL tracking
  if (Date.now() > hourlyResetAt) {
    hourlyPnl = 0;
    hourlyResetAt = Date.now() + 3_600_000;
  }
  hourlyPnl += pnl;

  // ─── Check circuit breaker triggers ───────────────────────────────────────

  // Session loss limit
  if (stats.pnl <= CONFIG.sessionLossCircuitBreaker) {
    triggerCircuitBreaker(
      `SESSION_LOSS ($${stats.pnl.toFixed(2)} < $${CONFIG.sessionLossCircuitBreaker})`,
      600_000  // 10 min cooldown
    );
    return;
  }

  // Hourly loss throttle
  if (hourlyPnl <= CONFIG.hourlyLossThrottle) {
    triggerThrottle(
      `HOURLY_LOSS ($${hourlyPnl.toFixed(2)} < $${CONFIG.hourlyLossThrottle})`,
      0.5,         // reduce sizing by 50%
      300_000      // 5 min throttle
    );
    return;
  }

  // Consecutive losses
  if (stats.consecutiveLosses >= CONFIG.consecutiveLossThrottle) {
    triggerThrottle(
      `CONSECUTIVE_LOSSES (${stats.consecutiveLosses} in a row)`,
      0.5,         // reduce sizing by 50%
      180_000      // 3 min throttle
    );
    return;
  }
}

// ─── Circuit Breaker Controls ──────────────────────────────────────────────

function triggerCircuitBreaker(reason: string, cooldownMs: number): void {
  circuitBreaker.active = true;
  circuitBreaker.reason = reason;
  circuitBreaker.resumeAt = Date.now() + cooldownMs;
  circuitBreaker.sizingMultiplier = 0;

  logger.event("risk", "CIRCUIT_BREAKER_TRIGGERED", {
    reason,
    cooldownMs,
    sessionPnl: stats.pnl,
    trades: stats.trades,
  });
}

function triggerThrottle(reason: string, multiplier: number, cooldownMs: number): void {
  circuitBreaker.active = true;
  circuitBreaker.reason = reason;
  circuitBreaker.resumeAt = Date.now() + cooldownMs;
  circuitBreaker.sizingMultiplier = multiplier;

  logger.event("risk", "THROTTLE_TRIGGERED", {
    reason,
    multiplier,
    cooldownMs,
    sessionPnl: stats.pnl,
    consecutiveLosses: stats.consecutiveLosses,
  });
}

function resetCircuitBreaker(): void {
  const wasActive = circuitBreaker.active;
  circuitBreaker.active = false;
  circuitBreaker.reason = "";
  circuitBreaker.resumeAt = 0;
  circuitBreaker.sizingMultiplier = 1.0;

  if (wasActive) {
    logger.event("risk", "CIRCUIT_BREAKER_RESET", { sessionPnl: stats.pnl });
  }
}

/**
 * Manual reset from dashboard.
 */
export function manualReset(): void {
  resetCircuitBreaker();
  logger.info("risk", "Manual circuit breaker reset from dashboard");
}

/**
 * Check if total capital at risk is within limits.
 */
export function checkTotalRisk(currentRiskUsd: number, additionalRiskUsd: number): boolean {
  return (currentRiskUsd + additionalRiskUsd) <= CONFIG.maxTotalAtRisk;
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
  hourlyPnl = 0;
  hourlyResetAt = Date.now() + 3_600_000;
  resetCircuitBreaker();
  logger.event("risk", "SESSION_RESET");
}
