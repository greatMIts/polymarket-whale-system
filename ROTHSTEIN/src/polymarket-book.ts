// ─── Layer 1: Polymarket Order Book ─────────────────────────────────────────
// Maintains live order books for all subscribed tokens via WS.
// REST fallback for empty/stale books. Rate-limited per token.
// Key lesson from spy v1: ONLY update book on messages with actual asks/bids arrays.

import WebSocket from "ws";
import axios from "axios";
import { BookState } from "./types";
import { CONFIG } from "./config";
import { logger } from "./logger";

// ─── State ──────────────────────────────────────────────────────────────────

const books = new Map<string, BookState>();
const subscribedTokens = new Set<string>();
const restFetchTimes = new Map<string, number>();

let ws: WebSocket | null = null;
let wsReady = false;
let pendingSubs: string[] = [];
let reconnectMs = 1000;
const MAX_RECONNECT_MS = 30_000;
let pingInterval: NodeJS.Timeout | null = null;

// ─── Public API ─────────────────────────────────────────────────────────────

export function getBook(tokenId: string): BookState | null {
  return books.get(tokenId) || null;
}

export function isBookFresh(tokenId: string, maxAgeMs?: number): boolean {
  const book = books.get(tokenId);
  if (!book || book.mid === 0) return false;
  return Date.now() - book.lastUpdate < (maxAgeMs || CONFIG.polyBookStaleMs);
}

export function getSubscribedCount(): number {
  return subscribedTokens.size;
}

export function isConnected(): boolean {
  return wsReady;
}

let lastWsMessage = 0;

export function getLastHeartbeat(): number {
  // Return the most recent WS message time (book update or any message)
  if (lastWsMessage > 0) return lastWsMessage;
  // Fallback: check book update times
  let latest = 0;
  for (const b of books.values()) {
    if (b.lastUpdate > latest) latest = b.lastUpdate;
  }
  return latest;
}

// ─── Subscribe ──────────────────────────────────────────────────────────────

export function subscribe(tokenIds: string[]): void {
  const newTokens = tokenIds.filter(t => !subscribedTokens.has(t));
  if (newTokens.length === 0) return;

  for (const t of newTokens) {
    subscribedTokens.add(t);
    // Initialize empty book
    if (!books.has(t)) {
      books.set(t, { bid: 0, ask: 0, mid: 0, spread: 0, lastUpdate: 0 });
    }
  }

  if (wsReady && ws) {
    sendSubscribe(newTokens);
  } else {
    pendingSubs.push(...newTokens);
  }

  logger.debug("polybook", `Subscribed ${newTokens.length} tokens (total: ${subscribedTokens.size})`);
}

/**
 * Unsubscribe a single token — removes from tracking sets and book map.
 * Called when contracts expire and are cleaned from the cache.
 */
export function unsubscribe(tokenId: string): void {
  subscribedTokens.delete(tokenId);
  books.delete(tokenId);
  restFetchTimes.delete(tokenId);
}

function sendSubscribe(tokenIds: string[]): void {
  if (!ws || !wsReady || tokenIds.length === 0) return;
  // Polymarket market channel: batch all token IDs in one message
  // No auth field (that's user channel only), no markets field
  try {
    ws.send(JSON.stringify({
      assets_ids: tokenIds,
      type: "market",
    }));
  } catch {}
}

// ─── Connection ─────────────────────────────────────────────────────────────

