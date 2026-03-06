/**
 * spy-server.ts
 * Standalone server that records whale activity cross-referenced with
 * BTC Binance price and Polymarket order book in real time.
 *
 * Run: npx ts-node spy-server.ts
 * Dashboard: http://localhost:3333
 *
 * Records to: spy-data/events.jsonl (survives restarts)
 */

import express from "express";
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const WALLETS = [
  { address: "0x63ce342161250d705dc0b16df89036c8e5f9ba9a", label: "0x63ce", monitorOnly: false },
  { address: "0x1d0034134e339a309700ff2d34e99fa2d48b0313", label: "0x1d00", monitorOnly: false },
  { address: "0x1979ae6b7e6534de9c4539d0c205e582ca637c9d", label: "0x1979", monitorOnly: false },
  { address: "0x37c94ea1b44e01b18a1ce3ab6f8002bd6b9d7e6d", label: "0x37c9", monitorOnly: false },
  { address: "0xf6963d4cdbb6f26d753bda303e9513132afb1b7d", label: "0xf696", monitorOnly: false },
  { address: "0x571c285a83eba5322b5f916ba681669dc368a61f", label: "0x571c", monitorOnly: false },
  { address: "0x0ea574f3204c5c9c0cdead90392ea0990f4d17e4", label: "0x0ea5", monitorOnly: false },
  { address: "0xa9ae84ee529dbec0c6634b08cd97d3f13f7d74f5", label: "0xa9ae", monitorOnly: true },
  { address: "0x2d8b401d2f0e6937afebf18e19e11ca568a5260a", label: "0x2d8b", monitorOnly: false },
  { address: "0xd7e71e9b1c9d5e428e94906660c5a94537e51150", label: "0xd7e7", monitorOnly: false },
  { address: "0x113d4c0b5a6702ab045ea2cba7c3f71d51fc3ce8", label: "0x113d", monitorOnly: false },
  { address: "0xe594336603f4fb5d3ba4125a67021ab3b4347052", label: "0xe594", monitorOnly: false },
];

const CONFIG = {
  port: parseInt(process.env.PORT || "3333"),
  wallets: WALLETS,
  pollIntervalMs: 3000,          // poll each whale every 3s (staggered)
  dataDir: "./spy-data",
  archiveDir: "./spy-data/archives",
  eventsFile: "./spy-data/events.jsonl",
  maxEventsInMemory: 5000,
  rotationMaxLines: 70_000,
  rotationMaxArchives: 20,
  // Combined stream for BTC, ETH, SOL, XRP
  binanceWsUrl: "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade/solusdt@trade/xrpusdt@trade",
  polymarketWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  gammaApi: "https://gamma-api.polymarket.com",
  dataApi: "https://data-api.polymarket.com",
};

// ─── TYPES ────────────────────────────────────────────────────────────────────

type EventType = "WHALE_TRADE" | "BTC_TICK" | "ORDERBOOK_SNAP" | "CONTRACT_CHANGE" | "PATTERN_DETECTED";

interface BaseEvent {
  id: string;
  type: EventType;
  ts: number;          // unix ms
  tsIso: string;
}

interface WhaleTrade extends BaseEvent {
  type: "WHALE_TRADE";
  wallet: string;        // full wallet address
  walletLabel: string;   // short label e.g. "0x63ce"
  side: "BUY" | "SELL";
  outcome: string;      // "Up" | "Down"
  price: number;
  usdcSize: number;
  shares: number;
  conditionId: string;
  title: string;
  txHash: string;
  asset: string;        // token ID the whale actually traded
  // Enriched at record time:
  spotPrice: number;             // asset price at trade time (BTC/ETH/SOL/XRP)
  delta30s: number;              // % asset moved in last 30s
  delta5m: number;               // % asset moved in last 5m
  priceDirection: "UP" | "DOWN" | "FLAT";
  secondsRemainingInContract: number;  // seconds until contract resolves, -1 if unknown
  edgeVsSpot: number | null;    // null when price history insufficient
  polyMid: number;               // order book mid price at trade time (0 if no book data)
  // Computed columns (for CSV analysis — avoid re-deriving from title):
  assetLabel: string;            // "BTC", "ETH", "SOL", "XRP"
  contractDurationMinutes: number; // 5, 15, 60
  momentumAligned: boolean;      // whale bet direction matches 30s asset direction
  sessionLabel: string;       // "ASIA", "EUROPE", "US", "LATE_US"
  concurrentWhales: number;   // distinct wallets on same conditionId in last 60s
}

interface BtcTick extends BaseEvent {
  type: "BTC_TICK";
  price: number;
  delta1s: number;
  delta30s: number;
  delta5m: number;
  direction: "UP" | "DOWN" | "FLAT";
}

interface OrderbookSnap extends BaseEvent {
  type: "ORDERBOOK_SNAP";
  contractId: string;
  upAsk: number;
  upBid: number;
  downAsk: number;
  downBid: number;
  upMid: number;
  downMid: number;
}

interface PatternDetected extends BaseEvent {
  type: "PATTERN_DETECTED";
  pattern: string;
  confidence: number;
  description: string;
  tradeId: string;
}

type Event = WhaleTrade | BtcTick | OrderbookSnap | PatternDetected;

interface CachedContract {
  conditionId: string;
  title: string;
  startTs: number;           // market creation timestamp (from Gamma)
  endTs: number;              // window end timestamp (from Gamma)
  windowStartTs: number;      // actual window start (parsed from title)
  durationMs: number;         // window duration in ms
  clobTokenIds: string[];     // [upTokenId, downTokenId]
  fetchedAt: number;
  isBtcContract: boolean;     // true if title contains "Bitcoin"
  binanceSymbol: string;      // e.g. "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "" if unknown
  strikePrice: number | null; // underlying price at window start (null if unknown)
  assetLabel: string;         // "BTC", "ETH", "SOL", "XRP", "" if unknown
  contractDurationMinutes: number; // 5, 15, 60, 0 if unknown
}

// ─── STATE ────────────────────────────────────────────────────────────────────

// Asset symbol mapping: Polymarket title keyword → Binance symbol
const ASSET_MAP: Record<string, string> = {
  bitcoin: "BTCUSDT",
  ethereum: "ETHUSDT",
  solana: "SOLUSDT",
  xrp: "XRPUSDT",
};

// Reverse map: "BTCUSDT" → "BTC" for display labels
const SYMBOL_TO_LABEL: Record<string, string> = {
  BTCUSDT: "BTC",
  ETHUSDT: "ETH",
  SOLUSDT: "SOL",
  XRPUSDT: "XRP",
};

// Reverse map: "BTC" → "BTCUSDT" for spotPrice/delta resolution when binanceSymbol is empty
const LABEL_TO_SYMBOL: Record<string, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  XRP: "XRPUSDT",
};

/** Derive assetLabel from binanceSymbol or title */
function deriveAssetLabel(binanceSymbol: string, title: string): string {
  if (binanceSymbol && SYMBOL_TO_LABEL[binanceSymbol]) return SYMBOL_TO_LABEL[binanceSymbol];
  const tl = title.toLowerCase();
  if (tl.includes("bitcoin")) return "BTC";
  if (tl.includes("ethereum")) return "ETH";
  if (tl.includes("solana")) return "SOL";
  if (tl.includes("xrp")) return "XRP";
  return "";
}

/** Derive contract duration in minutes from durationMs */
function deriveDurationMinutes(durationMs: number): number {
  if (durationMs <= 0) return 0;
  const mins = Math.round(durationMs / 60_000);
  // Canonical durations: 5, 15, 60
  if (mins >= 3 && mins <= 7) return 5;
  if (mins >= 12 && mins <= 18) return 15;
  if (mins >= 50 && mins <= 70) return 60;
  return mins; // non-standard
}

/** Session label from UTC hour */
function getSessionLabel(ts: number): string {
  const hour = new Date(ts).getUTCHours();
  if (hour >= 0 && hour < 8) return "ASIA";
  if (hour >= 8 && hour < 14) return "EUROPE";
  if (hour >= 14 && hour < 21) return "US";
  return "LATE_US";
}

// ─── CONCURRENT WHALES TRACKER ────────────────────────────────────────────
// Tracks wallets that traded the same conditionId within the last 60s

const concurrentWhaleTracker = new Map<string, { wallet: string; ts: number }[]>();

function recordConcurrentWhale(conditionId: string, wallet: string, ts: number) {
  const entries = concurrentWhaleTracker.get(conditionId) || [];
  entries.push({ wallet, ts });
  concurrentWhaleTracker.set(conditionId, entries);
}

