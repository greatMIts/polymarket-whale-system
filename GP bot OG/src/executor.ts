/**
 * executor.ts — Paper & live trade execution, position tracking, PnL.
 *
 * Paper mode (default): simulates fills at whale's price
 * Live mode: stubbed — ready for Polymarket CLOB API integration
 *
 * Features:
 * - Dynamic position sizing ($30 high-conviction at price >= 0.80, $10 standard)
 * - Position stacking (up to 3 entries per conditionId)
 * - Fresh market data at decision time (polyMid, bookSpread, binancePrice)
 * - Full decision logging with wouldPass for NEW_BEST + BALANCED + GOLD_PLUS
 * - Bot trades + decisions file rotation (90K lines → CSV archives)
 */

import * as fs from "fs";
import * as crypto from "crypto";
import { CONFIG, BOT_ID, FILE_PREFIX, DEFAULT_RISK, DEFAULT_FILTER } from "./config";
import type { FilterPresetName } from "./config";
import type { WhaleTrade, BotTrade, BotSettings, BotStats } from "./types";
import { resolutionCache, marketState, getPrice, getPriceDelta, getVol1h, getBtcVol1h, getOrderBookDepth } from "./market-data";
import { checkRisk, recordCooldown, clearOldCooldowns } from "./risk-manager";
import { evaluateTrade, filterStats, unifiedFilter } from "./filter-engine";
import { onWhaleTrade, getConcurrentWhales } from "./whale-watcher";
import { trackAppend, startRotationTimer, type RotationConfig } from "./file-rotation";
import { getClobClient, isClobReady, reconnectClobClient, queryBalance, getCachedBalance, hasEnoughBalance, Side, OrderType } from "./clob-client";
import { logLiveEvent } from "./live-events";

// ─── STATE ──────────────────────────────────────────────────────────────────

// All bot trades (open + closed)
const botTrades: BotTrade[] = [];

// Running stats
let stats: BotStats = {
  totalCopyTrades: 0,
  openPositions: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  totalPnl: 0,
  todayPnl: 0,
  todayTrades: 0,
  bestTrade: 0,
  worstTrade: 0,
  avgPnlPerTrade: 0,
  tradesPassedFilter: 0,
  tradesRejectedByRisk: 0,
};

// Event log for dashboard
const eventLog: { ts: number; msg: string; type: "info" | "trade" | "risk" | "resolution" }[] = [];

// Take profit: track in-flight LIVE SELL orders to prevent race with resolvePositions
const takeProfitInFlight = new Set<string>();

function logEvent(msg: string, type: "info" | "trade" | "risk" | "resolution" = "info") {
  eventLog.unshift({ ts: Date.now(), msg, type });
  if (eventLog.length > 500) eventLog.pop();
  console.log(`[bot] ${msg}`);
}

// ─── SETTINGS (persisted) ───────────────────────────────────────────────────

let settings: BotSettings = {
  mode: "PAPER",
  activeFilter: BOT_ID,
  highConvictionSize: DEFAULT_RISK.highConvictionSize,
  lowConvictionSize: DEFAULT_RISK.lowConvictionSize,
  highConvictionThreshold: DEFAULT_RISK.highConvictionThreshold,
  maxOpenPositions: DEFAULT_RISK.maxOpenPositions,
  maxExposureUSD: DEFAULT_RISK.maxExposureUSD,
  maxLossPerHour: DEFAULT_RISK.maxLossPerHour,
  maxLossPerSession: DEFAULT_RISK.maxLossPerSession,
  maxEntriesPerContract: DEFAULT_RISK.maxEntriesPerContract,
  minStackSize: DEFAULT_RISK.minStackSize,
  allowedAssets: DEFAULT_RISK.allowedAssets,
  allowedSides: DEFAULT_RISK.allowedSides,
  cooldownMs: DEFAULT_RISK.cooldownMs,
  botEnabled: true,
  enabledWallets: DEFAULT_RISK.enabledWallets,
  // Filter parameters (v10)
  standardSize: DEFAULT_FILTER.standardSize,
  priceFloor: DEFAULT_FILTER.priceFloor,
  priceCeiling: DEFAULT_FILTER.priceCeiling,
  midEdgeRanges: DEFAULT_FILTER.midEdgeRanges,
  edgeVsSpotEnabled: DEFAULT_FILTER.edgeVsSpotEnabled,
  edgeVsSpotThreshold: DEFAULT_FILTER.edgeVsSpotThreshold,
  momentumRequired: DEFAULT_FILTER.momentumRequired,
  whaleSizeGate: DEFAULT_FILTER.whaleSizeGate,
  secsRanges5m: DEFAULT_FILTER.secsRanges5m,
  secsRanges15m: DEFAULT_FILTER.secsRanges15m,
  takeProfitEnabled: DEFAULT_RISK.takeProfitEnabled,
  takeProfitPrice: DEFAULT_RISK.takeProfitPrice,
};

export function getSettings(): BotSettings {
  return { ...settings };
}

export function updateSettings(partial: Partial<BotSettings>): { rejected?: string } {
  // Handle mode toggle to LIVE
  if (partial.mode === "LIVE" && settings.mode !== "LIVE") {
    if (!isClobReady()) {
      const reason = "CLOB client not initialized — wallet credentials missing or derivation failed. Restart the bot to retry.";
      logEvent("LIVE mode rejected — CLOB not ready", "risk");
      delete partial.mode;
      // Apply remaining settings, then return rejection
      Object.assign(settings, partial);
      settings.activeFilter = BOT_ID;
      if ((settings as any).excludedWallets !== undefined) delete (settings as any).excludedWallets;
      if (!settings.enabledWallets) settings.enabledWallets = DEFAULT_RISK.enabledWallets;
      saveSettings();
      logEvent(`Settings updated (LIVE rejected): ${JSON.stringify(partial)}`);
      return { rejected: reason };
    } else {
      logLiveEvent({ event: "MODE_SWITCH", from: "PAPER", to: "LIVE" });
      const eff = getEffectiveSettings();
      logEvent(
        `LIVE RISK LIMITS ACTIVE: maxExposure=$${eff.maxExposureUSD}, maxLoss/hr=$${eff.maxLossPerHour}, maxLoss/session=$${eff.maxLossPerSession}, LC=$${eff.lowConvictionSize}/HC=$${eff.highConvictionSize}@${eff.highConvictionThreshold} sizing, max ${eff.maxEntriesPerContract} entries/contract`,
        "info"
      );
      // Reset per-contract tracking on mode switch to LIVE
      ordersPerContract.clear();
      autoFallbackReason = null;
      autoFallbackTs = null;
      consecutiveFailures = 0;
      consecutiveBalanceErrors = 0;
      clobReconnecting = false;
    }
  } else if (partial.mode === "PAPER" && settings.mode === "LIVE") {
    logLiveEvent({ event: "MODE_SWITCH", from: "LIVE", to: "PAPER" });
    logEvent("Switched to PAPER mode", "info");
  }

  Object.assign(settings, partial);
  // Always force activeFilter to BOT_ID (env-var determined)
  settings.activeFilter = BOT_ID;
  // v10.1: if old dashboard sent excludedWallets, clean up and ensure enabledWallets exists
  if ((settings as any).excludedWallets !== undefined) {
    delete (settings as any).excludedWallets;
  }
  if (!settings.enabledWallets) {
    settings.enabledWallets = DEFAULT_RISK.enabledWallets;
  }
  saveSettings();
  logEvent(`Settings updated: ${JSON.stringify(partial)}`);
  return {};
}

function saveSettings() {
  try {
    fs.writeFileSync(CONFIG.settingsFile, JSON.stringify(settings, null, 2));
  } catch {}
}

