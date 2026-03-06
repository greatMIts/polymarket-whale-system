// ─── Layer 1: Contract Scanner ──────────────────────────────────────────────
// Discovers active 5min BTC/ETH contracts via Gamma API.
// Pre-subscribes token IDs to polymarket-book BEFORE contract starts.
// Caches contract metadata for O(1) lookup by conditionId.

import axios from "axios";
import { ContractInfo, Asset } from "./types";
import { CONFIG } from "./config";
import { logger } from "./logger";
import * as polyBook from "./polymarket-book";

// ─── State ──────────────────────────────────────────────────────────────────

const contractCache = new Map<string, ContractInfo>();
const tokenToContract = new Map<string, ContractInfo>();   // tokenId → contract

// Asset keyword → Binance symbol mapping
const ASSET_MAP: Record<string, string> = {
  bitcoin: "BTCUSDT",
  btc: "BTCUSDT",
  ethereum: "ETHUSDT",
  eth: "ETHUSDT",
};

// ─── Public API ─────────────────────────────────────────────────────────────

export function getActiveContracts(): ContractInfo[] {
  const now = Date.now();
  const active: ContractInfo[] = [];

  for (const c of contractCache.values()) {
    // Contract is active if: started but not yet ended
    if (c.endTs > 0 && c.endTs > now && c.windowStartTs > 0 && c.windowStartTs <= now) {
      // Only include allowed assets and durations
      if (!CONFIG.allowedAssets.includes(c.asset as any)) continue;
      if (!CONFIG.allowedDurations.includes(c.contractDurationMinutes as any)) continue;
      active.push(c);
    }
  }

  return active;
}

export function getUpcomingContracts(): ContractInfo[] {
  const now = Date.now();
  return [...contractCache.values()].filter(c =>
    c.windowStartTs > now && c.windowStartTs - now < 600_000  // starts within 10 min
  );
}

export function getContractByConditionId(conditionId: string): ContractInfo | null {
  return contractCache.get(conditionId) || null;
}

export function getContractByTokenId(tokenId: string): ContractInfo | null {
  return tokenToContract.get(tokenId) || null;
}

export function getCacheSize(): number {
  return contractCache.size;
}

// ─── Gamma API Scan ─────────────────────────────────────────────────────────
// Query /markets with end_date_min/max + order by endDate ascending.
// This ensures we get CURRENTLY ACTIVE contracts (ending soonest) rather than
// the most recently CREATED ones (which are often far-future pre-created batches).
// Slug pattern: (btc|eth)-updown-(5m|15m)-{unix_timestamp}

const UPDOWN_SLUG_RE = /^(btc|eth)-updown-(5m|15m)-\d+$/;

export async function scanForContracts(): Promise<number> {
  let newContracts = 0;
  const now = Date.now();

  // Two-pass scan:
  //   Pass 1: Contracts ending in the next 10 minutes (currently active + just started)
  //   Pass 2: Contracts ending in 10-30 minutes (upcoming, for pre-subscription)
  const passes = [
    { end_date_min: new Date(now).toISOString(), end_date_max: new Date(now + 10 * 60_000).toISOString(), label: "active" },
    { end_date_min: new Date(now + 10 * 60_000).toISOString(), end_date_max: new Date(now + 30 * 60_000).toISOString(), label: "upcoming" },
  ];

  for (const pass of passes) {
    try {
      const { data } = await axios.get(`${CONFIG.gammaApi}/markets`, {
        params: {
          active: true,
          closed: false,
          limit: 100,
          order: "endDate",
          ascending: true,
          end_date_min: pass.end_date_min,
          end_date_max: pass.end_date_max,
        },
        timeout: 10000,
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      });

      const markets = Array.isArray(data) ? data : [];
      let passFound = 0;
      for (const m of markets) {
        const slug = m.slug || "";
        if (!UPDOWN_SLUG_RE.test(slug)) continue;

        // Only BTC and ETH for now
        const asset = slug.startsWith("btc") ? "BTC" : slug.startsWith("eth") ? "ETH" : null;
        if (!asset) continue;

        // Only 5-min contracts
        if (!slug.includes("-5m-")) continue;

        const added = processMarket(m);
        if (added) { newContracts++; passFound++; }
      }
      if (passFound > 0) {
        logger.debug("scanner", `${pass.label} pass: ${passFound} new from ${markets.length} results`);
      }
    } catch (e: any) {
      logger.debug("scanner", `Gamma ${pass.label} scan error: ${e.message}`);
    }
  }

  // Cleanup expired contracts (ended > 5 min ago) + notify polybook to unsub
  for (const [id, c] of contractCache) {
    if (c.endTs > 0 && now - c.endTs > 300_000) {
      contractCache.delete(id);
      for (const t of c.clobTokenIds) {
        tokenToContract.delete(t);
        polyBook.unsubscribe(t);
      }
    }
  }

  if (newContracts > 0) {
    logger.info("scanner", `Found ${newContracts} new contract(s), cache: ${contractCache.size}`);
  }

  return newContracts;
}

