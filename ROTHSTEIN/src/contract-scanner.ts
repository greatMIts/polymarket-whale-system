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

export async function scanForContracts(): Promise<number> {
  const keywords = ["Bitcoin", "Ethereum"];
  let newContracts = 0;

  for (const keyword of keywords) {
    try {
      const { data } = await axios.get(`${CONFIG.gammaApi}/events`, {
        params: { closed: false, limit: 5, tag: keyword },
        timeout: 8000,
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      });

      const events = Array.isArray(data) ? data : [];
      for (const ev of events) {
        const title = ev.title || ev.question || "";
        if (!/up or down/i.test(title)) continue;

        const markets = ev.markets || [];
        for (const m of markets) {
          const added = processMarket(m);
          if (added) newContracts++;
        }
      }
    } catch (e: any) {
      logger.debug("scanner", `Gamma scan error for ${keyword}: ${e.message}`);
    }
  }

  // Cleanup expired contracts (ended > 5 min ago)
  const now = Date.now();
  for (const [id, c] of contractCache) {
    if (c.endTs > 0 && now - c.endTs > 300_000) {
      contractCache.delete(id);
      for (const t of c.clobTokenIds) tokenToContract.delete(t);
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

  const title = m.question || m.title || "";
  const endTs = m.endDate ? new Date(m.endDate).getTime() : 0;
  const now = Date.now();

  // Skip if already ended
  if (endTs > 0 && endTs < now) return false;

  // Detect asset
  const titleLower = title.toLowerCase();
  let binanceSymbol = "";
  let asset: Asset = "BTC";
  for (const [kw, sym] of Object.entries(ASSET_MAP)) {
    if (titleLower.includes(kw)) {
      binanceSymbol = sym;
      asset = sym === "ETHUSDT" ? "ETH" : "BTC";
      break;
    }
  }
  if (!binanceSymbol) return false;

  // Parse time window from title
  const { windowStartTs, durationMs } = parseWindowStartTs(title, endTs);
  const contractDurationMinutes = durationMs > 0 ? Math.round(durationMs / 60_000) : 0;

  // Get strike price (will be fetched lazily if needed)
  const strikePrice: number | null = null;  // fetched on first evaluation

  const contract: ContractInfo = {
    conditionId,
    title,
    startTs: m.startDate ? new Date(m.startDate).getTime() : 0,
    endTs,
    windowStartTs,
    durationMs,
    clobTokenIds: tokenIds,
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

  return true;
}

// ─── Strike Price ───────────────────────────────────────────────────────────
// Fetches the Binance price at the contract's window start time.

export async function fetchStrikePrice(contract: ContractInfo): Promise<number | null> {
  if (contract.strikePrice !== null) return contract.strikePrice;
  if (contract.windowStartTs <= 0) return null;

  try {
    const { data } = await axios.get("https://api.binance.com/api/v3/klines", {
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
        // Update cache
        contract.strikePrice = openPrice;
        contractCache.set(contract.conditionId, contract);
        return openPrice;
      }
    }
  } catch {}

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
