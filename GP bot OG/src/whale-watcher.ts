/**
 * whale-watcher.ts — Polls whale wallets and enriches trades with metrics.
 *
 * Emits enriched WhaleTrade objects to registered listeners.
 * Staggered polling (750ms offset per wallet) to avoid rate limits.
 */

import axios from "axios";
import { CONFIG, ASSET_MAP, SYMBOL_DISPLAY } from "./config";
import {
  marketState,
  getPrice,
  getPriceDelta,
  getAssetDirection,
  computeRealizedVolatility,
  computeBinaryFairValue,
  getContractForAsset,
  fetchBookFromRest,
} from "./market-data";
import type { WhaleTrade } from "./types";

// ─── STATE ──────────────────────────────────────────────────────────────────

const seenTxHashes = new Set<string>();
const tradeListeners: ((trade: WhaleTrade) => void)[] = [];

// All observed whale trades (in-memory, newest first)
export const allWhaleTrades: WhaleTrade[] = [];

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

export function onWhaleTrade(listener: (trade: WhaleTrade) => void) {
  tradeListeners.push(listener);
}

export function getRecentWhaleTrades(limit: number = 200): WhaleTrade[] {
  return allWhaleTrades.slice(0, limit);
}

export function getTotalWhaleTradeCount(): number {
  return allWhaleTrades.length;
}

export function getConcurrentWhales(conditionId: string, currentTs: number): number {
  const cutoff = currentTs - 60_000;
  const wallets = new Set<string>();
  for (const t of allWhaleTrades) {
    if (t.ts >= cutoff && t.conditionId === conditionId) {
      wallets.add(t.walletLabel);
    }
  }
  return wallets.size;
}

// ─── POLL A SINGLE WALLET ───────────────────────────────────────────────────

