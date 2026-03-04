/**
 * config.ts — Central configuration for the whale copy-trading bot.
 *
 * All tunable parameters live here. Secrets (auth token) are generated
 * at boot if not provided via env var.
 *
 * BOT_ID env var controls which filter runs: "NEW_BEST" (default), "BALANCED", or "GOLD_PLUS".
 * All bots run the same codebase, differentiated only by this env var.
 */

import * as crypto from "crypto";
import type { MidEdgeRange } from "./types";

// ─── Wallets ────────────────────────────────────────────────────────────────

export const WALLETS = [
  { address: "0x63ce342161250d705dc0b16df89036c8e5f9ba9a", label: "0x63ce" },
  { address: "0x1d0034134e339a309700ff2d34e99fa2d48b0313", label: "0x1d00" },
  { address: "0x1979ae6b7e6534de9c4539d0c205e582ca637c9d", label: "0x1979" },
  { address: "0x37c94ea1b44e01b18a1ce3ab6f8002bd6b9d7e6d", label: "0x37c9" },
  { address: "0x0ea574f3204c5c9c0cdead90392ea0990f4d17e4", label: "0x0ea5" },
  { address: "0x571c285a83eba5322b5f916ba681669dc368a61f", label: "0x571c" },
  { address: "0xf6963d4cdbb6f26d753bda303e9513132afb1b7d", label: "0xf696" },
  { address: "0xa9ae84ee529dbec0c6634b08cd97d3f13f7d74f5", label: "0xa9ae" },
  { address: "0x2d8b401d2f0e6937afebf18e19e11ca568a5260a", label: "0x2d8b" },
];

// All wallets available for the dashboard wallet picker (includes labels for UI)
export const AVAILABLE_WALLETS = [
  { prefix: "0x63ce", label: "0x63ce" },
  { prefix: "0x37c9", label: "0x37c9" },
  { prefix: "0x0ea5", label: "0x0ea5" },
  { prefix: "0x1d00", label: "0x1d00" },
  { prefix: "0x1979", label: "0x1979" },
  { prefix: "0x571c", label: "0x571c" },
  { prefix: "0xf696", label: "0xf696" },
  { prefix: "0xa9ae", label: "0xa9ae" },
  { prefix: "0x2d8b", label: "0x2d8b" },
];

// Default enabled wallets: Tier 1 + Tier 2 (all bots same default)
export const DEFAULT_ENABLED_WALLETS = ["0x63ce", "0x37c9", "0x0ea5", "0x1d00", "0x1979", "0x2d8b"];

// ─── Asset Mapping ──────────────────────────────────────────────────────────

export const ASSET_MAP: Record<string, string> = {
  bitcoin:  "BTCUSDT",
  ethereum: "ETHUSDT",
  solana:   "SOLUSDT",
  xrp:      "XRPUSDT",
};

// Reverse map: "BTCUSDT" → "BTC" for display
export const SYMBOL_DISPLAY: Record<string, string> = {
  BTCUSDT: "BTC",
  ETHUSDT: "ETH",
  SOLUSDT: "SOL",
  XRPUSDT: "XRP",
};

// ─── Bot Identity ───────────────────────────────────────────────────────────

export type FilterPresetName = "NEW_BEST" | "BALANCED" | "GOLD_PLUS";

export const BOT_ID: FilterPresetName =
  process.env.BOT_ID === "BALANCED" ? "BALANCED" :
  process.env.BOT_ID === "GOLD_PLUS" ? "GOLD_PLUS" : "NEW_BEST";

// Short prefix for file naming: NEW_BEST → "NB", BALANCED → "BAL", GOLD_PLUS → "GP"
export const BOT_PREFIX: Record<FilterPresetName, string> = {
  NEW_BEST: "NB",
  BALANCED: "BAL",
  GOLD_PLUS: "GP",
};

export const FILE_PREFIX = BOT_PREFIX[BOT_ID];

// ─── Server ─────────────────────────────────────────────────────────────────

export const CONFIG = {
  port: parseInt(process.env.PORT || "4444"),
  wallets: WALLETS,
  pollIntervalMs: 3000,       // poll each whale every 3s (staggered 750ms per wallet)
  dataDir: "./data",
  archiveDir: "./data/archives",
  botTradesFile: `./data/${FILE_PREFIX}_bot_trades.jsonl`,   // bot's own copy trades
  decisionsFile: `./data/${FILE_PREFIX}_decisions.jsonl`,    // EVERY trade decision (copy/skip/blocked) with reasons
  settingsFile: "./data/settings.json",      // persist settings across restarts
  liveEventsFile: `./data/${FILE_PREFIX}_live_events.jsonl`,  // permanent audit trail (never rotated)
  rotationMaxLines: 70_000,                  // rotate JSONL files at this line count
  rotationMaxArchives: 20,                   // keep last N rotated CSV files per type

  // External APIs
  binanceWsUrl: "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade/solusdt@trade/xrpusdt@trade",
  polymarketWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  gammaApi: "https://gamma-api.polymarket.com",
  dataApi: "https://data-api.polymarket.com",

  // Auth — simple bearer token for dashboard access via ngrok
  authToken: process.env.BOT_AUTH_TOKEN || "7777777lL",

  // Dashboard WS broadcast interval
  broadcastIntervalMs: 500,
};

