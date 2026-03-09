// ─── ROTHSTEIN V2 Order Book ──────────────────────────────────────────────────
// Maintains real-time bid/ask/mid/spread for Polymarket tokens via WebSocket.
// Text "PING" keepalive every 10s. REST fallback for stale books.

import WebSocket from "ws";
import axios from "axios";
import { Book } from "./types";
import { URLS } from "./config";
import { createLogger } from "./log";

const log = createLogger("BOOK");

// ─── State ───────────────────────────────────────────────────────────────────

const KEEPALIVE_MS = 10_000;
const STALE_THRESHOLD_MS = 30_000;
const REST_FALLBACK_MS = 15_000;

/** tokenId → Book */
const books = new Map<string, Book>();

/** Token IDs we're actively subscribed to. */
const subscribed = new Set<string>();

/** Tokens queued for subscription (before WS is open). */
const pendingSubscribes: string[] = [];

let ws: WebSocket | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let restTimer: ReturnType<typeof setInterval> | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

// ─── Public API ──────────────────────────────────────────────────────────────

/** Get current book for a token. Returns undefined if no data. */
export function getBook(tokenId: string): Book | undefined {
  return books.get(tokenId);
}

/** Subscribe to one or more token IDs for order book updates. */
export function subscribe(tokenIds: string[]): void {
  const newIds = tokenIds.filter((id) => !subscribed.has(id));
  if (newIds.length === 0) return;

  for (const id of newIds) subscribed.add(id);

  if (ws?.readyState === WebSocket.OPEN) {
    sendSubscribe(newIds);
  } else {
    pendingSubscribes.push(...newIds);
  }
}

/** Unsubscribe a single token ID. */
export function unsubscribe(tokenId: string): void {
  subscribed.delete(tokenId);
  books.delete(tokenId);

  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "unsubscribe", assets_ids: [tokenId] }));
    } catch {
      // Ignore send errors
    }
  }
}

/** Health status for dashboard. */
export function getStatus(): { connected: boolean; lastUpdate: number } {
  let lastUpdate = 0;
  for (const b of books.values()) {
    if (b.lastUpdate > lastUpdate) lastUpdate = b.lastUpdate;
  }
  return { connected: ws?.readyState === WebSocket.OPEN, lastUpdate };
}

// ─── Internal: WebSocket ─────────────────────────────────────────────────────

function connect(): void {
  log.info("Connecting to Polymarket book WS...");
  ws = new WebSocket(URLS.polymarketWs);

  ws.on("open", () => {
    log.info("Book WS connected");
    reconnectAttempt = 0;

    // Subscribe to all tracked tokens
    const allIds = [...subscribed, ...pendingSubscribes];
    pendingSubscribes.length = 0;
    if (allIds.length > 0) sendSubscribe([...new Set(allIds)]);

    // Start keepalive
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send("PING");
      }
    }, KEEPALIVE_MS);
  });

  ws.on("message", (raw: WebSocket.Data) => {
    try {
      const text = raw.toString();
      if (text === "PONG") return;

      const msg = JSON.parse(text);
      handleBookMessage(msg);
    } catch {
      // Malformed message
    }
  });

  ws.on("error", (err: Error) => {
    log.error("Book WS error", err.message);
  });

  ws.on("close", () => {
    log.warn("Book WS closed");
    ws = null;
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (running) scheduleReconnect();
  });
}

function sendSubscribe(tokenIds: string[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    // Polymarket CLOB WS expects market subscription format
    ws.send(JSON.stringify({
      type: "subscribe",
      assets_ids: tokenIds,
    }));
    log.debug(`Subscribed to ${tokenIds.length} tokens`);
  } catch (err: any) {
    log.error("Subscribe send failed", err.message);
  }
}

function handleBookMessage(msg: any): void {
  // Book snapshot or update messages from Polymarket WS
  // Format varies — handle both snapshot and delta
  const assetId: string = msg.asset_id || msg.market || "";
  if (!assetId || !subscribed.has(assetId)) return;

  const now = Date.now();

  // Extract best bid/ask from the message
  let bestBid = 0;
  let bestAsk = 1;

  if (msg.bids && Array.isArray(msg.bids) && msg.bids.length > 0) {
    // Find best (highest) bid
    for (const b of msg.bids) {
      const p = parseFloat(b.price || b.p || "0");
      if (p > bestBid) bestBid = p;
    }
  }

  if (msg.asks && Array.isArray(msg.asks) && msg.asks.length > 0) {
    // Find best (lowest) ask
    for (const a of msg.asks) {
      const p = parseFloat(a.price || a.p || "1");
      if (p < bestAsk) bestAsk = p;
    }
  }

  // Only update if we got meaningful data
  if (bestBid > 0 || bestAsk < 1) {
    const existing = books.get(assetId);
    // Merge with existing for partial updates
    const bid = bestBid > 0 ? bestBid : (existing?.bid || 0);
    const ask = bestAsk < 1 ? bestAsk : (existing?.ask || 1);
    const mid = (bid + ask) / 2;
    const spread = ask - bid;

    books.set(assetId, { bid, ask, mid, spread, lastUpdate: now });
  }
}

function scheduleReconnect(): void {
  reconnectAttempt++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30_000);
  log.info(`Reconnecting book WS in ${delay}ms (attempt ${reconnectAttempt})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (running) connect();
  }, delay);
}

// ─── REST Fallback ───────────────────────────────────────────────────────────
// Polls REST for any subscribed tokens with stale book data.

async function restFallback(): Promise<void> {
  const now = Date.now();
  const staleTokens: string[] = [];

  for (const tid of subscribed) {
    const b = books.get(tid);
    if (!b || now - b.lastUpdate > STALE_THRESHOLD_MS) {
      staleTokens.push(tid);
    }
  }

  // Only fetch a few at a time to avoid hammering the API
  const batch = staleTokens.slice(0, 4);
  for (const tid of batch) {
    try {
      const res = await axios.get(`${URLS.clobApi}/book`, {
        params: { token_id: tid },
        timeout: 3000,
      });

      const data = res.data;
      let bestBid = 0;
      let bestAsk = 1;

      if (data.bids && data.bids.length > 0) {
        for (const b of data.bids) {
          const p = parseFloat(b.price || "0");
          if (p > bestBid) bestBid = p;
        }
      }
      if (data.asks && data.asks.length > 0) {
        for (const a of data.asks) {
          const p = parseFloat(a.price || "1");
          if (p < bestAsk) bestAsk = p;
        }
      }

      const mid = (bestBid + bestAsk) / 2;
      const spread = bestAsk - bestBid;
      books.set(tid, { bid: bestBid, ask: bestAsk, mid, spread, lastUpdate: Date.now() });
    } catch {
      // Skip this token
    }
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function start(): void {
  if (running) return;
  running = true;
  log.info("Starting order book feed");
  connect();
  restTimer = setInterval(restFallback, REST_FALLBACK_MS);
}

export function stop(): void {
  running = false;
  log.info("Stopping order book feed");
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
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