async function pollWhale(walletAddress: string, walletLabel: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const { data } = await axios.get(`${CONFIG.dataApi}/activity`, {
      params: {
        user: walletAddress,
        limit: 50,
        type: "TRADE",
        sortBy: "TIMESTAMP",
        sortDirection: "DESC",
      },
      timeout: 5000,
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(timeout);

    const trades: any[] = Array.isArray(data) ? data : data.data ?? [];

    // Fetch contract info for new assets in parallel
    const newAssets = new Set<string>();
    for (const t of trades) {
      const asset = t.asset || "";
      if (asset && !marketState.assetToContract.has(asset)) newAssets.add(asset);
    }
    if (newAssets.size > 0) {
      await Promise.allSettled([...newAssets].map(a => getContractForAsset(a)));
    }

    // Pre-compute volatility per symbol
    const volCache: Record<string, number | null> = {};
    let newCount = 0;
    const pollDetectedAt = Date.now(); // timestamp when this poll detected new trades

    for (const t of trades) {
      const txHash = t.transactionHash || `${t.timestamp}_${t.asset}`;
      if (seenTxHashes.has(txHash)) continue;
      seenTxHashes.add(txHash);

      const side = (t.side || "").toUpperCase() as "BUY" | "SELL";
      const price = Number(t.price || 0);
      const outcome = (t.outcome || "").toLowerCase();
      const dir = outcome.includes("up") ? "UP" : "DOWN";
      const conditionId = t.conditionId || "";
      const asset = t.asset || "";
      const usdcSize = Number(t.usdcSize || 0);
      const shares = Number(t.size || 0);

      // Contract lookup
      const contract = marketState.assetToContract.get(asset) || null;
      const now = Date.now();
      const endTs = contract?.endTs || 0;
      const secsRemaining = endTs ? (endTs - now) / 1000 : -1;

      // Contract duration in minutes (0 = unknown/unparseable → will fail 5-min filter)
      const contractDurationMinutes = contract?.durationMs
        ? contract.durationMs / 60_000
        : 0;

      // Detect asset
      const sym = contract?.binanceSymbol || "";
      let assetLabel = "";
      if (sym) assetLabel = SYMBOL_DISPLAY[sym] || sym.replace("USDT", "");

      // If no contract, try to detect from title
      if (!assetLabel) {
        const title = (t.title || contract?.title || "").toLowerCase();
        for (const [keyword, s] of Object.entries(ASSET_MAP)) {
          if (title.includes(keyword)) {
            assetLabel = SYMBOL_DISPLAY[s] || keyword.toUpperCase();
            break;
          }
        }
      }

      // Black-Scholes edge (per-asset: uses asset's own vol and spot price)
      let edgeVsSpot: number | null = null;
      if (contract && sym && contract.strikePrice && secsRemaining > 0) {
        if (!(sym in volCache)) volCache[sym] = computeRealizedVolatility(sym);
        const assetVol = volCache[sym];
        const assetPrice = getPrice(sym);
        if (assetVol !== null && assetPrice > 0) {
          const fairValue = computeBinaryFairValue(assetPrice, contract.strikePrice, secsRemaining, assetVol, dir as "UP" | "DOWN");
          edgeVsSpot = fairValue - price;
        }
      }

      // Order book mid — NON-BLOCKING: use WS book if available, kick off REST fetch in background
      let book = marketState.tokenBook.get(asset) || { ask: 0, bid: 0 };
      if ((book.ask === 0 || book.bid === 0) && asset) {
        // Fire-and-forget: don't block the trade pipeline for REST book data
        fetchBookFromRest(asset).catch(() => {});
      }
      const polyMid = book.ask > 0 && book.bid > 0 ? (book.ask + book.bid) / 2 : 0;
      const midEdge = polyMid > 0 ? polyMid - price : null;

      // Per-asset direction & momentum alignment
      const effectiveSym = sym || "BTCUSDT";
      const delta30s = getPriceDelta(effectiveSym, 30);
      const delta5m = getPriceDelta(effectiveSym, 300);
      const priceDirection = getAssetDirection(effectiveSym);

      // Momentum: does the whale's bet direction match the asset's 30s price movement?
      let momentumAligned = false;
      if (side === "BUY") {
        if (dir === "UP" && delta30s > 0.02) momentumAligned = true;
        if (dir === "DOWN" && delta30s < -0.02) momentumAligned = true;
      }

      const whaleTrade: WhaleTrade = {
        id: `whale_${txHash}`,
        ts: t.timestamp ? t.timestamp * 1000 : now,
        tsIso: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : new Date().toISOString(),
        wallet: walletAddress,
        walletLabel,
        side,
        outcome: t.outcome || "?",
        price,
        usdcSize,
        shares,
        conditionId,
        title: contract?.title || t.title || "",
        txHash,
        asset,
        spotPrice: getPrice(effectiveSym),
        assetPriceAtTrade: sym ? getPrice(sym) : getPrice("BTCUSDT"),
        delta30s,
        delta5m,
        priceDirection,
        secondsRemainingInContract: secsRemaining,
        contractDurationMinutes,
        edgeVsSpot,
        polyMid,
        midEdge,
        binanceSymbol: sym,
        assetLabel: assetLabel || "?",
        momentumAligned,
        detectedAt: pollDetectedAt,
      };

      allWhaleTrades.unshift(whaleTrade);
      if (allWhaleTrades.length > 5000) allWhaleTrades.length = 5000;
      newCount++;

      // Emit to all listeners (filter engine, persistence, etc.)
      for (const listener of tradeListeners) {
        try { listener(whaleTrade); } catch (err: any) {
          console.error("[whale-watcher] listener error:", err.message);
        }
      }
    }

    if (newCount > 0) {
      // Log latency breakdown for detected trades
      const apiLag = trades
        .filter((t: any) => t.timestamp && !seenTxHashes.has(t.transactionHash || `${t.timestamp}_${t.asset}`) === false)
        .map((t: any) => t.timestamp ? pollDetectedAt - t.timestamp * 1000 : 0)
        .filter((v: number) => v > 0);
      const avgApiLag = apiLag.length > 0 ? (apiLag.reduce((a: number, b: number) => a + b, 0) / apiLag.length / 1000).toFixed(1) : '?';
      console.log(`[${walletLabel}] +${newCount} trades | apiLag ~${avgApiLag}s | ${assetPriceSummary()}`);
    }
  } catch (e: any) {
    clearTimeout(timeout);
    if (e.code === "ECONNABORTED" || e.name === "AbortError" || e.code === "ERR_CANCELED") {
      // Timeout — silent retry
    } else {
      console.error(`[${walletLabel}] poll error:`, e.message);
    }
  }
}

function assetPriceSummary(): string {
  const parts: string[] = [];
  for (const [sym, bucket] of Object.entries(marketState.assetPrices)) {
    if (bucket.price > 0) {
      parts.push(`${sym.replace("USDT", "")}:$${bucket.price.toFixed(sym === "XRPUSDT" ? 4 : 0)}`);
    }
  }
  return parts.join(" ");
}

// ─── STAGGERED POLLING LOOP ─────────────────────────────────────────────────

export function startPolling() {
  const staggerMs = Math.floor(CONFIG.pollIntervalMs / CONFIG.wallets.length);

  for (let i = 0; i < CONFIG.wallets.length; i++) {
    const w = CONFIG.wallets[i];
    setTimeout(() => {
      setInterval(() => pollWhale(w.address, w.label), CONFIG.pollIntervalMs);
    }, i * staggerMs);
    console.log(`[boot] polling ${w.label} every ${CONFIG.pollIntervalMs / 1000}s (offset ${i * staggerMs}ms)`);
  }
}

