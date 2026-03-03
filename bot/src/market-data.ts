/**
 * market-data.ts — Real-time price feeds and order book management.
 *
 * Connects to:
 * 1. Binance combined WS stream (BTC, ETH, SOL, XRP)
 * 2. Polymarket CLOB WS (order book per token)
 * 3. Polymarket REST book fallback
 * 4. Gamma API for contract metadata
 *
 * Reuses proven patterns from spy-server.ts — all bugs already fixed.
 */

import { WebSocket } from "ws";
import axios from "axios";
import { CONFIG, ASSET_MAP } from "./config";
import type { CachedContract } from "./types";

// ─── STATE ──────────────────────────────────────────────────────────────────

export const marketState = {
  // Per-asset price + history
  assetPrices: {
    BTCUSDT: { price: 0, history: [] as { ts: number; price: number }[] },
    ETHUSDT: { price: 0, history: [] as { ts: number; price: number }[] },
    SOLUSDT: { price: 0, history: [] as { ts: number; price: number }[] },
    XRPUSDT: { price: 0, history: [] as { ts: number; price: number }[] },
  } as Record<string, { price: number; history: { ts: number; price: number }[] }>,

  // Token-level order book: tokenId → {ask, bid}
  tokenBook: new Map<string, { ask: number; bid: number }>(),

  // Tokens subscribed on Polymarket WS
  subscribedTokens: new Set<string>(),

  // Contract cache: conditionId → contract metadata
  contractCache: new Map<string, CachedContract>(),

  // Asset (CLOB token ID) → contract info
  assetToContract: new Map<string, CachedContract>(),

  // Full order book levels: tokenId → { asks, bids } for depth calculation
  tokenBookLevels: new Map<string, { asks: { price: number; size: number }[]; bids: { price: number; size: number }[] }>(),
};

// ─── BINANCE COMBINED STREAM ────────────────────────────────────────────────

let binanceWs: WebSocket | null = null;
let lastBinanceUpdate = 0;       // ts of last received price message
let binanceConnected = false;     // WS currently open
let binanceReconnecting = false;  // prevents concurrent reconnect attempts
let binanceBackoffMs = 3000;     // current reconnect delay (exponential backoff)
let binanceConsecutiveFails = 0; // consecutive failed connection attempts

const BINANCE_BACKOFF_BASE = 3000;
const BINANCE_BACKOFF_MAX = 30000;
const BINANCE_COOLDOWN_MS = 60000;  // 60s cooldown after 10 consecutive failures
const BINANCE_MAX_CONSECUTIVE = 10;

export function getBinanceHealth(): { connected: boolean; lastUpdateMs: number; staleSec: number } {
  const staleSec = lastBinanceUpdate > 0 ? (Date.now() - lastBinanceUpdate) / 1000 : Infinity;
  return { connected: binanceConnected, lastUpdateMs: lastBinanceUpdate, staleSec };
}

/** Returns true if Binance data is stale (>30s since last update) */
export function isBinanceStale(): boolean {
  if (lastBinanceUpdate === 0) return true;
  return (Date.now() - lastBinanceUpdate) > 30_000;
}

async function scheduleBinanceReconnect() {
  if (binanceReconnecting) return; // already reconnecting — skip
  binanceReconnecting = true;

  binanceConsecutiveFails++;

  let delay: number;
  if (binanceConsecutiveFails >= BINANCE_MAX_CONSECUTIVE) {
    delay = BINANCE_COOLDOWN_MS;
    console.error(`[binance] ${binanceConsecutiveFails} consecutive failures — will retry in 60s`);
    binanceConsecutiveFails = 0; // reset so we get another 10 attempts after cooldown
  } else {
    delay = Math.min(BINANCE_BACKOFF_BASE * Math.pow(2, binanceConsecutiveFails - 1), BINANCE_BACKOFF_MAX);
    console.log(`[binance] reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${binanceConsecutiveFails})...`);
  }

  await new Promise(r => setTimeout(r, delay));
  binanceReconnecting = false;
  connectBinance();
}