function loadSettings() {
  try {
    if (fs.existsSync(CONFIG.settingsFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.settingsFile, "utf-8"));
      Object.assign(settings, data);
      // Force activeFilter to BOT_ID regardless of saved value
      settings.activeFilter = BOT_ID;
      // ALWAYS boot into PAPER mode — never auto-resume LIVE
      settings.mode = "PAPER";
      // Migrate old settings: provide defaults for missing new fields
      if ((settings as any).positionSizeUsdc !== undefined) {
        // Old format — migrate
        if (!settings.highConvictionSize) settings.highConvictionSize = DEFAULT_RISK.highConvictionSize;
        if (!settings.lowConvictionSize) settings.lowConvictionSize = DEFAULT_RISK.lowConvictionSize;
        if (!settings.highConvictionThreshold) settings.highConvictionThreshold = DEFAULT_RISK.highConvictionThreshold;
        if (!settings.maxExposureUSD) settings.maxExposureUSD = DEFAULT_RISK.maxExposureUSD;
        if (!settings.maxLossPerHour) settings.maxLossPerHour = DEFAULT_RISK.maxLossPerHour;
        if (!settings.maxLossPerSession) settings.maxLossPerSession = DEFAULT_RISK.maxLossPerSession;
        if (!settings.maxEntriesPerContract) settings.maxEntriesPerContract = DEFAULT_RISK.maxEntriesPerContract;
        if (!settings.minStackSize) settings.minStackSize = DEFAULT_RISK.minStackSize;
        delete (settings as any).positionSizeUsdc;
        delete (settings as any).maxDailyLoss;
      }
      // v10.1: Migrate excludedWallets → enabledWallets (inclusion model)
      if ((settings as any).excludedWallets !== undefined && !settings.enabledWallets) {
        const excluded: string[] = (settings as any).excludedWallets || [];
        const allPrefixes = DEFAULT_RISK.enabledWallets; // use default as full list
        settings.enabledWallets = allPrefixes.filter(w => !excluded.includes(w));
        console.log(`[SETTINGS MIGRATION] excludedWallets [${excluded.join(",")}] → enabledWallets [${settings.enabledWallets.join(",")}]`);
        delete (settings as any).excludedWallets;
      }
      if (!settings.enabledWallets) {
        settings.enabledWallets = DEFAULT_RISK.enabledWallets;
      }

      // v10.2: midEdge — single threshold → range-based migration
      if ((settings as any).midEdgeThreshold !== undefined && !Array.isArray(settings.midEdgeRanges)) {
        const oldThreshold = (settings as any).midEdgeThreshold;
        settings.midEdgeRanges = [{ operator: "lt" as const, value: oldThreshold }];
        delete (settings as any).midEdgeThreshold;
        console.log(`[SETTINGS MIGRATION] midEdgeThreshold ${oldThreshold} → midEdgeRanges ${JSON.stringify(settings.midEdgeRanges)}`);
      }
      if (!Array.isArray(settings.midEdgeRanges)) {
        settings.midEdgeRanges = DEFAULT_FILTER.midEdgeRanges;
      }

      // v10: filter parameter migration — populate from per-bot defaults if missing
      if (settings.standardSize === undefined) settings.standardSize = DEFAULT_FILTER.standardSize;
      if (settings.priceFloor === undefined) settings.priceFloor = DEFAULT_FILTER.priceFloor;
      if (settings.priceCeiling === undefined) settings.priceCeiling = DEFAULT_FILTER.priceCeiling;
      if (settings.edgeVsSpotEnabled === undefined) settings.edgeVsSpotEnabled = DEFAULT_FILTER.edgeVsSpotEnabled;
      if (settings.edgeVsSpotThreshold === undefined) settings.edgeVsSpotThreshold = DEFAULT_FILTER.edgeVsSpotThreshold;
      if (settings.momentumRequired === undefined) settings.momentumRequired = DEFAULT_FILTER.momentumRequired;
      if (settings.whaleSizeGate === undefined) settings.whaleSizeGate = DEFAULT_FILTER.whaleSizeGate;
      // secsRanges: array-of-arrays — needs special handling
      if (!Array.isArray(settings.secsRanges5m)) {
        try { settings.secsRanges5m = typeof settings.secsRanges5m === "string" ? JSON.parse(settings.secsRanges5m) : DEFAULT_FILTER.secsRanges5m; }
        catch { settings.secsRanges5m = DEFAULT_FILTER.secsRanges5m; }
      }
      if (!Array.isArray(settings.secsRanges15m)) {
        try { settings.secsRanges15m = typeof settings.secsRanges15m === "string" ? JSON.parse(settings.secsRanges15m) : DEFAULT_FILTER.secsRanges15m; }
        catch { settings.secsRanges15m = DEFAULT_FILTER.secsRanges15m; }
      }
      console.log(`[settings] Filter params: floor=${settings.priceFloor}, ceil=${settings.priceCeiling}, edgeEnabled=${settings.edgeVsSpotEnabled}, gate=$${settings.whaleSizeGate}, secs5m=${JSON.stringify(settings.secsRanges5m)}`);
      // v11: take profit migration
      if (settings.takeProfitEnabled === undefined) settings.takeProfitEnabled = false;
      if (settings.takeProfitPrice === undefined) settings.takeProfitPrice = 0.90;

      // BAL-specific migrations
      if (BOT_ID === "BALANCED") {
        // Force maxEntriesPerContract = 1 — no stacking for LIVE safety
        if (settings.maxEntriesPerContract !== 1) {
          console.log(`[SETTINGS] BAL maxEntriesPerContract ${settings.maxEntriesPerContract} → 1 (no stacking for LIVE safety)`);
        }
        settings.maxEntriesPerContract = 1;
      }

      // GP-specific migrations — OG GOLD: no stacking, conservative risk
      if (BOT_ID === "GOLD_PLUS") {
        // Force maxEntriesPerContract = 1 — no stacking
        if (settings.maxEntriesPerContract !== 1) {
          console.log(`[SETTINGS] GP maxEntriesPerContract ${settings.maxEntriesPerContract} → 1 (OG GOLD: no stacking)`);
        }
        settings.maxEntriesPerContract = 1;
        // Force conservative risk limits (PAPER data collection)
        settings.maxOpenPositions = 15;
        settings.maxExposureUSD = 300;
        settings.maxLossPerHour = 100;
        settings.maxLossPerSession = 200;
        settings.cooldownMs = 5000;
      }

      saveSettings();
      console.log(`[settings] Loaded: mode=${settings.mode}, filter=${settings.activeFilter}, hcSize=$${settings.highConvictionSize}, lcSize=$${settings.lowConvictionSize}`);
    }
  } catch {}
}

// ─── LIVE MODE — RISK OVERRIDES & SAFETY ──────────────────────────────────

const LIVE_OVERRIDES: Partial<BotSettings> = {
  maxOpenPositions: 15,
  maxExposureUSD: 500,
  maxLossPerHour: 100,
  maxLossPerSession: 200,
  maxEntriesPerContract: 3,
  cooldownMs: 5000,
};

// BAL-specific LIVE overrides — conservative limits for initial LIVE phase
const BAL_LIVE_OVERRIDES: Partial<BotSettings> = {
  maxOpenPositions: 10,
  maxExposureUSD: 200,
  maxLossPerHour: 50,
  maxLossPerSession: 100,
  maxEntriesPerContract: 1,       // NO stacking for BAL LIVE safety
};

// GP-specific LIVE overrides — OG GOLD: no stacking, conservative limits
const GP_LIVE_OVERRIDES: Partial<BotSettings> = {
  maxExposureUSD: 300,
  maxLossPerHour: 100,
  maxLossPerSession: 200,
  maxEntriesPerContract: 1,       // OG GOLD: NO stacking — 1 entry per contract
};

// Returns settings with LIVE overrides applied when mode is LIVE
export function getEffectiveSettings(): BotSettings {
  if (settings.mode === "LIVE") {
    const base = { ...settings, ...LIVE_OVERRIDES };
    if (BOT_ID === "BALANCED") {
      return { ...base, ...BAL_LIVE_OVERRIDES };
    }
    if (BOT_ID === "GOLD_PLUS") {
      return { ...base, ...GP_LIVE_OVERRIDES };
    }
    return base;
  }
  return { ...settings };
}

// ─── CONSECUTIVE FAILURE TRACKING & AUTO-FALLBACK ──────────────────────────

let consecutiveFailures = 0;
let autoFallbackReason: string | null = null;
let autoFallbackTs: number | null = null;
let liveOrdersPlaced = 0;
let liveOrdersFailed = 0;
let lastOrderTs: number | null = null;
let lastOrderStatus: string | null = null;

// ─── BALANCE ERROR CIRCUIT BREAKER ──────────────────────────────────────────
let consecutiveBalanceErrors = 0;
let clobReconnecting = false;
const MAX_BALANCE_ERRORS = 3; // after 3 consecutive balance rejections → auto-fallback

function incrementFailureCount() {
  consecutiveFailures++;
  liveOrdersFailed++;
  lastOrderTs = Date.now();
  lastOrderStatus = "FAILED";
  if (consecutiveFailures >= 3) {
    triggerAutoFallback(`${consecutiveFailures} consecutive order failures`);
  }
}

function resetFailureCount() {
  consecutiveFailures = 0;
  consecutiveBalanceErrors = 0;
  liveOrdersPlaced++;
  lastOrderTs = Date.now();
  lastOrderStatus = "PLACED";
  // Refresh cached balance after successful trade (non-blocking)
  queryBalance().catch(() => {});
}

function triggerAutoFallback(reason: string) {
  console.warn("⚠ AUTO-FALLBACK TO PAPER — Reason: " + reason);
  settings.mode = "PAPER";
  autoFallbackReason = reason;
  autoFallbackTs = Date.now();
  saveSettings();
  logLiveEvent({ event: "AUTO_FALLBACK", reason });
  logEvent(`⚠ AUTO-FALLBACK TO PAPER — ${reason}`, "risk");
}

// ─── ORDER TRACKING PER CONTRACT (shared PAPER + LIVE) ──────────────────
// Tracks orders placed per conditionId — prevents stacking beyond maxEntriesPerContract
// LIVE: recordOrder() reserves slot BEFORE async CLOB call (race-condition guard),
//       decrementOrder() rolls back on failure so the slot isn't wasted
// PAPER: recordOrder() after canPlaceOrder() check (synchronous, no race)
// Cleaned up when a contract resolves

const ordersPerContract = new Map<string, { count: number; totalUSD: number; lastOrderTime: number }>();

