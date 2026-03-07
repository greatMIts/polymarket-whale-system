// ─── Layer 1: Whale Monitor (Parallel Polling + EventEmitter) ────────────────
// Replaces whale-listener.ts with:
//   - Parallel polling (all wallets via Promise.allSettled)
//   - Overlap guard (prevents cascading poll cycles)
//   - transactionHash dedup (primary) + composite key fallback
//   - EventEmitter for 'whale-trade' events consumed by copy-pipeline
//   - recentSignals Map with TTL for backward-compat getWhaleActivity()

import { EventEmitter } from "events";
import { WhaleSignal, Side } from "./types";
import { CONFIG } from "./config";
import { logger } from "./logger";
import axios, { AxiosInstance } from "axios";
import * as https from "https";

// ─── Constants ───────────────────────────────────────────────────────────────

const SIGNAL_TTL_MS = 120_000;        // 2-minute TTL for queryable signals
const DEDUP_TTL_MS = 300_000;         // 5-minute TTL for dedup cache
const CLEANUP_INTERVAL_MS = 60_000;   // cleanup every 60s

// Blocked wallets — Tier 3 toxic, consistent losers
const BLOCKED_WALLETS = ["0x2d8b", "0xa9ae"];

// ─── Module State ────────────────────────────────────────────────────────────

const emitter = new EventEmitter();
emitter.setMaxListeners(20);  // allow multiple pipeline subscriptions

let active = false;
let polling = false;                                    // overlap guard
let pollInterval: NodeJS.Timeout | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;
let lastPollTime = 0;
let walletsPolled = 0;
let walletsPolledResetAt = 0;
let pollCycleCount = 0;
let totalSignalsFound = 0;
let pollErrors = 0;

const walletCursors = new Map<string, number>();         // wallet address → last seen ts
const seenTrades = new Map<string, number>();             // txHash/compositeKey → timestamp
const recentSignals = new Map<string, WhaleSignal[]>();   // conditionId → signals

// HTTP client with keep-alive
const httpAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 20,
  maxFreeSockets: 10,
});

let axiosClient: AxiosInstance;

// Filter out blocked wallets
const activeWallets = (CONFIG.trackedWallets as readonly { address: string; label: string }[])
  .filter(w => !BLOCKED_WALLETS.includes(w.label));

// ─── Public API (backward-compat with whale-listener.ts) ────────────────────

export function on(event: string, handler: (...args: any[]) => void): void {
  emitter.on(event, handler);
}

export function off(event: string, handler: (...args: any[]) => void): void {
  emitter.off(event, handler);
}

export function getWhaleActivity(conditionId: string): WhaleSignal[] {
  const signals = recentSignals.get(conditionId) || [];
  const cutoff = Date.now() - SIGNAL_TTL_MS;
  return signals.filter(s => s.ts > cutoff);
}

export function getAllRecentActivity(limit: number = 50): WhaleSignal[] {
  const cutoff = Date.now() - SIGNAL_TTL_MS;
  const all: WhaleSignal[] = [];
  for (const signals of recentSignals.values()) {
    for (const s of signals) {
      if (s.ts > cutoff) all.push(s);
    }
  }
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, limit);
}

export function isActive(): boolean { return active; }
export function getLastPollTime(): number { return lastPollTime; }
export function getWalletsPolled(): number { return walletsPolled; }
export function getPollCycleCount(): number { return pollCycleCount; }
export function getTotalSignalsFound(): number { return totalSignalsFound; }

// Legacy compat aliases
export function isConnected(): boolean { return active; }
export function getLastHeartbeat(): number { return lastPollTime; }

// ─── Start / Stop ────────────────────────────────────────────────────────────