export function connectBinance() {
  if (binanceReconnecting) return;

  if (binanceWs) {
    try { binanceWs.terminate(); } catch {}
  }
  binanceWs = null;
  binanceConnected = false;

  const ws = new WebSocket(CONFIG.binanceWsUrl);

  ws.on("open", () => {
    binanceConnected = true;
    binanceConsecutiveFails = 0; // reset on successful connection
    lastBinanceUpdate = Date.now();
    console.log("[binance] WS connected");
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const d = msg.data || msg;
      const price = parseFloat(d.p);
      if (!price) return;

      lastBinanceUpdate = Date.now();

      const symbol = msg.stream ? msg.stream.split("@")[0].toUpperCase() : "BTCUSDT";
      const now = lastBinanceUpdate;
      const bucket = marketState.assetPrices[symbol];
      if (bucket) {
        bucket.price = price;
        bucket.history.push({ ts: now, price });
        // Trim to last 10 minutes
        const cutoff = now - 600_000;
        bucket.history = bucket.history.filter(p => p.ts > cutoff);
      }
    } catch {}
  });

  // Respond to server pings (keeps connection alive)
  ws.on("ping", () => {
    try { ws.pong(); } catch {}
  });

  ws.on("close", (code, reason) => {
    binanceConnected = false;
    const reasonStr = reason ? reason.toString() : "";
    console.error(`[binance] WS closed: code=${code}${reasonStr ? `, reason=${reasonStr}` : ""}`);
    scheduleBinanceReconnect();
  });

  ws.on("error", (e) => {
    binanceConnected = false;
    console.error("[binance] WS error:", e.message);
    try { ws.terminate(); } catch {}
    // If WS is blocked (e.g. US servers), fall back to REST polling
    if (!restPriceFallbackActive) startRestPriceFallback();
    // Don't schedule here — the close event will fire after error and handle reconnect
  });

  binanceWs = ws;
  console.log("[binance] WS connecting (BTC + ETH + SOL + XRP)");
}

// Staleness watchdog — check every 30 seconds, force reconnect if stale >30s
let binanceWatchdogInterval: ReturnType<typeof setInterval> | null = null;

export function startBinanceWatchdog() {
  if (binanceWatchdogInterval) return;
  binanceWatchdogInterval = setInterval(() => {
    if (lastBinanceUpdate === 0) return; // haven't connected yet
    if (binanceReconnecting) return; // already handling it
    const staleSec = (Date.now() - lastBinanceUpdate) / 1000;
    if (staleSec > 30) {
      console.error(`[binance] STALE for ${staleSec.toFixed(0)}s — forcing reconnect`);
      if (binanceWs) {
        try { binanceWs.terminate(); } catch {}
      }
      // terminate will trigger close event → scheduleBinanceReconnect
    }
  }, 30_000);
}

// ─── PER-ASSET VOLATILITY BUFFERS (rolling 1h of 30s delta samples) ─────────

const VOL_DELTA_BUFFER_SIZE = 120; // 120 × 30s = 1 hour
const volDeltaBuffers: Record<string, number[]> = {};

export function getVol1h(symbol: string): number {
  const buf = volDeltaBuffers[symbol];
  if (!buf || buf.length < 10) return -1; // not enough data yet
  const mean = buf.reduce((a, b) => a + b, 0) / buf.length;
  const variance = buf.reduce((a, b) => a + (b - mean) ** 2, 0) / buf.length;
  return Math.sqrt(variance);
}

/** @deprecated Use getVol1h("BTCUSDT") instead */
export function getBtcVol1h(): number {
  return getVol1h("BTCUSDT");
}

export function startVolSamplers() {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];
  for (const sym of symbols) {
    volDeltaBuffers[sym] = [];
  }
  setInterval(() => {
    for (const sym of symbols) {
      const delta = getPriceDelta(sym, 30);
      if (marketState.assetPrices[sym]?.price > 0) {
        if (!volDeltaBuffers[sym]) volDeltaBuffers[sym] = [];
        volDeltaBuffers[sym].push(delta);
        if (volDeltaBuffers[sym].length > VOL_DELTA_BUFFER_SIZE) volDeltaBuffers[sym].shift();
      }
    }
  }, 30_000);
  console.log(`[vol] Vol samplers initialized for: ${symbols.map(s => s.replace("USDT", "")).join(", ")}`);
}