function canPlaceOrder(conditionId: string, maxEntries: number): boolean {
  const existing = ordersPerContract.get(conditionId);
  if (!existing) return true;
  if (existing.count >= maxEntries) {
    const mode = settings.mode;
    console.warn(`⏭ ${mode} SKIP: maxEntriesPerContract (${maxEntries}) reached for ${conditionId.slice(0, 16)}… (have ${existing.count})`);
    if (mode === "LIVE") {
      logLiveEvent({
        event: "ORDER_SKIPPED",
        reason: "MAX_ENTRIES_PER_CONTRACT",
        conditionId,
        existingCount: existing.count,
        existingUSD: existing.totalUSD,
        maxEntries,
      });
    }
    return false;
  }
  return true;
}

function recordOrder(conditionId: string, orderSize: number) {
  const existing = ordersPerContract.get(conditionId) || { count: 0, totalUSD: 0, lastOrderTime: 0 };
  ordersPerContract.set(conditionId, {
    count: existing.count + 1,
    totalUSD: existing.totalUSD + orderSize,
    lastOrderTime: Date.now(),
  });
}

function decrementOrder(conditionId: string, orderSize: number) {
  const existing = ordersPerContract.get(conditionId);
  if (!existing || existing.count <= 0) return;
  const newCount = existing.count - 1;
  if (newCount <= 0) {
    ordersPerContract.delete(conditionId);
    console.log(`↩ Rolled back order slot for ${conditionId.slice(0, 16)}… (now 0 entries, removed from tracker)`);
  } else {
    existing.count = newCount;
    existing.totalUSD = Math.max(0, existing.totalUSD - orderSize);
    console.log(`↩ Rolled back order slot for ${conditionId.slice(0, 16)}… (now ${newCount} entries)`);
  }
}

function cleanupResolvedContracts() {
  for (const condId of ordersPerContract.keys()) {
    if (resolutionCache.has(condId) && resolutionCache.get(condId) !== null) {
      ordersPerContract.delete(condId);
    }
  }
}

// Live state for dashboard
export function getLiveState() {
  // Compute LIVE-only PnL and W/L
  const liveClosed = botTrades.filter(t => t.mode === "LIVE" && t.status !== "OPEN");
  const livePnl = liveClosed.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const liveWins = liveClosed.filter(t => t.won === true).length;
  const liveLosses = liveClosed.filter(t => t.won === false).length;

  return {
    clobReady: isClobReady(),
    consecutiveFailures,
    consecutiveBalanceErrors,
    clobReconnecting,
    walletBalance: getCachedBalance(),
    autoFallbackReason,
    autoFallbackTs,
    liveOrdersPlaced,
    liveOrdersFailed,
    lastOrderTs,
    lastOrderStatus,
    livePnl,
    liveWins,
    liveLosses,
  };
}

// ─── GETTERS ────────────────────────────────────────────────────────────────

export function getOpenPositions(): BotTrade[] {
  return botTrades.filter(t => t.status === "OPEN");
}

export function getClosedPositions(): BotTrade[] {
  return botTrades.filter(t => t.status !== "OPEN");
}

export function getAllBotTrades(): BotTrade[] {
  return botTrades;
}

export function getStats(): BotStats {
  return { ...stats };
}

export function resetStats() {
  stats.totalCopyTrades = 0;
  stats.openPositions = 0;
  stats.wins = 0;
  stats.losses = 0;
  stats.winRate = 0;
  stats.totalPnl = 0;
  stats.todayPnl = 0;
  stats.todayTrades = 0;
  stats.bestTrade = 0;
  stats.worstTrade = 0;
  stats.avgPnlPerTrade = 0;
  stats.tradesPassedFilter = 0;
  stats.tradesRejectedByRisk = 0;
  // Clear ALL trades — open and closed
  botTrades.length = 0;
  // Wipe file on disk
  try {
    fs.writeFileSync(CONFIG.botTradesFile, "");
  } catch (e: any) {
    console.error("[reset] Failed to wipe bot trades file:", e.message);
  }
  logEvent("Full reset — all positions and stats cleared", "info");
}

export function getEventLog() {
  return eventLog;
}

export function getFilterStats() {
  return { ...filterStats };
}

// ─── TODAY'S PnL ────────────────────────────────────────────────────────────

function getTodayPnl(): number {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const ts = todayStart.getTime();

  return botTrades
    .filter(t => t.status !== "OPEN" && t.pnl !== null && t.ts >= ts)
    .reduce((sum, t) => sum + (t.pnl || 0), 0);
}

function getTodayTradeCount(): number {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return botTrades.filter(t => t.ts >= todayStart.getTime()).length;
}

// ─── DYNAMIC POSITION SIZING ────────────────────────────────────────────────

function getTradeSize(entryPrice: number, s: BotSettings): { sizeUsdc: number; sizeReason: string } {
  if (entryPrice >= s.highConvictionThreshold) {
    return {
      sizeUsdc: s.highConvictionSize,
      sizeReason: `HIGH_CONVICTION (price ${entryPrice.toFixed(3)} >= ${s.highConvictionThreshold})`,
    };
  }
  return {
    sizeUsdc: s.lowConvictionSize,
    sizeReason: "STANDARD",
  };
}

// ─── FRESH MARKET DATA AT DECISION TIME ─────────────────────────────────────

function getFreshPolyMid(tokenId: string): number {
  const book = marketState.tokenBook.get(tokenId) || { ask: 0, bid: 0 };
  return (book.ask > 0 && book.bid > 0) ? (book.ask + book.bid) / 2 : 0;
}

function getFreshBookSpread(tokenId: string): number {
  const book = marketState.tokenBook.get(tokenId) || { ask: 0, bid: 0 };
  return (book.ask > 0 && book.bid > 0) ? (book.ask - book.bid) : 0;
}

// ─── SESSION LABEL ──────────────────────────────────────────────────────────

function getSessionLabel(ts: number): string {
  const hour = new Date(ts).getUTCHours();
  if (hour >= 0 && hour < 8) return "ASIA";
  if (hour >= 8 && hour < 14) return "EUROPE";
  if (hour >= 14 && hour < 21) return "US";
  return "LATE_US";
}

// ─── EXECUTE COPY TRADE ─────────────────────────────────────────────────────

