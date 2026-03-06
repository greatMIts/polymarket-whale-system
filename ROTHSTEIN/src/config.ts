// ─── Layer 0: Configuration ─────────────────────────────────────────────────
// All constants, thresholds, and env vars in one place.
// Hot-reloadable runtime config loaded from rothstein-config.json.

import * as fs from "fs";
import * as path from "path";
import { RuntimeConfig, Mode } from "./types";

// ─── Static Config (requires restart to change) ────────────────────────────

export const CONFIG = {
  // Server
  port: parseInt(process.env.PORT || "3334"),
  mode: (process.env.MODE || "PAPER") as Mode,
  spyServerUrl: process.env.SPY_SERVER_URL || "ws://localhost:3333",

  // Data sources
  binanceWsUrl: "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade",
  polymarketWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  gammaApi: "https://gamma-api.polymarket.com",
  clobApi: "https://clob.polymarket.com",

  // Scanning intervals
  scanIntervalMs: 15_000,         // evaluate all contracts every 15s
  resolutionCheckMs: 30_000,      // check if open positions resolved
  contractScanMs: 30_000,         // scan Gamma for new contracts
  heartbeatCheckMs: 10_000,       // subsystem health check
  bookRefreshMs: 15_000,          // refresh empty order books via REST
  dashboardBroadcastMs: 500,      // WS broadcast to dashboard

  // Staleness thresholds
  binanceStaleMs: 30_000,         // binance price older than 30s = stale
  polyBookStaleMs: 60_000,        // order book older than 60s = stale
  whaleSignalExpireMs: 120_000,   // whale signal expires after 2 min

  // Hard gates
  minEdgeVsSpot: 0.05,
  minPrice: 0.45,
  maxPrice: 0.85,
  maxBookSpread: 0.04,
  minSecsRemaining: 90,
  maxSecsRemaining: 300,
  allowedAssets: ["BTC", "ETH"] as const,
  allowedDurations: [5] as const,

  // Scoring (defaults, can be overridden by runtime config)
  defaultMinTradeScore: 60,

  // Sizing tiers: score threshold → base USD bet
  sizingTiers: [
    { minScore: 90, size: 20 },
    { minScore: 80, size: 15 },
    { minScore: 70, size: 10 },
    { minScore: 60, size: 5 },
    { minScore: 50, size: 2 },   // shadow/data-collection only
  ] as const,

  // Risk management
  maxConcurrentPositions: 5,
  maxTotalAtRisk: 50,
  sessionLossCircuitBreaker: -30,
  hourlyLossThrottle: -15,
  consecutiveLossThrottle: 5,

  // Conditional take-profit (NOT blind TP)
  // Exit when edge drops below threshold while position is at this price+
  conditionalTpMinPrice: 0.85,
  conditionalTpEdgeThreshold: 0,  // exit if edgeVsSpot drops below 0

  // Persistence
  dataDir: process.env.DATA_DIR || "./data",
  decisionsFile: "decisions.jsonl",
  positionsFile: "positions.jsonl",
  rotationMaxLines: 50_000,
  maxArchives: 20,

  // CLOB credentials (LIVE mode only)
  polyApiKey: process.env.POLY_API_KEY || "",
  polyApiSecret: process.env.POLY_API_SECRET || "",
  polyPassphrase: process.env.POLY_PASSPHRASE || "",
  polyWalletAddress: process.env.POLY_WALLET_ADDRESS || "",
  polyPrivateKey: process.env.POLY_PRIVATE_KEY || "",

  // Wallet tiers for whale signals
  walletTiers: {
    "0x571c": 1, "0xf696": 1, "0x0ea5": 1,           // Tier 1: 55%+ WR
    "0x63ce": 2, "0x37c9": 2, "0x1979": 2, "0x1d00": 2,  // Tier 2: ~49-51%
    "0x2d8b": 3, "0xa9ae": 3,                          // Tier 3: bad/monitor
    "0xd7e7": 3, "0x113d": 3, "0xe594": 3,            // Tier 3: new, no data
  } as Record<string, number>,

  // Hour scoring: UTC hour → bonus points (-5 to +5)
  hourScoring: {
    6: 5, 8: 5, 11: 5, 23: 5,      // best hours
    3: 3, 4: 3, 13: 3, 21: 3,      // good hours
    15: -5, 16: -5,                  // worst hours
  } as Record<number, number>,
} as const;

// ─── Runtime Config (hot-reloadable, no restart needed) ─────────────────────

const RUNTIME_CONFIG_FILE = path.resolve(CONFIG.dataDir, "rothstein-config.json");

const DEFAULT_RUNTIME: RuntimeConfig = {
  deadHours: [15, 16],            // UTC hours to skip trading
  minTradeScore: CONFIG.defaultMinTradeScore,
  sizingMultiplier: 1.0,
  maxConcurrentPositions: CONFIG.maxConcurrentPositions,
  paused: false,
};

let _runtime: RuntimeConfig = { ...DEFAULT_RUNTIME };

export function getRuntime(): Readonly<RuntimeConfig> {
  return _runtime;
}

export function updateRuntime(partial: Partial<RuntimeConfig>): RuntimeConfig {
  _runtime = { ..._runtime, ...partial };
  saveRuntimeConfig();
  return _runtime;
}

function loadRuntimeConfig(): void {
  try {
    if (fs.existsSync(RUNTIME_CONFIG_FILE)) {
      const raw = fs.readFileSync(RUNTIME_CONFIG_FILE, "utf8");
      const parsed = JSON.parse(raw);
      _runtime = { ...DEFAULT_RUNTIME, ...parsed };
      console.log("[config] Loaded runtime config:", _runtime);
    } else {
      _runtime = { ...DEFAULT_RUNTIME };
      saveRuntimeConfig();
      console.log("[config] Created default runtime config");
    }
  } catch (e: any) {
    console.error("[config] Error loading runtime config:", e.message);
    _runtime = { ...DEFAULT_RUNTIME };
  }
}

function saveRuntimeConfig(): void {
  try {
    const dir = path.dirname(RUNTIME_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RUNTIME_CONFIG_FILE, JSON.stringify(_runtime, null, 2));
  } catch (e: any) {
    console.error("[config] Error saving runtime config:", e.message);
  }
}

// Watch for external config changes (hot-reload)
let _configWatcher: fs.FSWatcher | null = null;

export function startConfigWatcher(): void {
  loadRuntimeConfig();

  try {
    if (fs.existsSync(RUNTIME_CONFIG_FILE)) {
      _configWatcher = fs.watch(RUNTIME_CONFIG_FILE, () => {
        console.log("[config] Runtime config file changed, reloading...");
        loadRuntimeConfig();
      });
    }
  } catch {
    // Config watching is nice-to-have, not critical
  }
}

export function stopConfigWatcher(): void {
  if (_configWatcher) {
    _configWatcher.close();
    _configWatcher = null;
  }
}