/** @deprecated Use startVolSamplers() instead */
export function startBtcVolSampler() {
  startVolSamplers();
}

// ─── ORDER BOOK DEPTH ──────────────────────────────────────────────────────

export function getOrderBookDepth(tokenId: string): number {
  const book = marketState.tokenBook.get(tokenId);
  if (!book || book.ask === 0 || book.bid === 0) return -1;
  const mid = (book.ask + book.bid) / 2;
  if (mid === 0) return -1;

  const levels = marketState.tokenBookLevels.get(tokenId);
  if (!levels || (levels.asks.length === 0 && levels.bids.length === 0)) return -1;

  let totalUsdc = 0;
  for (const bid of levels.bids) {
    if (bid.price >= mid - 0.05) totalUsdc += bid.size * bid.price;
  }
  for (const ask of levels.asks) {
    if (ask.price <= mid + 0.05) totalUsdc += ask.size * ask.price;
  }
  return totalUsdc;
}

// ─── REST PRICE FALLBACK (for when Binance WS is blocked, e.g. US servers) ──

let restPriceFallbackActive = false;

function updatePrice(symbol: string, price: number) {
  const now = Date.now();
  const bucket = marketState.assetPrices[symbol];
  if (bucket) {
    bucket.price = price;
    bucket.history.push({ ts: now, price });
    const cutoff = now - 600_000;
    bucket.history = bucket.history.filter(p => p.ts > cutoff);
  }
}

async function pollPricesViaRest() {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];
  try {
    // Binance REST API works globally (even where WS is blocked)
    const { data } = await axios.get("https://api.binance.com/api/v3/ticker/price", {
      params: { symbols: JSON.stringify(symbols) },
      timeout: 5000,
    });
    if (Array.isArray(data)) {
      for (const item of data) {
        const price = parseFloat(item.price);
        if (price > 0 && item.symbol) {
          updatePrice(item.symbol, price);
        }
      }
    }
  } catch {
    // Try binance.us as second fallback
    try {
      for (const sym of symbols) {
        const { data } = await axios.get(`https://api.binance.us/api/v3/ticker/price`, {
          params: { symbol: sym },
          timeout: 3000,
        });
        const price = parseFloat(data.price);
        if (price > 0) updatePrice(sym, price);
      }
    } catch (e: any) {
      console.error("[price-rest] Both Binance endpoints failed:", e.message);
    }
  }
}

export function startRestPriceFallback() {
  if (restPriceFallbackActive) return;
  restPriceFallbackActive = true;
  console.log("[price-rest] Binance WS unavailable — switching to REST polling (every 3s)");
  // Poll immediately, then every 3s
  pollPricesViaRest();
  setInterval(pollPricesViaRest, 3000);
}

// ─── PRICE HELPERS ──────────────────────────────────────────────────────────

export function getPrice(symbol: string): number {
  return marketState.assetPrices[symbol]?.price || 0;
}

export function getPriceDelta(symbol: string, seconds: number): number {
  const bucket = marketState.assetPrices[symbol];
  if (!bucket || bucket.price === 0) return 0;
  const cutoff = Date.now() - seconds * 1000;
  const old = bucket.history.findLast(p => p.ts <= cutoff);
  if (!old || old.price === 0) return 0;
  return ((bucket.price - old.price) / old.price) * 100;
}

export function getAssetDirection(symbol: string): "UP" | "DOWN" | "FLAT" {
  const delta = getPriceDelta(symbol, 30);
  if (delta > 0.02) return "UP";
  if (delta < -0.02) return "DOWN";
  return "FLAT";
}

/** @deprecated Use getAssetDirection("BTCUSDT") instead */
export function getBtcDirection(): "UP" | "DOWN" | "FLAT" {
  return getAssetDirection("BTCUSDT");
}

// ─── REALIZED VOLATILITY ────────────────────────────────────────────────────
// Rolling 5-min lookback, 5s resampling, annualized, clamped [20%, 200%]