// ─── Process a Market from Gamma API ────────────────────────────────────────

function processMarket(m: any): boolean {
  const conditionId = m.conditionId || "";
  if (!conditionId) return false;

  // Skip if already cached and fresh (<5 min)
  const existing = contractCache.get(conditionId);
  if (existing && Date.now() - existing.fetchedAt < 300_000) return false;

  // Parse token IDs
  let rawTokenIds = m.clobTokenIds || [];
  if (typeof rawTokenIds === "string") {
    try { rawTokenIds = JSON.parse(rawTokenIds); } catch { rawTokenIds = []; }
  }
  const tokenIds: string[] = Array.isArray(rawTokenIds)
    ? rawTokenIds.filter((id: any) => typeof id === "string" && id.length > 0)
    : [];
  if (tokenIds.length === 0) return false;

  // Parse outcomes — parallel array with clobTokenIds: e.g. ["Up", "Down"]
  let rawOutcomes = m.outcomes || [];
  if (typeof rawOutcomes === "string") {
    try { rawOutcomes = JSON.parse(rawOutcomes); } catch { rawOutcomes = []; }
  }
  const outcomes: string[] = Array.isArray(rawOutcomes)
    ? rawOutcomes.map((o: any) => String(o))
    : [];

  const title = m.question || m.title || "";
  const endTs = m.endDate ? new Date(m.endDate).getTime() : 0;
  const now = Date.now();

  // Skip if already ended
  if (endTs > 0 && endTs < now) return false;

  // Detect asset from slug or title
  const slug = m.slug || "";
  const titleLower = title.toLowerCase();
  let binanceSymbol = "";
  let asset: Asset = "BTC";

  if (slug.startsWith("btc-") || titleLower.includes("bitcoin") || titleLower.includes("btc")) {
    binanceSymbol = "BTCUSDT";
    asset = "BTC";
  } else if (slug.startsWith("eth-") || titleLower.includes("ethereum") || titleLower.includes("eth")) {
    binanceSymbol = "ETHUSDT";
    asset = "ETH";
  } else {
    // Fallback: try keyword map
    for (const [kw, sym] of Object.entries(ASSET_MAP)) {
      if (titleLower.includes(kw)) {
        binanceSymbol = sym;
        asset = sym === "ETHUSDT" ? "ETH" : "BTC";
        break;
      }
    }
  }
  if (!binanceSymbol) return false;

  // Use eventStartTime from API if available (much more reliable than title parsing)
  let windowStartTs = 0;
  let durationMs = 0;

  if (m.eventStartTime) {
    windowStartTs = new Date(m.eventStartTime).getTime();
    durationMs = endTs > 0 && windowStartTs > 0 ? endTs - windowStartTs : 0;
  }

  // Fallback: parse from slug timestamp or title
  if (windowStartTs <= 0) {
    const slugMatch = slug.match(/-(\d{10,})$/);
    if (slugMatch) {
      windowStartTs = parseInt(slugMatch[1]) * 1000;
      durationMs = endTs > 0 && windowStartTs > 0 ? endTs - windowStartTs : 0;
    }
  }
  if (windowStartTs <= 0) {
    const parsed = parseWindowStartTs(title, endTs);
    windowStartTs = parsed.windowStartTs;
    durationMs = parsed.durationMs;
  }

  const contractDurationMinutes = durationMs > 0 ? Math.round(durationMs / 60_000) : 0;

  // Get strike price (will be fetched lazily if needed)
  const strikePrice: number | null = null;  // fetched on first evaluation

  const contract: ContractInfo = {
    conditionId,
    title,
    startTs: m.startDate ? new Date(m.startDate).getTime() : (m.createdAt ? new Date(m.createdAt).getTime() : 0),
    endTs,
    windowStartTs,
    durationMs,
    clobTokenIds: tokenIds,
    outcomes,
    binanceSymbol,
    asset,
    strikePrice,
    contractDurationMinutes,
    fetchedAt: Date.now(),
  };

  contractCache.set(conditionId, contract);
  for (const tid of tokenIds) tokenToContract.set(tid, contract);

  // Pre-subscribe to order book!
  polyBook.subscribe(tokenIds);

  logger.debug("scanner", `Cached: "${title.slice(0, 60)}" | ${asset} ${contractDurationMinutes}m | ${tokenIds.length} tokens | ends ${endTs ? new Date(endTs).toISOString() : "?"}`);

  return true;
}

