// ─── ROTHSTEIN V2 Server ─────────────────────────────────────────────────────
// Express HTTP + WebSocket server for dashboard + API.

import express from "express";
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as path from "path";
import * as fs from "fs";
import { DashboardState } from "./types";
import { ENV, getFilter, updateFilter } from "./config";
import { createLogger } from "./log";
import * as binance from "./binance";
import * as contracts from "./contracts";
import * as book from "./book";
import * as whales from "./whales";
import * as positions from "./positions";
import * as decisions from "./decisions";
import * as pipeline from "./pipeline";

const log = createLogger("SERVER");
const startedAt = Date.now();

let app: express.Express;
let server: http.Server;
let wss: WebSocketServer;
let broadcastInterval: NodeJS.Timeout | null = null;

// ─── Build Dashboard State ──────────────────────────────────────────────────

function buildState(): DashboardState {
  const btcHistory = binance.getHistory("BTC");
  const ethHistory = binance.getHistory("ETH");
  // Only send last 5 minutes of history to dashboard (limit payload size)
  const fiveMinAgo = Date.now() - 300_000;

  return {
    mode: ENV.mode,
    uptime: Date.now() - startedAt,
    paused: getFilter().paused,
    btcPrice: binance.getPrice("BTC") || 0,
    ethPrice: binance.getPrice("ETH") || 0,
    btcDelta30s: binance.getDelta("BTC", 30),
    ethDelta30s: binance.getDelta("ETH", 30),
    btcHistory: btcHistory.filter(p => p.ts > fiveMinAgo),
    ethHistory: ethHistory.filter(p => p.ts > fiveMinAgo),
    activeContracts: contracts.getActiveContracts(),
    recentDecisions: decisions.getRecentDecisions(),
    whaleSignals: whales.getRecentSignals(50),
    openPositions: positions.getOpenPositions(),
    closedPositions: positions.getClosedPositions().slice(-50),
    stats: positions.getStats(),
    health: {
      binanceWs: binance.getStatus(),
      polymarketWs: book.getStatus(),
      whaleMonitor: whales.getStatus(),
    },
    filter: getFilter(),
  };
}

// ─── Start Server ───────────────────────────────────────────────────────────

export function start(): void {
  app = express();
  app.use(express.json());

  // Serve dashboard
  const dashboardPath = path.resolve(__dirname, "../dashboard");
  app.use("/", express.static(dashboardPath));

  // Health endpoint
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", mode: ENV.mode, uptime: Date.now() - startedAt });
  });

  // Full state API
  app.get("/api/state", (_req, res) => {
    res.json(buildState());
  });

  // Filter config endpoints
  app.get("/api/filter", (_req, res) => {
    res.json(getFilter());
  });

  app.post("/api/filter", (req, res) => {
    const updated = updateFilter(req.body);
    log.info(`Filter updated: ${JSON.stringify(req.body)}`);
    res.json(updated);
  });

  // Pause/unpause
  app.post("/api/pause", (_req, res) => {
    updateFilter({ paused: true });
    log.info("Bot PAUSED via API");
    res.json({ paused: true });
  });

  app.post("/api/resume", (_req, res) => {
    updateFilter({ paused: false });
    log.info("Bot RESUMED via API");
    res.json({ paused: false });
  });

  // Mode switch (PAPER/LIVE)
  app.post("/api/mode", (req, res) => {
    const newMode = req.body.mode;
    if (newMode === "PAPER" || newMode === "LIVE") {
      ENV.mode = newMode;
      log.info(`Mode switched to ${newMode} via API`);
      res.json({ mode: newMode });
    } else {
      res.status(400).json({ error: "Invalid mode. Use PAPER or LIVE." });
    }
  });

  // Download decisions/trades files
  app.get("/api/download/:file", (req, res) => {
    const allowed = ["decisions.csv", "trades.csv"];
    const file = req.params.file;
    if (!allowed.includes(file)) return res.status(404).send("Not found");
    const filePath = path.resolve(ENV.dataDir, file);
    if (!fs.existsSync(filePath)) return res.status(404).send("File not found");
    res.download(filePath);
  });

  // Create HTTP server
  server = http.createServer(app);

  // WebSocket server for live dashboard updates
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    log.info("Dashboard client connected");
    // Send initial state immediately
    try { ws.send(JSON.stringify(buildState())); } catch {}
    ws.on("close", () => log.info("Dashboard client disconnected"));
  });

  // Broadcast state to all connected dashboards every 500ms
  broadcastInterval = setInterval(() => {
    if (wss.clients.size === 0) return;
    const state = JSON.stringify(buildState());
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(state); } catch {}
      }
    }
  }, 500);

  server.listen(ENV.port, () => {
    log.info(`Server listening on port ${ENV.port}`);
    log.info(`Dashboard: http://localhost:${ENV.port}`);
    log.info(`API: http://localhost:${ENV.port}/api/state`);
  });
}

export function stop(): void {
  if (broadcastInterval) clearInterval(broadcastInterval);
  if (wss) wss.close();
  if (server) server.close();
}