function getConcurrentWhales(conditionId: string, ts: number): number {
  const entries = concurrentWhaleTracker.get(conditionId) || [];
  const cutoff = ts - 60_000;
  // Filter to entries within last 60s, then count distinct wallets
  const recent = entries.filter(e => e.ts >= cutoff);
  // Clean up old entries while we're here
  concurrentWhaleTracker.set(conditionId, recent);
  const wallets = new Set(recent.map(e => e.wallet));
  return wallets.size;
}

const state = {
  events: [] as Event[],
  btcPrice: 0,
  btcPriceHistory: [] as { ts: number; price: number }[],   // last 10 min
  // Multi-asset price tracking: symbol → { price, history }
  assetPrices: {
    BTCUSDT:  { price: 0, history: [] as { ts: number; price: number }[] },
    ETHUSDT:  { price: 0, history: [] as { ts: number; price: number }[] },
    SOLUSDT:  { price: 0, history: [] as { ts: number; price: number }[] },
    XRPUSDT:  { price: 0, history: [] as { ts: number; price: number }[] },
  } as Record<string, { price: number; history: { ts: number; price: number }[] }>,
  lastWhaleTxHash: new Set<string>(),
  whaleTrades: [] as WhaleTrade[],

  // Contract cache: conditionId → contract metadata (from Gamma API)
  contractCache: new Map<string, CachedContract>(),

  // Token-level order book: tokenId → {ask, bid}
  tokenBook: new Map<string, { ask: number; bid: number }>(),

  // Tokens we've already subscribed to on the Polymarket WS
  subscribedTokens: new Set<string>(),

  // Most recent contract the whale traded (for dashboard display)
  latestContract: null as CachedContract | null,

  // Resolution cache: conditionId → "Up" | "Down" | null (pending)
  resolutionCache: new Map<string, string | null>(),

  stats: {
    totalWhaleTrades: 0,
    buyCount: 0,
    sellCount: 0,
    upCount: 0,
    downCount: 0,
    avgBuyPrice: 0,
    avgSellPrice: 0,
    avgEdge: 0,
    patternsDetected: 0,
  },
};

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────

fs.mkdirSync(CONFIG.dataDir, { recursive: true });

let eventsAppendCount = 0;

function appendEvent(event: Event) {
  state.events.push(event);
  if (state.events.length > CONFIG.maxEventsInMemory) state.events.shift();

  // Persist to JSONL
  fs.appendFileSync(CONFIG.eventsFile, JSON.stringify(event) + "\n");

  // Track appends for rotation
  eventsAppendCount++;
  if (eventsAppendCount >= 1000) {
    eventsAppendCount = 0;
    checkEventsRotation();
  }
}

// ─── FILE ROTATION ───────────────────────────────────────────────────────────
// NOTE: CSV includes both BUY and SELL rows. SELL rows have empty won/pnl columns
// since BUY-perspective formulas are misleading for SELLs.

const WHALE_TRADES_CSV_HEADER = "ts,wallet,walletLabel,side,outcome,price,usdcSize,shares,spotPrice,delta30s,delta5m,priceDirection,edgeVsSpot,polyMid,midEdge,secsRemaining,resolution,won,pnl,conditionId,title,asset,whaleTxHash,assetLabel,contractDurationMinutes,momentumAligned,sessionLabel,concurrentWhales";

function eventToWhaleTradeCsvRow(e: any): string | null {
  if (e.type !== "WHALE_TRADE") return null;
  const resolution = state.resolutionCache.get(e.conditionId) || null;
  // Only compute won/pnl for BUY trades — SELL won/pnl is meaningless from BUY perspective
  let won: boolean | null = null;
  let pnl: number | null = null;
  if (resolution && e.side === "BUY") {
    won = (e.outcome === resolution);
    const shares = e.shares || 0;
    const entry = e.price || 0;
    pnl = won ? (1 - entry) * shares : -entry * shares;
  }
  const polyMid = e.polyMid || 0;
  const midEdge = polyMid > 0 ? polyMid - e.price : null;
  const spotPrice = e.spotPrice ?? e.btcPriceAtTrade;
  const delta30s = e.delta30s ?? e.btcDelta30s;
  const delta5m = e.delta5m ?? e.btcDelta5m;
  const priceDir = e.priceDirection ?? e.btcDirection;
  const edgeVsSpot = e.edgeVsSpot ?? e.edgeVsBtc;
  return [
    e.tsIso || "",
    e.wallet || "",
    e.walletLabel || "",
    e.side, e.outcome, e.price, e.usdcSize, e.shares,
    spotPrice,
    typeof delta30s === "number" ? delta30s.toFixed(4) : "",
    typeof delta5m === "number" ? delta5m.toFixed(4) : "",
    priceDir || "",
    edgeVsSpot !== null && edgeVsSpot !== undefined ? Number(edgeVsSpot).toFixed(4) : "",
    polyMid > 0 ? polyMid.toFixed(4) : "",
    midEdge !== null ? midEdge.toFixed(4) : "",
    e.secondsRemainingInContract >= 0 ? Number(e.secondsRemainingInContract).toFixed(0) : "",
    resolution || "",
    won !== null ? (won ? "TRUE" : "FALSE") : "",
    pnl !== null ? pnl.toFixed(4) : "",
    e.conditionId || "",
    `"${(e.title || "").replace(/"/g, '""')}"`,
    e.asset || "",
    e.txHash || "",
    // New computed columns
    e.assetLabel || "",
    e.contractDurationMinutes !== undefined && e.contractDurationMinutes !== null ? e.contractDurationMinutes : "",
    e.momentumAligned !== undefined ? (e.momentumAligned ? "TRUE" : "FALSE") : "",
    e.sessionLabel || "",
    e.concurrentWhales !== undefined && e.concurrentWhales !== null ? e.concurrentWhales : "",
  ].join(",");
}

function archiveTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function getArchiveFiles(prefix: string): string[] {
  if (!fs.existsSync(CONFIG.archiveDir)) return [];
  return fs.readdirSync(CONFIG.archiveDir)
    .filter(f => f.startsWith(prefix + "_") && f.endsWith(".csv"))
    .sort();
}

function checkEventsRotation(): boolean {
  if (!fs.existsSync(CONFIG.eventsFile)) return false;
  const content = fs.readFileSync(CONFIG.eventsFile, "utf-8").trim();
  if (!content) return false;
  const lines = content.split("\n").filter(Boolean);
  if (lines.length < CONFIG.rotationMaxLines) return false;

  fs.mkdirSync(CONFIG.archiveDir, { recursive: true });

  // Convert WHALE_TRADE events to CSV rows
  const csvRows: string[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const row = eventToWhaleTradeCsvRow(obj);
      if (row) csvRows.push(row);
    } catch {}
  }

  const archiveName = `whale_trades_${archiveTimestamp()}.csv`;
  const archivePath = path.join(CONFIG.archiveDir, archiveName);
  fs.writeFileSync(archivePath, WHALE_TRADES_CSV_HEADER + "\n" + csvRows.join("\n") + "\n");

  // Clear the JSONL file
  fs.writeFileSync(CONFIG.eventsFile, "");

  // Also clear in-memory state since the file is now empty
  state.events = [];
  state.whaleTrades = [];

  // Prune old archives
  const archives = getArchiveFiles("whale_trades");
  if (archives.length > CONFIG.rotationMaxArchives) {
    const toDelete = archives.slice(0, archives.length - CONFIG.rotationMaxArchives);
    for (const f of toDelete) {
      try { fs.unlinkSync(path.join(CONFIG.archiveDir, f)); } catch {}
    }
  }

  console.log(`[rotation] events.jsonl → ${archiveName} (${lines.length} lines, ${csvRows.length} trades)`);
  return true;
}

