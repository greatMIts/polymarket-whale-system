// ─── Layer 5: HTTP + WS Server ──────────────────────────────────────────────
// Express server for dashboard. WebSocket broadcasts state every 500ms.
// REST endpoints for runtime config updates (dead hours, pause, scoring).
// Dashboard is KING — all state visible, all controls accessible.

import express from "express";
import * as http from "http";
import WebSocket from "ws";
import * as path from "path";
import { DashboardPayload, SubsystemHealth, RuntimeConfig } from "./types";
import { CONFIG, getRuntime, updateRuntime } from "./config";
import { logger } from "./logger";
import * as binance from "./binance-feed";
import * as polyBook from "./polymarket-book";
import * as contractScanner from "./contract-scanner";
import * as whales from "./whale-listener";
import * as positions from "./positions";
import * as risk from "./risk";
import * as scanner from "./scanner";
import { getRecentDecisions } from "./decisions-log";

// ─── State ──────────────────────────────────────────────────────────────────

let server: http.Server | null = null;
let wss: WebSocket.Server | null = null;
let broadcastInterval: NodeJS.Timeout | null = null;
let lastTradeTime = 0;

export function setLastTradeTime(ts: number): void {
  lastTradeTime = ts;
}

// ─── Build Dashboard Payload ───────────────────────────────────────────────

function buildPayload(): DashboardPayload {
  const runtime = getRuntime();

  const subsystemHealth: SubsystemHealth = {
    binanceWs: {
      connected: binance.isReady(),
      lastHeartbeat: Math.max(binance.getLastUpdate("BTC"), binance.getLastUpdate("ETH")),
      stale: binance.isStale(),
    },
    polymarketWs: {
      connected: polyBook.isConnected(),
      lastHeartbeat: polyBook.getLastHeartbeat(),
      stale: !polyBook.isConnected(),
    },
    spyWs: {
      connected: whales.isConnected(),
      lastHeartbeat: whales.getLastHeartbeat(),
      stale: !whales.isConnected(),
    },
    scanner: {
      running: scanner.isRunning(),
      lastScan: scanner.getLastScanTime(),
    },
  };

  return {
    mode: CONFIG.mode,
    uptime: Date.now() - logger.getBootTime(),
    lastScanTime: scanner.getLastScanTime(),
    lastTradeTime,

    btcPrice: binance.getPrice("BTC") || 0,
    ethPrice: binance.getPrice("ETH") || 0,
    btcDelta30s: binance.getDelta30s("BTC"),
    ethDelta30s: binance.getDelta30s("ETH"),

    activeContracts: contractScanner.getActiveContracts(),
    recentScores: getRecentDecisions(50),
    openPositions: positions.getOpen(),
    closedPositions: positions.getClosed(50),
    sessionStats: risk.getStats(),
    circuitBreaker: risk.getCircuitBreaker(),
    whaleActivity: whales.getAllRecentActivity(50),
    deadHours: runtime.deadHours,
    paused: runtime.paused,

    subsystemHealth,
  };
}

// ─── Start Server ──────────────────────────────────────────────────────────

export function start(): void {
  const app = express();
  app.use(express.json());

  // Serve dashboard
  app.use(express.static(path.join(__dirname, "..", "dashboard")));

  // ─── REST API ──────────────────────────────────────────────────────────

  // Get full state
  app.get("/api/state", (_req, res) => {
    res.json(buildPayload());
  });

  // Get runtime config
  app.get("/api/config", (_req, res) => {
    res.json(getRuntime());
  });

  // Update runtime config (dead hours, pause, scoring, etc.)
  app.post("/api/config", (req, res) => {
    try {
      const updates: Partial<RuntimeConfig> = {};

      if (req.body.deadHours !== undefined) {
        updates.deadHours = req.body.deadHours.map(Number).filter((n: number) => !isNaN(n) && n >= 0 && n < 24);
      }
      if (req.body.minTradeScore !== undefined) {
        updates.minTradeScore = Math.max(0, Math.min(100, Number(req.body.minTradeScore)));
      }
      if (req.body.sizingMultiplier !== undefined) {
        updates.sizingMultiplier = Math.max(0, Math.min(5, Number(req.body.sizingMultiplier)));
      }
      if (req.body.maxConcurrentPositions !== undefined) {
        updates.maxConcurrentPositions = Math.max(1, Math.min(20, Number(req.body.maxConcurrentPositions)));
      }
      if (req.body.paused !== undefined) {
        updates.paused = Boolean(req.body.paused);
      }

      const newConfig = updateRuntime(updates);
      logger.event("server", "CONFIG_UPDATED", updates);
      res.json({ ok: true, config: newConfig });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Toggle pause
  app.post("/api/pause", (_req, res) => {
    const current = getRuntime();
    const newConfig = updateRuntime({ paused: !current.paused });
    logger.event("server", newConfig.paused ? "PAUSED" : "RESUMED");
    res.json({ ok: true, paused: newConfig.paused });
  });

  // Reset circuit breaker
  app.post("/api/reset-circuit-breaker", (_req, res) => {
    risk.manualReset();
    res.json({ ok: true });
  });

  // Reset session stats
  app.post("/api/reset-session", (_req, res) => {
    risk.resetSession();
    res.json({ ok: true });
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", mode: CONFIG.mode, uptime: Date.now() - logger.getBootTime() });
  });

  // ─── HTTP + WS Server ─────────────────────────────────────────────────

  server = http.createServer(app);
  wss = new WebSocket.Server({ server });

  wss.on("connection", (client) => {
    logger.debug("server", "Dashboard client connected");
    // Send initial state immediately
    try {
      client.send(JSON.stringify({ type: "state", ...buildPayload() }));
    } catch {}
  });

  // Broadcast state to all dashboard clients
  broadcastInterval = setInterval(() => {
    if (!wss || wss.clients.size === 0) return;
    const payload = JSON.stringify({ type: "state", ...buildPayload() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload); } catch {}
      }
    }
  }, CONFIG.dashboardBroadcastMs);

  server.listen(CONFIG.port, () => {
    logger.info("server", `Dashboard: http://localhost:${CONFIG.port}`);
    logger.info("server", `WS: ws://localhost:${CONFIG.port}`);
    logger.info("server", `API: http://localhost:${CONFIG.port}/api/state`);
  });
}

export function stop(): void {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
  if (wss) {
    wss.close();
    wss = null;
  }
  if (server) {
    server.close();
    server = null;
  }
}
