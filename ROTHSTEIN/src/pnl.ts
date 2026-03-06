// ─── Layer 2: PnL Calculations ──────────────────────────────────────────────
// Pure functions for computing profit/loss. Side-aware.
// No state, no side effects.

import { Side } from "./types";

/**
 * Compute PnL for a binary option position.
 *
 * For "Up" side (or any side we BUY):
 *   Win  → pnl = (1.00 - entryPrice) * shares
 *   Loss → pnl = -entryPrice * shares
 *
 * For conditional TP exit:
 *   pnl = (exitPrice - entryPrice) * shares
 */

export function computePnl(
  entryPrice: number,
  shares: number,
  won: boolean
): number {
  if (won) {
    return (1.0 - entryPrice) * shares;
  } else {
    return -entryPrice * shares;
  }
}

export function computeExitPnl(
  entryPrice: number,
  exitPrice: number,
  shares: number
): number {
  return (exitPrice - entryPrice) * shares;
}

/**
 * Compute shares from USD amount and entry price.
 * shares = usdAmount / entryPrice
 */
export function computeShares(sizeUsd: number, entryPrice: number): number {
  if (entryPrice <= 0 || entryPrice >= 1) return 0;
  return sizeUsd / entryPrice;
}

/**
 * Compute expected value of holding vs taking profit.
 *
 * holdEV = winRate * (1.0 - entry) - (1 - winRate) * entry
 * tpEV   = tpPrice - entry  (guaranteed)
 *
 * Returns positive if HOLD is better, negative if TP is better.
 */
export function holdVsTpEv(
  entryPrice: number,
  currentMarketPrice: number,
  estimatedWinRate: number
): { holdEV: number; tpEV: number; delta: number; recommendation: "HOLD" | "TP" | "CLOSE" } {
  const holdEV = estimatedWinRate * (1.0 - entryPrice) - (1 - estimatedWinRate) * entryPrice;
  const tpEV = currentMarketPrice - entryPrice;
  const delta = holdEV - tpEV;

  let recommendation: "HOLD" | "TP" | "CLOSE";
  if (delta > 0.005) recommendation = "HOLD";
  else if (delta < -0.005) recommendation = "TP";
  else recommendation = "CLOSE";

  return { holdEV, tpEV, delta, recommendation };
}

/**
 * Max dollar risk for a position.
 * risk = entryPrice * shares (total loss if contract resolves against us)
 */
export function computeRisk(entryPrice: number, shares: number): number {
  return entryPrice * shares;
}
