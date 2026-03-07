// ─── Layer 1: Whale Listener (Direct Polling) ──────────────────────────────
// Polls Polymarket Data API for whale trades directly — no spy server dependency.
// Staggered polling across all tracked wallets for rate-limit friendliness.

import { WhaleSignal, Side } from "./types";
import { CONFIG } from "./config";
import { logger } from "./logger";

// ─── State ──────────────────────────────────────────────────────────────────

const recentWhales = new Map<string, WhaleSignal[]>();  // conditionId → signals
let pollInterval: NodeJS.Timeout | null = null;
let active = false;
let lastPollTime = 0;
let walletsPolled = 0;          // polls since last reset (resets every 60s)
let walletsPolledResetAt = 0;   // next reset timestamp

// Track last seen trade timestamp per wallet to avoid processing old trades
const lastSeenTs = new Map<string, number>();

// ─── Public API ─────────────────────────────────────────────────────────────

export function getWhaleActivity(conditionId: string): WhaleSignal[] {
  const signals = recentWhales.get(conditionId) || [];
  const cutoff = Date.now() - CONFIG.whaleSignalExpireMs;
  return signals.filter(s => s.ts > cutoff);
}

/**
 * Get all recent whale activity across all contracts (for dashboard display).
 * Returns up to `limit` most recent signals, sorted newest first.
 */
export function getAllRecentActivity(limit: number = 50): WhaleSignal[] {
  const cutoff = Date.now() - CONFIG.whaleSignalExpireMs;
  const all: WhaleSignal[] = [];
  for (const signals of recentWhales.values()) {
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

// ─── Polling ────────────────────────────────────────────────────────────────

export function start(): void {
  if (active) return;
  active = true;

  const wallets = CONFIG.trackedWallets as readonly { address: string; label: string }[];
  if (!wallets || wallets.length === 0) {
    logger.warn("whale", "No wallets configured for polling");
    return;
  }

  logger.info("whale", `Starting whale poller for ${wallets.length} wallets`);

  // Initialize lastSeenTs for each wallet
  for (const w of wallets) {
    if (!lastSeenTs.has(w.address)) {
      lastSeenTs.set(w.address, Date.now() - CONFIG.whaleSignalExpireMs);
    }
  }

  // Staggered polling: distribute wallets across the poll interval
  let walletIdx = 0;
  const staggerMs = Math.floor(CONFIG.whalePollMs / wallets.length);

  pollInterval = setInterval(() => {
    if (!active) return;
    const wallet = wallets[walletIdx % wallets.length];
    walletIdx++;
    pollWallet(wallet.address, wallet.label).catch(() => {});
  }, staggerMs);

  // Also do an initial poll of all wallets
  for (let i = 0; i < wallets.length; i++) {
    setTimeout(() => {
      if (!active) return;
      pollWallet(wallets[i].address, wallets[i].label).catch(() => {});
    }, i * 200);  // stagger initial polls by 200ms
  }
}

async function pollWallet(address: string, label: string): Promise<void> {
  try {
    const url = `${CONFIG.dataApi}/activity?user=${address}&limit=20&type=TRADE&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.debug("whale", `Poll failed for ${label}: HTTP ${res.status}`);
      return;
    }

    const trades = (await res.json()) as any[];
    lastPollTime = Date.now();
    // Reset counter every 60s so it shows "polls per minute" — meaningful metric
    if (Date.now() > walletsPolledResetAt) {
      walletsPolled = 0;
      walletsPolledResetAt = Date.now() + 60_000;
    }
    walletsPolled++;

    const cutoff = Date.now() - CONFIG.whaleSignalExpireMs;
    const walletLastSeen = lastSeenTs.get(address) || cutoff;

    for (const t of trades) {
      let tradeTs = new Date(t.timestamp || t.ts).getTime();
      // Polymarket Data API returns Unix seconds — detect and convert to ms
      if (tradeTs > 0 && tradeTs < 1e12) tradeTs *= 1000;
      if (isNaN(tradeTs) || tradeTs <= walletLastSeen || tradeTs < cutoff) continue;

      const conditionId = t.conditionId || t.condition_id;
      if (!conditionId) continue;

      const tier = CONFIG.walletTiers[label] || 3;
      const outcome = t.outcome || t.side || "";
      const usdcSize = parseFloat(t.usdcSize || t.size || t.amount || "0") || 0;
      const price = parseFloat(t.price || "0") || 0;

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
      };

      if (!recentWhales.has(conditionId)) {
        recentWhales.set(conditionId, []);
      }
      const existing = recentWhales.get(conditionId)!;

      // Dedup by wallet + timestamp
      const isDupe = existing.some(s =>
        s.walletLabel === signal.walletLabel && Math.abs(s.ts - signal.ts) < 2000
      );
      if (!isDupe) {
        existing.push(signal);
        logger.debug("whale", `${label} traded ${outcome} on ${conditionId.slice(0, 8)}... $${usdcSize.toFixed(0)} @ ${price.toFixed(2)}`);
      }
    }

    // Update last seen timestamp
    if (trades.length > 0) {
      const newestTs = Math.max(...trades.map((t: any) => {
        let ts = new Date(t.timestamp || t.ts).getTime();
        if (ts > 0 && ts < 1e12) ts *= 1000;
        return ts;
      }).filter((n: number) => !isNaN(n)));
      if (newestTs > walletLastSeen) {
        lastSeenTs.set(address, newestTs);
      }
    }

    // Cleanup expired entries
    for (const [condId, signals] of recentWhales) {
      const fresh = signals.filter(s => s.ts > cutoff);
      if (fresh.length === 0) {
        recentWhales.delete(condId);
      } else {
        recentWhales.set(condId, fresh);
      }
    }
  } catch (e: any) {
    logger.debug("whale", `Poll error for ${label}: ${e.message}`);
  }
}

export function stop(): void {
  active = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// Legacy compat — these are no longer meaningful but prevent import errors
export function isConnected(): boolean { return active; }
export function getLastHeartbeat(): number { return lastPollTime; }
export function connect(): void { start(); }
export function disconnect(): void { stop(); }
