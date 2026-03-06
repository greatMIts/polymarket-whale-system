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

// Alternate Binance endpoints for geo-restriction failover
const WS_ENDPOINTS = [
  CONFIG.binanceWsUrl,
  "wss://data-stream.binance.vision/stream?streams=btcusdt@trade/ethusdt@trade",
  "wss://stream.binance.com:443/stream?streams=btcusdt@trade/ethusdt@trade",
];
const REST_ENDPOINTS = [
  "https://api.binance.com/api/v3/ticker/price",
  "https://data-api.binance.vision/api/v3/ticker/price",
  "https://api1.binance.com/api/v3/ticker/price",
  "https://api2.binance.com/api/v3/ticker/price",
  "https://api3.binance.com/api/v3/ticker/price",
  "https://api4.binance.com/api/v3/ticker/price",
];
let wsEndpointIdx = 0;
let restEndpointIdx = 0;

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

  const endpoint = WS_ENDPOINTS[wsEndpointIdx % WS_ENDPOINTS.length];
  logger.info("binance", `Connecting to ${endpoint.split("?")[0]}...`);
  ws = new WebSocket(endpoint);

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

      // Trim to last 10 minutes (trigger at 5000 entries to avoid frequent rebuilds)
      if (bucket.history.length > 5000) {
        const cutoff = now - HISTORY_MAX_MS;
        bucket.history = bucket.history.filter(p => p.ts > cutoff);
      }

      // Mark ready only when BOTH BTC and ETH have prices
      if (!_ready && assets["BTCUSDT"].price > 0 && assets["ETHUSDT"].price > 0) {
        _ready = true;
        logger.event("binance", "READY", {
          BTC: assets["BTCUSDT"].price,
          ETH: assets["ETHUSDT"].price,
        });
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
  // Cycle to next endpoint on repeated failures
  wsEndpointIdx++;
  if (wsEndpointIdx >= WS_ENDPOINTS.length) wsEndpointIdx = 0;
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
      const restUrl = REST_ENDPOINTS[restEndpointIdx % REST_ENDPOINTS.length];
      const { data } = await axios.get(restUrl, {
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
      restEndpointIdx++;  // cycle to next REST endpoint
      logger.error("binance", `REST fallback failed (trying next endpoint): ${e.message}`);
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