async function executeCopyTrade(whaleTrade: WhaleTrade, filterPreset: FilterPresetName, sizeUsdc: number, sizeReason: string) {
  const id = `bot_${crypto.randomBytes(8).toString("hex")}`;

  // Stacking: use shared ordersPerContract tracker for accurate count
  const existingTracker = ordersPerContract.get(whaleTrade.conditionId);
  const stackEntry = existingTracker ? existingTracker.count : 1; // current slot (already recorded for LIVE)
  const stackTotal = stackEntry;

  // Fresh market data at OUR decision time (not the whale's snapshot)
  const polyMidAtDecision = getFreshPolyMid(whaleTrade.asset);
  const bookSpread = getFreshBookSpread(whaleTrade.asset);
  const binancePrice = getPrice(whaleTrade.binanceSymbol);
  const decisionAt = Date.now();
  const latencyMs = decisionAt - whaleTrade.ts;

  // Latency breakdown log
  const apiLag = whaleTrade.detectedAt ? whaleTrade.detectedAt - whaleTrade.ts : latencyMs;
  const processLag = whaleTrade.detectedAt ? decisionAt - whaleTrade.detectedAt : 0;
  console.log(`[LATENCY] ${whaleTrade.walletLabel} ${whaleTrade.assetLabel} | total=${(latencyMs / 1000).toFixed(1)}s | apiLag=${(apiLag / 1000).toFixed(1)}s | process=${processLag}ms`);

  // Statistical columns — per-asset vol1h
  const vol1h = getVol1h(whaleTrade.binanceSymbol || "BTCUSDT");
  const concurrentWhales = getConcurrentWhales(whaleTrade.conditionId, Date.now());
  const sessionLabel = getSessionLabel(Date.now());
  const orderBookDepth = getOrderBookDepth(whaleTrade.asset);

  // ── Determine entry price and slippage based on mode ──────────────────
  let entryPrice: number;
  let slippage: number;
  let actualMode: "PAPER" | "LIVE" = settings.mode;
  let liveConfirmed = false; // true only when FOK fill is confirmed

  if (settings.mode === "LIVE") {
    const client = getClobClient();
    if (!client) {
      console.error("LIVE mode active but CLOB client unavailable — executing as PAPER");
      // Fall through to PAPER logic for this trade (don't switch mode globally)
      entryPrice = whaleTrade.price;
      slippage = 0;
      actualMode = "PAPER";
      liveConfirmed = true; // PAPER is always confirmed
    } else {
      // LIVE stacking guard — check AND reserve BEFORE async CLOB call
      // Record immediately to prevent race condition (multiple async orders in flight)
      const effectiveLiveSettings = getEffectiveSettings();
      const maxStack = effectiveLiveSettings.maxEntriesPerContract;
      const currentStack = ordersPerContract.get(whaleTrade.conditionId)?.count || 0;
      if (!canPlaceOrder(whaleTrade.conditionId, maxStack)) {
        return; // skip — already at max entries for this contract
      }
      recordOrder(whaleTrade.conditionId, sizeUsdc); // reserve slot BEFORE async call
      console.log(`[LIVE ORDER] ${whaleTrade.conditionId.slice(0, 16)}…: entry ${currentStack + 1}/${maxStack}, ordersPerContract size=${ordersPerContract.size}`);

      try {
        const tokenID = whaleTrade.asset;
        if (!tokenID || tokenID === "" || tokenID === "undefined") {
          throw new Error("Missing tokenID (asset field) — cannot place CLOB order");
        }

        // FOK BUY at whale's price + 0.02 buffer (slippage tolerance)
        // FOK = Fill-Or-Kill: fills immediately at limit or better, or cancels. No resting orders.
        const priceBuffer = 0.02;
        const limitPrice = Math.min(whaleTrade.price + priceBuffer, 0.99);
        const roundedPrice = Math.round(limitPrice * 100) / 100; // tick size 0.01

        // Look up negRisk from contract cache (don't hardcode)
        const contractInfo = marketState.assetToContract.get(tokenID);
        const negRisk = contractInfo?.negRisk ?? false;

        // ── PRE-TRADE BALANCE GATE ──────────────────────────────────────
        // Skip order locally if cached balance is confidently too low.
        if (!hasEnoughBalance(sizeUsdc)) {
          const bal = getCachedBalance();
          console.warn(`⏭ SKIP: cached balance $${bal.balance?.toFixed(2)} too low for $${sizeUsdc} (checked ${Math.round((Date.now() - bal.lastChecked) / 1000)}s ago)`);
          logLiveEvent({
            event: "ORDER_SKIPPED",
            reason: "BALANCE_TOO_LOW",
            tokenID: whaleTrade.asset,
            conditionId: whaleTrade.conditionId,
            cachedBalance: bal.balance,
            requestedSize: sizeUsdc,
          });
          decrementOrder(whaleTrade.conditionId, sizeUsdc);
          consecutiveBalanceErrors++;
          liveOrdersFailed++;
          lastOrderTs = Date.now();
          lastOrderStatus = "BALANCE_TOO_LOW";
          if (consecutiveBalanceErrors >= MAX_BALANCE_ERRORS) {
            triggerAutoFallback(`${consecutiveBalanceErrors} consecutive balance failures — cached balance $${bal.balance?.toFixed(2)}`);
          }
          return;
        }

        console.log(`[LIVE] Placing FOK order: token=${tokenID.slice(0, 10)}…, price=${roundedPrice}, size=${sizeUsdc}, feeRateBps=1000`);

        const orderResponse = await client.createAndPostOrder({
          tokenID: tokenID,
          price: roundedPrice,
          size: sizeUsdc,
          side: Side.BUY,
          feeRateBps: 1000,
          orderType: OrderType.FOK,
        } as any, {
          tickSize: "0.01",
          negRisk,
        });

        if (!orderResponse || !orderResponse.orderID) {
          throw new Error("No orderID in response: " + JSON.stringify(orderResponse));
        }

        console.log(`✅ LIVE FOK filled: ${orderResponse.orderID} | ${tokenID} | $${sizeUsdc} @ ${roundedPrice}`);

        entryPrice = roundedPrice;
        slippage = roundedPrice - whaleTrade.price;
        liveConfirmed = true;

        logLiveEvent({
          event: "ORDER_PLACED",
          orderID: orderResponse.orderID,
          orderType: "FOK",
          tokenID,
          conditionId: whaleTrade.conditionId,
          side: "BUY",
          requestedPrice: roundedPrice,
          requestedSize: sizeUsdc,
          whalePrice: whaleTrade.price,
          whaleTxHash: whaleTrade.txHash,
          slippage,
        });

        resetFailureCount();
      } catch (error: any) {
        const errMsg = (error.message || "").toLowerCase();

        // Roll back the optimistic slot reservation on ANY failure
        decrementOrder(whaleTrade.conditionId, sizeUsdc);

        // Classify error: balance/FOK-rejection are skip-graceful, everything else is system failure
        const isBalanceError = errMsg.includes("balance") || errMsg.includes("allowance") || errMsg.includes("insufficient");
        const isFokRejection = errMsg.includes("no fill") || errMsg.includes("would not") || errMsg.includes("cancelled")
          || errMsg.includes("crosses") || errMsg.includes("cross the book");

        if (isBalanceError) {
          consecutiveBalanceErrors++;
          liveOrdersFailed++;
          lastOrderTs = Date.now();
          lastOrderStatus = "BALANCE_ERROR";
          console.warn(`⏭ SKIP: insufficient balance for $${sizeUsdc} order (${consecutiveBalanceErrors}/${MAX_BALANCE_ERRORS} consecutive) — ${error.message}`);
          logLiveEvent({
            event: "ORDER_SKIPPED",
            reason: "INSUFFICIENT_BALANCE",
            tokenID: whaleTrade.asset,
            conditionId: whaleTrade.conditionId,
            requestedSize: sizeUsdc,
            consecutiveBalanceErrors,
            error: error.message,
          });
          // Refresh balance cache after every API rejection
          queryBalance().catch(() => {});

          // At 2 consecutive errors: try CLOB reconnect (session may be stale)
          if (consecutiveBalanceErrors === 2 && !clobReconnecting) {
            clobReconnecting = true;
            console.warn(`⚠ ${consecutiveBalanceErrors} consecutive balance errors — attempting CLOB reconnect...`);
            logEvent(`⚠ CLOB reconnect triggered after ${consecutiveBalanceErrors} balance errors`, "risk");

            reconnectClobClient().then((ok) => {
              clobReconnecting = false;
              if (ok) {
                consecutiveBalanceErrors = 0;
                logEvent("✅ CLOB reconnected — balance errors may resolve", "info");
              } else {
                logEvent("❌ CLOB reconnect failed — will fallback if errors continue", "risk");
              }
            }).catch(() => { clobReconnecting = false; });
          }

          // At MAX_BALANCE_ERRORS: give up and fallback to PAPER
          if (consecutiveBalanceErrors >= MAX_BALANCE_ERRORS) {
            triggerAutoFallback(`${consecutiveBalanceErrors} consecutive balance rejections — wallet may be empty, funds locked, or CLOB session stale`);
          }
          return;
        }

        if (isFokRejection) {
          console.warn(`⏭ SKIP: FOK couldn't fill at ${Math.round(Math.min(whaleTrade.price + 0.02, 0.99) * 100) / 100} — ${error.message}`);
          logLiveEvent({
            event: "ORDER_SKIPPED",
            reason: "FOK_NO_FILL",
            tokenID: whaleTrade.asset,
            conditionId: whaleTrade.conditionId,
            requestedPrice: Math.round(Math.min(whaleTrade.price + 0.02, 0.99) * 100) / 100,
            requestedSize: sizeUsdc,
            error: error.message,
          });
          return; // skip gracefully, no failure count
        }

        // System failure — counts toward auto-fallback (3 consecutive → PAPER)
        console.error("❌ LIVE order FAILED (system):", error.message);
        logLiveEvent({
          event: "ORDER_FAILED",
          tokenID: whaleTrade.asset,
          conditionId: whaleTrade.conditionId,
          requestedPrice: Math.round(Math.min(whaleTrade.price + 0.02, 0.99) * 100) / 100,
          requestedSize: sizeUsdc,
          whalePrice: whaleTrade.price,
          whaleTxHash: whaleTrade.txHash,
          error: error.message,
        });

        incrementFailureCount();
        return;
      }
    }
  } else {
    // PAPER mode: fill at whale's price — also enforce stacking via shared tracker
    const effectivePaperSettings = getEffectiveSettings();
    if (!canPlaceOrder(whaleTrade.conditionId, effectivePaperSettings.maxEntriesPerContract)) {
      return;
    }
    recordOrder(whaleTrade.conditionId, sizeUsdc);
    entryPrice = whaleTrade.price;
    slippage = 0;
    liveConfirmed = true; // PAPER is always confirmed
  }

  const shares = sizeUsdc / entryPrice;
  const fillPriceVsMid = polyMidAtDecision > 0 ? entryPrice - polyMidAtDecision : null;

  const botTrade: BotTrade = {
    id,
    ts: Date.now(),
    tsIso: new Date().toISOString(),
    whaleTradeId: whaleTrade.id,
    walletLabel: whaleTrade.walletLabel,
    conditionId: whaleTrade.conditionId,
    title: whaleTrade.title,
    side: whaleTrade.side,
    outcome: whaleTrade.outcome,
    entryPrice,
    sizeUsdc,
    shares,
    asset: whaleTrade.asset,
    filterPreset,
    midEdge: whaleTrade.midEdge,
    edgeVsSpot: whaleTrade.edgeVsSpot,
    momentumAligned: whaleTrade.momentumAligned,
    secsRemaining: whaleTrade.secondsRemainingInContract,
    assetLabel: whaleTrade.assetLabel,
    // New data columns
    botId: BOT_ID,
    contractDuration: whaleTrade.contractDurationMinutes,
    sizeReason,
    stackEntry,
    stackTotal,
    stackTriggerSize: whaleTrade.usdcSize,
    whaleTxHash: whaleTrade.txHash,
    latencyMs,
    spotPrice: binancePrice,
    polyMidAtDecision,
    bookSpread,
    // Statistical columns
    slippage,
    fillPriceVsMid,
    vol1h,
    concurrentWhales,
    sessionLabel,
    orderBookDepth,
    // Resolution
    resolution: null,
    won: null,
    pnl: null,
    exitPrice: null,
    resolvedAt: null,
    status: "OPEN",
    mode: actualMode,
    confirmed: liveConfirmed,
    // Whale context columns
    whaleUsdcSize: whaleTrade.usdcSize,
    whalePrice: whaleTrade.price,
    delta30s: getPriceDelta(whaleTrade.binanceSymbol || "BTCUSDT", 30),
    delta5m: getPriceDelta(whaleTrade.binanceSymbol || "BTCUSDT", 300),
  };

  botTrades.unshift(botTrade);
  recordCooldown(whaleTrade.conditionId);

  // Persist
  try {
    fs.appendFileSync(CONFIG.botTradesFile, JSON.stringify(botTrade) + "\n");
    trackAppend(botTradesRotationConfig);
  } catch {}

  stats.totalCopyTrades++;
  stats.openPositions = getOpenPositions().length;

  const modeTag = actualMode === "PAPER" ? "[PAPER]" : "[LIVE]";
  const stackTag = stackEntry > 1 ? ` (stack ${stackEntry}/${stackTotal})` : "";
  const sizeTag = sizeReason.startsWith("HIGH") ? " ⚡" : "";
  logEvent(
    `${modeTag} COPY ${whaleTrade.walletLabel} — ${whaleTrade.side} ${whaleTrade.outcome} ` +
    `@ ${entryPrice.toFixed(3)} | $${sizeUsdc.toFixed(2)}${sizeTag}${stackTag} | ${whaleTrade.assetLabel} | ` +
    `filter: ${filterPreset} | secsLeft: ${whaleTrade.secondsRemainingInContract.toFixed(0)}`,
    "trade"
  );
}