export function start(): void {
  if (active) return;
  active = true;

  if (activeWallets.length === 0) {
    logger.warn("whale-monitor", "No active wallets configured for polling");
    return;
  }

  // Create axios client
  axiosClient = axios.create({
    httpsAgent: httpAgent,
    timeout: 10_000,
  });

  logger.info("whale-monitor", `Starting whale monitor for ${activeWallets.length} wallets (parallel polling)`);

  // Initialize wallet cursors
  for (const w of activeWallets) {
    if (!walletCursors.has(w.address)) {
      walletCursors.set(w.address, Date.now() - CONFIG.whaleSignalExpireMs);
    }
  }

  // Start polling loop
  pollInterval = setInterval(() => {
    pollCycle().catch(e => {
      logger.error("whale-monitor", `Poll cycle error: ${e.message}`);
    });
  }, CONFIG.whalePollMs);

  // Start cleanup loop
  cleanupInterval = setInterval(() => {
    cleanup();
  }, CLEANUP_INTERVAL_MS);

  // Initial poll immediately
  pollCycle().catch(e => {
    logger.error("whale-monitor", `Initial poll cycle error: ${e.message}`);
  });
}

export function stop(): void {
  active = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// ─── Poll Cycle (parallel, with overlap guard) ───────────────────────────────

async function pollCycle(): Promise<void> {
  // Overlap guard: skip if previous cycle still running
  if (polling) return;
  polling = true;

  try {
    // Poll ALL wallets in parallel
    const results = await Promise.allSettled(
      activeWallets.map(w => pollWallet(w.address, w.label))
    );

    pollCycleCount++;
    let cycleSignals = 0;
    let cycleErrors = 0;

    // Process results — emit events for new signals
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        for (const signal of result.value) {
          signal.detectedAt = Date.now();
          storeSignal(signal);
          emitter.emit("whale-trade", signal);
          cycleSignals++;
          totalSignalsFound++;
        }
      } else if (result.status === "rejected") {
        cycleErrors++;
        pollErrors++;
      }
    }

    // Log new signals at INFO level so they're always visible
    if (cycleSignals > 0) {
      logger.info("whale-monitor", `Poll #${pollCycleCount}: ${cycleSignals} new signal(s) detected`);
    }

    // Log errors at warn level
    if (cycleErrors > 0) {
      logger.warn("whale-monitor", `Poll #${pollCycleCount}: ${cycleErrors}/${activeWallets.length} wallet polls failed`);
    }

    // Heartbeat log every ~60s (30 cycles at 2s interval)
    if (pollCycleCount % 30 === 0) {
      logger.info("whale-monitor",
        `Heartbeat: ${pollCycleCount} cycles | ${totalSignalsFound} signals found | ${pollErrors} errors | ${activeWallets.length} wallets | dedup cache: ${seenTrades.size}`
      );
    }
  } finally {
    polling = false;
  }
}

// ─── Poll Single Wallet ─────────────────────────────────────────────────────

