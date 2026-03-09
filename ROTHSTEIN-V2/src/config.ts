// ─── ROTHSTEIN V2 Configuration ─────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";
import { Mode, FilterConfig } from "./types";

export const ENV = {
  port: parseInt(process.env.PORT || "8080"),
  mode: (process.env.MODE || "PAPER") as Mode,
  password: process.env.DASHBOARD_PASSWORD || "7777777lL",
  dataDir: process.env.DATA_DIR || "./data",
  // CLOB credentials (LIVE mode)
  polyApiKey: process.env.POLY_API_KEY || "",
  polyApiSecret: process.env.POLY_API_SECRET || "",
  polyPassphrase: process.env.POLY_PASSPHRASE || "",
  polyWalletAddress: process.env.POLY_WALLET_ADDRESS || "",
  polyPrivateKey: process.env.POLY_PRIVATE_KEY || "",
  polySignatureType: parseInt(process.env.POLY_SIGNATURE_TYPE || "1"),
};

export const URLS = {
  binanceWs: "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade",
  binanceWsBackup: "wss://data-stream.binance.vision/stream?streams=btcusdt@trade/ethusdt@trade",
  binanceRest: "https://api.binance.com/api/v3/ticker/price",
  binanceKlines: "https://data-api.binance.vision/api/v3/klines",
  polymarketWs: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  clobApi: "https://clob.polymarket.com",
  gammaApi: "https://gamma-api.polymarket.com",
  dataApi: "https://data-api.polymarket.com",
};

// 13 whale wallets from spy server
export const WALLETS = [
  { address: "0x63ce342161250d705dc0b16df89036c8e5f9ba9a", label: "0x63ce" },
  { address: "0x1d0034134e339a309700ff2d34e99fa2d48b0313", label: "0x1d00" },
  { address: "0x1979ae6b7e6534de9c4539d0c205e582ca637c9d", label: "0x1979" },
  { address: "0x37c94ea1b44e01b18a1ce3ab6f8002bd6b9d7e6d", label: "0x37c9" },
  { address: "0xf6963d4cdbb6f26d753bda303e9513132afb1b7d", label: "0xf696" },
  { address: "0x571c285a83eba5322b5f916ba681669dc368a61f", label: "0x571c" },
  { address: "0x0ea574f3204c5c9c0cdead90392ea0990f4d17e4", label: "0x0ea5" },
  { address: "0x2d8b401d2f0e6937afebf18e19e11ca568a5260a", label: "0x2d8b" },
  { address: "0xd7e71e9b1c9d5e428e94906660c5a94537e51150", label: "0xd7e7" },
  { address: "0x113d4c0b5a6702ab045ea2cba7c3f71d51fc3ce8", label: "0x113d" },
  { address: "0xe594336603f4fb5d3ba4125a67021ab3b4347052", label: "0xe594" },
  { address: "0xd0d6053c3c37e727402d84c14069780d360993aa", label: "0xd0d6" },
  { address: "0xa9ae84ee529dbec0c6634b08cd97d3f13f7d74f5", label: "0xa9ae" },
] as const;

// ─── Data-driven filter (from 7-day analysis of 1.27M trades) ───────────────
// Key findings:
//   Momentum aligned:  60.3% WR, +$649K PnL
//   Edge >= 0:         52-65% WR vs 35-41% negative
//   Secs 150-300:      50-53% WR, best PnL density
//   Block 0xa9ae(26%), 0xe594(37%), 0x113d(43%): consistent losers
//   Whale size $3+:    53% WR (filters dust noise)
//   Combined filter:   66% WR, $1.37/trade on $10 flat

const DEFAULT_FILTER: FilterConfig = {
  blockedWallets: ["0xa9ae", "0xe594", "0x113d"],
  minWhaleSize: 3,
  requireMomentum: true,
  minEdge: 0.0,
  maxEdge: 1.0,
  minSecsRemaining: 150,
  maxSecsRemaining: 300,
  fokMaxPrice: 0.70,
  maxPositionsPerContract: 1,
  maxTotalRisk: 500,
  betSize: 10,
  paused: false,
};

let _filter: FilterConfig = { ...DEFAULT_FILTER };
const CONFIG_FILE = path.resolve(ENV.dataDir, "filter-config.json");

export function getFilter(): Readonly<FilterConfig> { return _filter; }

export function updateFilter(partial: Partial<FilterConfig>): FilterConfig {
  _filter = { ..._filter, ...partial };
  saveFilter();
  return _filter;
}

function loadFilter(): void {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      _filter = { ...DEFAULT_FILTER, ...raw };
    } else {
      _filter = { ...DEFAULT_FILTER };
      saveFilter();
    }
  } catch {
    _filter = { ...DEFAULT_FILTER };
  }
}

function saveFilter(): void {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(_filter, null, 2));
  } catch {}
}

export function initConfig(): void { loadFilter(); }