// ─── RESOLVE POSITIONS ──────────────────────────────────────────────────────

export function resolvePositions() {
  const open = getOpenPositions();
  let newResolutions = 0;

  for (const pos of open) {
    // --- FALLBACK: force-resolve stale positions using CLOB book price ---
    const contract = marketState.contractCache.get(pos.conditionId);
    const endTs = contract?.endTs || 0;
    const minutesPastEnd = endTs > 0 ? (Date.now() - endTs) / 60_000 : 0;

    if (minutesPastEnd > 10 && !resolutionCache.has(pos.conditionId)) {
      // Contract ended 10+ min ago with no Gamma resolution — use CLOB book price
      const book = marketState.tokenBook.get(pos.asset);
      if (book) {
        const mid = (book.bid + book.ask) / 2;
        if (mid > 0.85) {
          resolutionCache.set(pos.conditionId, pos.outcome);  // this outcome won
          logEvent(`🔄 Force-resolved ${pos.title.slice(0, 40)} via book price (mid=${mid.toFixed(3)})`, "resolution");
        } else if (mid < 0.15) {
          // This outcome lost — set resolution to the opposite
          const otherOutcome = pos.outcome.toLowerCase() === "up" ? "Down" : "Up";
          resolutionCache.set(pos.conditionId, otherOutcome);
          logEvent(`🔄 Force-resolved ${pos.title.slice(0, 40)} via book price (mid=${mid.toFixed(3)})`, "resolution");
        } else if (minutesPastEnd > 60) {
          // 1 hour past end, book price inconclusive — mark as expired
          resolutionCache.set(pos.conditionId, "__EXPIRED__");
          logEvent(`⏰ Force-expired ${pos.title.slice(0, 40)} — ended ${Math.round(minutesPastEnd)}min ago, book mid=${mid.toFixed(3)}`, "resolution");
        }
      } else if (minutesPastEnd > 60) {
        // 1 hour past end, no book data at all — mark as expired
        resolutionCache.set(pos.conditionId, "__EXPIRED__");
        logEvent(`⏰ Force-expired ${pos.title.slice(0, 40)} — ended ${Math.round(minutesPastEnd)}min ago, no book data`, "resolution");
      }
    }

    // Handle __EXPIRED__ positions (force-closed with 0 PnL)
    if (resolutionCache.get(pos.conditionId) === "__EXPIRED__") {
      pos.resolution = "EXPIRED";
      pos.won = null;
      pos.pnl = 0;
      pos.exitPrice = null;
      pos.resolvedAt = Date.now();
      pos.status = "EXPIRED";
      newResolutions++;
      logEvent(`⏰ EXPIRED: ${pos.title.slice(0, 40)} — contract ended ${Math.round(minutesPastEnd)}min ago`, "resolution");
      continue;
    }

    const resolution = resolutionCache.get(pos.conditionId);
    if (resolution === undefined || resolution === null) continue;
    // Skip positions with in-flight take profit SELL orders
    if (takeProfitInFlight.has(pos.id)) continue;

    // Safety check: if this LIVE position was never confirmed (FOK didn't fill),
    // remove it without counting in W/L stats — it had 0 shares.
    if (!pos.confirmed && pos.mode === "LIVE") {
      console.log(`⚠ Removing unconfirmed LIVE position (no FOK fill) — ${pos.conditionId.slice(0, 16)}…`);
      pos.resolution = resolution;
      pos.won = null;
      pos.pnl = 0;
      pos.exitPrice = null;
      pos.resolvedAt = Date.now();
      pos.status = "EXPIRED";
      newResolutions++;
      logEvent(`⚠ EXPIRED (unconfirmed): ${pos.title.slice(0, 40)} — no FOK fill, 0 PnL`, "resolution");
      continue;
    }

    const tradeOutcome = pos.outcome.toLowerCase();
    const resOutcome = resolution.toLowerCase();
    const won = tradeOutcome === resOutcome;

    let pnl: number;
    if (pos.side === "BUY") {
      pnl = won ? (1 - pos.entryPrice) * pos.shares : -pos.entryPrice * pos.shares;
    } else {
      pnl = won ? -(1 - pos.entryPrice) * pos.shares : pos.entryPrice * pos.shares;
    }

    pos.resolution = resolution;
    pos.won = won;
    pos.pnl = pnl;
    pos.exitPrice = won ? 1 : 0;
    pos.resolvedAt = Date.now();
    pos.status = won ? "WON" : "LOST";

    if (won) stats.wins++;
    else stats.losses++;

    stats.totalPnl += pnl;
    if (pnl > stats.bestTrade) stats.bestTrade = pnl;
    if (pnl < stats.worstTrade) stats.worstTrade = pnl;

    newResolutions++;

    const emoji = won ? "✅" : "❌";
    const stackTag = pos.stackEntry > 1 ? ` [stack ${pos.stackEntry}]` : "";
    logEvent(
      `${emoji} ${pos.title.slice(0, 40)} → ${resolution} | ` +
      `${won ? "WON" : "LOST"} $${pnl.toFixed(2)} | $${pos.sizeUsdc}${stackTag} | mode: ${pos.mode}`,
      "resolution"
    );
  }

  if (newResolutions > 0) {
    recalcStats();
    cleanupResolvedContracts();
  }
}

function recalcStats() {
  const closed = getClosedPositions();
  stats.openPositions = getOpenPositions().length;
  stats.winRate = closed.length > 0 ? (stats.wins / closed.length) * 100 : 0;
  stats.totalPnl = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
  stats.todayPnl = getTodayPnl();
  stats.todayTrades = getTodayTradeCount();
  stats.avgPnlPerTrade = closed.length > 0 ? stats.totalPnl / closed.length : 0;
}

// ─── PERSIST TRADE UPDATE ──────────────────────────────────────────────────
// Appends the updated trade to JSONL (same pattern as new trade).
// On restart, loadBotTrades() deduplicates by id (last occurrence wins).
// Compatible with file rotation — does NOT rewrite the entire file.

function persistTradeUpdate(trade: BotTrade) {
  try {
    fs.appendFileSync(CONFIG.botTradesFile, JSON.stringify(trade) + "\n");
    trackAppend(botTradesRotationConfig);
  } catch (e: any) {
    console.error("[persistTradeUpdate] Failed:", e.message);
  }
}

// ─── TAKE PROFIT ───────────────────────────────────────────────────────────

async function checkTakeProfit() {
  const s = getEffectiveSettings();
  if (!s.takeProfitEnabled) return;
  if (s.takeProfitPrice <= 0 || s.takeProfitPrice >= 1.0) return;

  const threshold = s.takeProfitPrice;
  const open = getOpenPositions();

  for (const pos of open) {
    if (takeProfitInFlight.has(pos.id)) continue;

    // Use BID price — that's what we'd actually receive when selling
    const book = marketState.tokenBook.get(pos.asset);
    if (!book || book.bid <= 0) continue;
    if (book.bid < threshold) continue;

    // Take profit triggered
    const currentBid = book.bid;
    console.log(`[TAKE PROFIT] ${pos.title.slice(0, 40)} | bid=${currentBid.toFixed(3)} >= threshold=${threshold} | mode=${settings.mode}`);

    if (settings.mode === "LIVE") {
      takeProfitInFlight.add(pos.id);
      try {
        await executeTakeProfitLive(pos, currentBid);
      } finally {
        takeProfitInFlight.delete(pos.id);
      }
    } else {
      executeTakeProfitPaper(pos, currentBid);
    }
  }
}

