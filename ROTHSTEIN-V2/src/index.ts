// ─── ROTHSTEIN V2 — Main Entry Point ────────────────────────────────────────
// Whale copy-trading bot for Polymarket 5-min BTC/ETH up/down contracts.
// Architecture: Binance WS → Contract Scanner → Whale Monitor → Filter → Execute

import { initConfig, ENV } from "./config";
import { createLogger, setLevel } from "./log";
import * as binance from "./binance";
import * as contracts from "./contracts";
import * as book from "./book";
import * as whales from "./whales";
import * as positions from "./positions";
import * as decisions from "./decisions";
import * as pipeline from "./pipeline";
import * as server from "./server";
import * as executor from "./executor";

const log = createLogger("MAIN");

async function main(): Promise<void> {
  console.log("\n");
  console.log("  ██████╗  ██████╗ ████████╗██╗  ██╗███████╗████████╗███████╗██╗███╗   ██╗");
  console.log("  ██╔══██╗██╔═══██╗╚══██╔══╝██║  ██║██╔════╝╚══██╔══╝██╔════╝██║████╗  ██║");
  console.log("  ██████╔╝██║   ██║   ██║   ███████║███████╗   ██║   █████╗  ██║██╔██╗ ██║");
  console.log("  ██╔══██╗██║   ██║   ██║   ██╔══██║╚════██║   ██║   ██╔══╝  ██║██║╚██╗██║");
  console.log("  ██║  ██║╚██████╔╝   ██║   ██║  ██║███████║   ██║   ███████╗██║██║ ╚████║");
  console.log("  ╚═╝  ╚═╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝╚═╝╚═╝  ╚═══╝");
  console.log("                           V2 — \"I never gamble. I calculate.\"");
  console.log(`                           Mode: ${ENV.mode} | Port: ${ENV.port}\n`);

  // 1. Load config
  initConfig();
  log.info("Config loaded");

  // 2. Initialize CLOB client + keepalive (LIVE mode only)
  if (ENV.mode === "LIVE") {
    log.info("Initializing CLOB client for LIVE trading...");
    await executor.start();
    log.info("CLOB client ready");
  } else {
    log.info("PAPER mode — no CLOB client needed");
  }

  // 3. Start subsystems
  log.info("Starting subsystems...");

  // 3a. Binance price feed
  binance.start();
  log.info("Binance feed connecting...");

  // 3b. Polymarket order book WS
  book.start();
  log.info("Polymarket book WS connecting...");

  // 3c. Contract scanner (initial scan + interval)
  await contracts.start();
  log.info("Contract scanner running");

  // 3d. Decision logger + Position resolver
  decisions.start();
  positions.start();
  log.info("Position resolver running");

  // 3e. Whale monitor (starts polling)
  whales.start();
  log.info("Whale monitor running");

  // 3f. Copy pipeline (listens for whale-trade events)
  pipeline.start();
  log.info("Copy pipeline active");

  // 4. Start HTTP/WS server (dashboard)
  server.start();

  // 5. Graceful shutdown
  const shutdown = () => {
    log.info("Shutting down...");
    pipeline.stop();
    whales.stop();
    decisions.stop();
    positions.stop();
    contracts.stop();
    book.stop();
    binance.stop();
    executor.stop();
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("ROTHSTEIN V2 fully operational");
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