function loadHistory() {
  if (!fs.existsSync(CONFIG.eventsFile)) return;
  const lines = fs.readFileSync(CONFIG.eventsFile, "utf-8").trim().split("\n").filter(Boolean);
  const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Event[];
  // Load last N
  state.events = parsed.slice(-CONFIG.maxEventsInMemory);
  state.whaleTrades = parsed.filter(e => e.type === "WHALE_TRADE") as WhaleTrade[];

  // Backfill wallet fields for historical trades that predate multi-wallet support
  const firstWallet = CONFIG.wallets[0];
  for (const t of state.whaleTrades) {
    if (!t.wallet) {
      t.wallet = firstWallet.address;
      t.walletLabel = firstWallet.label;
    }
    // Backward compat: map old BTC-specific field names to new generic names
    const ta = t as any;
    if (ta.btcPriceAtTrade !== undefined && ta.spotPrice === undefined) ta.spotPrice = ta.btcPriceAtTrade;
    if (ta.btcDelta30s !== undefined && ta.delta30s === undefined)      ta.delta30s = ta.btcDelta30s;
    if (ta.btcDelta5m !== undefined && ta.delta5m === undefined)        ta.delta5m = ta.btcDelta5m;
    if (ta.btcDirection !== undefined && ta.priceDirection === undefined) ta.priceDirection = ta.btcDirection;
    if (ta.edgeVsBtc !== undefined && ta.edgeVsSpot === undefined)     ta.edgeVsSpot = ta.edgeVsBtc;
  }

  state.whaleTrades.forEach(t => state.lastWhaleTxHash.add((t as WhaleTrade).txHash));
  console.log(`[history] Loaded ${state.events.length} events, ${state.whaleTrades.length} whale trades`);
}

// ─── BTC PRICE TRACKING ───────────────────────────────────────────────────────

function getBtcDelta(seconds: number): number {
  const cutoff = Date.now() - seconds * 1000;
  const old = state.btcPriceHistory.findLast(p => p.ts <= cutoff);
  if (!old || old.price === 0 || state.btcPrice === 0) return 0;
  return ((state.btcPrice - old.price) / old.price) * 100;
}

function getBtcDirection(): "UP" | "DOWN" | "FLAT" {
  const delta = getBtcDelta(30);
  if (delta >  0.02) return "UP";
  if (delta < -0.02) return "DOWN";
  return "FLAT";
}

/** Per-asset delta (% change over `seconds`). Falls back to getBtcDelta when symbol has no history. */
function getAssetDelta(symbol: string, seconds: number): number {
  const bucket = state.assetPrices[symbol];
  if (!bucket || bucket.history.length === 0) return getBtcDelta(seconds);
  const cutoff = Date.now() - seconds * 1000;
  const old = bucket.history.findLast(p => p.ts <= cutoff);
  if (!old || old.price === 0 || bucket.price === 0) return 0;
  return ((bucket.price - old.price) / old.price) * 100;
}

/** Per-asset direction based on 30s delta with +/-0.02% thresholds. */
function getAssetDirection(symbol: string): "UP" | "DOWN" | "FLAT" {
  const delta = getAssetDelta(symbol, 30);
  if (delta >  0.02) return "UP";
  if (delta < -0.02) return "DOWN";
  return "FLAT";
}

// ─── BINARY OPTION PRICING (Black-Scholes digital option) ────────────────────

// Standard normal CDF — Abramowitz & Stegun rational approximation (max error 1.5e-7)
function normalCDF(x: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 0.5 * (1.0 + sign * y);
}

// Rolling realized volatility from asset tick data (annualized)
// Resamples at 5s intervals over a 5-minute lookback window
// symbol: "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"
function computeRealizedVolatility(symbol: string = "BTCUSDT"): number | null {
  const now = Date.now();
  const lookbackMs = 300_000;   // 5 minutes
  const sampleMs   = 5_000;     // sample every 5 seconds

  // Use asset-specific history (falls back to legacy btcPriceHistory for BTCUSDT)
  const history = symbol === "BTCUSDT"
    ? state.btcPriceHistory
    : (state.assetPrices[symbol]?.history || []);

  const samples: number[] = [];
  for (let t = now - lookbackMs; t <= now; t += sampleMs) {
    const tick = history.findLast(p => p.ts <= t);
    if (tick) samples.push(tick.price);
  }

  if (samples.length < 20) return null; // need ~100s of data

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

  // Annualize: periodsPerYear = ms_per_year / sampleMs
  const periodsPerYear = (365.25 * 24 * 3600 * 1000) / sampleMs;
  const annualized = stdDev * Math.sqrt(periodsPerYear);

  // Floor 20%, cap 200% — prevents extreme values from noise
  return Math.min(2.0, Math.max(0.20, annualized));
}

// Parse contract window start time from title
// e.g. "Bitcoin Up or Down - February 27, 5:45AM-5:50AM ET"
// Uses endTs from Gamma API minus parsed duration to get precise window start
function parseWindowStartTs(title: string, endTs: number): { windowStartTs: number; durationMs: number } {
  if (!endTs) return { windowStartTs: 0, durationMs: 0 };

  // Helper: parse "7:15AM" or "7AM" into total minutes since midnight
  function parseTimeToMins(hourStr: string, minStr: string | null, ampm: string): number {
    let h = parseInt(hourStr);
    const m = minStr ? parseInt(minStr) : 0;
    if (ampm.toUpperCase() === "PM" && h !== 12) h += 12;
    if (ampm.toUpperCase() === "AM" && h === 12) h = 0;
    return h * 60 + m;
  }

  // General range regex: handles all combos of "H:MMAM-H:MMAM", "HAM-H:MMAM", "H:MMAM-HAM"
  const rangeMatch = title.match(
    /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(ET|EST|EDT)/i
  );
  if (rangeMatch) {
    const [, sh, sm, sap, eh, em, eap] = rangeMatch;
    const startMins = parseTimeToMins(sh, sm || null, sap);
    const endMins   = parseTimeToMins(eh, em || null, eap);
    let durationMins = endMins - startMins;
    if (durationMins <= 0) durationMins += 24 * 60;

    const durationMs = durationMins * 60 * 1000;
    return { windowStartTs: endTs - durationMs, durationMs };
  }

  // Standalone hour: "6AM ET" or "11PM ET" (hourly contract, assume 1 hour)
  const hourlyMatch = title.match(/(\d{1,2})\s*(AM|PM)\s+(ET|EST|EDT)/i);
  if (hourlyMatch) {
    const durationMs = 3_600_000; // 1 hour
    return { windowStartTs: endTs - durationMs, durationMs };
  }

  return { windowStartTs: 0, durationMs: 0 };
}

// Strike price cache: "SYMBOL_windowStartTs" → price at that moment
const strikePriceCache = new Map<string, number>();

async function getStrikePrice(windowStartTs: number, symbol: string = "BTCUSDT"): Promise<number | null> {
  if (!windowStartTs || windowStartTs <= 0) return null;

  const cacheKey = `${symbol}_${windowStartTs}`;
  const cached = strikePriceCache.get(cacheKey);
  if (cached) return cached;

  // Check our own tick history first (within 3s of window start)
  const history = symbol === "BTCUSDT"
    ? state.btcPriceHistory
    : (state.assetPrices[symbol]?.history || []);
  const tick = history.find(
    p => Math.abs(p.ts - windowStartTs) < 3000
  );
  if (tick) {
    strikePriceCache.set(cacheKey, tick.price);
    return tick.price;
  }

  // Fetch 1-minute kline from Binance REST API (works for any symbol)
  try {
    const { data } = await axios.get("https://api.binance.com/api/v3/klines", {
      params: {
        symbol,
        interval: "1m",
        startTime: windowStartTs,
        limit: 1,
      },
      timeout: 5000,
    });

    if (data && data.length > 0) {
      const openPrice = parseFloat(data[0][1]); // index 1 = open price
      strikePriceCache.set(cacheKey, openPrice);
      console.log(`[strike] ${symbol} at window start (${new Date(windowStartTs).toISOString()}): $${openPrice.toFixed(2)}`);
      return openPrice;
    }
  } catch (e: any) {
    console.error(`[strike] Binance kline fetch failed:`, e.message);
  }

  return null;
}

// Binary option fair value: P(up) = N(d2)
// d2 = [ln(S/K) - σ²T/2] / (σ√T)
// S = current BTC price, K = strike (BTC at window start), σ = annualized vol, T = years to expiry
function computeBinaryFairValue(
  currentPrice: number,
  strikePrice: number,
  secondsRemaining: number,
  annualizedVol: number,
  direction: "UP" | "DOWN"
): number {
  const T = secondsRemaining / (365.25 * 24 * 3600);

  // Near expiry (<1s): outcome effectively known
  if (T < 1e-10 || secondsRemaining < 1) {
    const pUp = currentPrice > strikePrice ? 0.99
              : currentPrice < strikePrice ? 0.01
              : 0.50;
    return direction === "UP" ? pUp : 1 - pUp;
  }

  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(currentPrice / strikePrice) - (annualizedVol ** 2 / 2) * T)
             / (annualizedVol * sqrtT);

  let pUp = normalCDF(d2);
  pUp = Math.min(0.99, Math.max(0.01, pUp));

  return direction === "UP" ? pUp : 1 - pUp;
}

