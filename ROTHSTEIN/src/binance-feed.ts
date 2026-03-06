// ─── Layer 1: Binance Price Feed ────────────────────────────────────────────
// Single persistent WebSocket to Binance. Tracks BTC + ETH prices with
// rolling 10-minute history. Computes deltas and direction.
// Exponential backoff on disconnect. REST fallback if WS dead >60s.

import WebSocket from "ws";
import axios from "axios";
import { AssetState, PricePoint, Direction, Asset } from "./types";
import { CONFIG } from "./config";
import { logger } from "./logger";

// ─── State ──────────────────────────────────────────────────────────────────

const assets: Record<string, AssetState> = {
  BTCUSDT: { price: 0, history: [], lastUpdate: 0 },
  ETHUSDT: { price: 0, history: [], lastUpdate: 0 },
};

let ws: WebSocket | null = null;
let reconnectMs = 100;
const MAX_RECONNECT_MS = 30_000;
const HISTORY_MAX_MS = 600_000;  // 10 minutes
let restFallbackTimer: NodeJS.Timeout | null = null;
let _ready = false;

// ─── Public API ─────────────────────────────────────────────────────────────

const symbolMap: Record<Asset, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT" };

export function getPrice(asset: Asset): number | null {
  const sym = symbolMap[asset];
  return assets[sym]?.price || null;
}

export function getDelta(asset: Asset, seconds: number): number {
  const sym = symbolMap[asset];
  const bucket = assets[sym];
  if (!bucket || bucket.price === 0 || bucket.history.length === 0) return 0;

  const cutoff = Date.now() - seconds * 1000;
  let old: PricePoint | null = null;
  for (let i = bucket.history.length - 1; i >= 0; i--) {
    if (bucket.history[i].ts <= cutoff) { old = bucket.history[i]; break; }
  }
  if (!old || old.price === 0) return 0;
  return ((bucket.price - old.price) / old.price) * 100;
}

export function getDelta30s(asset: Asset): number { return getDelta(asset, 30); }
export function getDelta5m(asset: Asset): number { return getDelta(asset, 300); }

export function getDirection(asset: Asset): Direction {
  const d = getDelta(asset, 30);
  if (d > 0.005) return "UP";
  if (d < -0.005) return "DOWN";
  return "FLAT";
}

export function getHistory(asset: Asset): PricePoint[] {
  return assets[symbolMap[asset]]?.history || [];
}

export function isStale(): boolean {
  const now = Date.now();
  return Object.values(assets).every(a =>
    a.lastUpdate === 0 || now - a.lastUpdate > CONFIG.binanceStaleMs
  );
}

export function isReady(): boolean { return _ready; }

export function getLastUpdate(asset: Asset): number {
  return assets[symbolMap[asset]]?.lastUpdate || 0;
}

// ─── Connection ─────────────────────────────────────────────────────────────

export function connect(): void {
  if (ws) {
    try { ws.terminate(); } catch {}
  }

  ws = new WebSocket(CONFIG.binanceWsUrl);

  ws.on("open", () => {
    logger.info("binance", "WS connected (BTC + ETH)");
    reconnectMs = 100;  // reset backoff
    stopRestFallback();
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const d = msg.data || msg;
      const price = parseFloat(d.p);
      if (!price || isNaN(price)) return;

      const symbol = msg.stream
        ? msg.stream.split("@")[0].toUpperCase()
        : "BTCUSDT";

      const bucket = assets[symbol];
      if (!bucket) return;

      const now = Date.now();
      bucket.price = price;
      bucket.lastUpdate = now;
      bucket.history.push({ ts: now, price });

      // Trim to last 10 minutes
      const cutoff = now - HISTORY_MAX_MS;
      if (bucket.history.length > 1000) {
        bucket.history = bucket.history.filter(p => p.ts > cutoff);
      }

      // Mark ready after first price received
      if (!_ready) {
        _ready = true;
        logger.event("binance", "READY", { symbol, price });
      }
    } catch {}
  });

  ws.on("close", () => {
    logger.warn("binance", `WS disconnected, reconnecting in ${reconnectMs}ms`);
    scheduleReconnect();
  });

  ws.on("error", (e: Error) => {
    logger.error("binance", `WS error: ${e.message}`);
    startRestFallback();
  });
}

function scheduleReconnect(): void {
  setTimeout(() => connect(), reconnectMs);
  reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);  // exponential backoff
}

// ─── REST Fallback ──────────────────────────────────────────────────────────
// If WS is dead for >60s, poll REST every 5s as degraded mode.

function startRestFallback(): void {
  if (restFallbackTimer) return;
  logger.warn("binance", "Starting REST price fallback");
  restFallbackTimer = setInterval(async () => {
    try {
      const { data } = await axios.get("https://api.binance.com/api/v3/ticker/price", {
        params: { symbols: '["BTCUSDT","ETHUSDT"]' },
        timeout: 3000,
      });
      const now = Date.now();
      for (const item of data) {
        const sym = item.symbol;
        const price = parseFloat(item.price);
        if (assets[sym] && price > 0) {
          assets[sym].price = price;
          assets[sym].lastUpdate = now;
          assets[sym].history.push({ ts: now, price });
        }
      }
      if (!_ready) {
        _ready = true;
        logger.event("binance", "READY_VIA_REST");
      }
    } catch (e: any) {
      logger.error("binance", `REST fallback failed: ${e.message}`);
    }
  }, 5_000);
}

function stopRestFallback(): void {
  if (restFallbackTimer) {
    clearInterval(restFallbackTimer);
    restFallbackTimer = null;
    logger.info("binance", "REST fallback stopped (WS recovered)");
  }
}

export function disconnect(): void {
  stopRestFallback();
  if (ws) {
    try { ws.terminate(); } catch {}
    ws = null;
  }
}