export function connect(): void {
  if (ws) {
    try { ws.terminate(); } catch {}
  }
  wsReady = false;

  ws = new WebSocket(CONFIG.polymarketWsUrl);

  ws.on("open", () => {
    wsReady = true;
    reconnectMs = 1000;
    lastWsMessage = Date.now();
    logger.info("polybook", "WS connected");

    // Polymarket requires application-level PING text every 10s (NOT WS protocol ping)
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && wsReady) {
        try { ws.send("PING"); } catch {}
      }
    }, 10_000);

    // Re-subscribe all known tokens in one batch
    const allTokens = [...subscribedTokens, ...pendingSubs];
    pendingSubs = [];
    if (allTokens.length > 0) {
      sendSubscribe(allTokens);
    }
  });

  ws.on("message", (raw) => {
    lastWsMessage = Date.now();
    try {
      const text = raw.toString();
      // Handle PONG heartbeat response
      if (text === "PONG") return;

      const msgs = JSON.parse(text);
      const arr = Array.isArray(msgs) ? msgs : [msgs];

      for (const msg of arr) {
        const tokenId = msg.asset_id;
        if (!tokenId) continue;

        // CRITICAL: Only update book if message contains actual book data.
        // Non-book messages (trades, etc.) must NOT zero out good data.
        const hasAsks = Array.isArray(msg.asks);
        const hasBids = Array.isArray(msg.bids);
        if (!hasAsks && !hasBids) continue;

        const existing = books.get(tokenId) || { bid: 0, ask: 0, mid: 0, spread: 0, lastUpdate: 0 };
        let bestAsk = existing.ask;
        let bestBid = existing.bid;

        if (hasAsks && msg.asks.length > 0) {
          const sorted = msg.asks.sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
          bestAsk = parseFloat(sorted[0].price);
        }
        if (hasBids && msg.bids.length > 0) {
          const sorted = msg.bids.sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
          bestBid = parseFloat(sorted[0].price);
        }

        const mid = (bestAsk > 0 && bestBid > 0) ? (bestAsk + bestBid) / 2 : 0;
        const spread = (bestAsk > 0 && bestBid > 0) ? bestAsk - bestBid : 0;

        books.set(tokenId, {
          bid: bestBid,
          ask: bestAsk,
          mid,
          spread,
          lastUpdate: Date.now(),
        });
      }
    } catch {}
  });

  ws.on("close", () => {
    wsReady = false;
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    logger.warn("polybook", `WS disconnected, reconnecting in ${reconnectMs}ms`);
    setTimeout(() => connect(), reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
  });

  ws.on("error", (e: Error) => {
    logger.error("polybook", `WS error: ${e.message}`);
  });
}

// ─── REST Book Fallback ─────────────────────────────────────────────────────

export async function fetchBookRest(tokenId: string): Promise<BookState> {
  // Rate-limit: don't re-fetch same token within 5s
  const lastFetch = restFetchTimes.get(tokenId) || 0;
  if (Date.now() - lastFetch < 5_000) {
    return books.get(tokenId) || { bid: 0, ask: 0, mid: 0, spread: 0, lastUpdate: 0 };
  }
  restFetchTimes.set(tokenId, Date.now());

  try {
    const { data } = await axios.get(`${CONFIG.clobApi}/book`, {
      params: { token_id: tokenId },
      timeout: 3000,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });

    const asks = (data.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bids = (data.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));

    const bestAsk = asks[0] ? parseFloat(asks[0].price) : 0;
    const bestBid = bids[0] ? parseFloat(bids[0].price) : 0;

    if (bestAsk > 0 || bestBid > 0) {
      const existing = books.get(tokenId) || { bid: 0, ask: 0, mid: 0, spread: 0, lastUpdate: 0 };
      const merged: BookState = {
        ask: bestAsk > 0 ? bestAsk : existing.ask,
        bid: bestBid > 0 ? bestBid : existing.bid,
        mid: 0,
        spread: 0,
        lastUpdate: Date.now(),
      };
      merged.mid = (merged.ask > 0 && merged.bid > 0) ? (merged.ask + merged.bid) / 2 : 0;
      merged.spread = (merged.ask > 0 && merged.bid > 0) ? merged.ask - merged.bid : 0;
      books.set(tokenId, merged);
      return merged;
    }
  } catch {}

  return books.get(tokenId) || { bid: 0, ask: 0, mid: 0, spread: 0, lastUpdate: 0 };
}

// Periodically refresh empty AND stale books via REST.
// For 5-minute binary options, book data must be fresh — WS may not send
// frequent updates for thin markets, causing the ask to get stuck at 0.50.
const STALE_BOOK_MS = 15_000;  // refresh any book not updated in 15s

export async function refreshEmptyBooks(): Promise<void> {
  const now = Date.now();
  const needsRefresh: string[] = [];

  for (const [tokenId, book] of books) {
    const isEmpty = book.ask === 0 || book.bid === 0;
    const isStale = (now - book.lastUpdate) > STALE_BOOK_MS;
    if (isEmpty || isStale) needsRefresh.push(tokenId);
  }
  if (needsRefresh.length === 0) return;

  const batch = needsRefresh.slice(0, 10);  // max 10 at a time
  let refreshed = 0;
  for (const tokenId of batch) {
    const book = await fetchBookRest(tokenId);
    if (book.ask > 0 && book.bid > 0) refreshed++;
    await new Promise(r => setTimeout(r, 200));  // rate limit
  }

  if (refreshed > 0) {
    logger.debug("polybook", `REST refreshed ${refreshed}/${batch.length} books (${needsRefresh.length} stale/empty total)`);
  }
}

export function disconnect(): void {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (ws) {
    try { ws.terminate(); } catch {}
    ws = null;
    wsReady = false;
  }
}