function executeTakeProfitPaper(pos: BotTrade, exitPrice: number) {
  const pnl = (exitPrice - pos.entryPrice) * pos.shares;

  pos.resolution = "TAKE_PROFIT";
  pos.won = pnl > 0;
  pos.pnl = pnl;
  pos.exitPrice = exitPrice;
  pos.resolvedAt = Date.now();
  pos.status = pos.won ? "WON" : "LOST";

  if (pos.won) stats.wins++;
  else stats.losses++;
  stats.totalPnl += pnl;
  if (pnl > stats.bestTrade) stats.bestTrade = pnl;
  if (pnl < stats.worstTrade) stats.worstTrade = pnl;

  recalcStats();
  persistTradeUpdate(pos);

  const emoji = pos.won ? "\uD83C\uDFAF" : "\uD83D\uDCC9";
  logEvent(
    `${emoji} TAKE PROFIT [PAPER] ${pos.title.slice(0, 35)} | exit=${exitPrice.toFixed(3)} | entry=${pos.entryPrice.toFixed(3)} | PnL $${pnl.toFixed(2)} | $${pos.sizeUsdc}`,
    "resolution"
  );
}

async function executeTakeProfitLive(pos: BotTrade, currentBid: number) {
  if (pos.status !== "OPEN") return;  // already closed by resolvePositions during race

  const client = getClobClient();
  if (!client) {
    console.error("[TAKE PROFIT] LIVE mode but CLOB client unavailable — skipping");
    return;
  }

  // Price: bid minus 1 tick (aggressive, ensures FOK fill)
  const sellPrice = Math.round((currentBid - 0.01) * 100) / 100;
  if (sellPrice <= 0) return;

  // CLOB SELL: size = shares (tokens), NOT USDC
  const contractInfo = marketState.assetToContract.get(pos.asset);
  const negRisk = contractInfo?.negRisk ?? false;

  try {
    console.log(`[TAKE PROFIT LIVE] FOK SELL: token=${pos.asset.slice(0, 10)}…, price=${sellPrice}, shares=${pos.shares.toFixed(4)}`);

    const orderResponse = await client.createAndPostOrder({
      tokenID: pos.asset,
      price: sellPrice,
      size: pos.shares,
      side: Side.SELL,
      feeRateBps: 1000,
      orderType: OrderType.FOK,
    } as any, {
      tickSize: "0.01",
      negRisk,
    });

    // Re-check status after await — resolvePositions may have closed it
    if (pos.status !== "OPEN") {
      console.warn(`[TAKE PROFIT] Position already closed during CLOB call — discarding sell result`);
      return;
    }

    if (!orderResponse || !orderResponse.orderID) {
      throw new Error("No orderID in SELL response: " + JSON.stringify(orderResponse));
    }

    console.log(`\u2705 TAKE PROFIT SELL filled: ${orderResponse.orderID} | ${pos.asset.slice(0, 10)}… | ${pos.shares.toFixed(2)} shares @ ${sellPrice}`);

    const pnl = (sellPrice - pos.entryPrice) * pos.shares;
    pos.resolution = "TAKE_PROFIT";
    pos.won = pnl > 0;
    pos.pnl = pnl;
    pos.exitPrice = sellPrice;
    pos.resolvedAt = Date.now();
    pos.status = pos.won ? "WON" : "LOST";

    if (pos.won) stats.wins++;
    else stats.losses++;
    stats.totalPnl += pnl;
    if (pnl > stats.bestTrade) stats.bestTrade = pnl;
    if (pnl < stats.worstTrade) stats.worstTrade = pnl;
    recalcStats();
    persistTradeUpdate(pos);

    logLiveEvent({
      event: "TAKE_PROFIT_SOLD",
      orderID: orderResponse.orderID,
      tokenID: pos.asset,
      conditionId: pos.conditionId,
      sellPrice,
      entryPrice: pos.entryPrice,
      shares: pos.shares,
      pnl,
    });

    logEvent(
      `\uD83C\uDFAF TAKE PROFIT [LIVE] ${pos.title.slice(0, 35)} | sold=${sellPrice.toFixed(3)} | entry=${pos.entryPrice.toFixed(3)} | PnL $${pnl.toFixed(2)}`,
      "resolution"
    );
  } catch (error: any) {
    const errMsg = (error.message || "").toLowerCase();
    const isFokRejection = errMsg.includes("no fill") || errMsg.includes("cancelled") || errMsg.includes("crosses");

    if (isFokRejection) {
      console.warn(`[TAKE PROFIT] FOK SELL couldn't fill at ${sellPrice} — will retry next 2s cycle`);
    } else {
      console.error(`[TAKE PROFIT] SELL FAILED:`, error.message);
      logLiveEvent({
        event: "TAKE_PROFIT_FAILED",
        tokenID: pos.asset,
        conditionId: pos.conditionId,
        requestedPrice: sellPrice,
        shares: pos.shares,
        error: error.message,
      });
    }
    // Take profit failures do NOT count toward auto-fallback (consecutiveFailures).
    // The position stays OPEN and retries next 2s cycle.
  }
}

// ─── DECISIONS ROTATION CONFIG ──────────────────────────────────────────────

const DECISIONS_CSV_HEADER = "ts,decision,filterPreset,walletLabel,side,outcome,price,usdcSize,assetLabel," +
  "midEdge,edgeVsSpot,momentumAligned,secsRemaining,contractDuration," +
  "filterReasons,riskReason," +
  "wouldPass_NEW_BEST,wouldPass_BALANCED,wouldPass_GOLD_PLUS," +
  "botId,whaleTxHash,latencyMs,spotPrice,polyMidAtDecision,bookSpread," +
  "conditionId,title," +
  "vol1h,concurrentWhales,sessionLabel,orderBookDepth," +
  "delta30s,delta5m";

function decisionToCsvRow(d: any): string {
  const wp = d.wouldPass || {};
  // Backward compat: accept old or new field names
  const edge = d.edgeVsSpot ?? d.edgeVsBtc;
  const sp = d.spotPrice ?? d.binancePrice;
  const v1h = d.vol1h ?? d.btcVol1h;
  const d30 = d.delta30s ?? d.btcDelta30s;
  const d5m = d.delta5m ?? d.btcDelta5m;
  return [
    d.tsIso, d.decision, d.filterPreset, d.walletLabel, d.side, d.outcome,
    d.price, d.usdcSize, d.assetLabel,
    d.midEdge !== null && d.midEdge !== undefined ? Number(d.midEdge).toFixed(4) : "",
    edge !== null && edge !== undefined ? Number(edge).toFixed(4) : "",
    d.momentumAligned ? "TRUE" : "FALSE",
    d.secsRemaining !== null && d.secsRemaining !== undefined ? Number(d.secsRemaining).toFixed(0) : "",
    d.contractDuration !== null && d.contractDuration !== undefined ? d.contractDuration : "",
    `"${(d.filterReasons || []).join("; ").replace(/"/g, '""')}"`,
    d.riskReason ? `"${String(d.riskReason).replace(/"/g, '""')}"` : "",
    // wouldPass — handle both old (6 presets) and new (2/3 presets) formats
    wp.NEW_BEST !== undefined ? (wp.NEW_BEST ? "TRUE" : "FALSE") : (wp.FULL_COMBO ? "TRUE" : "FALSE"),
    wp.BALANCED !== undefined ? (wp.BALANCED ? "TRUE" : "FALSE") : "",
    wp.GOLD_PLUS !== undefined ? (wp.GOLD_PLUS ? "TRUE" : "FALSE") : "",
    // New columns
    d.botId || "",
    d.whaleTxHash || "",
    d.latencyMs !== null && d.latencyMs !== undefined ? d.latencyMs : "",
    sp !== null && sp !== undefined ? Number(sp).toFixed(2) : "",
    d.polyMidAtDecision !== null && d.polyMidAtDecision !== undefined ? Number(d.polyMidAtDecision).toFixed(4) : "",
    d.bookSpread !== null && d.bookSpread !== undefined ? Number(d.bookSpread).toFixed(4) : "",
    d.conditionId,
    `"${(d.title || "").replace(/"/g, '""')}"`,
    // Statistical columns
    v1h !== null && v1h !== undefined ? Number(v1h).toFixed(6) : "",
    d.concurrentWhales !== null && d.concurrentWhales !== undefined ? d.concurrentWhales : "",
    d.sessionLabel || "",
    d.orderBookDepth !== null && d.orderBookDepth !== undefined ? Number(d.orderBookDepth).toFixed(2) : "",
    // Momentum columns
    d30 !== null && d30 !== undefined ? Number(d30).toFixed(4) : "",
    d5m !== null && d5m !== undefined ? Number(d5m).toFixed(4) : "",
  ].join(",");
}

export const decisionsRotationConfig: RotationConfig = {
  jsonlPath: CONFIG.decisionsFile,
  archiveDir: CONFIG.archiveDir,
  archivePrefix: `${FILE_PREFIX}_decisions`,
  maxLines: CONFIG.rotationMaxLines,
  maxArchives: CONFIG.rotationMaxArchives,
  toCsvRow: decisionToCsvRow,
  csvHeader: DECISIONS_CSV_HEADER,
  onRotate: (archivePath, lineCount) => {
    const name = archivePath.split(/[/\\]/).pop();
    logEvent(`Rotated decisions.jsonl → ${name} (${lineCount.toLocaleString()} lines)`, "info");
  },
};

