// ─── ROTHSTEIN V2 Whale Monitor ───────────────────────────────────────────────
// Polls Polymarket data API for whale wallet activity every 2 seconds.
// Deduplicates on txHash, emits 'whale-trade' events for new signals.
// Tracks concurrent whales per conditionId within a 60s window.

import { EventEmitter } from "events";
import axios from "axios";
import { Side, WhaleSignal } from "./types";
import { URLS, WALLETS } from "./config";
import { createLogger } from "./log";

const log = createLogger("WHALES");

// ─── State ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const CONCURRENT_WINDOW_MS = 60_000;
const RECENT_SIGNALS_MAX = 200;

/** Set of seen transaction hashes for dedup. */
const seenTxHashes = new Set<string>();

/** conditionId → list of { wallet, ts } for concurrent whale tracking. */
const recentTradesPerContract = new Map<string, { wallet: string; ts: number }[]>();

/** Ring buffer of recent whale signals for dashboard display. */
const recentSignals: WhaleSignal[] = [];

let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let pollCount = 0;

// ─── Event Emitter ───────────────────────────────────────────────────────────

export const emitter = new EventEmitter();

// ─── Public API ──────────────────────────────────────────────────────────────

/** Count of unique whales trading a conditionId in the last 60s. */
export function getConcurrentWhales(conditionId: string): number {
  const cutoff = Date.now() - CONCURRENT_WINDOW_MS;
  const entries = recentTradesPerContract.get(conditionId);
  if (!entries) return 0;

  // Deduplicate by wallet, only count recent
  const uniqueWallets = new Set<string>();
  for (const e of entries) {
    if (e.ts >= cutoff) uniqueWallets.add(e.wallet);
  }
  return uniqueWallets.size;
}

/** Recent whale signals for dashboard display. */
export function getRecentSignals(limit: number = 50): WhaleSignal[] {
  return recentSignals.slice(0, limit);
}

/** Health status for dashboard. */
export function getStatus(): { active: boolean; lastPoll: number; polls: number } {
  return { active: running, lastPoll: Date.now(), polls: pollCount };
}

// ─── Polling ─────────────────────────────────────────────────────────────────

async function pollAll(): Promise<void> {
  pollCount++;

  const results = await Promise.allSettled(
    WALLETS.map((w) => pollWallet(w.address, w.label))
  );

  // Log any failures at debug level (noisy)
  for (const r of results) {
    if (r.status === "rejected") {
      log.debug("Wallet poll failed", r.reason?.message || r.reason);
    }
  }
}

async function pollWallet(address: string, label: string): Promise<void> {
  const res = await axios.get(`${URLS.dataApi}/activity`, {
    params: {
      user: address,
      limit: 20,
      type: "TRADE",
    },
    timeout: 5000,
  });

  const trades: any[] = res.data || [];

  for (const t of trades) {
    const txHash: string = t.transactionHash || t.transaction_hash || "";
    if (!txHash) continue;
    if (seenTxHashes.has(txHash)) continue;
    seenTxHashes.add(txHash);

    // Parse the trade into a WhaleSignal
    const signal = parseSignal(t, address, label);
    if (!signal) continue;

    // Track concurrent whales
    trackConcurrent(signal.conditionId, address, signal.ts);

    // Store in recent signals ring buffer
    recentSignals.unshift(signal);
    if (recentSignals.length > RECENT_SIGNALS_MAX) recentSignals.length = RECENT_SIGNALS_MAX;

    log.info(`Whale trade: ${label} ${signal.side} $${signal.usdcSize.toFixed(2)} on ${signal.conditionId.slice(0, 10)}...`);
    emitter.emit("whale-trade", signal);
  }
}

function parseSignal(t: any, wallet: string, label: string): WhaleSignal | null {
  try {
    const conditionId: string = t.conditionId || t.condition_id || "";
    if (!conditionId) return null;

    const outcome: string = t.outcome || t.title || "";
    const side: Side = outcome.toLowerCase().includes("up") ? "Up" : "Down";
    const price = parseFloat(t.price || "0");
    const usdcSize = parseFloat(t.usdcSize || t.amount || t.usdc_size || "0");
    // Data API returns timestamp as Unix SECONDS (e.g. 1773101133), not milliseconds
    const rawTs = t.timestamp || t.createdAt || t.created_at || Date.now();
    let ts: number;
    if (typeof rawTs === "number") {
      // Unix seconds if < 10 billion (before year 2286), otherwise already ms
      ts = rawTs < 10_000_000_000 ? rawTs * 1000 : rawTs;
    } else {
      ts = new Date(rawTs).getTime();
    }
    if (isNaN(ts)) ts = Date.now();

    if (price <= 0 || usdcSize <= 0) return null;

    return {
      ts,
      wallet,
      walletLabel: label,
      side,
      outcome,
      price,
      usdcSize,
      conditionId,
      txHash: t.transactionHash || t.transaction_hash,
      detectedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function trackConcurrent(conditionId: string, wallet: string, ts: number): void {
  if (!recentTradesPerContract.has(conditionId)) {
    recentTradesPerContract.set(conditionId, []);
  }
  recentTradesPerContract.get(conditionId)!.push({ wallet, ts });

  // Prune old entries beyond the window
  const cutoff = Date.now() - CONCURRENT_WINDOW_MS;
  const entries = recentTradesPerContract.get(conditionId)!;
  const fresh = entries.filter((e) => e.ts >= cutoff);
  if (fresh.length === 0) {
    recentTradesPerContract.delete(conditionId);
  } else {
    recentTradesPerContract.set(conditionId, fresh);
  }
}

/** Periodic cleanup of the seenTxHashes set to prevent unbounded growth. */
function pruneSeenHashes(): void {
  // Keep the set from growing beyond 50K entries
  if (seenTxHashes.size > 50_000) {
    const all = [...seenTxHashes];
    seenTxHashes.clear();
    // Keep the most recent 25K
    for (const h of all.slice(-25_000)) {
      seenTxHashes.add(h);
    }
    log.debug(`Pruned seenTxHashes from ${all.length} to ${seenTxHashes.size}`);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function start(): void {
  if (running) return;
  running = true;
  log.info(`Starting whale monitor — tracking ${WALLETS.length} wallets`);
  pollAll(); // Initial poll
  pollTimer = setInterval(() => {
    pollAll();
    pruneSeenHashes();
  }, POLL_INTERVAL_MS);
}

export function stop(): void {
  running = false;
  log.info("Stopping whale monitor");
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
