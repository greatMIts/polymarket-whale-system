/**
 * risk-manager.ts — Position limits, exposure caps, stacking, cooldowns.
 *
 * Every copy trade must pass through risk checks before execution.
 * Designed to protect capital in both paper and live modes.
 *
 * Supports position stacking: up to maxEntriesPerContract entries on the
 * same conditionId, with per-contract cooldown enforced between entries.
 *
 * Check order:
 *   1. Bot enabled
 *   2. Max open positions
 *   3. Max exposure (USD)
 *   4. Max loss per hour
 *   5. Max loss per session
 *   6. Per-contract cooldown (5s between entries on same conditionId)
 *   7. Stacking: count < maxEntriesPerContract, and if stacking, whale size >= minStackSize
 */

import type { BotTrade, BotSettings } from "./types";

// ─── STATE ──────────────────────────────────────────────────────────────────

// Cooldown tracker: conditionId → last copy trade timestamp
const cooldowns = new Map<string, number>();

// Session loss reset: only count losses from positions resolved AFTER this timestamp
let sessionLossResetTs: number = 0;

export function resetSessionLosses(closedPositions: BotTrade[]) {
  const oneHourAgo = Date.now() - 3600_000;
  const hourlyLoss = closedPositions
    .filter(t => t.resolvedAt && t.resolvedAt >= oneHourAgo && t.pnl !== null && t.pnl < 0)
    .reduce((sum, t) => sum + Math.abs(t.pnl!), 0);
  const sessionLoss = closedPositions
    .filter(t => t.resolvedAt && t.resolvedAt > sessionLossResetTs && t.pnl !== null && t.pnl < 0)
    .reduce((sum, t) => sum + Math.abs(t.pnl!), 0);
  console.log(`[RISK] Session losses reset via dashboard. Previous: hourly=$${hourlyLoss.toFixed(2)}, session=$${sessionLoss.toFixed(2)}`);
  sessionLossResetTs = Date.now();
}

// ─── RISK CHECK ─────────────────────────────────────────────────────────────

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
}

export function checkRisk(
  settings: BotSettings,
  openPositions: BotTrade[],
  closedPositions: BotTrade[],
  conditionId: string,
  whaleUsdcSize: number,
  proposedSizeUsdc: number,
): RiskCheckResult {
  // 1. Bot must be enabled
  if (!settings.botEnabled) {
    return { allowed: false, reason: "Bot is disabled" };
  }

  // 2. Max open positions (counts individual entries, not unique contracts)
  if (openPositions.length >= settings.maxOpenPositions) {
    return { allowed: false, reason: `Max ${settings.maxOpenPositions} open positions reached (have ${openPositions.length})` };
  }

  // 3. Max exposure (total USD at risk across all open positions)
  const currentExposure = openPositions.reduce((sum, p) => sum + p.sizeUsdc, 0);
  if (currentExposure + proposedSizeUsdc > settings.maxExposureUSD) {
    return {
      allowed: false,
      reason: `Exposure would exceed $${settings.maxExposureUSD} (current: $${currentExposure.toFixed(2)} + $${proposedSizeUsdc.toFixed(2)})`,
    };
  }

  // 4. Max loss per hour
  const oneHourAgo = Date.now() - 3600_000;
  const hourlyLoss = closedPositions
    .filter(t => t.resolvedAt && t.resolvedAt >= oneHourAgo && t.pnl !== null && t.pnl < 0)
    .reduce((sum, t) => sum + Math.abs(t.pnl!), 0);
  if (hourlyLoss >= settings.maxLossPerHour) {
    return {
      allowed: false,
      reason: `Hourly loss limit: $${hourlyLoss.toFixed(2)} >= $${settings.maxLossPerHour}`,
    };
  }

  // 5. Max loss per session (closed losses since boot or last session reset)
  const sessionLoss = closedPositions
    .filter(t => t.resolvedAt && t.resolvedAt > sessionLossResetTs && t.pnl !== null && t.pnl < 0)
    .reduce((sum, t) => sum + Math.abs(t.pnl!), 0);
  if (sessionLoss >= settings.maxLossPerSession) {
    return {
      allowed: false,
      reason: `Session loss limit: $${sessionLoss.toFixed(2)} >= $${settings.maxLossPerSession}`,
    };
  }

  // 6. Cooldown — prevent rapid-fire copies on same contract (enforced BEFORE stacking)
  const lastCopyTime = cooldowns.get(conditionId) || 0;
  const elapsed = Date.now() - lastCopyTime;
  if (elapsed < settings.cooldownMs) {
    return {
      allowed: false,
      reason: `Cooldown: ${((settings.cooldownMs - elapsed) / 1000).toFixed(1)}s remaining for ${conditionId.slice(0, 16)}…`,
    };
  }

  // 7. Stacking — allow up to maxEntriesPerContract entries per conditionId
  const existingCount = openPositions.filter(p => p.conditionId === conditionId).length;
  if (existingCount >= settings.maxEntriesPerContract) {
    return {
      allowed: false,
      reason: `Max ${settings.maxEntriesPerContract} entries on ${conditionId.slice(0, 16)}… (have ${existingCount})`,
    };
  }
  // If stacking (already have entries), require whale size >= minStackSize
  if (existingCount > 0 && whaleUsdcSize < settings.minStackSize) {
    return {
      allowed: false,
      reason: `Stack requires whale size >= $${settings.minStackSize} (got $${whaleUsdcSize.toFixed(2)}) on ${conditionId.slice(0, 16)}…`,
    };
  }

  return { allowed: true, reason: "All risk checks passed" };
}

// ─── COOLDOWN MANAGEMENT ────────────────────────────────────────────────────

export function recordCooldown(conditionId: string) {
  cooldowns.set(conditionId, Date.now());
}

export function clearOldCooldowns() {
  const now = Date.now();
  for (const [condId, ts] of cooldowns) {
    if (now - ts > 600_000) cooldowns.delete(condId); // clean up after 10min
  }
}
