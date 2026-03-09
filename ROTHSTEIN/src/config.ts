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
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "7777777lL",

  // Data sources
  binanceWsUrl: "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade",
  polymarketWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  gammaApi: "https://gamma-api.polymarket.com",
  clobApi: "https://clob.polymarket.com",
  dataApi: "https://data-api.polymarket.com",

  // Whale polling
  whalePollMs: 2_000,             // poll all wallets every 2s (parallel)
  trackedWallets: [
    { address: "0x571c285a83eba5322b5f916ba681669dc368a61f", label: "0x571c" },
    { address: "0xf6963d4cdbb6f26d753bda303e9513132afb1b7d", label: "0xf696" },
    { address: "0x0ea574f3204c5c9c0cdead90392ea0990f4d17e4", label: "0x0ea5" },
    { address: "0x63ce342161250d705dc0b16df89036c8e5f9ba9a", label: "0x63ce" },
    { address: "0x37c94ea1b44e01b18a1ce3ab6f8002bd6b9d7e6d", label: "0x37c9" },
    { address: "0x1979ae6b7e6534de9c4539d0c205e582ca637c9d", label: "0x1979" },
    { address: "0x1d0034134e339a309700ff2d34e99fa2d48b0313", label: "0x1d00" },
    { address: "0x2d8b401d2f0e6937afebf18e19e11ca568a5260a", label: "0x2d8b" },
    { address: "0xa9ae84ee529dbec0c6634b08cd97d3f13f7d74f5", label: "0xa9ae" },
    { address: "0xd7e71e9b1c9d5e428e94906660c5a94537e51150", label: "0xd7e7" },
    { address: "0x113d4c0b5a6702ab045ea2cba7c3f71d51fc3ce8", label: "0x113d" },
    { address: "0xe594336603f4fb5d3ba4125a67021ab3b4347052", label: "0xe594" },
    { address: "0xd0d6053c3c37e727402d84c14069780d360993aa", label: "0xd0d6" },
  ] as const,

  // Scanning intervals
  scanIntervalMs: 1_000,          // evaluate all contracts every 1s
  resolutionCheckMs: 5_000,       // check if open positions resolved (was 30s, reduced for faster dashboard updates)
  contractScanMs: 10_000,         // scan Gamma for new contracts (was 30s, reduced for faster discovery)
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
  minCopyScore: 50,                // min score to execute a whale copy trade (matches $2 sizing tier)
  copyLatencyBudgetMs: 2_000,      // max pipeline latency before abort

  // Sizing tiers: score threshold → base USD bet
  sizingTiers: [
    { minScore: 90, size: 20 },
    { minScore: 80, size: 15 },
    { minScore: 70, size: 10 },
    { minScore: 60, size: 5 },
    { minScore: 50, size: 2 },   // shadow/data-collection only
  ] as const,

  // Risk management
  maxConcurrentPositions: 100,
  maxTotalAtRisk: 500,

  // Conditional take-profit (NOT blind TP)
  // Exit when edge drops below threshold while position is at this price+
  conditionalTpMinPrice: 0.85,
  conditionalTpEdgeThreshold: 0,  // exit if edgeVsSpot drops below 0

  // Persistence
  dataDir: process.env.DATA_DIR || "./data",
  decisionsFile: "decisions.jsonl",
  positionsFile: "positions.jsonl",
  rotationMaxLines: 50_000,       // reduced from 60k — wider rows with whale copy fields, keep files <30MB
  maxArchives: 20,

  // CLOB credentials (LIVE mode only)
  polyApiKey: process.env.POLY_API_KEY || "",
  polyApiSecret: process.env.POLY_API_SECRET || "",
  polyPassphrase: process.env.POLY_PASSPHRASE || "",
  polyWalletAddress: process.env.POLY_WALLET_ADDRESS || "",
  polySignatureType: parseInt(process.env.POLY_SIGNATURE_TYPE || "1"),  // 0=EOA, 1=Magic/Email(default), 2=GnosisSafe
  polyPrivateKey: process.env.POLY_PRIVATE_KEY || "",

  // Wallet tiers for whale signals
  walletTiers: {
    "0x571c": 1, "0xf696": 1, "0x0ea5": 1,           // Tier 1: 55%+ WR
    "0x63ce": 2, "0x37c9": 2, "0x1979": 2, "0x1d00": 2,  // Tier 2: ~49-51%
    "0x2d8b": 3, "0xa9ae": 3,                          // Tier 3: bad/monitor
    "0xd7e7": 3, "0x113d": 3, "0xe594": 3, "0xd0d6": 3, // Tier 3: new, no data
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

  // Hard gates
  minEdgeVsSpot: CONFIG.minEdgeVsSpot,
  minPrice: CONFIG.minPrice,
  maxPrice: CONFIG.maxPrice,
  maxBookSpread: CONFIG.maxBookSpread,
  minSecsRemaining: CONFIG.minSecsRemaining,
  maxSecsRemaining: CONFIG.maxSecsRemaining,

  // Risk
  maxTotalAtRisk: CONFIG.maxTotalAtRisk,

  // Sizing
  betSizeUsdc: 10,                  // fixed USDC per trade (legacy, overridden by tiers)

  // MidEdge gate
  minMidEdge: -1,                   // disabled by default

  // Sizing tiers (score-based)
  sizingTier1Score: 80,
  sizingTier1Size: 15,
  sizingTier2Score: 70,
  sizingTier2Size: 10,
  sizingTier3Score: 60,
  sizingTier3Size: 5,
  sizingTier4Score: 50,
  sizingTier4Size: 2,

  // Conditional TP
  conditionalTpMinPrice: CONFIG.conditionalTpMinPrice,
  conditionalTpEdgeThreshold: CONFIG.conditionalTpEdgeThreshold,
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
      // Clamp critical values to prevent bad saved configs
      if (_runtime.minTradeScore < 30) _runtime.minTradeScore = DEFAULT_RUNTIME.minTradeScore;
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
