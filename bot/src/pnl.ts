/**
 * pnl.ts — Side-Aware PnL Calculations (Single Source of Truth)
 *
 * Layer 0b — imports only types. Zero runtime dependencies. Fully pure.
 * Every PnL calculation in the entire system MUST route through these four functions.
 * No inline PnL formulas anywhere else — this eliminates the recurring BUY-hardcoding bug class.
 */

import { BotTrade, ContractOutcome } from './types';

// ── Resolution PnL (contract resolved YES/NO) ──
export function computeResolutionPnl(pos: BotTrade, outcome: ContractOutcome): number {
  if (pos.side === 'BUY') {
    // Bought YES token at entryPrice
    // YES outcome: token pays $1, profit = (1 - entry) * shares
    // NO  outcome: token worthless, loss = -entry * shares
    return outcome.outcome === 'YES'
      ? (1.0 - pos.entryPrice) * pos.shares
      : -pos.entryPrice * pos.shares;
  }
  // Sold YES token at entryPrice
  // YES outcome: owe $1, received entry, loss = -(1 - entry) * shares
  // NO  outcome: token worthless, keep premium, profit = entry * shares
  return outcome.outcome === 'YES'
    ? -(1.0 - pos.entryPrice) * pos.shares
    : pos.entryPrice * pos.shares;
}

// ── Take-Profit PnL (exited at a specific price) ──
export function computeTakeProfitPnl(pos: BotTrade, exitPrice: number): number {
  if (pos.side === 'BUY') {
    return (exitPrice - pos.entryPrice) * pos.shares;
  }
  return (pos.entryPrice - exitPrice) * pos.shares;
}

// ── Unrealized PnL (for dashboard display + TP trigger) ──
export function computeUnrealizedPnl(
  pos: BotTrade,
  currentBid: number,
  currentAsk: number
): number {
  if (pos.side === 'BUY') {
    // Would sell at bid
    return (currentBid - pos.entryPrice) * pos.shares;
  }
  // Would buy back at ask
  return (pos.entryPrice - currentAsk) * pos.shares;
}

// ── Expired PnL (side-aware conservative full loss) ──
export function computeExpiredPnl(pos: BotTrade): number {
  if (pos.side === 'BUY') {
    // Worst case: token worthless
    return -pos.entryPrice * pos.shares;
  }
  // Worst case: token resolves YES, owe (1 - entry) per share
  return -(1.0 - pos.entryPrice) * pos.shares;
}
