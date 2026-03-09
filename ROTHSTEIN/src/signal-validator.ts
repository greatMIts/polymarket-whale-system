// ─── Layer 2: Signal Validator ───────────────────────────────────────────────
// Hard-gate sync checks on whale signals before pipeline processing.
// Pure function — no state, no side effects, no async.
// All gates are memory reads, expected latency <1ms.

import { WhaleSignal, ContractInfo, BookState } from "./types";
import { CONFIG, getRuntime } from "./config";

// ─── Blocked Wallets (Tier 3 toxic — consistent losers) ─────────────────────

const BLOCKED_WALLETS = ["0x2d8b", "0xa9ae"];

// ─── Validation Result ──────────────────────────────────────────────────────

export interface ValidationResult {
  pass: boolean;
  rejectReason?: string;
}

// ─── Validate Whale Signal ──────────────────────────────────────────────────

export function validateWhaleSignal(
  signal: WhaleSignal,
  contract: ContractInfo | undefined,
  book: BookState | undefined
): ValidationResult {
  const runtime = getRuntime();

  // Gate 1: Blocked wallets
  if (BLOCKED_WALLETS.includes(signal.walletLabel)) {
    return { pass: false, rejectReason: "BLOCKED_WALLET" };
  }

  // Gate 2: Minimum whale trade size ($3 USD)
  // Every individual whale trade is evaluated — filter out dust/noise
  if (signal.usdcSize < runtime.minWhaleSizeUsd) {
    return { pass: false, rejectReason: "SIZE_TOO_SMALL" };
  }

  // Gate 3: Must have matching contract
  if (!contract) {
    return { pass: false, rejectReason: "NO_CONTRACT" };
  }

  // Gate 4: Asset check (BTC/ETH only)
  if (!(CONFIG.allowedAssets as readonly string[]).includes(contract.asset)) {
    return { pass: false, rejectReason: "INVALID_ASSET" };
  }

  // Gate 5: Duration check (5-min contracts only)
  if (!(CONFIG.allowedDurations as readonly number[]).includes(contract.contractDurationMinutes)) {
    return { pass: false, rejectReason: "INVALID_DURATION" };
  }

  // Gate 6: Time remaining (90s min + 15s latency buffer = 105s)
  const secsRemaining = Math.max(0, (contract.endTs - Date.now()) / 1000);
  if (secsRemaining < (runtime.minSecsRemaining + 15)) {
    return { pass: false, rejectReason: "TOO_CLOSE_TO_EXPIRY" };
  }

  // Gate 7: Price range check
  if (signal.price < runtime.minPrice || signal.price > runtime.maxPrice) {
    return { pass: false, rejectReason: "PRICE_OUT_OF_RANGE" };
  }

  // Gate 8: Book data existence
  if (!book || book.mid <= 0) {
    return { pass: false, rejectReason: "NO_BOOK_DATA" };
  }

  // Gate 9: Book spread check
  if (book.spread > runtime.maxBookSpread) {
    return { pass: false, rejectReason: "SPREAD_TOO_WIDE" };
  }

  // All gates passed
  return { pass: true };
}