// ─── BOT TRADES ROTATION CONFIG ────────────────────────────────────────────

const BOT_TRADES_CSV_HEADER = "ts,botId,mode,filterPreset,walletLabel,side,outcome,entryPrice,sizeUsdc,shares," +
  "assetLabel,contractDuration,sizeReason,stackEntry,stackTotal,stackTriggerSize," +
  "midEdge,edgeVsSpot,momentumAligned,secsRemaining," +
  "whaleTxHash,latencyMs,spotPrice,polyMidAtDecision,bookSpread," +
  "resolution,won,pnl,status,conditionId,title,asset," +
  "slippage,fillPriceVsMid,vol1h,concurrentWhales,sessionLabel,orderBookDepth," +
  "confirmed,whaleUsdcSize,delta30s,delta5m,whalePrice";

function botTradeToCsvRow(t: any): string {
  // Backward compat: accept old or new field names
  const edge = t.edgeVsSpot ?? t.edgeVsBtc;
  const sp = t.spotPrice ?? t.binancePrice;
  const v1h = t.vol1h ?? t.btcVol1h;
  const d30 = t.delta30s ?? t.btcDelta30s;
  const d5m = t.delta5m ?? t.btcDelta5m;
  return [
    t.tsIso, t.botId || BOT_ID, t.mode, t.filterPreset, t.walletLabel, t.side, t.outcome,
    t.entryPrice, t.sizeUsdc, typeof t.shares === "number" ? t.shares.toFixed(4) : t.shares,
    t.assetLabel,
    t.contractDuration !== null && t.contractDuration !== undefined ? t.contractDuration : "",
    t.sizeReason || "STANDARD",
    t.stackEntry || 1,
    t.stackTotal || 1,
    t.stackTriggerSize !== null && t.stackTriggerSize !== undefined ? Number(t.stackTriggerSize).toFixed(2) : "",
    t.midEdge !== null && t.midEdge !== undefined ? Number(t.midEdge).toFixed(4) : "",
    edge !== null && edge !== undefined ? Number(edge).toFixed(4) : "",
    t.momentumAligned ? "TRUE" : "FALSE",
    typeof t.secsRemaining === "number" ? t.secsRemaining.toFixed(0) : "",
    t.whaleTxHash || "",
    t.latencyMs !== null && t.latencyMs !== undefined ? t.latencyMs : "",
    sp !== null && sp !== undefined ? Number(sp).toFixed(2) : "",
    t.polyMidAtDecision !== null && t.polyMidAtDecision !== undefined ? Number(t.polyMidAtDecision).toFixed(4) : "",
    t.bookSpread !== null && t.bookSpread !== undefined ? Number(t.bookSpread).toFixed(4) : "",
    t.resolution || "",
    t.won !== null && t.won !== undefined ? (t.won ? "TRUE" : "FALSE") : "",
    t.pnl !== null && t.pnl !== undefined ? Number(t.pnl).toFixed(4) : "",
    t.status,
    t.conditionId,
    `"${(t.title || "").replace(/"/g, '""')}"`,
    t.asset,
    // Statistical columns
    t.slippage !== null && t.slippage !== undefined ? Number(t.slippage).toFixed(4) : "0",
    t.fillPriceVsMid !== null && t.fillPriceVsMid !== undefined ? Number(t.fillPriceVsMid).toFixed(4) : "",
    v1h !== null && v1h !== undefined ? Number(v1h).toFixed(6) : "",
    t.concurrentWhales !== null && t.concurrentWhales !== undefined ? t.concurrentWhales : "",
    t.sessionLabel || "",
    t.orderBookDepth !== null && t.orderBookDepth !== undefined ? Number(t.orderBookDepth).toFixed(2) : "",
    // New whale context columns
    t.confirmed !== undefined ? (t.confirmed ? "TRUE" : "FALSE") : "TRUE",
    t.whaleUsdcSize !== null && t.whaleUsdcSize !== undefined ? Number(t.whaleUsdcSize).toFixed(2) : "",
    d30 !== null && d30 !== undefined ? Number(d30).toFixed(4) : "",
    d5m !== null && d5m !== undefined ? Number(d5m).toFixed(4) : "",
    t.whalePrice !== null && t.whalePrice !== undefined ? Number(t.whalePrice).toFixed(4) : "",
  ].join(",");
}

export const botTradesRotationConfig: RotationConfig = {
  jsonlPath: CONFIG.botTradesFile,
  archiveDir: CONFIG.archiveDir,
  archivePrefix: `${FILE_PREFIX}_bot_trades`,
  maxLines: CONFIG.rotationMaxLines,
  maxArchives: CONFIG.rotationMaxArchives,
  toCsvRow: botTradeToCsvRow,
  csvHeader: BOT_TRADES_CSV_HEADER,
  onRotate: (archivePath, lineCount) => {
    const name = archivePath.split(/[/\\]/).pop();
    logEvent(`Rotated bot_trades.jsonl → ${name} (${lineCount.toLocaleString()} lines)`, "info");
  },
};

// ─── DECISION LOG (every trade, pass or fail) ──────────────────────────────

function logDecision(trade: WhaleTrade, decision: "COPY" | "SKIP_FILTER" | "SKIP_RISK" | "SKIP_EXCLUDED_WALLET" | "SKIP_WALLET_NOT_ENABLED", filterPreset: string, reasons: string[], riskReason?: string) {
  // Fresh market data at OUR decision time
  const polyMidAtDecision = getFreshPolyMid(trade.asset);
  const bookSpread = getFreshBookSpread(trade.asset);
  const binancePrice = getPrice(trade.binanceSymbol);
  const latencyMs = Date.now() - trade.ts;

  const entry = {
    ts: Date.now(),
    tsIso: new Date().toISOString(),
    decision,
    filterPreset,
    walletLabel: trade.walletLabel,
    conditionId: trade.conditionId,
    title: trade.title,
    side: trade.side,
    outcome: trade.outcome,
    price: trade.price,
    usdcSize: trade.usdcSize,
    assetLabel: trade.assetLabel,
    midEdge: trade.midEdge,
    edgeVsSpot: trade.edgeVsSpot,
    momentumAligned: trade.momentumAligned,
    secsRemaining: trade.secondsRemainingInContract,
    contractDuration: trade.contractDurationMinutes,
    filterReasons: reasons,
    riskReason: riskReason || null,
    // Cross-analysis: would this trade pass unified filter with current settings?
    wouldPass: {
      [BOT_ID]: unifiedFilter(trade, getEffectiveSettings()),
    },
    // New data columns
    botId: BOT_ID,
    whaleTxHash: trade.txHash,
    latencyMs,
    spotPrice: binancePrice,
    polyMidAtDecision,
    bookSpread,
    // Statistical columns — per-asset
    vol1h: getVol1h(trade.binanceSymbol || "BTCUSDT"),
    concurrentWhales: getConcurrentWhales(trade.conditionId, Date.now()),
    sessionLabel: getSessionLabel(Date.now()),
    orderBookDepth: getOrderBookDepth(trade.asset),
    // Momentum columns — per-asset
    delta30s: getPriceDelta(trade.binanceSymbol || "BTCUSDT", 30),
    delta5m: getPriceDelta(trade.binanceSymbol || "BTCUSDT", 300),
  };
  try {
    fs.appendFileSync(CONFIG.decisionsFile, JSON.stringify(entry) + "\n");
    trackAppend(decisionsRotationConfig);
  } catch {}
}

// ─── TRADE PIPELINE ─────────────────────────────────────────────────────────

