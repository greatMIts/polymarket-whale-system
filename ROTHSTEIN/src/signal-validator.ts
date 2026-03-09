// ─── Layer 2: Signal Validator ───────────────────────────────────────────────
// Minimal pre-filter on whale signals BEFORE buildFeatureVector().
// Only checks things that buildFeatureVector() CANNOT check itself:
//   1. Blocked wallets (static blacklist)
//   2. Min whale trade size (signal-level, not market data)
//   3. Contract existence (can't build features without a contract)
//   4. Asset check (BTC/ETH only — structural filter)
//   5. Duration check (5-min contracts only — structural filter)
//
// All market-data gates (timing, price range, book, spread, edge) are handled
// by buildFeatureVector() which ALWAYS returns real features even on rejection.
// This ensures every decision in the CSV has populated metrics for analysis.

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
// Checks ONLY structural/identity gates. Market-data gates are in features.ts.

export function validateWhaleSignal(
  signal: WhaleSignal,
  contract: ContractInfo | undefined,
  _book: BookState | undefined   // kept for API compat — no longer checked here
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

  // Gates 6-9 (timing, price range, book, spread) REMOVED — handled by
  // buildFeatureVector() which returns real features even on rejection.

  // All structural gates passed → proceed to buildFeatureVector()
  return { pass: true };
}