export function computeRealizedVolatility(symbol: string): number | null {
  const now = Date.now();
  const lookbackMs = 300_000;
  const sampleMs = 5_000;

  const history = marketState.assetPrices[symbol]?.history || [];
  const samples: number[] = [];
  for (let t = now - lookbackMs; t <= now; t += sampleMs) {
    const tick = history.findLast(p => p.ts <= t);
    if (tick) samples.push(tick.price);
  }

  if (samples.length < 20) return null;

  const logReturns: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] > 0) {
      logReturns.push(Math.log(samples[i] / samples[i - 1]));
    }
  }
  if (logReturns.length < 10) return null;

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  const periodsPerYear = (365.25 * 24 * 3600 * 1000) / sampleMs;
  const annualized = stdDev * Math.sqrt(periodsPerYear);

  return Math.min(2.0, Math.max(0.20, annualized));
}

// ─── BLACK-SCHOLES BINARY PRICING ───────────────────────────────────────────

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
}

export function computeBinaryFairValue(
  currentPrice: number,
  strikePrice: number,
  secondsRemaining: number,
  annualizedVol: number,
  direction: "UP" | "DOWN"
): number {
  const T = secondsRemaining / (365.25 * 24 * 3600);
  if (T < 1e-10 || secondsRemaining < 1) {
    const pUp = currentPrice > strikePrice ? 0.99 : currentPrice < strikePrice ? 0.01 : 0.50;
    return direction === "UP" ? pUp : 1 - pUp;
  }
  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(currentPrice / strikePrice) - (annualizedVol ** 2 / 2) * T) / (annualizedVol * sqrtT);
  let pUp = normalCDF(d2);
  pUp = Math.min(0.99, Math.max(0.01, pUp));
  return direction === "UP" ? pUp : 1 - pUp;
}

// ─── POLYMARKET ORDER BOOK WS ───────────────────────────────────────────────

let polyWs: WebSocket | null = null;
let polyWsReady = false;
let pendingSubscriptions: string[] = [];

export function connectPolymarketWs() {
  if (polyWs) polyWs.terminate();
  polyWsReady = false;

  polyWs = new WebSocket(CONFIG.polymarketWsUrl);

  polyWs.on("open", () => {
    polyWsReady = true;
    console.log("[polymarket] WS connected");

    // Re-subscribe all known tokens
    if (marketState.subscribedTokens.size > 0) {
      const allTokens = [...marketState.subscribedTokens];
      marketState.subscribedTokens.clear();
      subscribeTokens(allTokens);
    }

    if (pendingSubscriptions.length > 0) {
      const pending = [...pendingSubscriptions];
      pendingSubscriptions = [];
      subscribeTokens(pending);
    }
  });

  polyWs.on("message", (raw) => {
    try {
      const msgs = JSON.parse(raw.toString());
      const arr = Array.isArray(msgs) ? msgs : [msgs];

      for (const msg of arr) {
        const tokenId = msg.asset_id;
        if (!tokenId) continue;

        // IMPORTANT: Only update book if message contains book data.
        // Non-book messages don't have asks/bids — don't zero out good data.
        const hasAsks = Array.isArray(msg.asks);
        const hasBids = Array.isArray(msg.bids);
        if (!hasAsks && !hasBids) continue;

        const existing = marketState.tokenBook.get(tokenId) || { ask: 0, bid: 0 };
        let bestAsk = existing.ask;
        let bestBid = existing.bid;
        const existingLevels = marketState.tokenBookLevels.get(tokenId) || { asks: [], bids: [] };

        if (hasAsks && msg.asks.length > 0) {
          const asks = msg.asks.sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
          bestAsk = parseFloat(asks[0].price);
          existingLevels.asks = asks.map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));
        }
        if (hasBids && msg.bids.length > 0) {
          const bids = msg.bids.sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
          bestBid = parseFloat(bids[0].price);
          existingLevels.bids = bids.map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
        }

        marketState.tokenBook.set(tokenId, { ask: bestAsk, bid: bestBid });
        marketState.tokenBookLevels.set(tokenId, existingLevels);
      }
    } catch {}
  });

  polyWs.on("close", () => {
    polyWsReady = false;
    console.log("[polymarket] disconnected, reconnecting in 5s");
    setTimeout(connectPolymarketWs, 5000);
  });

  polyWs.on("error", (e) => console.error("[polymarket] error:", e.message));
}