let binanceWs: WebSocket | null = null;

function connectBinance() {
  if (binanceWs) binanceWs.terminate();

  binanceWs = new WebSocket(CONFIG.binanceWsUrl);

  binanceWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Combined stream format: { stream: "btcusdt@trade", data: { p: "65000.00", ... } }
      const d = msg.data || msg;
      const price = parseFloat(d.p);
      if (!price) return;

      // Determine symbol from stream name (e.g. "btcusdt@trade" → "BTCUSDT")
      const symbol = msg.stream ? msg.stream.split("@")[0].toUpperCase() : "BTCUSDT";

      const now = Date.now();
      const bucket = state.assetPrices[symbol];
      if (bucket) {
        bucket.price = price;
        bucket.history.push({ ts: now, price });
        // Trim to last 10 minutes
        const cutoff = now - 600_000;
        bucket.history = bucket.history.filter(p => p.ts > cutoff);
      }

      // Keep legacy btcPrice in sync for backward compat
      if (symbol === "BTCUSDT") {
        state.btcPrice = price;
        state.btcPriceHistory.push({ ts: now, price });
        const cutoff = now - 600_000;
        state.btcPriceHistory = state.btcPriceHistory.filter(p => p.ts > cutoff);
      }
    } catch {}
  });

  binanceWs.on("close", () => {
    console.log("[binance] disconnected, reconnecting in 3s");
    setTimeout(connectBinance, 3000);
  });

  binanceWs.on("error", (e) => {
    console.error("[binance] error:", e.message);
    startRestPriceFallback();
  });
  console.log("[binance] WS connecting (BTC + ETH + SOL + XRP)");
}

// ─── BINANCE REST PRICE FALLBACK (for regions where WS is blocked) ──────────

let restPriceFallbackActive = false;

function updatePrice(symbol: string, price: number) {
  const now = Date.now();
  const bucket = state.assetPrices[symbol];
  if (bucket) {
    bucket.price = price;
    bucket.history.push({ ts: now, price });
    const cutoff = now - 600_000;
    bucket.history = bucket.history.filter(p => p.ts > cutoff);
  }
  if (symbol === "BTCUSDT") {
    state.btcPrice = price;
    state.btcPriceHistory.push({ ts: now, price });
    const cutoff = now - 600_000;
    state.btcPriceHistory = state.btcPriceHistory.filter(p => p.ts > cutoff);
  }
}

async function pollPricesViaRest() {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];
  try {
    const { data } = await axios.get("https://api.binance.com/api/v3/ticker/price", {
      params: { symbols: JSON.stringify(symbols) },
      timeout: 5000,
    });
    if (Array.isArray(data)) {
      for (const item of data) {
        const price = parseFloat(item.price);
        if (price > 0 && item.symbol) updatePrice(item.symbol, price);
      }
    }
  } catch {
    try {
      for (const sym of symbols) {
        const { data } = await axios.get("https://api.binance.us/api/v3/ticker/price", {
          params: { symbol: sym }, timeout: 3000,
        });
        const price = parseFloat(data.price);
        if (price > 0) updatePrice(sym, price);
      }
    } catch (e: any) {
      console.error("[price-rest] Both Binance endpoints failed:", e.message);
    }
  }
}

function startRestPriceFallback() {
  if (restPriceFallbackActive) return;
  restPriceFallbackActive = true;
  console.log("[price-rest] Binance WS unavailable — switching to REST polling (every 3s)");
  pollPricesViaRest();
  setInterval(pollPricesViaRest, 3000);
}

// ─── CONTRACT CACHE (trade-driven, keyed by asset/token ID) ─────────────────

// Maps asset (CLOB token ID) → contract info
const assetToContract = new Map<string, CachedContract>();

async function getContractForAsset(asset: string): Promise<CachedContract | null> {
  if (!asset) return null;

  // Return cached if fresh (< 5 min old)
  const cached = assetToContract.get(asset);
  if (cached && Date.now() - cached.fetchedAt < 300_000) return cached;

  try {
    // Look up by clob_token_ids — this is the correct Gamma API param
    const { data } = await axios.get(`${CONFIG.gammaApi}/markets`, {
      params: { clob_token_ids: asset },
      timeout: 5000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });

    const markets = Array.isArray(data) ? data : data.markets ?? [];
    const market = markets[0];
    if (!market) {
      console.log(`[gamma] No market found for asset ${asset.slice(0, 16)}…`);
      return null;
    }

    // clobTokenIds comes back as a JSON string from Gamma API
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

    const isBtcContract = /bitcoin/i.test(title);
    const { windowStartTs, durationMs } = parseWindowStartTs(title, endTs);

    // Detect Binance symbol from title (e.g. "Bitcoin" → BTCUSDT, "Ethereum" → ETHUSDT)
    let binanceSymbol = "";
    const titleLower = title.toLowerCase();
    for (const [keyword, sym] of Object.entries(ASSET_MAP)) {
      if (titleLower.includes(keyword)) {
        binanceSymbol = sym;
        break;
      }
    }

    // Fetch strike price for ANY recognized asset (from Binance kline at window start)
    let strikePrice: number | null = null;
    if (binanceSymbol && windowStartTs > 0) {
      strikePrice = await getStrikePrice(windowStartTs, binanceSymbol);
    }

    const assetLabel = deriveAssetLabel(binanceSymbol, title);
    const contractDurationMinutes = deriveDurationMinutes(durationMs);

    const contract: CachedContract = {
      conditionId,
      title,
      startTs,
      endTs,
      windowStartTs,
      durationMs,
      clobTokenIds: tokenIds,
      fetchedAt: Date.now(),
      isBtcContract,
      binanceSymbol,
      strikePrice,
      assetLabel,
      contractDurationMinutes,
    };

    // Cache by conditionId and by every token ID in this market
    state.contractCache.set(conditionId, contract);
    for (const tid of tokenIds) {
      assetToContract.set(tid, contract);
    }
    // Also cache for the queried asset in case it wasn't in tokenIds
    assetToContract.set(asset, contract);

    const strikeStr = strikePrice ? `$${strikePrice.toFixed(2)}` : "N/A";
    console.log(`[gamma] Cached: "${contract.title.slice(0, 60)}" | ${assetLabel} ${contractDurationMinutes}min | ${tokenIds.length} tokens | ends ${contract.endTs ? new Date(contract.endTs).toISOString() : "unknown"} | strike: ${strikeStr}`);

    // Subscribe to these tokens on the Polymarket WS
    if (tokenIds.length > 0) subscribeTokens(tokenIds);

    return contract;
  } catch (e: any) {
    console.error(`[gamma] Failed to fetch asset ${asset.slice(0, 16)}…:`, e.message);
    return null;
  }
}

// ─── POLYMARKET ORDER BOOK (multi-token) ─────────────────────────────────────

let polyWs: WebSocket | null = null;
let polyWsReady = false;
let pendingSubscriptions: string[] = [];

