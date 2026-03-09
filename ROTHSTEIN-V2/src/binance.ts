// ─── ROTHSTEIN V2 Binance Feed ────────────────────────────────────────────────
// Real-time BTC + ETH prices via Binance combined WebSocket stream.
// Rolling 10-min price history, delta/direction helpers, exponential backoff
// reconnect, and REST fallback when WS is dead.

import WebSocket from "ws";
import axios from "axios";
import { Asset, AssetFeed, Direction, PricePoint } from "./types";
import { URLS } from "./config";
import { createLogger } from "./log";

const log = createLogger("BINANCE");

// ─── State ───────────────────────────────────────────────────────────────────

const HISTORY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const STALE_THRESHOLD_MS = 15_000;         // 15s without update = stale
const REST_POLL_INTERVAL_MS = 5_000;       // REST fallback poll interval

const feeds: Record<Asset, AssetFeed> = {
  BTC: { price: 0, history: [], lastUpdate: 0 },
  ETH: { price: 0, history: [], lastUpdate: 0 },
};

const SYMBOL_MAP: Record<string, Asset> = {
  btcusdt: "BTC",
  ethusdt: "ETH",
};

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let restTimer: ReturnType<typeof setInterval> | null = null;
let usingBackup = false;
let running = false;

// ─── Public API ──────────────────────────────────────────────────────────────

/** Current price for an asset. Returns 0 if unknown. */
export function getPrice(asset: Asset): number {
  return feeds[asset].price;
}

/** Price history (newest last) for the rolling 10-min window. */
export function getHistory(asset: Asset): PricePoint[] {
  return feeds[asset].history;
}

/** Price change over the last `seconds` for an asset. Returns 0 if insufficient data. */
export function getDelta(asset: Asset, seconds: number): number {
  const { history, price } = feeds[asset];
  if (history.length === 0 || price === 0) return 0;
  const cutoff = Date.now() - seconds * 1000;
  // Find the oldest point at or after the cutoff
  const baseline = history.find((p) => p.ts >= cutoff);
  if (!baseline) return 0;
  return price - baseline.price;
}

/** Directional trend over last 30s. */
export function getDirection(asset: Asset): Direction {
  const d = getDelta(asset, 30);
  if (d > 0) return "UP";
  if (d < 0) return "DOWN";
  return "FLAT";
}

/** Whether the feed has a recent price (not stale). */
export function isHealthy(): boolean {
  const now = Date.now();
  return (
    feeds.BTC.lastUpdate > 0 &&
    feeds.ETH.lastUpdate > 0 &&
    now - feeds.BTC.lastUpdate < STALE_THRESHOLD_MS &&
    now - feeds.ETH.lastUpdate < STALE_THRESHOLD_MS
  );
}

/** Last update timestamps for health dashboard. */
export function getStatus(): { connected: boolean; lastUpdate: number } {
  const lastUpdate = Math.max(feeds.BTC.lastUpdate, feeds.ETH.lastUpdate);
  return { connected: ws?.readyState === WebSocket.OPEN, lastUpdate };
}

// ─── Internal: update a feed ─────────────────────────────────────────────────

function updatePrice(asset: Asset, price: number, ts: number): void {
  const feed = feeds[asset];
  feed.price = price;
  feed.lastUpdate = ts;
  feed.history.push({ ts, price });

  // Trim history beyond 10-min window
  const cutoff = ts - HISTORY_WINDOW_MS;
  while (feed.history.length > 0 && feed.history[0].ts < cutoff) {
    feed.history.shift();
  }
}

// ─── WebSocket Connection ────────────────────────────────────────────────────

function connect(): void {
  const url = usingBackup ? URLS.binanceWsBackup : URLS.binanceWs;
  log.info(`Connecting to ${usingBackup ? "backup" : "primary"} stream...`);

  ws = new WebSocket(url);

  ws.on("open", () => {
    log.info("WebSocket connected");
    reconnectAttempt = 0;
  });

  ws.on("message", (raw: WebSocket.Data) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Combined stream format: { stream: "btcusdt@trade", data: { p: "...", T: ... } }
      if (!msg.stream || !msg.data) return;
      const symbol = msg.stream.split("@")[0]; // e.g. "btcusdt"
      const asset = SYMBOL_MAP[symbol];
      if (!asset) return;
      const price = parseFloat(msg.data.p);
      const ts = msg.data.T || Date.now();
      if (price > 0) updatePrice(asset, price, ts);
    } catch {
      // Malformed message — ignore
    }
  });

  ws.on("error", (err: Error) => {
    log.error("WebSocket error", err.message);
  });

  ws.on("close", () => {
    log.warn("WebSocket closed");
    ws = null;
    if (running) scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  reconnectAttempt++;
  // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30_000);
  log.info(`Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);

  // Toggle primary/backup every other attempt
  if (reconnectAttempt % 2 === 0) {
    usingBackup = !usingBackup;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (running) connect();
  }, delay);
}

// ─── REST Fallback ───────────────────────────────────────────────────────────
// Polls REST if WS is dead or stale, so we always have *some* price.

async function restFallback(): Promise<void> {
  if (isHealthy()) return; // WS is fine, skip

  try {
    const [btcRes, ethRes] = await Promise.all([
      axios.get(`${URLS.binanceRest}?symbol=BTCUSDT`, { timeout: 3000 }),
      axios.get(`${URLS.binanceRest}?symbol=ETHUSDT`, { timeout: 3000 }),
    ]);
    const now = Date.now();
    const btc = parseFloat(btcRes.data.price);
    const eth = parseFloat(ethRes.data.price);
    if (btc > 0) updatePrice("BTC", btc, now);
    if (eth > 0) updatePrice("ETH", eth, now);
    log.debug("REST fallback updated prices");
  } catch (err: any) {
    log.error("REST fallback failed", err.message);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function start(): void {
  if (running) return;
  running = true;
  log.info("Starting Binance feed");
  connect();
  restTimer = setInterval(restFallback, REST_POLL_INTERVAL_MS);
}

export function stop(): void {
  running = false;
  log.info("Stopping Binance feed");
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (restTimer) {
    clearInterval(restTimer);
    restTimer = null;
  }
}
