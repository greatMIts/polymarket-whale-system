// ─── Layer 5: HTTP + WS Server ──────────────────────────────────────────────
// Express server for dashboard. WebSocket broadcasts state every 500ms.
// REST endpoints for runtime config updates (dead hours, pause, scoring).
// Password-protected dashboard. Dashboard is KING.

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
import * as whales from "./whale-monitor";
import * as positions from "./positions";
import * as risk from "./risk";
import * as copyPipeline from "./copy-pipeline";
import { getRecentDecisions } from "./decisions-log";
import * as fs from "fs";
import { readJsonl } from "./persistence";

// ─── State ──────────────────────────────────────────────────────────────────

let server: http.Server | null = null;
let wss: WebSocket.Server | null = null;
let broadcastInterval: NodeJS.Timeout | null = null;
let lastTradeTime = 0;

// Simple token-based auth: dashboard POSTs password, gets a token
const validTokens = new Set<string>();

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
    whalePoller: {
      active: whales.isActive(),
      lastPoll: whales.getLastPollTime(),
      walletsPolled: whales.getWalletsPolled(),
    },
    scanner: {
      running: whales.isActive(),      // pipeline is active when whale monitor is active
      lastScan: whales.getLastPollTime(),
    },
  };

  return {
    mode: CONFIG.mode,
    uptime: Date.now() - logger.getBootTime(),
    lastScanTime: whales.getLastPollTime(),
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
    whaleActivity: whales.getAllRecentActivity(50),
    deadHours: runtime.deadHours,
    paused: runtime.paused,
    runtimeConfig: { ...runtime },

    subsystemHealth,
  };
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

