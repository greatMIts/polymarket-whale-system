/**
 * whale-watcher.ts — Polls whale wallets and enriches trades with metrics.
 *
 * Layer 2 — Imports config, market-data, types.
 * V7.5 changes: duration gate (5m/15m only), contractDuration field,
 * capped FIFO (200), field renames (wallet→walletAddress, etc.).
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
import type { CachedContract } from "./market-data";
import type { WhaleTrade } from "./types";

// ─── STATE ──────────────────────────────────────────────────────────────────

const seenTxHashes = new Set<string>();
const handlers: ((trade: WhaleTrade) => void)[] = [];

// V7.5: Capped FIFO (max 200), newest last
const recentTrades: WhaleTrade[] = [];

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

export function onWhaleTrade(handler: (trade: WhaleTrade) => void) {
  handlers.push(handler);
}

export function getRecentTrades(): readonly WhaleTrade[] {
  return recentTrades;
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
    const pollDetectedAt = Date.now();

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

      // Contract lookup
      const contract: CachedContract | null = marketState.assetToContract.get(asset) || null;
      const now = Date.now();
      const endTs = contract?.endTs || 0;
      const secsRemaining = endTs ? (endTs - now) / 1000 : -1;

      // ── V7.5 Duration gate: only emit 5m and 15m contracts ──
      const durationMatch = (contract?.title || "").match(/(\d+)\s*min/i);
      const durationMin = durationMatch ? parseInt(durationMatch[1]) : null;
      if (durationMin !== 5 && durationMin !== 15) continue;

      const contractDuration: '5m' | '15m' = durationMin === 5 ? '5m' : '15m';

      // Compute seconds remaining per duration
      const secsRemaining5m = contractDuration === '5m' ? Math.max(0, secsRemaining) : 0;
      const secsRemaining15m = contractDuration === '15m' ? Math.max(0, secsRemaining) : 0;

      // Detect asset label
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

      // Order book mid
      let book = marketState.tokenBook.get(asset) || { ask: 0, bid: 0 };
      if ((book.ask === 0 || book.bid === 0) && asset) {
        fetchBookFromRest(asset).catch(() => {});
      }
      const polyMid = book.ask > 0 && book.bid > 0 ? (book.ask + book.bid) / 2 : 0;
      const midEdge = polyMid > 0 ? polyMid - price : 0;

      // Per-asset direction & momentum alignment
      const effectiveSym = sym || "BTCUSDT";
      const delta30s = getPriceDelta(effectiveSym, 30);

      let momentumAligned = false;
      if (side === "BUY") {
        if (dir === "UP" && delta30s > 0.02) momentumAligned = true;
        if (dir === "DOWN" && delta30s < -0.02) momentumAligned = true;
      }

      // ── Build V7.5 WhaleTrade (14 fields) ──
      const whaleTrade: WhaleTrade = {
        conditionId,
        asset,
        assetLabel: assetLabel || "?",
        title: contract?.title || t.title || "",
        side,
        usdcSize,
        walletAddress: walletAddress,
        txHash,
        midEdge,
        momentumAligned,
        contractDuration,
        secsRemaining5m,
        secsRemaining15m,
        detectedAt: pollDetectedAt,
      };

      // V7.5: capped FIFO (max 200)
      recentTrades.push(whaleTrade);
      if (recentTrades.length > 200) recentTrades.shift();

      newCount++;

      // Emit to all handlers
      for (const handler of handlers) {
        try {
          handler(whaleTrade);
        } catch (err: any) {
          console.error("[whale-watcher] handler error:", err.message);
        }
      }
    }

    if (newCount > 0) {
      console.log(`[${walletLabel}] +${newCount} trades | ${assetPriceSummary()}`);
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

export function start() {
  const staggerMs = Math.floor(CONFIG.pollIntervalMs / CONFIG.wallets.length);

  for (let i = 0; i < CONFIG.wallets.length; i++) {
    const w = CONFIG.wallets[i];
    setTimeout(() => {
      setInterval(() => pollWhale(w.address, w.label), CONFIG.pollIntervalMs);
    }, i * staggerMs);
    console.log(`[boot] polling ${w.label} every ${CONFIG.pollIntervalMs / 1000}s (offset ${i * staggerMs}ms)`);
  }
}