// ─── Strike Price ───────────────────────────────────────────────────────────
// Fetches the Binance price at the contract's window start time.

// Klines endpoints with geo-restriction failover (same as binance-feed.ts)
const KLINES_ENDPOINTS = [
  "https://data-api.binance.vision/api/v3/klines",
  "https://api.binance.com/api/v3/klines",
  "https://api1.binance.com/api/v3/klines",
  "https://api2.binance.com/api/v3/klines",
];
let klinesEndpointIdx = 0;

export async function fetchStrikePrice(contract: ContractInfo): Promise<number | null> {
  if (contract.strikePrice !== null) return contract.strikePrice;
  if (contract.windowStartTs <= 0) return null;

  // Don't attempt klines fetch if the window started less than 3s ago (data not available yet)
  const age = Date.now() - contract.windowStartTs;
  if (age < 3000) return null;

  // Try multiple endpoints for geo-restriction failover
  for (let attempt = 0; attempt < KLINES_ENDPOINTS.length; attempt++) {
    const endpoint = KLINES_ENDPOINTS[klinesEndpointIdx % KLINES_ENDPOINTS.length];
    try {
      const { data } = await axios.get(endpoint, {
        params: {
          symbol: contract.binanceSymbol,
          interval: "1s",
          startTime: contract.windowStartTs,
          limit: 1,
        },
        timeout: 5000,
      });

      if (data && data[0]) {
        const openPrice = parseFloat(data[0][1]);
        if (openPrice > 0) {
          contract.strikePrice = openPrice;
          contractCache.set(contract.conditionId, contract);
          logger.info("scanner", `Strike fetched: ${contract.asset} $${openPrice.toFixed(2)} for "${contract.title.slice(0, 50)}"`);
          return openPrice;
        }
      }
      // Request succeeded but no data — for very new contracts, kline might not exist yet
      logger.debug("scanner", `Klines returned no data for ${contract.asset} at ${new Date(contract.windowStartTs).toISOString()} (age: ${Math.round(age / 1000)}s)`);
      break;  // Request succeeded (even if no data), stop retrying
    } catch (e: any) {
      // 451 = geo-restriction, cycle to next endpoint
      klinesEndpointIdx++;
      if (attempt < KLINES_ENDPOINTS.length - 1) {
        logger.debug("scanner", `Klines endpoint blocked (${e.message}), trying next...`);
      } else {
        logger.debug("scanner", `All klines endpoints failed for ${contract.asset}: ${e.message}`);
      }
    }
  }

  return null;
}

// ─── Title Parsing ──────────────────────────────────────────────────────────
// Extracts time window from contract title.
// e.g. "Bitcoin Up or Down - March 2, 7:15PM-7:20PM ET" → 5 min duration

function parseWindowStartTs(title: string, endTs: number): { windowStartTs: number; durationMs: number } {
  if (!endTs) return { windowStartTs: 0, durationMs: 0 };

  function parseTimeToMins(hourStr: string, minStr: string | null, ampm: string): number {
    let h = parseInt(hourStr);
    const m = minStr ? parseInt(minStr) : 0;
    if (ampm.toUpperCase() === "PM" && h !== 12) h += 12;
    if (ampm.toUpperCase() === "AM" && h === 12) h = 0;
    return h * 60 + m;
  }

  // General range: "H:MMAM-H:MMAM ET"
  const rangeMatch = title.match(
    /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(ET|EST|EDT)/i
  );
  if (rangeMatch) {
    const [, sh, sm, sap, eh, em, eap] = rangeMatch;
    const startMins = parseTimeToMins(sh, sm || null, sap);
    const endMins = parseTimeToMins(eh, em || null, eap);
    let durationMins = endMins - startMins;
    if (durationMins <= 0) durationMins += 24 * 60;
    const durationMs = durationMins * 60 * 1000;
    return { windowStartTs: endTs - durationMs, durationMs };
  }

  // Standalone hour: "6AM ET" (hourly contract)
  const hourlyMatch = title.match(/(\d{1,2})\s*(AM|PM)\s+(ET|EST|EDT)/i);
  if (hourlyMatch) {
    const durationMs = 3_600_000;
    return { windowStartTs: endTs - durationMs, durationMs };
  }

  return { windowStartTs: 0, durationMs: 0 };
}