function connectPolymarketWs() {
  if (polyWs) polyWs.terminate();
  polyWsReady = false;

  polyWs = new WebSocket(CONFIG.polymarketWsUrl);

  polyWs.on("open", () => {
    polyWsReady = true;
    console.log("[polymarket] WS connected");

    // Re-subscribe all known tokens
    if (state.subscribedTokens.size > 0) {
      const allTokens = [...state.subscribedTokens];
      state.subscribedTokens.clear(); // will be re-added by subscribeTokens
      subscribeTokens(allTokens);
    }

    // Flush any pending subscriptions
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

        // IMPORTANT: Only update book if message actually contains book data.
        // Non-book messages (trades, etc.) don't have asks/bids keys —
        // we must NOT zero out good book data when they arrive.
        const hasAsks = Array.isArray(msg.asks);
        const hasBids = Array.isArray(msg.bids);
        if (!hasAsks && !hasBids) continue; // skip non-book messages

        const existing = state.tokenBook.get(tokenId) || { ask: 0, bid: 0 };

        let bestAsk = existing.ask;
        let bestBid = existing.bid;

        if (hasAsks && msg.asks.length > 0) {
          const asks = msg.asks.sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
          bestAsk = parseFloat(asks[0].price);
        }
        if (hasBids && msg.bids.length > 0) {
          const bids = msg.bids.sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
          bestBid = parseFloat(bids[0].price);
        }

        state.tokenBook.set(tokenId, { ask: bestAsk, bid: bestBid });
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

function subscribeTokens(tokenIds: string[]) {
  const newTokens = tokenIds.filter(id => id && !state.subscribedTokens.has(id));
  if (newTokens.length === 0) return;

  if (!polyWs || !polyWsReady) {
    pendingSubscriptions.push(...newTokens);
    return;
  }

  polyWs.send(JSON.stringify({
    type: "market",
    assets_ids: newTokens,
  }));

  for (const id of newTokens) {
    state.subscribedTokens.add(id);
    // Initialize book entry
    if (!state.tokenBook.has(id)) {
      state.tokenBook.set(id, { ask: 0, bid: 0 });
    }
  }

  console.log(`[polymarket] subscribed to ${newTokens.length} new token(s) (total: ${state.subscribedTokens.size})`);
}

// ─── REST BOOK FALLBACK ──────────────────────────────────────────────────────

// Cache of last REST fetch time per token (avoid hammering the API)
const restBookFetchTimes = new Map<string, number>();

async function fetchBookFromRest(tokenId: string): Promise<{ ask: number; bid: number }> {
  // Rate-limit: don't re-fetch the same token within 10s
  const lastFetch = restBookFetchTimes.get(tokenId) || 0;
  if (Date.now() - lastFetch < 10_000) {
    return state.tokenBook.get(tokenId) || { ask: 0, bid: 0 };
  }
  restBookFetchTimes.set(tokenId, Date.now());

  try {
    const { data } = await axios.get("https://clob.polymarket.com/book", {
      params: { token_id: tokenId },
      timeout: 3000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });

    const asks = (data.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bids = (data.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));

    const bestAsk = asks[0] ? parseFloat(asks[0].price) : 0;
    const bestBid = bids[0] ? parseFloat(bids[0].price) : 0;

    if (bestAsk > 0 || bestBid > 0) {
      // Merge with existing (don't zero out a side if REST didn't return it)
      const existing = state.tokenBook.get(tokenId) || { ask: 0, bid: 0 };
      const merged = {
        ask: bestAsk > 0 ? bestAsk : existing.ask,
        bid: bestBid > 0 ? bestBid : existing.bid,
      };
      state.tokenBook.set(tokenId, merged);
      return merged;
    }
  } catch {
    // Silently fail — REST fallback is best-effort
  }

  return state.tokenBook.get(tokenId) || { ask: 0, bid: 0 };
}

// Periodically refresh book data for subscribed tokens that have empty books
async function refreshEmptyBooks() {
  const emptyTokens: string[] = [];
  for (const [tokenId, book] of state.tokenBook) {
    if (book.ask === 0 || book.bid === 0) {
      emptyTokens.push(tokenId);
    }
  }

  if (emptyTokens.length === 0) return;

  // Only refresh up to 10 at a time to avoid rate limits
  const batch = emptyTokens.slice(0, 10);
  let filled = 0;
  for (const tokenId of batch) {
    const book = await fetchBookFromRest(tokenId);
    if (book.ask > 0 && book.bid > 0) filled++;
    // Small delay between calls
    await new Promise(r => setTimeout(r, 200));
  }

  if (filled > 0) {
    console.log(`[book-refresh] Filled ${filled}/${batch.length} empty books via REST (${emptyTokens.length} total empty)`);
  }
}

// ─── WHALE ACTIVITY POLLING ───────────────────────────────────────────────────

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
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    clearTimeout(timeout);

    const trades: any[] = Array.isArray(data) ? data : data.data ?? [];

    // Collect unique assets (token IDs) we haven't cached yet
    const newAssets = new Set<string>();
    for (const t of trades) {
      const asset = t.asset || "";
      if (asset && !assetToContract.has(asset)) newAssets.add(asset);
    }

    // Fetch contract info for all new assets in parallel (via clob_token_ids)
    if (newAssets.size > 0) {
      await Promise.allSettled([...newAssets].map(a => getContractForAsset(a)));
    }

    // Pre-compute volatility per asset (reused across all trades in this poll)
    const volCache: Record<string, number | null> = {};

    let newCount = 0;

    for (const t of trades) {
      const txHash = t.transactionHash || `${t.timestamp}_${t.asset}`;
      if (state.lastWhaleTxHash.has(txHash)) continue;
      state.lastWhaleTxHash.add(txHash);

      const side    = (t.side || "").toUpperCase() as "BUY" | "SELL";
      const price   = Number(t.price || 0);
      const outcome = (t.outcome || "").toLowerCase();
      const dir     = outcome.includes("up") ? "UP" : "DOWN";
      const conditionId = t.conditionId || "";
      const asset   = t.asset || "";

      // Look up contract from cache for timing (keyed by asset)
      const contract = assetToContract.get(asset) || null;
      const now      = Date.now();
      const endTs    = contract?.endTs || 0;
      const secsRemaining = endTs ? (endTs - now) / 1000 : -1;

      // Edge: Black-Scholes binary option fair value vs trade price
      // Works for any asset with a Binance price feed (BTC, ETH, SOL, XRP)
      let edgeVsSpot: number | null = null;
      const sym = contract?.binanceSymbol || "";
      if (contract && sym && contract.strikePrice && secsRemaining > 0) {
        // Lazy-compute vol per symbol
        if (!(sym in volCache)) volCache[sym] = computeRealizedVolatility(sym);
        const assetVol = volCache[sym];
        const assetPrice = state.assetPrices[sym]?.price || 0;
        if (assetVol !== null && assetPrice > 0) {
          const fairValue = computeBinaryFairValue(
            assetPrice, contract.strikePrice, secsRemaining, assetVol, dir as "UP" | "DOWN"
          );
          edgeVsSpot = fairValue - price;
        }
      }

      // Update latest contract for dashboard
      if (contract) state.latestContract = contract;

      // Order book mid price for this specific token (model-free fair value)
      // Try WS book first; if empty, fall back to REST API fetch
      let book = state.tokenBook.get(asset) || { ask: 0, bid: 0 };
      if ((book.ask === 0 || book.bid === 0) && asset) {
        book = await fetchBookFromRest(asset);
      }
      const polyMid = book.ask > 0 && book.bid > 0 ? (book.ask + book.bid) / 2 : 0;

      // Compute new enriched columns
      const tradeOutcome = t.outcome || "?";
      const tradeAssetLabel = contract?.assetLabel || deriveAssetLabel(contract?.binanceSymbol || "", contract?.title || t.title || "");
      // Resolve effective Binance symbol: prefer contract.binanceSymbol, fall back to assetLabel→symbol map
      const effectiveSym = sym || LABEL_TO_SYMBOL[tradeAssetLabel] || "BTCUSDT";
      const tradeAssetDir = getAssetDirection(effectiveSym);
      const tradeContractDurationMinutes = contract?.contractDurationMinutes || deriveDurationMinutes(contract?.durationMs || 0);
      const tradeMomentumAligned =
        (tradeAssetDir === "UP" && tradeOutcome === "Up") ||
        (tradeAssetDir === "DOWN" && tradeOutcome === "Down");
      const tradeTs = t.timestamp ? t.timestamp * 1000 : now;
      const tradeSessionLabel = getSessionLabel(tradeTs);

      // Record concurrent whale activity BEFORE computing count
      recordConcurrentWhale(conditionId, walletAddress, tradeTs);
      const tradeConcurrentWhales = getConcurrentWhales(conditionId, tradeTs);

      // ETH price debug — remove after confirming fix
      if (tradeAssetLabel === "ETH") {
        console.log(`[ETH PRICE CHECK] sym=${sym}, effectiveSym=${effectiveSym}, spotPrice=${state.assetPrices[effectiveSym]?.price || 0}, btcPrice=${state.btcPrice}`);
      }

      const event: WhaleTrade = {
        id: `whale_${txHash}`,
        type: "WHALE_TRADE",
        ts: tradeTs,
        tsIso: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : new Date().toISOString(),
        wallet: walletAddress,
        walletLabel,
        side,
        outcome: tradeOutcome,
        price,
        usdcSize: Number(t.usdcSize || 0),
        shares: Number(t.size || 0),
        conditionId,
        title: contract?.title || t.title || "",
        txHash,
        asset,
        spotPrice: state.assetPrices[effectiveSym]?.price || state.btcPrice,
        delta30s: getAssetDelta(effectiveSym, 30),
        delta5m:  getAssetDelta(effectiveSym, 300),
        priceDirection: tradeAssetDir,
        secondsRemainingInContract: secsRemaining,
        edgeVsSpot,
        polyMid,
        // New computed columns
        assetLabel: tradeAssetLabel,
        contractDurationMinutes: tradeContractDurationMinutes,
        momentumAligned: tradeMomentumAligned,
        sessionLabel: tradeSessionLabel,
        concurrentWhales: tradeConcurrentWhales,
      };

      appendEvent(event);
      state.whaleTrades.unshift(event);
      // No cap — all trades stay in memory for CSV export & dashboard
      // (events.jsonl handles persistence; 100k trades ≈ 200MB, fine)
      newCount++;

      // Pattern detection
      detectPattern(event);
      updateStats(event);
    }

    if (newCount > 0) {
      const tokenCount = state.subscribedTokens.size;
      const contractCount = state.contractCache.size;
      console.log(`[${walletLabel}] +${newCount} new trades | BTC: $${state.btcPrice.toFixed(0)} | contracts: ${contractCount} | tokens: ${tokenCount}`);
    }
  } catch (e: any) {
    clearTimeout(timeout);
    if (e.code === 'ECONNABORTED' || e.name === 'AbortError' || e.code === 'ERR_CANCELED') {
      console.log(`[${walletLabel}] request timed out — will retry next interval`);
    } else {
      console.error(`[${walletLabel}] poll error:`, e.message);
    }
  }
}

// ─── PATTERN DETECTION ────────────────────────────────────────────────────────

function detectPattern(trade: WhaleTrade) {
  const patterns: { pattern: string; confidence: number; description: string }[] = [];

  // Pattern 1: Buys when BTC is strongly moving in same direction
  if (trade.side === "BUY") {
    const tradeDir = trade.outcome.toLowerCase().includes("up") ? "UP" : "DOWN";
    if (tradeDir === trade.priceDirection && Math.abs(trade.delta30s) > 0.03) {
      patterns.push({
        pattern: "MOMENTUM_FOLLOW",
        confidence: Math.min(0.9, Math.abs(trade.delta30s) * 20),
        description: `Bought ${tradeDir} when spot moved ${trade.delta30s.toFixed(3)}% in 30s`,
      });
    }

    // Pattern 2: Buys lagging price (edge > threshold) — only when edge is valid
    if (trade.edgeVsSpot !== null && trade.edgeVsSpot > 0.08) {
      patterns.push({
        pattern: "LAG_ARBITRAGE",
        confidence: Math.min(0.95, trade.edgeVsSpot * 5),
        description: `Bought at ${trade.price.toFixed(3)}, spot fair value ${(trade.price + trade.edgeVsSpot).toFixed(3)} — edge: +${trade.edgeVsSpot.toFixed(3)}`,
      });
    }

    // Pattern 3: Late entry (< 90s remaining) — only when timing is known
    if (trade.secondsRemainingInContract > 0 && trade.secondsRemainingInContract < 90) {
      patterns.push({
        pattern: "LATE_ENTRY",
        confidence: 0.8,
        description: `Bought with only ${trade.secondsRemainingInContract.toFixed(0)}s remaining in contract`,
      });
    }

    // Pattern 4: Early entry — detected when secsRemaining is close to full contract duration
    // (Gamma API only gives endDate, not per-window startDate, so we can't reliably detect this)
  }

  // Pattern 5: Buy followed by quick sell (scalping)
  if (trade.side === "SELL") {
    const recentBuy = state.whaleTrades.find(t =>
      t.side === "BUY" &&
      t.conditionId === trade.conditionId &&
      t.outcome === trade.outcome &&
      trade.ts - t.ts < 120_000 &&
      trade.ts - t.ts > 0 // must be after the buy
    );
    if (recentBuy) {
      const holdSecs  = (trade.ts - recentBuy.ts) / 1000;
      const priceDiff = trade.price - recentBuy.price;
      patterns.push({
        pattern: "QUICK_SCALP",
        confidence: 0.9,
        description: `Bought @ ${recentBuy.price.toFixed(3)} → Sold @ ${trade.price.toFixed(3)} in ${holdSecs.toFixed(0)}s | P&L: ${priceDiff >= 0 ? "+" : ""}${priceDiff.toFixed(3)}`,
      });
    }
  }

  for (const p of patterns) {
    const event: PatternDetected = {
      id: `pattern_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "PATTERN_DETECTED",
      ts: trade.ts,
      tsIso: trade.tsIso,
      tradeId: trade.id,
      ...p,
    };
    appendEvent(event);
    state.stats.patternsDetected++;
    console.log(`[pattern] ${p.pattern} (conf: ${(p.confidence * 100).toFixed(0)}%) — ${p.description}`);
  }
}

function updateStats(trade: WhaleTrade) {
  const s = state.stats;
  s.totalWhaleTrades++;
  if (trade.side === "BUY")  s.buyCount++;
  if (trade.side === "SELL") s.sellCount++;
  const dir = trade.outcome.toLowerCase().includes("up") ? "UP" : "DOWN";
  if (dir === "UP")   s.upCount++;
  if (dir === "DOWN") s.downCount++;

  // Rolling averages
  const buys  = state.whaleTrades.filter(t => t.side === "BUY");
  const sells = state.whaleTrades.filter(t => t.side === "SELL");
  s.avgBuyPrice  = buys.length  ? buys.reduce((a, t) => a + t.price, 0) / buys.length : 0;
  s.avgSellPrice = sells.length ? sells.reduce((a, t) => a + t.price, 0) / sells.length : 0;
  const buysWithEdge = buys.filter(t => t.edgeVsSpot !== null);
  s.avgEdge = buysWithEdge.length
    ? buysWithEdge.reduce((a, t) => a + (t.edgeVsSpot as number), 0) / buysWithEdge.length
    : 0;
}

// ─── RESOLUTION TRACKING ─────────────────────────────────────────────────────

async function checkResolutions() {
  const now = Date.now();
  let newResolutions = 0;

  for (const [condId, contract] of state.contractCache) {
    // Skip if already resolved
    if (state.resolutionCache.has(condId) && state.resolutionCache.get(condId) !== null) continue;

    // Only check if contract has ended (+ 60s grace for on-chain resolution)
    if (contract.endTs === 0 || now < contract.endTs + 60_000) continue;

    // Need at least one token ID to query Gamma
    if (contract.clobTokenIds.length === 0) continue;

    try {
      const { data } = await axios.get(`${CONFIG.gammaApi}/markets`, {
        params: { clob_token_ids: contract.clobTokenIds[0] },
        timeout: 5000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
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

      // Check for definitive resolution (price = "1")
      const winIdx = prices.indexOf("1");
      if (winIdx >= 0 && outcomes[winIdx]) {
        state.resolutionCache.set(condId, outcomes[winIdx]);
        newResolutions++;
        console.log(`[resolution] ${contract.title.slice(0, 55)} => ${outcomes[winIdx]}`);
      } else {
        // High-confidence resolution: price > 0.95 means the outcome is effectively decided.
        // Don't require m.closed — Polymarket often delays setting closed=true on hourly
        // contracts even when outcomePrices are at 0.9995. We only do this for contracts
        // that have ended (we already checked endTs above), so this is safe.
        const maxPrice = Math.max(...prices.map(Number));
        if (maxPrice > 0.95) {
          const idx = prices.findIndex((p: string) => Number(p) > 0.95);
          if (idx >= 0 && outcomes[idx]) {
            state.resolutionCache.set(condId, outcomes[idx]);
            newResolutions++;
            console.log(`[resolution] ${contract.title.slice(0, 55)} => ${outcomes[idx]} (price: ${prices[idx]})`);
          }
        }
      }
      // else: not yet resolved, will retry next cycle
    } catch {
      // Silently skip — will retry next cycle
    }
  }

  if (newResolutions > 0) {
    console.log(`[resolution] ${newResolutions} new resolution(s), total: ${state.resolutionCache.size}`);
  }
}

// Compute P&L for a single trade given its resolution.
// SELL trades return null won/pnl — SELLs are not meaningful for BUY-perspective statistics.
// SELL rows are preserved in CSV for research but won/pnl columns will be empty.
function computeTradePnl(trade: WhaleTrade, resolution: string | null): { won: boolean | null; pnl: number | null } {
  if (!resolution) return { won: null, pnl: null };

  // SELL trades: return null — don't compute misleading BUY-perspective won/pnl
  if (trade.side === "SELL") return { won: null, pnl: null };

  const tradeOutcome = trade.outcome.toLowerCase();
  const resOutcome = resolution.toLowerCase();
  const won = tradeOutcome === resOutcome;

  // BUY: paid price*shares upfront. If won, receive 1*shares. If lost, receive 0.
  const pnl = won ? (1 - trade.price) * trade.shares : -trade.price * trade.shares;

  return { won, pnl };
}

// ─── EXPRESS + WEBSOCKET SERVER ───────────────────────────────────────────────

const app  = express();
const server = http.createServer(app);
const wss  = new WebSocketServer({ server });

app.use(express.static(__dirname));

// Build a dashboard-friendly orderBook from the latest contract
function getDashboardOrderBook() {
  const contract = state.latestContract;
  if (!contract || contract.clobTokenIds.length < 2) {
    return { upAsk: 0, upBid: 0, downAsk: 0, downBid: 0, contractId: "", contractTitle: "", startTs: 0, endTs: 0 };
  }
  const upBook   = state.tokenBook.get(contract.clobTokenIds[0]) || { ask: 0, bid: 0 };
  const downBook = state.tokenBook.get(contract.clobTokenIds[1]) || { ask: 0, bid: 0 };
  return {
    upAsk: upBook.ask,
    upBid: upBook.bid,
    downAsk: downBook.ask,
    downBid: downBook.bid,
    contractId: contract.conditionId,
    contractTitle: contract.title,
    startTs: contract.startTs,
    endTs: contract.endTs,
  };
}

// Stream state to dashboard clients
setInterval(() => {
  const ob = getDashboardOrderBook();

  // Compute per-wallet trade counts from the FULL dataset (not just what we send)
  const walletCounts: Record<string, number> = {};
  for (const t of state.whaleTrades) {
    const lbl = t.walletLabel || "??";
    walletCounts[lbl] = (walletCounts[lbl] || 0) + 1;
  }

  const payload = JSON.stringify({
    type: "state",
    btcPrice: state.btcPrice,
    btcDelta30s: getBtcDelta(30),
    btcDelta5m: getBtcDelta(300),
    btcDirection: getBtcDirection(),
    orderBook: ob,
    recentTrades: state.whaleTrades.slice(0, 500),
    recentEvents: state.events.slice(-100),
    stats: state.stats,
    wallets: CONFIG.wallets,
    walletCounts,
    totalTrades: state.whaleTrades.length,
    activeContract: state.latestContract ? {
      conditionId: state.latestContract.conditionId,
      title: state.latestContract.title,
      startTs: state.latestContract.startTs,
      endTs: state.latestContract.endTs,
    } : null,
    btcHistory: state.btcPriceHistory.filter((_, i, a) => i % 10 === 0).slice(-60),
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}, 500);

// REST endpoints
app.get("/api/wallets", (_req, res) => res.json(CONFIG.wallets));
app.get("/api/trades", (req, res) => {
  const wallet = req.query.wallet as string | undefined;
  const trades = wallet
    ? state.whaleTrades.filter(t => t.wallet === wallet || t.walletLabel === wallet)
    : state.whaleTrades;
  res.json(trades);
});
app.get("/api/events", (_req, res) => res.json(state.events.slice(-500)));
app.get("/api/stats",  (_req, res) => res.json(state.stats));
app.get("/api/patterns", (_req, res) => {
  res.json(state.events.filter(e => e.type === "PATTERN_DETECTED"));
});
app.get("/api/contracts", (_req, res) => {
  res.json([...state.contractCache.values()]);
});
app.get("/api/resolutions", (_req, res) => {
  const result: Record<string, any> = {};
  for (const [condId, resolution] of state.resolutionCache) {
    const contract = state.contractCache.get(condId);
    result[condId] = {
      title: contract?.title || "",
      resolution: resolution || "pending",
      endTs: contract?.endTs || 0,
    };
  }
  res.json(result);
});

// Export CSV for analysis
app.get("/api/export.csv", (_req, res) => {
  const trades = state.whaleTrades;
  const header = "ts,wallet,walletLabel,side,outcome,price,usdcSize,shares,spotPrice,delta30s,delta5m,priceDirection,edgeVsSpot,polyMid,midEdge,secsRemaining,resolution,won,pnl,conditionId,title,asset,whaleTxHash,assetLabel,contractDurationMinutes,momentumAligned,sessionLabel,concurrentWhales\n";
  const rows = trades.map(t => {
    const resolution = state.resolutionCache.get(t.conditionId) || null;
    const { won, pnl } = computeTradePnl(t, resolution);
    const polyMid = t.polyMid || 0;
    const midEdge = polyMid > 0 ? polyMid - t.price : null;
    const spotPrice = (t as any).spotPrice ?? (t as any).btcPriceAtTrade;
    const delta30s = (t as any).delta30s ?? (t as any).btcDelta30s;
    const delta5m = (t as any).delta5m ?? (t as any).btcDelta5m;
    const priceDir = (t as any).priceDirection ?? (t as any).btcDirection;
    const edgeVsSpot = (t as any).edgeVsSpot ?? (t as any).edgeVsBtc;
    return [
      t.tsIso,
      t.wallet || "",
      t.walletLabel || "",
      t.side, t.outcome, t.price, t.usdcSize, t.shares,
      spotPrice, typeof delta30s === "number" ? delta30s.toFixed(4) : "", typeof delta5m === "number" ? delta5m.toFixed(4) : "",
      priceDir || "",
      edgeVsSpot !== null && edgeVsSpot !== undefined ? edgeVsSpot.toFixed(4) : "",
      polyMid > 0 ? polyMid.toFixed(4) : "",
      midEdge !== null ? midEdge.toFixed(4) : "",
      t.secondsRemainingInContract >= 0 ? t.secondsRemainingInContract.toFixed(0) : "",
      resolution || "",
      won !== null ? (won ? "TRUE" : "FALSE") : "",
      pnl !== null ? pnl.toFixed(4) : "",
      t.conditionId,
      `"${(t.title || "").replace(/"/g, '""')}"`,
      t.asset,
      (t as any).txHash || "",
      // New computed columns
      t.assetLabel || "",
      t.contractDurationMinutes !== undefined ? t.contractDurationMinutes : "",
      t.momentumAligned !== undefined ? (t.momentumAligned ? "TRUE" : "FALSE") : "",
      t.sessionLabel || "",
      t.concurrentWhales !== undefined ? t.concurrentWhales : "",
    ].join(",");
  }).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=whale_trades.csv");
  res.send(header + rows);
});