// ─── Filter Preset Definitions ──────────────────────────────────────────────

export interface FilterPresetConfig {
  name: FilterPresetName;
  label: string;
  description: string;
  logic: string;           // human-readable filter logic
  backtestWinRate: number;
  backtestTrades: number;
  backtestFreqPerHr: number;
}

export const FILTER_PRESETS: FilterPresetConfig[] = [
  {
    name: "NEW_BEST",
    label: "NEW_BEST — 90.0% WR",
    description: "Highest win rate — 5min BTC/ETH, tight time window, edge+momentum+edgeVsBtc",
    logic: "BUY && midEdge < -0.05 && momentum && secs 90-200 && edgeVsBtc > 0 && 5min && BTC/ETH",
    backtestWinRate: 90.0,
    backtestTrades: 629,
    backtestFreqPerHr: 45,
  },
  {
    name: "BALANCED",
    label: "BALANCED — 80.8% CWR (Strategy D)",
    description: "NB-quality criteria with wider price range — 5+15min BTC/ETH, price 0.50-0.85",
    logic: "BUY && price 0.50-0.85 && midEdge < -0.05 && momentum && edgeVsSpot > 0 && 5min(90-200s)/15min(90-300s) && BTC/ETH",
    backtestWinRate: 80.8,
    backtestTrades: 218,
    backtestFreqPerHr: 20,
  },
  {
    name: "GOLD_PLUS",
    label: "GOLD_PLUS — OG GOLD + 0.50 floor",
    description: "OG GOLD filter + price floor. midEdge + momentum + timing + $10 whale gate + price >= 0.50. No edgeVsBtc, no dead hours.",
    logic: "BUY && price >= 0.50 && midEdge < -0.05 && momentum && secs 90-300 && whaleSize >= $10 && 5+15min && BTC/ETH",
    backtestWinRate: 80.8,
    backtestTrades: 82000,
    backtestFreqPerHr: 95,
  },
];

// ─── Risk Management Defaults ───────────────────────────────────────────────
// Per-bot overrides: GOLD_PLUS gets wider loss limits (more trades/hr),
// BALANCED gets moderate bump, NEW_BEST keeps tightest limits.

const BASE_RISK = {
  maxOpenPositions: 15,
  maxExposureUSD: 500,
  maxLossPerHour: 100,
  maxLossPerSession: 200,
  maxPositionSize: 50,
  highConvictionSize: 20,
  lowConvictionSize: 10,
  highConvictionThreshold: 0.80,
  cooldownMs: 5000,
  maxEntriesPerContract: 3,
  minStackSize: 25,
  allowedAssets: ["BTC", "ETH"] as string[],
  allowedSides: ["BUY"] as ("BUY" | "SELL")[],
  enabledWallets: DEFAULT_ENABLED_WALLETS,
  takeProfitEnabled: false,
  takeProfitPrice: 0.90,
};

const BOT_RISK_OVERRIDES: Record<FilterPresetName, Partial<typeof BASE_RISK>> = {
  NEW_BEST: {},  // tightest limits — default values ($100/hr, $200/session)
  BALANCED: {
    maxLossPerHour: 150,
    maxLossPerSession: 400,
  },
  GOLD_PLUS: {
    maxExposureUSD: 300,
    maxLossPerHour: 240,
    maxLossPerSession: 500,
    maxEntriesPerContract: 1,     // no stacking — 1 entry per contract
  },
};

export const DEFAULT_RISK = {
  ...BASE_RISK,
  ...BOT_RISK_OVERRIDES[BOT_ID],
};

// ─── Filter Parameter Defaults (v10 — unified filter) ────────────────────────

const BASE_FILTER = {
  standardSize: 10,
  priceFloor: 0.70,
  priceCeiling: 0.85,
  midEdgeRanges: [{ operator: "lt" as const, value: -0.05 }] as MidEdgeRange[],
  edgeVsSpotEnabled: true,
  edgeVsSpotThreshold: 0.0,
  momentumRequired: true,
  whaleSizeGate: 0,
  secsRanges5m: [[90, 200]] as number[][],
  secsRanges15m: [[90, 300]] as number[][],
};

const BOT_FILTER_OVERRIDES: Record<FilterPresetName, Partial<typeof BASE_FILTER>> = {
  NEW_BEST: {},  // NB: priceFloor 0.70, ceiling 1.0, edgeVsSpot enabled, gate 0
  BALANCED: {
    priceFloor: 0.50,
    whaleSizeGate: 10,
  },
  GOLD_PLUS: {
    priceFloor: 0.50,
    edgeVsSpotEnabled: false,
    whaleSizeGate: 10,
    secsRanges5m: [[90, 300]],
  },
};

export const DEFAULT_FILTER = {
  ...BASE_FILTER,
  ...BOT_FILTER_OVERRIDES[BOT_ID],
};
