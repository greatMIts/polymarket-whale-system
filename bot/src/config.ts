/**
 * config.ts — Central configuration for the V7.5 bot system.
 *
 * Layer 0b — Imports only types (for FilterPresetName, WalletInfo).
 * Constants only. No business logic. No runtime state.
 *
 * BOT_ID env var controls which filter preset runs: "BALANCED", "GOLD_PLUS", or "NEW_BEST".
 * All bots run the same codebase, differentiated only by this env var.
 */

import { FilterPresetName, WalletInfo } from './types';

// ── Bot Identity (validated at boot — crash if invalid) ──
export const BOT_ID = process.env.BOT_ID as FilterPresetName;

const VALID_BOT_IDS: FilterPresetName[] = ['BALANCED', 'GOLD_PLUS', 'NEW_BEST'];
if (!VALID_BOT_IDS.includes(BOT_ID)) {
  throw new Error(
    `Fatal: BOT_ID must be one of ${VALID_BOT_IDS.join(' | ')}, got: "${process.env.BOT_ID ?? '(undefined)'}"`
  );
}

// File prefix: NEW_BEST → "new-best", BALANCED → "balanced", GOLD_PLUS → "gold-plus"
export const FILE_PREFIX = BOT_ID.toLowerCase().replace(/_/g, '-');

const DATA_DIR = process.env.DATA_DIR || './data';

// ── V7.5 S1: All 9 wallets fully specified ──
export const WALLETS: Record<string, WalletInfo> = {
  '0x63ce': { label: '0x63ce', shortAddress: '0x63ce…9a' },
  '0x1d00': { label: '0x1d00', shortAddress: '0x1d00…13' },
  '0x1979': { label: '0x1979', shortAddress: '0x1979…9d' },
  '0x37c9': { label: '0x37c9', shortAddress: '0x37c9…6d' },
  '0x0ea5': { label: '0x0ea5', shortAddress: '0x0ea5…e4' },
  '0x571c': { label: '0x571c', shortAddress: '0x571c…1f' },
  '0xf696': { label: '0xf696', shortAddress: '0xf696…7d' },
  '0xa9ae': { label: '0xa9ae', shortAddress: '0xa9ae…f5' },
  '0x2d8b': { label: '0x2d8b', shortAddress: '0x2d8b…0a' },
};
export const AVAILABLE_WALLETS = Object.keys(WALLETS);

// ── V7.5 C1: Asset label → Binance stream symbol ──
export const LABEL_TO_SYMBOL: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
};

// ── Asset Mapping (kept for whale-watcher + market-data title parsing) ──
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

// ── Wallet full addresses (for whale-watcher polling) ──
const WALLET_ADDRESSES = [
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

// ── CONFIG object ──
export const CONFIG = {
  port: parseInt(process.env.PORT || '4444'),
  authToken: process.env.BOT_AUTH_TOKEN || process.env.AUTH_TOKEN || 'dev-token',
  settingsFile: `${DATA_DIR}/${FILE_PREFIX}-settings.json`,
  dataDir: DATA_DIR,
  archiveDir: `${DATA_DIR}/archives`,

  // Whale polling
  wallets: WALLET_ADDRESSES,
  pollIntervalMs: 3000,       // poll each whale every 3s (staggered per wallet)

  // External APIs
  binanceWsUrl: "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade/solusdt@trade/xrpusdt@trade",
  polymarketWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  gammaApi: "https://gamma-api.polymarket.com",
  dataApi: "https://data-api.polymarket.com",
  clobApiBase: "https://clob.polymarket.com",

  // Dashboard WS broadcast interval
  broadcastIntervalMs: 500,

  // File rotation
  rotationMaxLines: 70_000,
  rotationMaxArchives: 20,
};