// ─── ARCHIVES ──────────────────────────────────────────────────────────────

app.get("/api/archives", (_req, res) => {
  const files = getArchiveFiles("whale_trades");
  const archives = files.map(f => {
    const fullPath = path.join(CONFIG.archiveDir, f);
    const stat = fs.statSync(fullPath);
    return {
      name: f,
      type: "whale_trades",
      sizeBytes: stat.size,
      created: stat.mtime.toISOString(),
      downloadUrl: `/api/archives/${f}`,
    };
  });
  res.json({ archives });
});

app.get("/api/archives/:filename", (req, res) => {
  const safeName = path.basename(req.params.filename);
  if (!safeName.startsWith("whale_trades_") || !safeName.endsWith(".csv")) {
    return res.status(400).json({ error: "Invalid archive name" });
  }
  const fullPath = path.join(CONFIG.archiveDir, safeName);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "Archive not found" });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${safeName}`);
  res.send(fs.readFileSync(fullPath, "utf-8"));
});

// Serve dashboard
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "spy-dashboard.html")));

// ─── PROACTIVE CONTRACT SUBSCRIPTION (fix polyMid coverage) ──────────────────

// Fetches upcoming/active "Up or Down" contracts from Gamma API
// and pre-subscribes their tokens to the Polymarket WS so we have
// book data BEFORE any whale trade arrives.
async function proactiveContractScan() {
  const keywords = ["Bitcoin", "Ethereum", "Solana", "XRP"];
  let newContracts = 0;

  for (const keyword of keywords) {
    try {
      // Gamma API: fetch active markets, filter client-side for "Up or Down" keyword
      const { data } = await axios.get(`${CONFIG.gammaApi}/events`, {
        params: {
          closed: false,
          limit: 5,
          tag: keyword,
        },
        timeout: 8000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });

      // Events contain nested markets; flatten them
      const events = Array.isArray(data) ? data : [];
      const markets: any[] = [];
      for (const ev of events) {
        const title = ev.title || ev.question || "";
        // Only "Up or Down" type events
        if (!/up or down/i.test(title)) continue;
        const mkts = ev.markets || [];
        for (const m of mkts) markets.push(m);
      }

      for (const m of markets) {
        const conditionId = m.conditionId || "";
        if (!conditionId) continue;

        // Skip if we already have this contract cached and it's fresh
        const existing = state.contractCache.get(conditionId);
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
        const now = Date.now();

        // Skip if already ended
        if (endTs > 0 && endTs < now) continue;

        const isBtcContract = /bitcoin/i.test(title);
        const { windowStartTs, durationMs } = parseWindowStartTs(title, endTs);

        // Detect Binance symbol
        let binanceSymbol = "";
        const titleLower = title.toLowerCase();
        for (const [kw, sym] of Object.entries(ASSET_MAP)) {
          if (titleLower.includes(kw)) { binanceSymbol = sym; break; }
        }

        // Fetch strike price
        let strikePrice: number | null = null;
        if (binanceSymbol && windowStartTs > 0) {
          strikePrice = await getStrikePrice(windowStartTs, binanceSymbol);
        }

        const assetLabel = deriveAssetLabel(binanceSymbol, title);
        const contractDurationMinutes = deriveDurationMinutes(durationMs);

        const contract: CachedContract = {
          conditionId, title, startTs, endTs, windowStartTs, durationMs,
          clobTokenIds: tokenIds,
          fetchedAt: Date.now(),
          isBtcContract, binanceSymbol, strikePrice,
          assetLabel, contractDurationMinutes,
        };

        state.contractCache.set(conditionId, contract);
        for (const tid of tokenIds) assetToContract.set(tid, contract);

        // Pre-subscribe to order book for these tokens!
        subscribeTokens(tokenIds);
        newContracts++;
      }
    } catch (e: any) {
      // Non-critical — silently retry next cycle
    }
  }

  if (newContracts > 0) {
    console.log(`[proactive] Pre-subscribed ${newContracts} upcoming contract(s), total tokens: ${state.subscribedTokens.size}`);
  }
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

async function main() {
  // Ensure archive dir exists
  fs.mkdirSync(CONFIG.archiveDir, { recursive: true });

  // Check rotation on startup (in case file is already over limit)
  checkEventsRotation();

  loadHistory();

  // Warm up contract cache from historical trades (needed for resolution tracking)
  const historicalAssets = new Set<string>();
  for (const t of state.whaleTrades) {
    if (t.asset && !assetToContract.has(t.asset)) historicalAssets.add(t.asset);
  }
  if (historicalAssets.size > 0) {
    console.log(`[boot] Warming contract cache for ${historicalAssets.size} historical assets...`);
    await Promise.allSettled([...historicalAssets].map(a => getContractForAsset(a)));
    console.log(`[boot] Contract cache ready: ${state.contractCache.size} contracts`);
  }

  // ─── METRIC VALIDATION (v7) ─────────────────────────────────────────────
  // Verify computed columns on recent records to catch data quality issues
  {
    const recent = state.whaleTrades.slice(0, 50);
    let issues = 0;
    for (const t of recent) {
      // 1. assetLabel: should be BTC/ETH/SOL/XRP, not empty
      if (!t.assetLabel || !["BTC", "ETH", "SOL", "XRP"].includes(t.assetLabel)) {
        console.warn(`[METRIC_CHECK] Trade ${t.id}: assetLabel="${t.assetLabel}" — expected BTC/ETH/SOL/XRP`);
        issues++;
      }
      // 2. contractDurationMinutes: should be 5/15/60/240, not 0
      if (!t.contractDurationMinutes || ![5, 15, 60, 240].includes(t.contractDurationMinutes)) {
        console.warn(`[METRIC_CHECK] Trade ${t.id}: contractDurationMinutes=${t.contractDurationMinutes} — expected 5/15/60/240`);
        issues++;
      }
      // 3. momentumAligned: should be boolean, not string
      if (typeof t.momentumAligned !== "boolean") {
        console.warn(`[METRIC_CHECK] Trade ${t.id}: momentumAligned=${t.momentumAligned} (type: ${typeof t.momentumAligned}) — expected boolean`);
        issues++;
      }
      // 4. delta30s and delta5m: should be present and reasonable range
      if (typeof t.delta30s !== "number") {
        console.warn(`[METRIC_CHECK] Trade ${t.id}: delta30s is not a number (${typeof t.delta30s})`);
        issues++;
      } else if (Math.abs(t.delta30s) > 5) {
        console.warn(`[METRIC_CHECK] Trade ${t.id}: delta30s=${t.delta30s}% — unusually large (>5%)`);
        issues++;
      }
      if (typeof t.delta5m !== "number") {
        console.warn(`[METRIC_CHECK] Trade ${t.id}: delta5m is not a number (${typeof t.delta5m})`);
        issues++;
      }
      // 5. won/pnl on BUY trades: verify formula
      if (t.side === "BUY") {
        const resolution = state.resolutionCache.get(t.conditionId) || null;
        if (resolution) {
          const expectedWon = t.outcome.toLowerCase() === resolution.toLowerCase();
          const { won, pnl } = computeTradePnl(t, resolution);
          if (won !== expectedWon) {
            console.warn(`[METRIC_CHECK] Trade ${t.id}: won mismatch — expected ${expectedWon}, got ${won}`);
            issues++;
          }
        }
      }
      // 6. concurrentWhales: should be >= 1 (at minimum, the current wallet)
      if (typeof t.concurrentWhales !== "number" || t.concurrentWhales < 0) {
        console.warn(`[METRIC_CHECK] Trade ${t.id}: concurrentWhales=${t.concurrentWhales} — expected >= 0`);
        issues++;
      }
    }
    if (recent.length > 0) {
      console.log(`[METRIC_CHECK] Validated ${recent.length} recent trades — ${issues === 0 ? "ALL OK ✅" : `${issues} issue(s) found ⚠`}`);
    } else {
      console.log("[METRIC_CHECK] No recent trades to validate (fresh boot)");
    }
  }

  server.listen(CONFIG.port, () => {
    console.log(`\n🕵️  Whale Spy running at http://localhost:${CONFIG.port}\n`);
  });

  connectBinance();
  connectPolymarketWs();

  // Poll all wallets in staggered fashion to avoid rate limits
  // Each wallet gets its own interval, offset by pollIntervalMs / walletCount
  let lastPollSuccess = Date.now();
  const staggerMs = Math.floor(CONFIG.pollIntervalMs / CONFIG.wallets.length);
  for (let i = 0; i < CONFIG.wallets.length; i++) {
    const w = CONFIG.wallets[i];
    // Stagger start so wallets don't all poll at the same instant
    setTimeout(() => {
      setInterval(async () => {
        const before = state.whaleTrades.length;
        await pollWhale(w.address, w.label);
        if (state.whaleTrades.length !== before) {
          lastPollSuccess = Date.now();
        }
      }, CONFIG.pollIntervalMs);
    }, i * staggerMs);
    console.log(`[boot] polling ${w.label} (${w.address.slice(0, 10)}…) every ${CONFIG.pollIntervalMs / 1000}s (offset ${i * staggerMs}ms)`);
  }

  setInterval(() => {
    const silenceSecs = ((Date.now() - lastPollSuccess) / 1000).toFixed(0);
    if (Date.now() - lastPollSuccess > 120000) {
      console.warn(`[watchdog] No new data from ANY wallet for ${silenceSecs}s — data API may be rate limiting`);
    }
  }, 30000);

  // Log realized volatility periodically for all tracked assets
  setInterval(() => {
    const parts: string[] = [];
    for (const sym of Object.keys(state.assetPrices)) {
      const vol = computeRealizedVolatility(sym);
      const p = state.assetPrices[sym]?.price || 0;
      if (vol !== null && p > 0) {
        parts.push(`${sym.replace("USDT","")}:${(vol * 100).toFixed(1)}%`);
      }
    }
    if (parts.length > 0) {
      console.log(`[vol] Realized vols: ${parts.join(" | ")} (annualized)`);
    }
  }, 60000);

  // Check contract resolutions every 30s
  setInterval(checkResolutions, 30_000);
  // Also run immediately after a short delay (let contracts load first)
  setTimeout(checkResolutions, 10_000);

  // Proactive contract subscription: pre-subscribe to upcoming contracts
  // so we have polyMid data BEFORE any whale trade arrives
  setTimeout(proactiveContractScan, 5_000);  // first scan 5s after boot
  setInterval(proactiveContractScan, 30_000); // then every 30s

  // Periodic REST book refresh for tokens with empty WS book data
  setInterval(refreshEmptyBooks, 15_000); // every 15s

  // File rotation check every 60s
  setInterval(checkEventsRotation, 60_000);
}

main().catch(console.error);