async function pollWallet(address: string, label: string): Promise<WhaleSignal[]> {
  try {
    const url = `${CONFIG.dataApi}/activity?user=${address}&limit=20&type=TRADE&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await axiosClient.get(url);

    // Diagnostic: log first poll response structure for each wallet
    if (pollCycleCount <= 1) {
      const dataType = Array.isArray(res.data) ? `array[${res.data.length}]` : typeof res.data;
      const sample = Array.isArray(res.data) && res.data.length > 0
        ? JSON.stringify(Object.keys(res.data[0]))
        : (res.data && typeof res.data === "object" ? JSON.stringify(Object.keys(res.data)) : "N/A");
      logger.info("whale-monitor", `Diag ${label}: type=${dataType} keys=${sample}`);
    }

    if (!res.data || !Array.isArray(res.data)) return [];

    lastPollTime = Date.now();

    // Reset counter every 60s for polls-per-minute metric
    if (Date.now() > walletsPolledResetAt) {
      walletsPolled = 0;
      walletsPolledResetAt = Date.now() + 60_000;
    }
    walletsPolled++;

    const trades = res.data;
    const cutoff = Date.now() - CONFIG.whaleSignalExpireMs;
    const walletLastSeen = walletCursors.get(address) || cutoff;
    const newSignals: WhaleSignal[] = [];

    // Diagnostic: log trade timestamps vs cursor on first cycle
    if (pollCycleCount <= 1 && trades.length > 0) {
      const newest = trades[0];
      let newestTs = new Date(newest.timestamp || newest.ts).getTime();
      if (newestTs > 0 && newestTs < 1e12) newestTs *= 1000;
      const age = Math.round((Date.now() - newestTs) / 1000);
      logger.info("whale-monitor",
        `Diag ${label}: ${trades.length} trades | newest=${age}s ago | cursor=${Math.round((Date.now() - walletLastSeen)/1000)}s ago | cutoff=${Math.round((Date.now() - cutoff)/1000)}s`
      );
    }

    for (const t of trades) {
      let tradeTs = new Date(t.timestamp || t.ts).getTime();
      // Polymarket Data API returns Unix seconds — detect and convert to ms
      if (tradeTs > 0 && tradeTs < 1e12) tradeTs *= 1000;
      if (isNaN(tradeTs) || tradeTs <= walletLastSeen || tradeTs < cutoff) continue;

      const conditionId = t.conditionId || t.condition_id;
      if (!conditionId) continue;

      // Dedup check
      if (isDuplicate(t, address)) continue;

      const tier = CONFIG.walletTiers[label] || 3;
      const outcome = t.outcome || t.side || "";
      const usdcSize = parseFloat(t.usdcSize || t.size || t.amount || "0") || 0;
      const price = parseFloat(t.price || "0") || 0;
      const txHash = t.transactionHash || t.txHash || undefined;

      const signal: WhaleSignal = {
        ts: tradeTs,
        wallet: address,
        walletLabel: label,
        side: (outcome.toLowerCase().includes("up") ? "Up" : "Down") as Side,
        outcome,
        price,
        usdcSize,
        conditionId,
        tier,
        txHash,
      };

      newSignals.push(signal);

      logger.debug("whale-monitor",
        `${label} traded ${outcome} on ${conditionId.slice(0, 8)}... $${usdcSize.toFixed(0)} @ ${price.toFixed(2)}`
      );
    }

    // Update wallet cursor to newest trade
    if (trades.length > 0) {
      const newestTs = Math.max(
        ...trades.map((t: any) => {
          let ts = new Date(t.timestamp || t.ts).getTime();
          if (ts > 0 && ts < 1e12) ts *= 1000;
          return ts;
        }).filter((n: number) => !isNaN(n))
      );
      if (newestTs > walletLastSeen) {
        walletCursors.set(address, newestTs);
      }
    }

    return newSignals;
  } catch (e: any) {
    logger.warn("whale-monitor", `Poll error for ${label}: ${e.message}`);
    pollErrors++;
    return [];
  }
}

// ─── Dedup ───────────────────────────────────────────────────────────────────

function isDuplicate(trade: any, walletAddress: string): boolean {
  const txHash = trade.transactionHash || trade.txHash;

  if (txHash) {
    // Primary dedup: transactionHash
    if (seenTrades.has(txHash)) return true;
    seenTrades.set(txHash, Date.now());
    return false;
  }

  // Fallback: composite key when transactionHash is missing
  const conditionId = trade.conditionId || trade.condition_id;
  const timestamp = trade.timestamp || trade.ts;
  const price = trade.price;
  const compositeKey = `${walletAddress}:${conditionId}:${timestamp}:${price}`;

  if (seenTrades.has(compositeKey)) return true;
  seenTrades.set(compositeKey, Date.now());
  return false;
}

// ─── Signal Storage ──────────────────────────────────────────────────────────

function storeSignal(signal: WhaleSignal): void {
  const key = signal.conditionId;
  if (!recentSignals.has(key)) {
    recentSignals.set(key, []);
  }
  recentSignals.get(key)!.push(signal);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup(): void {
  const now = Date.now();

  // Clean dedup cache (5-minute TTL)
  const dedupCutoff = now - DEDUP_TTL_MS;
  for (const [key, ts] of seenTrades) {
    if (ts < dedupCutoff) seenTrades.delete(key);
  }

  // Clean signal cache (2-minute TTL)
  const signalCutoff = now - SIGNAL_TTL_MS;
  for (const [condId, signals] of recentSignals) {
    const fresh = signals.filter(s => s.ts > signalCutoff);
    if (fresh.length === 0) {
      recentSignals.delete(condId);
    } else {
      recentSignals.set(condId, fresh);
    }
  }
}