function generateToken(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 32; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  // Login endpoint is always accessible
  if (req.path === "/api/login" || req.path === "/health") {
    next();
    return;
  }

  // Check for token in query param or Authorization header
  const token = req.query.token as string || req.headers.authorization?.replace("Bearer ", "");
  if (token && validTokens.has(token)) {
    next();
    return;
  }

  // If requesting the dashboard page without auth, serve login page
  if (req.accepts("html") && !req.path.startsWith("/api/")) {
    res.send(getLoginPage());
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

function getLoginPage(): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ROTHSTEIN - Login</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0a0a; color:#e0e0e0; font-family:'Courier New',monospace;
         display:flex; justify-content:center; align-items:center; min-height:100vh; }
  .login-box { background:#111; border:1px solid #333; border-radius:8px; padding:40px;
               text-align:center; max-width:400px; width:90%; }
  h1 { color:#ff6600; font-size:28px; margin-bottom:8px; }
  .subtitle { color:#666; font-size:12px; margin-bottom:30px; }
  input { background:#1a1a1a; border:1px solid #333; color:#e0e0e0; padding:12px 16px;
          font-size:16px; font-family:inherit; width:100%; border-radius:4px; margin-bottom:16px; }
  input:focus { outline:none; border-color:#ff6600; }
  button { background:#ff6600; color:#000; border:none; padding:12px 24px; font-size:16px;
           font-family:inherit; font-weight:bold; cursor:pointer; border-radius:4px; width:100%; }
  button:hover { background:#ff8800; }
  .error { color:#ff4444; font-size:13px; margin-top:12px; display:none; }
</style>
</head><body>
<div class="login-box">
  <h1>ROTHSTEIN</h1>
  <div class="subtitle">"I never gamble. I calculate."</div>
  <input type="password" id="pw" placeholder="Password" autofocus
         onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">Enter</button>
  <div class="error" id="err">Wrong password</div>
</div>
<script>
async function login() {
  const pw = document.getElementById('pw').value;
  const res = await fetch('/api/login', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ password: pw })
  });
  const data = await res.json();
  if (data.token) {
    localStorage.setItem('rothstein_token', data.token);
    window.location.href = '/?token=' + data.token;
  } else {
    document.getElementById('err').style.display = 'block';
  }
}
</script>
</body></html>`;
}

// ─── Start Server ──────────────────────────────────────────────────────────

export function start(): void {
  const app = express();
  app.use(express.json());

  // ─── Login endpoint (before auth middleware) ─────────────────────────
  app.post("/api/login", (req, res) => {
    if (req.body.password === CONFIG.dashboardPassword) {
      const token = generateToken();
      validTokens.add(token);
      logger.event("server", "DASHBOARD_LOGIN");
      res.json({ ok: true, token });
    } else {
      res.status(401).json({ ok: false, error: "Wrong password" });
    }
  });

  // Health check (no auth needed)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", mode: CONFIG.mode, uptime: Date.now() - logger.getBootTime() });
  });

  // Auth middleware — everything below requires a valid token
  app.use(requireAuth);

  // Serve dashboard (only for authenticated users)
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

  // Update runtime config (all filter parameters, dead hours, pause, scoring, etc.)
  app.post("/api/config", (req, res) => {
    try {
      const updates: Partial<RuntimeConfig> = {};
      const b = req.body;

      // Existing params
      if (b.deadHours !== undefined) {
        updates.deadHours = b.deadHours.map(Number).filter((n: number) => !isNaN(n) && n >= 0 && n < 24);
      }
      if (b.minTradeScore !== undefined) updates.minTradeScore = Math.max(30, Math.min(100, Number(b.minTradeScore)));
      if (b.sizingMultiplier !== undefined) updates.sizingMultiplier = Math.max(0, Math.min(5, Number(b.sizingMultiplier)));
      if (b.maxConcurrentPositions !== undefined) updates.maxConcurrentPositions = Math.max(1, Math.min(200, Number(b.maxConcurrentPositions)));
      if (b.paused !== undefined) updates.paused = Boolean(b.paused);

      // Hard gates
      if (b.minEdgeVsSpot !== undefined) updates.minEdgeVsSpot = Math.max(0, Math.min(0.5, Number(b.minEdgeVsSpot)));
      if (b.minPrice !== undefined) updates.minPrice = Math.max(0.01, Math.min(0.99, Number(b.minPrice)));
      if (b.maxPrice !== undefined) updates.maxPrice = Math.max(0.01, Math.min(0.99, Number(b.maxPrice)));
      if (b.maxBookSpread !== undefined) updates.maxBookSpread = Math.max(0.001, Math.min(0.20, Number(b.maxBookSpread)));
      if (b.minSecsRemaining !== undefined) updates.minSecsRemaining = Math.max(0, Math.min(600, Number(b.minSecsRemaining)));
      if (b.maxSecsRemaining !== undefined) updates.maxSecsRemaining = Math.max(30, Math.min(900, Number(b.maxSecsRemaining)));

      // Risk
      if (b.maxTotalAtRisk !== undefined) updates.maxTotalAtRisk = Math.max(5, Math.min(500, Number(b.maxTotalAtRisk)));
      // Sizing
      if (b.betSizeUsdc !== undefined) updates.betSizeUsdc = Math.max(1, Math.min(1000, Number(b.betSizeUsdc)));

      // Conditional TP
      if (b.conditionalTpMinPrice !== undefined) updates.conditionalTpMinPrice = Math.max(0.5, Math.min(0.99, Number(b.conditionalTpMinPrice)));
      if (b.conditionalTpEdgeThreshold !== undefined) updates.conditionalTpEdgeThreshold = Math.max(-0.5, Math.min(0.5, Number(b.conditionalTpEdgeThreshold)));

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

  // Reset session stats
  app.post("/api/reset-session", (_req, res) => {
    risk.resetSession();
    res.json({ ok: true });
  });

  // ─── Data Export Endpoints ────────────────────────────────────────────

  // Export decisions as CSV
  app.get("/api/export/decisions", (_req, res) => {
    try {
      const entries = readJsonl<any>(CONFIG.decisionsFile);
      const decisions = entries.filter((e: any) => e.ts && e.conditionId && e.score !== undefined && !e.type);
      if (decisions.length === 0) { res.status(404).json({ error: "No decisions to export" }); return; }

      const headers = ["ts","time","conditionId","title","asset","side","score","action","sizeUsd","entryPrice","secsRemaining","edgeVsSpot","midEdge","momentumAligned","spotPrice","polyMid","bookSpread","delta30s","delta5m","vol1h","fairValue","concurrentWhales","bestWalletTier","whaleMaxSize","whaleAgreement","triggeredByWallet","whaleWalletLabel","whaleTier","whaleUsdcSize","whaleEntryPrice","pipelineLatencyMs","resolution","won","pnl"];
      const csvLines = [headers.join(",")];
      for (const d of decisions) {
        const f = d.features || {};
        const row = [
          d.ts, new Date(d.ts).toISOString(), d.conditionId, `"${(d.title||'').replace(/"/g,'""')}"`,
          d.asset, d.side, d.score, d.action, d.sizeUsd||0, d.entryPrice?.toFixed(6)||'',
          Math.round(d.secsRemaining||0), f.edgeVsSpot?.toFixed(6)||'', f.midEdge?.toFixed(6)||'',
          f.momentumAligned||false, f.spotPrice?.toFixed(2)||'', f.polyMid?.toFixed(4)||'',
          f.bookSpread?.toFixed(4)||'', f.delta30s?.toFixed(6)||'', f.delta5m?.toFixed(6)||'',
          f.vol1h?.toFixed(4)||'', f.fairValue?.toFixed(6)||'', f.concurrentWhales||0,
          f.bestWalletTier||0, f.whaleMaxSize?.toFixed(2)||0, f.whaleAgreement||false,
          d.triggeredByWallet||'', d.whaleWalletLabel||'', d.whaleTier===undefined?'':d.whaleTier,
          d.whaleUsdcSize===undefined?'':d.whaleUsdcSize?.toFixed(2), d.whaleEntryPrice===undefined?'':d.whaleEntryPrice?.toFixed(6),
          d.pipelineLatencyMs===undefined?'':d.pipelineLatencyMs,
          d.resolution||'', d.won===undefined?'':d.won, d.pnl===undefined?'':d.pnl?.toFixed(4)
        ];
        csvLines.push(row.join(","));
      }
      const csv = csvLines.join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="rothstein_decisions_${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}.csv"`);
      res.send(csv);
      logger.event("server", "EXPORTED_DECISIONS", { count: decisions.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Export trades (positions) as CSV
  app.get("/api/export/trades", (_req, res) => {
    try {
      const entries = readJsonl<any>(CONFIG.positionsFile);
      // Build positions map from JSONL events
      const posMap = new Map<string, any>();
      for (const entry of entries) {
        if (entry.type === "OPEN" && entry.position) {
          posMap.set(entry.position.id, { ...entry.position, resolvedData: null });
        } else if (entry.type === "RESOLVED" && entry.id) {
          const pos = posMap.get(entry.id);
          if (pos) pos.resolvedData = entry;
        }
      }
      const allPositions = [...posMap.values()];
      if (allPositions.length === 0) { res.status(404).json({ error: "No trades to export" }); return; }

      const headers = ["ts","time","id","mode","asset","side","title","entryPrice","sizeUsd","shares","score","edgeVsSpot","midEdge","momentumAligned","secsRemaining","spotPrice","polyMid","bookSpread","delta30s","delta5m","vol1h","fairValue","concurrentWhales","bestWalletTier","whaleMaxSize","strikePrice","conditionId","triggeredByWallet","whaleWalletLabel","whaleTier","whaleUsdcSize","whaleEntryPrice","pipelineLatencyMs","whaleToExecutionMs","slippageVsWhale","bookSpreadAtEntry","status","resolution","won","pnl","exitPrice","closedAt"];
      const csvLines = [headers.join(",")];
      for (const p of allPositions) {
        const t = p.trade || {};
        const f = t.features || {};
        const r = p.resolvedData || {};
        const wc = t.whaleCopy || {};
        const row = [
          t.ts||p.openedAt, new Date(t.ts||p.openedAt).toISOString(), t.id||p.id, t.mode||'PAPER',
          t.asset||'', t.side||'', `"${(t.title||'').replace(/"/g,'""')}"`,
          t.entryPrice?.toFixed(6)||'', t.sizeUsd||'', t.shares?.toFixed(4)||'', t.score||'',
          f.edgeVsSpot?.toFixed(6)||'', f.midEdge?.toFixed(6)||'', f.momentumAligned||false,
          Math.round(f.secsRemaining||0), f.spotPrice?.toFixed(2)||'', f.polyMid?.toFixed(4)||'',
          f.bookSpread?.toFixed(4)||'', f.delta30s?.toFixed(6)||'', f.delta5m?.toFixed(6)||'',
          f.vol1h?.toFixed(4)||'', f.fairValue?.toFixed(6)||'', f.concurrentWhales||0,
          f.bestWalletTier||0, f.whaleMaxSize?.toFixed(2)||0, t.strikePrice?.toFixed(2)||'',
          t.conditionId||'',
          wc.triggeredByWallet||'', wc.whaleWalletLabel||'', wc.whaleTier===undefined?'':wc.whaleTier,
          wc.whaleUsdcSize===undefined?'':wc.whaleUsdcSize?.toFixed(2),
          wc.whaleEntryPrice===undefined?'':wc.whaleEntryPrice?.toFixed(6),
          wc.pipelineLatencyMs===undefined?'':wc.pipelineLatencyMs,
          wc.whaleToExecutionMs===undefined?'':wc.whaleToExecutionMs,
          wc.slippageVsWhale===undefined?'':wc.slippageVsWhale?.toFixed(6),
          wc.bookSpreadAtEntry===undefined?'':wc.bookSpreadAtEntry?.toFixed(4),
          r.status||p.status||'OPEN', r.won===undefined?'':(r.won?'WIN':'LOSS'),
          r.won===undefined?'':r.won, r.pnl===undefined?'':r.pnl?.toFixed(4),
          r.exitPrice?.toFixed(6)||'', r.ts ? new Date(r.ts).toISOString() : ''
        ];
        csvLines.push(row.join(","));
      }
      const csv = csvLines.join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="rothstein_trades_${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}.csv"`);
      res.send(csv);
      logger.event("server", "EXPORTED_TRADES", { count: allPositions.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // List archived data files
  app.get("/api/archives", (_req, res) => {
    try {
      const archiveDir = path.join(CONFIG.dataDir, "archives");
      if (!fs.existsSync(archiveDir)) { res.json({ archives: [] }); return; }
      const files = fs.readdirSync(archiveDir).sort().reverse();
      const archives = files.map(f => {
        const stat = fs.statSync(path.join(archiveDir, f));
        return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
      });
      res.json({ archives, dataDir: CONFIG.dataDir });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Download a specific archive file
  app.get("/api/archives/:filename", (req, res) => {
    try {
      const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, ""); // sanitize
      const filePath = path.join(CONFIG.dataDir, "archives", filename);
      if (!fs.existsSync(filePath)) { res.status(404).json({ error: "Archive not found" }); return; }
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.sendFile(path.resolve(filePath));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── HTTP + WS Server ─────────────────────────────────────────────────

  server = http.createServer(app);
  wss = new WebSocket.Server({ server });

  wss.on("connection", (client, req) => {
    // Check auth token in WS URL query params
    const url = new URL(req.url || "", `http://localhost:${CONFIG.port}`);
    const token = url.searchParams.get("token");
    if (!token || !validTokens.has(token)) {
      client.close(4001, "Unauthorized");
      return;
    }

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