export function subscribeTokens(tokenIds: string[]) {
  const newTokens = tokenIds.filter(id => id && !marketState.subscribedTokens.has(id));
  if (newTokens.length === 0) return;

  if (!polyWs || !polyWsReady) {
    pendingSubscriptions.push(...newTokens);
    return;
  }

  polyWs.send(JSON.stringify({ type: "market", assets_ids: newTokens }));

  for (const id of newTokens) {
    marketState.subscribedTokens.add(id);
    if (!marketState.tokenBook.has(id)) {
      marketState.tokenBook.set(id, { ask: 0, bid: 0 });
    }
  }

  console.log(`[polymarket] subscribed ${newTokens.length} token(s) (total: ${marketState.subscribedTokens.size})`);
}

// ─── REST BOOK FALLBACK ─────────────────────────────────────────────────────

const restBookFetchTimes = new Map<string, number>();

export async function fetchBookFromRest(tokenId: string): Promise<{ ask: number; bid: number }> {
  const lastFetch = restBookFetchTimes.get(tokenId) || 0;
  if (Date.now() - lastFetch < 10_000) {
    return marketState.tokenBook.get(tokenId) || { ask: 0, bid: 0 };
  }
  restBookFetchTimes.set(tokenId, Date.now());

  try {
    const { data } = await axios.get("https://clob.polymarket.com/book", {
      params: { token_id: tokenId },
      timeout: 3000,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });

    const asks = (data.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bids = (data.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const bestAsk = asks[0] ? parseFloat(asks[0].price) : 0;
    const bestBid = bids[0] ? parseFloat(bids[0].price) : 0;

    if (bestAsk > 0 || bestBid > 0) {
      const existing = marketState.tokenBook.get(tokenId) || { ask: 0, bid: 0 };
      const merged = {
        ask: bestAsk > 0 ? bestAsk : existing.ask,
        bid: bestBid > 0 ? bestBid : existing.bid,
      };
      marketState.tokenBook.set(tokenId, merged);
      // Store full levels for depth calculation
      marketState.tokenBookLevels.set(tokenId, {
        asks: asks.map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
        bids: bids.map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
      });
      return merged;
    }
  } catch {}

  return marketState.tokenBook.get(tokenId) || { ask: 0, bid: 0 };
}

export async function refreshEmptyBooks() {
  const emptyTokens: string[] = [];
  for (const [tokenId, book] of marketState.tokenBook) {
    if (book.ask === 0 || book.bid === 0) emptyTokens.push(tokenId);
  }
  if (emptyTokens.length === 0) return;

  const batch = emptyTokens.slice(0, 10);
  let filled = 0;
  for (const tokenId of batch) {
    const book = await fetchBookFromRest(tokenId);
    if (book.ask > 0 && book.bid > 0) filled++;
    await new Promise(r => setTimeout(r, 200));
  }
  if (filled > 0) {
    console.log(`[book-refresh] Filled ${filled}/${batch.length} empty books via REST`);
  }
}

// ─── CONTRACT CACHE (Gamma API) ─────────────────────────────────────────────

function parseWindowStartTs(title: string, endTs: number): { windowStartTs: number; durationMs: number } {
  if (!endTs) return { windowStartTs: 0, durationMs: 0 };

  function parseTimeToMins(hourStr: string, minStr: string | null, ampm: string): number {
    let h = parseInt(hourStr);
    const m = minStr ? parseInt(minStr) : 0;
    if (ampm.toUpperCase() === "PM" && h !== 12) h += 12;
    if (ampm.toUpperCase() === "AM" && h === 12) h = 0;
    return h * 60 + m;
  }

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

  const hourlyMatch = title.match(/(\d{1,2})\s*(AM|PM)\s+(ET|EST|EDT)/i);
  if (hourlyMatch) {
    const durationMs = 3_600_000;
    return { windowStartTs: endTs - durationMs, durationMs };
  }

  return { windowStartTs: 0, durationMs: 0 };
}

const strikePriceCache = new Map<string, number>();

async function getStrikePrice(windowStartTs: number, symbol: string): Promise<number | null> {
  if (!windowStartTs || windowStartTs <= 0) return null;

  const cacheKey = `${symbol}_${windowStartTs}`;
  const cached = strikePriceCache.get(cacheKey);
  if (cached) return cached;

  // Check tick history
  const history = marketState.assetPrices[symbol]?.history || [];
  const tick = history.find(p => Math.abs(p.ts - windowStartTs) < 3000);
  if (tick) {
    strikePriceCache.set(cacheKey, tick.price);
    return tick.price;
  }

  // Binance kline REST fallback
  try {
    const { data } = await axios.get("https://api.binance.com/api/v3/klines", {
      params: { symbol, interval: "1m", startTime: windowStartTs, limit: 1 },
      timeout: 5000,
    });
    if (data && data.length > 0) {
      const openPrice = parseFloat(data[0][1]);
      strikePriceCache.set(cacheKey, openPrice);
      return openPrice;
    }
  } catch {}

  return null;
}

export async function getContractForAsset(asset: string): Promise<CachedContract | null> {
  if (!asset) return null;

  const cached = marketState.assetToContract.get(asset);
  if (cached && Date.now() - cached.fetchedAt < 300_000) return cached;

  try {
    const { data } = await axios.get(`${CONFIG.gammaApi}/markets`, {
      params: { clob_token_ids: asset },
      timeout: 5000,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });

    const markets = Array.isArray(data) ? data : data.markets ?? [];
    const market = markets[0];
    if (!market) return null;

    let rawTokenIds = market.clobTokenIds || [];
    if (typeof rawTokenIds === "string") {
      try { rawTokenIds = JSON.parse(rawTokenIds); } catch { rawTokenIds = []; }
    }
    const tokenIds: string[] = Array.isArray(rawTokenIds)
      ? rawTokenIds.filter((id: any) => typeof id === "string" && id.length > 0)
      : [];

    const conditionId = market.conditionId || "";
    const title = market.question || market.title || "";
    const endTs = market.endDate ? new Date(market.endDate).getTime() : 0;
    const startTs = market.startDate ? new Date(market.startDate).getTime() : 0;
    const { windowStartTs, durationMs } = parseWindowStartTs(title, endTs);

    let binanceSymbol = "";
    const titleLower = title.toLowerCase();
    for (const [keyword, sym] of Object.entries(ASSET_MAP)) {
      if (titleLower.includes(keyword)) { binanceSymbol = sym; break; }
    }

    let strikePrice: number | null = null;
    if (binanceSymbol && windowStartTs > 0) {
      strikePrice = await getStrikePrice(windowStartTs, binanceSymbol);
    }

    const negRisk = !!market.negRisk;

    const contract: CachedContract = {
      conditionId, title, startTs, endTs, windowStartTs, durationMs,
      clobTokenIds: tokenIds, fetchedAt: Date.now(), binanceSymbol, strikePrice, negRisk,
    };

    marketState.contractCache.set(conditionId, contract);
    for (const tid of tokenIds) marketState.assetToContract.set(tid, contract);
    marketState.assetToContract.set(asset, contract);

    if (tokenIds.length > 0) subscribeTokens(tokenIds);
    return contract;
  } catch (e: any) {
    console.error(`[gamma] Failed for asset ${asset.slice(0, 16)}…:`, e.message);
    return null;
  }
}

// ─── PROACTIVE CONTRACT SCAN ────────────────────────────────────────────────

export async function proactiveContractScan() {
  const keywords = ["Bitcoin", "Ethereum", "Solana", "XRP"];
  let newContracts = 0;

  for (const keyword of keywords) {
    try {
      const { data } = await axios.get(`${CONFIG.gammaApi}/events`, {
        params: { closed: false, limit: 5, tag: keyword },
        timeout: 8000,
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      });

      const events = Array.isArray(data) ? data : [];
      const markets: any[] = [];
      for (const ev of events) {
        const title = ev.title || ev.question || "";
        if (!/up or down/i.test(title)) continue;
        for (const m of (ev.markets || [])) markets.push(m);
      }

      for (const m of markets) {
        const conditionId = m.conditionId || "";
        if (!conditionId) continue;

        const existing = marketState.contractCache.get(conditionId);
        if (existing && Date.now() - existing.fetchedAt < 300_000) continue;

        let rawTokenIds = m.clobTokenIds || [];
        if (typeof rawTokenIds === "string") {
          try { rawTokenIds = JSON.parse(rawTokenIds); } catch { rawTokenIds = []; }
        }
        const tokenIds: string[] = Array.isArray(rawTokenIds)
          ? rawTokenIds.filter((id: any) => typeof id === "string" && id.length > 0)
          : [];
        if (tokenIds.length === 0) continue;

        const title = m.question || m.title || "";
        const endTs = m.endDate ? new Date(m.endDate).getTime() : 0;
        const startTs = m.startDate ? new Date(m.startDate).getTime() : 0;
        if (endTs > 0 && endTs < Date.now()) continue;

        const { windowStartTs, durationMs } = parseWindowStartTs(title, endTs);

        let binanceSymbol = "";
        const titleLower = title.toLowerCase();
        for (const [kw, sym] of Object.entries(ASSET_MAP)) {
          if (titleLower.includes(kw)) { binanceSymbol = sym; break; }
        }

        let strikePrice: number | null = null;
        if (binanceSymbol && windowStartTs > 0) {
          strikePrice = await getStrikePrice(windowStartTs, binanceSymbol);
        }

        const negRisk = !!m.negRisk;

        const contract: CachedContract = {
          conditionId, title, startTs, endTs, windowStartTs, durationMs,
          clobTokenIds: tokenIds, fetchedAt: Date.now(), binanceSymbol, strikePrice, negRisk,
        };

        marketState.contractCache.set(conditionId, contract);
        for (const tid of tokenIds) marketState.assetToContract.set(tid, contract);
        subscribeTokens(tokenIds);
        newContracts++;
      }
    } catch {}
  }

  if (newContracts > 0) {
    console.log(`[proactive] Pre-subscribed ${newContracts} contract(s), tokens: ${marketState.subscribedTokens.size}`);
  }
}

// ─── RESOLUTION TRACKING ────────────────────────────────────────────────────

export const resolutionCache = new Map<string, string | null>();

export async function checkResolutions() {
  const now = Date.now();
  let newResolutions = 0;

  for (const [condId, contract] of marketState.contractCache) {
    if (resolutionCache.has(condId) && resolutionCache.get(condId) !== null) continue;
    if (contract.endTs === 0 || now < contract.endTs + 60_000) continue;
    if (contract.clobTokenIds.length === 0) continue;

    try {
      const { data } = await axios.get(`${CONFIG.gammaApi}/markets`, {
        params: { clob_token_ids: contract.clobTokenIds[0] },
        timeout: 5000,
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      });

      const markets = Array.isArray(data) ? data : [];
      const m = markets[0];
      if (!m) continue;

      let outcomes: string[] = [];
      let prices: string[] = [];
      try {
        outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes || [];
        prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices || [];
      } catch { continue; }

      // Exact "1" price
      const winIdx = prices.indexOf("1");
      if (winIdx >= 0 && outcomes[winIdx]) {
        resolutionCache.set(condId, outcomes[winIdx]);
        newResolutions++;
        continue;
      }

      // High-confidence: price > 0.95 (don't require m.closed)
      const maxPrice = Math.max(...prices.map(Number));
      if (maxPrice > 0.95) {
        const idx = prices.findIndex((p: string) => Number(p) > 0.95);
        if (idx >= 0 && outcomes[idx]) {
          resolutionCache.set(condId, outcomes[idx]);
          newResolutions++;
        }
      }
    } catch {}
  }

  if (newResolutions > 0) {
    console.log(`[resolution] ${newResolutions} new, total: ${resolutionCache.size}`);
  }
}