async function onNewWhaleTrade(trade: WhaleTrade) {
  // All filtering is handled by the unified filter in evaluateTrade()
  // Use effective settings (applies LIVE overrides when mode is LIVE)
  const effectiveSettings = getEffectiveSettings();

  // Step 1: Run through filter
  const filterResult = evaluateTrade(trade, effectiveSettings);

  if (!filterResult.passed) {
    logDecision(trade, "SKIP_FILTER", filterResult.presetName, filterResult.reasons);
    return;
  }

  stats.tradesPassedFilter++;

  // Step 2: Compute dynamic position size BEFORE risk check
  const { sizeUsdc, sizeReason } = getTradeSize(trade.price, effectiveSettings);

  // Step 3: Risk check (includes stacking logic + cooldown)
  // When in LIVE mode, only count LIVE positions for risk limits — PAPER positions
  // (from before the mode switch) must NOT block LIVE trades
  const currentMode = effectiveSettings.mode;
  const openForRisk = currentMode === "LIVE"
    ? getOpenPositions().filter(p => p.mode === "LIVE")
    : getOpenPositions();
  const closedForRisk = currentMode === "LIVE"
    ? getClosedPositions().filter(p => p.mode === "LIVE")
    : getClosedPositions();

  const riskResult = checkRisk(
    effectiveSettings,
    openForRisk,
    closedForRisk,
    trade.conditionId,
    trade.usdcSize,      // whale's size for minStackSize check
    sizeUsdc,            // proposed size for exposure check
  );

  if (!riskResult.allowed) {
    stats.tradesRejectedByRisk++;
    logDecision(trade, "SKIP_RISK", filterResult.presetName, filterResult.reasons, riskResult.reason);
    logEvent(`BLOCKED: ${riskResult.reason} | ${trade.walletLabel} ${trade.side} ${trade.outcome} $${trade.usdcSize.toFixed(2)}`, "risk");
    return;
  }

  // Step 4: Wallet inclusion check (LIVE mode only — PAPER still tracks all wallets)
  if (effectiveSettings.mode === "LIVE" && !effectiveSettings.enabledWallets?.includes(trade.walletLabel)) {
    logDecision(trade, "SKIP_WALLET_NOT_ENABLED", filterResult.presetName, filterResult.reasons, `Wallet ${trade.walletLabel} not in enabledWallets`);
    logEvent(`SKIP: Wallet ${trade.walletLabel} not enabled — LIVE mode only`, "risk");
    return;
  }

  // Step 4.5: Fresh price ceiling re-check at bot's fill time
  if (effectiveSettings.priceCeiling < 1.0) {
    const freshMid = getFreshPolyMid(trade.asset);
    if (freshMid > 0 && freshMid > effectiveSettings.priceCeiling) {
      stats.tradesRejectedByRisk++;
      logDecision(trade, "SKIP_RISK", filterResult.presetName, filterResult.reasons,
        `Fresh mid ${freshMid.toFixed(3)} > ceiling ${effectiveSettings.priceCeiling}`);
      logEvent(
        `BLOCKED: Fresh mid ${freshMid.toFixed(3)} > ceiling ${effectiveSettings.priceCeiling} | ` +
        `${trade.walletLabel} ${trade.side} ${trade.outcome} ${trade.assetLabel}`,
        "risk"
      );
      return;
    }
  }

  // Step 5: Execute (async for LIVE mode CLOB orders)
  logDecision(trade, "COPY", filterResult.presetName, filterResult.reasons);
  await executeCopyTrade(trade, filterResult.presetName, sizeUsdc, sizeReason);
}

// ─── LOAD BOT TRADE HISTORY ────────────────────────────────────────────────

function loadBotTrades() {
  if (!fs.existsSync(CONFIG.botTradesFile)) return;
  const lines = fs.readFileSync(CONFIG.botTradesFile, "utf-8").trim().split("\n").filter(Boolean);
  let loaded = 0;
  for (const line of lines) {
    try {
      const trade = JSON.parse(line) as BotTrade;
      // Migrate old records missing new fields
      if (!trade.botId) trade.botId = BOT_ID;
      if (!trade.stackEntry) trade.stackEntry = 1;
      if (!trade.stackTotal) trade.stackTotal = 1;
      if (!trade.stackTriggerSize) trade.stackTriggerSize = 0;
      if (!trade.whaleTxHash) trade.whaleTxHash = "";
      if (!trade.latencyMs) trade.latencyMs = 0;
      // v10 rename migration: old field names → new
      const raw = trade as any;
      if (raw.binancePrice !== undefined && trade.spotPrice === undefined) trade.spotPrice = raw.binancePrice;
      if (raw.edgeVsBtc !== undefined && trade.edgeVsSpot === undefined) trade.edgeVsSpot = raw.edgeVsBtc;
      if (raw.btcVol1h !== undefined && trade.vol1h === undefined) trade.vol1h = raw.btcVol1h;
      if (raw.btcDelta30s !== undefined && trade.delta30s === undefined) trade.delta30s = raw.btcDelta30s;
      if (raw.btcDelta5m !== undefined && trade.delta5m === undefined) trade.delta5m = raw.btcDelta5m;
      if (!trade.spotPrice) trade.spotPrice = 0;
      if (!trade.polyMidAtDecision) trade.polyMidAtDecision = 0;
      if (!trade.bookSpread) trade.bookSpread = 0;
      if (!trade.contractDuration) trade.contractDuration = 0;
      if (!trade.sizeReason) trade.sizeReason = "STANDARD";
      // Statistical column migration
      if (trade.slippage === undefined || trade.slippage === null) trade.slippage = 0;
      if (trade.fillPriceVsMid === undefined) trade.fillPriceVsMid = null;
      if (trade.vol1h === undefined || trade.vol1h === null) trade.vol1h = -1;
      if (trade.concurrentWhales === undefined || trade.concurrentWhales === null) trade.concurrentWhales = 1;
      if (!trade.sessionLabel) trade.sessionLabel = "";
      if (trade.orderBookDepth === undefined || trade.orderBookDepth === null) trade.orderBookDepth = -1;
      // Migrate confirmed field — old trades are assumed confirmed (they existed before FOK-only)
      if (trade.confirmed === undefined) trade.confirmed = true;
      // Migrate whale context columns — use 0/entry price for old trades
      if (trade.whaleUsdcSize === undefined) trade.whaleUsdcSize = trade.stackTriggerSize || 0;
      if (trade.whalePrice === undefined) trade.whalePrice = trade.entryPrice;
      if (trade.delta30s === undefined) trade.delta30s = 0;
      if (trade.delta5m === undefined) trade.delta5m = 0;
      if (trade.edgeVsSpot === undefined) trade.edgeVsSpot = null;
      botTrades.push(trade);
      loaded++;
    } catch {}
  }
  // Deduplicate by id — keep last occurrence (handles take profit re-appends)
  const idToLastIndex = new Map<string, number>();
  for (let i = 0; i < botTrades.length; i++) {
    idToLastIndex.set(botTrades[i].id, i);
  }
  if (idToLastIndex.size < botTrades.length) {
    const keep = new Set(idToLastIndex.values());
    const deduped: BotTrade[] = [];
    for (let i = 0; i < botTrades.length; i++) {
      if (keep.has(i)) deduped.push(botTrades[i]);
    }
    const removed = botTrades.length - deduped.length;
    botTrades.length = 0;
    botTrades.push(...deduped);
    loaded = deduped.length;
    console.log(`[bot-history] Deduplicated: removed ${removed} stale records`);
  }
  if (loaded > 0) {
    // Recalc stats from loaded trades
    for (const t of botTrades) {
      stats.totalCopyTrades++;
      if (t.won === true) stats.wins++;
      if (t.won === false) stats.losses++;
      if (t.pnl !== null) {
        stats.totalPnl += t.pnl;
        if (t.pnl > stats.bestTrade) stats.bestTrade = t.pnl;
        if (t.pnl < stats.worstTrade) stats.worstTrade = t.pnl;
      }
    }
    recalcStats();
    console.log(`[bot-history] Loaded ${loaded} bot trades (${stats.wins}W/${stats.losses}L, PnL: $${stats.totalPnl.toFixed(2)})`);
  }
}

// ─── INITIALIZATION ─────────────────────────────────────────────────────────

export function initExecutor() {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  loadSettings();
  loadBotTrades();

  // SELF-TEST: verify stacking enforcement works at runtime
  // This catches the bug where settings say maxEntries=1 but getEffectiveSettings() returns 3
  const testCid = "SELF_TEST_STACKING_CHECK";
  const effTest = getEffectiveSettings();
  ordersPerContract.set(testCid, { count: 1, totalUSD: 10, lastOrderTime: 0 });
  const shouldBlock = !canPlaceOrder(testCid, effTest.maxEntriesPerContract);
  ordersPerContract.delete(testCid);
  if (effTest.maxEntriesPerContract === 1 && !shouldBlock) {
    console.error("[CRITICAL] STACKING CHECK FAILED: maxEntriesPerContract=1 but canPlaceOrder returned true with count=1. Aborting.");
    process.exit(1);
  }
  console.log(`[SELF-TEST] Stacking enforcement OK: maxEntriesPerContract=${effTest.maxEntriesPerContract}, blocked=${shouldBlock}`);

  // Register as listener for new whale trades
  onWhaleTrade(onNewWhaleTrade);

  // Resolve positions every 15s
  setInterval(resolvePositions, 15_000);

  // Take profit check every 2 seconds
  setInterval(checkTakeProfit, 2_000);

  // Clean old cooldowns every 60s
  setInterval(clearOldCooldowns, 60_000);

  // Force PAPER mode on boot regardless of saved settings
  settings.mode = "PAPER";

  const clobStatus = isClobReady();
  if (clobStatus) {
    console.log("LIVE mode available — currently in PAPER. Enable via dashboard.");
    if (BOT_ID === "BALANCED") {
      console.log("[WARNING] BAL sharing LIVE wallet 0xdb67 with NB/GP. Ensure NB/GP are OFF to avoid position conflicts.");
      console.log(`[BAL LIVE LIMITS] maxExposure=$200, maxLoss/hr=$50, maxLoss/session=$100, maxEntries=1 (no stacking), flat $10`);
    }
  } else {
    console.log("LIVE mode unavailable — missing credentials");
  }

  logEvent(`Bot initialized: id=${BOT_ID}, mode=PAPER, LIVE available=${clobStatus}, hcSize=$${settings.highConvictionSize}, lcSize=$${settings.lowConvictionSize}, maxStack=${settings.maxEntriesPerContract}`);
}
