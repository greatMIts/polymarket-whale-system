// ─── ROTHSTEIN V2 Contract Scanner ────────────────────────────────────────────
// Scans Gamma API every 10s for active BTC/ETH 5-min up/down contracts.
// Caches by conditionId, maps tokenId→contract, fetches strike price from
// Binance klines, and pre-subscribes token IDs to the book module.

import axios from "axios";
import { Asset, Contract } from "./types";
import { URLS } from "./config";
import { createLogger } from "./log";
import * as book from "./book";

const log = createLogger("CONTRACTS");

// ─── State ───────────────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 10_000;
const SLUG_REGEX = /^(btc|eth)-updown-5m-\d+$/;

/** conditionId → Contract */
const contracts = new Map<string, Contract>();

/** tokenId → Contract (for fast lookup from whale trades) */
const tokenIndex = new Map<string, Contract>();

let scanTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

// ─── Public API ──────────────────────────────────────────────────────────────

/** Get a contract by conditionId. */
export function getContract(conditionId: string): Contract | undefined {
  return contracts.get(conditionId);
}

/** Get a contract by any of its token IDs. */
export function getContractByToken(tokenId: string): Contract | undefined {
  return tokenIndex.get(tokenId);
}

/** All currently cached contracts. */
export function getAllContracts(): Contract[] {
  return Array.from(contracts.values());
}

/** Active contracts (not yet expired). */
export function getActiveContracts(): Contract[] {
  const now = Date.now();
  return Array.from(contracts.values()).filter((c) => c.endTs > now);
}

// ─── Scanning ────────────────────────────────────────────────────────────────

async function scan(): Promise<void> {
  let newCount = 0;
  const now = Date.now();

  // Two-pass scan (matching V1 approach):
  //   Pass 1: Contracts ending NOW → +10 min (currently active + about to start)
  //   Pass 2: Contracts ending +10 min → +30 min (upcoming, for pre-subscription)
  const passes = [
    { end_date_min: new Date(now).toISOString(), end_date_max: new Date(now + 10 * 60_000).toISOString(), label: "active" },
    { end_date_min: new Date(now + 10 * 60_000).toISOString(), end_date_max: new Date(now + 30 * 60_000).toISOString(), label: "upcoming" },
  ];

  for (const pass of passes) {
    try {
      const res = await axios.get(`${URLS.gammaApi}/markets`, {
        params: {
          end_date_min: pass.end_date_min,
          end_date_max: pass.end_date_max,
          closed: false,
          limit: 100,
          order: "endDate",
          ascending: true,
        },
        timeout: 5000,
      });

      const markets: any[] = res.data || [];

      for (const m of markets) {
        const slug: string = m.slug || "";
        if (!SLUG_REGEX.test(slug)) continue;

        const conditionId: string = m.conditionId || m.condition_id || "";
        if (!conditionId) continue;
        if (contracts.has(conditionId)) continue; // Already cached

        const asset: Asset = slug.startsWith("btc") ? "BTC" : "ETH";
        const endTs = new Date(m.end_date_iso || m.endDate || 0).getTime();

        // Skip contracts that already ended
        if (endTs > 0 && endTs < now) continue;

        const rawTokenIds = m.clob_token_ids || m.clobTokenIds || "[]";
        const clobTokenIds: string[] = typeof rawTokenIds === "string" ? JSON.parse(rawTokenIds) : rawTokenIds;
        const rawOutcomes = m.outcomes || '["Up","Down"]';
        const outcomes: string[] = typeof rawOutcomes === "string" ? JSON.parse(rawOutcomes) : rawOutcomes;

        if (clobTokenIds.length < 2) continue;

        // Compute 5-min window start (endTs - 5min)
        const durationMs = 5 * 60 * 1000;
        const windowStartTs = endTs - durationMs;

        // Fetch strike price from Binance klines
        const strikePrice = await fetchStrikePrice(asset, windowStartTs);

        const contract: Contract = {
          conditionId,
          title: m.question || m.title || slug,
          slug,
          endTs,
          windowStartTs,
          durationMs,
          clobTokenIds,
          outcomes,
          asset,
          strikePrice,
          fetchedAt: Date.now(),
        };

        // Store in both indexes
        contracts.set(conditionId, contract);
        for (const tid of clobTokenIds) {
          tokenIndex.set(tid, contract);
        }

        // Pre-subscribe token IDs to book module
        book.subscribe(clobTokenIds);
        newCount++;

        log.info(`New contract: ${contract.title}`, {
          conditionId: conditionId.slice(0, 10) + "...",
          asset,
          endTs: new Date(endTs).toISOString(),
          strike: strikePrice,
        });
      }
    } catch (err: any) {
      log.error(`Scan ${pass.label} failed`, err.message);
    }
  }

  if (newCount > 0) {
    log.info(`Scan found ${newCount} new contracts (${contracts.size} total cached)`);
  }

  // Prune expired contracts (ended more than 5 min ago — matching V1)
  pruneExpired();
}

/** Fetch the close price of the 1-min kline at the contract's window start. */
async function fetchStrikePrice(asset: Asset, windowStartTs: number): Promise<number | null> {
  try {
    const symbol = asset === "BTC" ? "BTCUSDT" : "ETHUSDT";
    const res = await axios.get(URLS.binanceKlines, {
      params: {
        symbol,
        interval: "1m",
        startTime: windowStartTs - 60_000, // Kline ending at windowStart
        endTime: windowStartTs,
        limit: 1,
      },
      timeout: 3000,
    });

    // Kline format: [openTime, open, high, low, close, ...]
    const klines: any[] = res.data || [];
    if (klines.length > 0) {
      const close = parseFloat(klines[0][4]);
      if (close > 0) return close;
    }
    return null;
  } catch (err: any) {
    log.warn(`Failed to fetch strike for ${asset}`, err.message);
    return null;
  }
}

/** Remove contracts that expired more than 5 minutes ago (matching V1). */
function pruneExpired(): void {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [cid, c] of contracts) {
    if (c.endTs < cutoff) {
      for (const tid of c.clobTokenIds) {
        tokenIndex.delete(tid);
        book.unsubscribe(tid);
      }
      contracts.delete(cid);
    }
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  log.info("Starting contract scanner");
  await scan(); // Initial scan
  scanTimer = setInterval(scan, SCAN_INTERVAL_MS);
}

export function stop(): void {
  running = false;
  log.info("Stopping contract scanner");
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}
