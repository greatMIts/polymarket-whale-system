// ─── ROTHSTEIN: Boot Sequence ────────────────────────────────────────────────
// 12-step startup. Each step depends on the previous.
// Graceful shutdown on SIGINT/SIGTERM.
// "I never gamble. I calculate."

import { CONFIG, startConfigWatcher, stopConfigWatcher } from "./config";
import { logger } from "./logger";
import { ensureDataDir } from "./persistence";
import * as binance from "./binance-feed";
import * as polyBook from "./polymarket-book";
import * as contractScanner from "./contract-scanner";
import * as whales from "./whale-listener";
import * as positions from "./positions";
import * as scanner from "./scanner";
import * as server from "./server";

// ─── Boot ──────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // Step 1: Banner
  logger.banner();

  // Step 2: Mode check
  logger.info("boot", `Mode: ${CONFIG.mode}`);
  if (CONFIG.mode === "LIVE") {
    if (!CONFIG.polyApiKey || !CONFIG.polyPrivateKey) {
      logger.error("boot", "LIVE mode requires POLY_API_KEY and POLY_PRIVATE_KEY");
      process.exit(1);
    }
    logger.warn("boot", "⚠️  LIVE MODE — Real money on the line");
  } else {
    logger.info("boot", "PAPER mode — Simulated trading, no real orders");
  }

  // Step 3: Data directory + persistence
  logger.info("boot", "Step 3/12: Ensuring data directory...");
  ensureDataDir();

  // Step 4: Hot-reloadable config
  logger.info("boot", "Step 4/12: Loading runtime config...");
  startConfigWatcher();

  // Step 5: Crash recovery — restore open positions
  logger.info("boot", "Step 5/12: Crash recovery...");
  positions.loadFromDisk();

  // Step 6: Connect Binance WS
  logger.info("boot", "Step 6/12: Connecting to Binance...");
  binance.connect();

  // Step 7: Connect Polymarket WS
  logger.info("boot", "Step 7/12: Connecting to Polymarket book...");
  polyBook.connect();

  // Step 8: Connect Spy Server (whale signals — optional)
  logger.info("boot", "Step 8/12: Connecting to Spy server...");
  whales.connect();

  // Step 9: Initial contract scan
  logger.info("boot", "Step 9/12: Scanning for contracts...");
  await contractScanner.scanForContracts();

  // Step 10: Wait for Binance to be ready
  logger.info("boot", "Step 10/12: Waiting for Binance price feed...");
  await waitForBinance(15_000);

  // Step 11: Start periodic tasks
  logger.info("boot", "Step 11/12: Starting periodic tasks...");
  startPeriodicTasks();

  // Step 12: Start HTTP server + dashboard
  logger.info("boot", "Step 12/12: Starting server...");
  server.start();

  // Step 13: Start scan loop
  logger.info("boot", "Starting main scan loop...");
  scanner.start();

  logger.info("boot", "═══════════════════════════════════════════");
  logger.info("boot", "  ROTHSTEIN is READY. All systems nominal.");
  logger.info("boot", `  Dashboard: http://localhost:${CONFIG.port}`);
  logger.info("boot", `  Mode: ${CONFIG.mode}`);
  logger.info("boot", "═══════════════════════════════════════════");
}

// ─── Wait for Binance ──────────────────────────────────────────────────────

function waitForBinance(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (binance.isReady()) {
        clearInterval(check);
        const btc = binance.getPrice("BTC");
        const eth = binance.getPrice("ETH");
        logger.info("boot", `Binance ready! BTC=$${btc ? btc.toFixed(2) : 'pending'} ETH=$${eth ? eth.toFixed(2) : 'pending'}`);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        logger.warn("boot", "Binance timeout — proceeding with REST fallback");
        resolve();
      }
    }, 500);
  });
}

// ─── Periodic Tasks ─────────────────────────────────────────────────────────

let intervals: NodeJS.Timeout[] = [];

function startPeriodicTasks(): void {
  // Contract discovery (every 30s)
  intervals.push(setInterval(async () => {
    try { await contractScanner.scanForContracts(); } catch {}
  }, CONFIG.contractScanMs));

  // Resolution check (every 30s)
  intervals.push(setInterval(async () => {
    try { await positions.checkResolutions(); } catch {}
  }, CONFIG.resolutionCheckMs));

  // Conditional TP check (every 10s — faster for time-sensitive exits)
  intervals.push(setInterval(async () => {
    try { await positions.checkConditionalTp(); } catch {}
  }, 10_000));

  // Book refresh for empty books (every 15s)
  intervals.push(setInterval(async () => {
    try { await polyBook.refreshEmptyBooks(); } catch {}
  }, CONFIG.bookRefreshMs));

  // Heartbeat / health monitor (every 10s)
  intervals.push(setInterval(() => {
    const btcAge = Date.now() - binance.getLastUpdate("BTC");
    const ethAge = Date.now() - binance.getLastUpdate("ETH");
    if (btcAge > CONFIG.binanceStaleMs) {
      logger.warn("heartbeat", `BTC price stale (${Math.round(btcAge / 1000)}s old)`);
    }
    if (ethAge > CONFIG.binanceStaleMs) {
      logger.warn("heartbeat", `ETH price stale (${Math.round(ethAge / 1000)}s old)`);
    }
  }, CONFIG.heartbeatCheckMs));

  logger.info("boot", "Periodic tasks started: contracts, resolution, TP check, book refresh, heartbeat");
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info("boot", `Received ${signal} — shutting down gracefully...`);

  scanner.stop();
  server.stop();

  for (const iv of intervals) clearInterval(iv);
  intervals = [];

  binance.disconnect();
  polyBook.disconnect();
  whales.disconnect();
  stopConfigWatcher();

  logger.info("boot", "ROTHSTEIN shutdown complete. Arrivederci.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  logger.error("boot", `Uncaught exception: ${e.message}\n${e.stack}`);
});
process.on("unhandledRejection", (reason) => {
  logger.error("boot", `Unhandled rejection: ${reason}`);
});

// ─── GO ─────────────────────────────────────────────────────────────────────

boot().catch((e) => {
  logger.error("boot", `Fatal boot error: ${e.message}`);
  process.exit(1);
});
