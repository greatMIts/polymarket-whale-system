/**
 * bot-server.ts — Main entry point for the Polymarket Whale Copy-Trading Bot.
 *
 * Run: npx ts-node src/bot-server.ts
 * Dashboard: http://localhost:4444
 *
 * Architecture:
 *   market-data.ts → whale-watcher.ts → filter-engine.ts → risk-manager.ts → executor.ts
 *   All orchestrated from this file, with Express + WS for the dashboard.
 *
 * BOT_ID env var: "NEW_BEST" (default), "BALANCED", or "GOLD_PLUS"
 */

import express from "express";
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";
import { CONFIG, BOT_ID, FILE_PREFIX, AVAILABLE_WALLETS } from "./config";
import type { FilterPresetName } from "./config";
import {
  connectBinance,
  startBinanceWatchdog,
  getBinanceHealth,
  startVolSamplers,
  connectPolymarketWs,
  proactiveContractScan,
  refreshEmptyBooks,
  checkResolutions,
  marketState,
  getPrice,
  getPriceDelta,
  getBtcDirection,
  computeRealizedVolatility,
  resolutionCache,
} from "./market-data";
import {
  startPolling,
  getRecentWhaleTrades,
  getTotalWhaleTradeCount,
  allWhaleTrades,
} from "./whale-watcher";
import { filterStats } from "./filter-engine";
import { resetSessionLosses } from "./risk-manager";
import {
  initExecutor,
  getSettings,
  getEffectiveSettings,
  updateSettings,
  getOpenPositions,
  getClosedPositions,
  getAllBotTrades,
  getStats,
  resetStats,
  getEventLog,
  getFilterStats,
  getLiveState,
  resolvePositions,
  decisionsRotationConfig,
  botTradesRotationConfig,
} from "./executor";
import { initClobClient, isClobReady } from "./clob-client";
import { startRotationTimer, listArchives, readArchive } from "./file-rotation";
import { liveEventsRotationConfig } from "./live-events";

// ─── EXPRESS + WEBSOCKET ────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// ─── AUTH MIDDLEWARE (simple bearer token) ───────────────────────────────────

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Allow dashboard HTML without auth
  if (req.path === "/" || req.path === "/bot-dashboard.html") {
    return next();
  }

  // Check token for API routes
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string;
  const token = authHeader?.replace("Bearer ", "") || queryToken;

  if (token !== CONFIG.authToken) {
    return res.status(401).json({ error: "Unauthorized. Provide ?token=YOUR_TOKEN or Authorization: Bearer YOUR_TOKEN" });
  }

  next();
}

// Auth on /api routes only
app.use("/api", authMiddleware);

// ─── DASHBOARD BROADCAST ────────────────────────────────────────────────────

setInterval(() => {
  const settings = getSettings();
  const stats = getStats();
  const openPositions = getOpenPositions();
  const closedPositions = getClosedPositions().slice(0, 100);

  // Build token mid-prices for open positions (current Polymarket mid-price)
  const tokenMids: Record<string, number> = {};
  for (const pos of openPositions) {
    if (pos.asset && !tokenMids[pos.asset]) {
      const book = marketState.tokenBook.get(pos.asset);
      if (book && book.ask > 0 && book.bid > 0) {
        tokenMids[pos.asset] = (book.ask + book.bid) / 2;
      } else if (book && book.ask > 0) {
        tokenMids[pos.asset] = book.ask;
      } else if (book && book.bid > 0) {
        tokenMids[pos.asset] = book.bid;
      }
    }
  }

  const payload = JSON.stringify({
    type: "state",
    // Bot identity
    botId: BOT_ID,

    // Prices
    prices: Object.fromEntries(
      Object.entries(marketState.assetPrices).map(([sym, b]) => [sym, b.price])
    ),
    delta30s: getPriceDelta("BTCUSDT", 30),
    delta5m: getPriceDelta("BTCUSDT", 300),
    priceDirection: getBtcDirection(),

    // Token mid-prices for open positions
    tokenMids,

    // Whale trades
    recentWhaleTrades: getRecentWhaleTrades(200),
    totalWhaleTrades: getTotalWhaleTradeCount(),

    // Bot trades
    openPositions,
    closedPositions,

    // Stats & settings
    stats,
    settings,
    effectiveSettings: getEffectiveSettings(),
    filterStats: getFilterStats(),

    // Wallet picker: all available wallets for the dashboard UI
    availableWallets: AVAILABLE_WALLETS,

    // LIVE mode state
    liveState: getLiveState(),
    // System
    subscribedTokens: marketState.subscribedTokens.size,
    contractsCached: marketState.contractCache.size,
    resolutionsCached: resolutionCache.size,
    binanceHealth: getBinanceHealth(),
    eventLog: getEventLog().slice(0, 50),
    uptime: process.uptime(),
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}, CONFIG.broadcastIntervalMs);

// WS auth: clients must send token as first message
wss.on("connection", (ws) => {
  let authenticated = false;

  // Give 5s to authenticate
  const authTimeout = setTimeout(() => {
    if (!authenticated) ws.close(1008, "Auth timeout");
  }, 5000);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "auth") {
        if (msg.token === CONFIG.authToken) {
          authenticated = true;
          clearTimeout(authTimeout);
          ws.send(JSON.stringify({ type: "auth_ok" }));
        } else {
          ws.send(JSON.stringify({ type: "auth_error", message: "Invalid token" }));
          ws.close(1008, "Invalid token");
        }
        return;
      }

      if (!authenticated) {
        ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
        return;
      }

      // Handle settings updates from dashboard
      if (msg.type === "update_settings") {
        updateSettings(msg.settings);
        ws.send(JSON.stringify({ type: "settings_updated", settings: getSettings() }));
      }
    } catch {}
  });
});

// ─── REST API ───────────────────────────────────────────────────────────────

// Settings
app.get("/api/settings", (_req, res) => res.json(getSettings()));
app.post("/api/settings", (req, res) => {
  updateSettings(req.body);
  res.json(getSettings());
});

// Bot stats
app.get("/api/stats", (_req, res) => res.json(getStats()));
app.post("/api/reset-stats", (_req, res) => {
  resetStats();
  res.json({ ok: true, stats: getStats() });
});

app.post("/api/reset-session-losses", (_req, res) => {
  resetSessionLosses(getClosedPositions());
  res.json({ success: true, message: "Session losses reset" });
});

// Bot trades
app.get("/api/bot-trades", (_req, res) => res.json(getAllBotTrades()));
app.get("/api/open-positions", (_req, res) => res.json(getOpenPositions()));
app.get("/api/closed-positions", (_req, res) => res.json(getClosedPositions()));

// Whale trades
app.get("/api/whale-trades", (req, res) => {
  const limit = parseInt(req.query.limit as string) || 200;
  res.json(getRecentWhaleTrades(limit));
});

// Filter info
app.get("/api/filters", (_req, res) => {
  res.json({
    botId: BOT_ID,
    stats: getFilterStats(),
    active: BOT_ID,
  });
});

// Event log
app.get("/api/events", (_req, res) => res.json(getEventLog()));

// System info
app.get("/api/system", (_req, res) => {
  res.json({
    botId: BOT_ID,
    uptime: process.uptime(),
    totalWhaleTrades: getTotalWhaleTradeCount(),
    subscribedTokens: marketState.subscribedTokens.size,
    contractsCached: marketState.contractCache.size,
    resolutionsCached: resolutionCache.size,
    prices: Object.fromEntries(
      Object.entries(marketState.assetPrices).map(([sym, b]) => [sym, b.price])
    ),
    vols: Object.fromEntries(
      Object.keys(marketState.assetPrices).map(sym => [sym, computeRealizedVolatility(sym)])
    ),
  });
});

// ─── CSV EXPORT ─────────────────────────────────────────────────────────────

// Export whale trades
app.get("/api/export-whale.csv", (_req, res) => {
  const trades = allWhaleTrades;
  const header = "ts,wallet,walletLabel,side,outcome,price,usdcSize,shares,assetLabel,binanceSymbol," +
    "spotPrice,delta30s,delta5m,priceDirection,edgeVsSpot,polyMid,midEdge,momentumAligned," +
    "secsRemaining,contractDuration,resolution,won,pnl,conditionId,title,asset,whaleTxHash\n";

  const rows = trades.map(t => {
    const resolution = resolutionCache.get(t.conditionId) || null;
    let won: boolean | null = null;
    let pnl: number | null = null;
    // Only compute won/pnl for BUY trades — SELL won/pnl is misleading (BUY perspective formula)
    if (resolution && t.side === "BUY") {
      won = t.outcome.toLowerCase() === resolution.toLowerCase();
      pnl = won ? (1 - t.price) * t.shares : -t.price * t.shares;
    }
    return [
      t.tsIso, t.wallet, t.walletLabel, t.side, t.outcome,
      t.price, t.usdcSize, t.shares, t.assetLabel, t.binanceSymbol,
      t.spotPrice ?? (t as any).btcPriceAtTrade, ((t.delta30s ?? (t as any).btcDelta30s) || 0).toFixed(4), ((t.delta5m ?? (t as any).btcDelta5m) || 0).toFixed(4), t.priceDirection ?? (t as any).btcDirection,
      (t.edgeVsSpot ?? (t as any).edgeVsBtc) !== null ? ((t.edgeVsSpot ?? (t as any).edgeVsBtc) || 0).toFixed(4) : "",
      t.polyMid > 0 ? t.polyMid.toFixed(4) : "",
      t.midEdge !== null ? t.midEdge.toFixed(4) : "",
      t.momentumAligned ? "TRUE" : "FALSE",
      t.secondsRemainingInContract >= 0 ? t.secondsRemainingInContract.toFixed(0) : "",
      t.contractDurationMinutes || "",
      resolution || "",
      won !== null ? (won ? "TRUE" : "FALSE") : "",
      pnl !== null ? pnl.toFixed(4) : "",
      t.conditionId,
      `"${(t.title || "").replace(/"/g, '""')}"`,
      t.asset,
      t.txHash || "",
    ].join(",");
  }).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${FILE_PREFIX}_whale_trades.csv`);
  res.send(header + rows);
});

// Export bot trades (with all new columns)
function generateBotTradesCsv(): string {
  const trades = getAllBotTrades();
  const header = "ts,botId,mode,filterPreset,walletLabel,side,outcome,entryPrice,sizeUsdc,shares," +
    "assetLabel,contractDuration,sizeReason,stackEntry,stackTotal,stackTriggerSize," +
    "midEdge,edgeVsSpot,momentumAligned,secsRemaining," +
    "whaleTxHash,latencyMs,spotPrice,polyMidAtDecision,bookSpread," +
    "resolution,won,pnl,status,conditionId,title,asset," +
    "slippage,fillPriceVsMid,vol1h,concurrentWhales,sessionLabel,orderBookDepth," +
    "confirmed,whaleUsdcSize,delta30s,delta5m,whalePrice\n";

  const rows = trades.map(t => [
    t.tsIso, t.botId || BOT_ID, t.mode, t.filterPreset, t.walletLabel, t.side, t.outcome,
    t.entryPrice, t.sizeUsdc, t.shares.toFixed(4),
    t.assetLabel,
    t.contractDuration || "",
    t.sizeReason || "STANDARD",
    t.stackEntry || 1,
    t.stackTotal || 1,
    t.stackTriggerSize ? Number(t.stackTriggerSize).toFixed(2) : "",
    t.midEdge !== null ? t.midEdge.toFixed(4) : "",
    (t.edgeVsSpot ?? (t as any).edgeVsBtc) !== null ? ((t.edgeVsSpot ?? (t as any).edgeVsBtc) || 0).toFixed(4) : "",
    t.momentumAligned ? "TRUE" : "FALSE",
    t.secsRemaining.toFixed(0),
    t.whaleTxHash || "",
    t.latencyMs || "",
    (t.spotPrice ?? (t as any).binancePrice) ? Number(t.spotPrice ?? (t as any).binancePrice).toFixed(2) : "",
    t.polyMidAtDecision ? Number(t.polyMidAtDecision).toFixed(4) : "",
    t.bookSpread ? Number(t.bookSpread).toFixed(4) : "",
    t.resolution || "",
    t.won !== null ? (t.won ? "TRUE" : "FALSE") : "",
    t.pnl !== null ? t.pnl.toFixed(4) : "",
    t.status,
    t.conditionId,
    `"${(t.title || "").replace(/"/g, '""')}"`,
    t.asset,
    // Statistical columns
    t.slippage !== null && t.slippage !== undefined ? Number(t.slippage).toFixed(4) : "0",
    t.fillPriceVsMid !== null && t.fillPriceVsMid !== undefined ? Number(t.fillPriceVsMid).toFixed(4) : "",
    (t.vol1h ?? (t as any).btcVol1h) !== null && (t.vol1h ?? (t as any).btcVol1h) !== undefined ? Number(t.vol1h ?? (t as any).btcVol1h).toFixed(6) : "",
    t.concurrentWhales !== null && t.concurrentWhales !== undefined ? t.concurrentWhales : "",
    t.sessionLabel || "",
    t.orderBookDepth !== null && t.orderBookDepth !== undefined ? Number(t.orderBookDepth).toFixed(2) : "",
    // Whale context columns
    t.confirmed !== undefined ? (t.confirmed ? "TRUE" : "FALSE") : "TRUE",
    (t as any).whaleUsdcSize !== null && (t as any).whaleUsdcSize !== undefined ? Number((t as any).whaleUsdcSize).toFixed(2) : "",
    ((t as any).delta30s ?? (t as any).btcDelta30s) != null ? Number((t as any).delta30s ?? (t as any).btcDelta30s).toFixed(4) : "",
    ((t as any).delta5m ?? (t as any).btcDelta5m) != null ? Number((t as any).delta5m ?? (t as any).btcDelta5m).toFixed(4) : "",
    (t as any).whalePrice !== null && (t as any).whalePrice !== undefined ? Number((t as any).whalePrice).toFixed(4) : "",
  ].join(",")).join("\n");

  return header + rows;
}

app.get("/api/export-bot.csv", (_req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${FILE_PREFIX}_bot_trades.csv`);
  res.send(generateBotTradesCsv());
});

// Alias endpoint per spec
app.get("/api/export-bot-trades.csv", (_req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${FILE_PREFIX}_bot_trades.csv`);
  res.send(generateBotTradesCsv());
});

// Export decisions log
app.get("/api/export-decisions.csv", (_req, res) => {
  const filePath = CONFIG.decisionsFile;
  if (!fs.existsSync(filePath)) {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=${FILE_PREFIX}_decisions.csv`);
    return res.send("No decisions logged yet.\n");
  }
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  const header = "ts,decision,filterPreset,walletLabel,side,outcome,price,usdcSize,assetLabel," +
    "midEdge,edgeVsSpot,momentumAligned,secsRemaining,contractDuration," +
    "filterReasons,riskReason," +
    "wouldPass_NEW_BEST,wouldPass_BALANCED,wouldPass_GOLD_PLUS," +
    "botId,whaleTxHash,latencyMs,spotPrice,polyMidAtDecision,bookSpread," +
    "conditionId,title," +
    "vol1h,concurrentWhales,sessionLabel,orderBookDepth," +
    "delta30s,delta5m\n";
  const rows = lines.map(line => {
    try {
      const d = JSON.parse(line);
      const wp = d.wouldPass || {};
      return [
        d.tsIso, d.decision, d.filterPreset, d.walletLabel, d.side, d.outcome,
        d.price, d.usdcSize, d.assetLabel,
        d.midEdge !== null && d.midEdge !== undefined ? Number(d.midEdge).toFixed(4) : "",
        (d.edgeVsSpot ?? d.edgeVsBtc) != null ? Number(d.edgeVsSpot ?? d.edgeVsBtc).toFixed(4) : "",
        d.momentumAligned ? "TRUE" : "FALSE",
        d.secsRemaining !== null && d.secsRemaining !== undefined ? Number(d.secsRemaining).toFixed(0) : "",
        d.contractDuration !== null && d.contractDuration !== undefined ? d.contractDuration : "",
        `"${(d.filterReasons || []).join("; ").replace(/"/g, '""')}"`,
        d.riskReason ? `"${String(d.riskReason).replace(/"/g, '""')}"` : "",
        // Handle both old (6 presets) and new (2/3 presets) formats
        wp.NEW_BEST !== undefined ? (wp.NEW_BEST ? "TRUE" : "FALSE") : (wp.FULL_COMBO ? "TRUE" : "FALSE"),
        wp.BALANCED !== undefined ? (wp.BALANCED ? "TRUE" : "FALSE") : "",
        wp.GOLD_PLUS !== undefined ? (wp.GOLD_PLUS ? "TRUE" : "FALSE") : "",
        d.botId || "",
        d.whaleTxHash || "",
        d.latencyMs !== null && d.latencyMs !== undefined ? d.latencyMs : "",
        (d.spotPrice ?? d.binancePrice) != null ? Number(d.spotPrice ?? d.binancePrice).toFixed(2) : "",
        d.polyMidAtDecision !== null && d.polyMidAtDecision !== undefined ? Number(d.polyMidAtDecision).toFixed(4) : "",
        d.bookSpread !== null && d.bookSpread !== undefined ? Number(d.bookSpread).toFixed(4) : "",
        d.conditionId,
        `"${(d.title || "").replace(/"/g, '""')}"`,
        // Statistical columns
        (d.vol1h ?? d.btcVol1h) != null ? Number(d.vol1h ?? d.btcVol1h).toFixed(6) : "",
        d.concurrentWhales !== null && d.concurrentWhales !== undefined ? d.concurrentWhales : "",
        d.sessionLabel || "",
        d.orderBookDepth !== null && d.orderBookDepth !== undefined ? Number(d.orderBookDepth).toFixed(2) : "",
        // Momentum columns
        (d.delta30s ?? d.btcDelta30s) != null ? Number(d.delta30s ?? d.btcDelta30s).toFixed(4) : "",
        (d.delta5m ?? d.btcDelta5m) != null ? Number(d.delta5m ?? d.btcDelta5m).toFixed(4) : "",
      ].join(",");
    } catch { return ""; }
  }).filter(Boolean).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${FILE_PREFIX}_decisions.csv`);
  res.send(header + rows);
});

// ─── ARCHIVES ────────────────────────────────────────────────────────────────

app.get("/api/archives", (_req, res) => {
  const token = _req.query.token;
  const decisions = listArchives(decisionsRotationConfig).map(a => ({
    ...a,
    type: "decisions",
    downloadUrl: `/api/archives/decisions/${a.name}?token=${token}`,
  }));
  const botTrades = listArchives(botTradesRotationConfig).map(a => ({
    ...a,
    type: "bot_trades",
    downloadUrl: `/api/archives/bot-trades/${a.name}?token=${token}`,
  }));
  const liveEvents = listArchives(liveEventsRotationConfig).map(a => ({
    ...a,
    type: "live_events",
    downloadUrl: `/api/archives/live-events/${a.name}?token=${token}`,
  }));
  res.json({ decisions, botTrades, liveEvents });
});

app.get("/api/archives/decisions/:filename", (req, res) => {
  const content = readArchive(decisionsRotationConfig, req.params.filename);
  if (!content) return res.status(404).json({ error: "Archive not found" });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${req.params.filename}`);
  res.send(content);
});

app.get("/api/archives/bot-trades/:filename", (req, res) => {
  const content = readArchive(botTradesRotationConfig, req.params.filename);
  if (!content) return res.status(404).json({ error: "Archive not found" });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${req.params.filename}`);
  res.send(content);
});

app.get("/api/archives/live-events/:filename", (req, res) => {
  const content = readArchive(liveEventsRotationConfig, req.params.filename);
  if (!content) return res.status(404).json({ error: "Archive not found" });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${req.params.filename}`);
  res.send(content);
});

// Serve dashboard
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "bot-dashboard.html")));

// ─── CRASH RESILIENCE ─────────────────────────────────────────────────────
// Subsystem failures must NEVER crash the entire process

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException — NOT exiting:", err.message);
  console.error(err.stack || "");
});

process.on("unhandledRejection", (reason: any) => {
  console.error("[FATAL] unhandledRejection — NOT exiting:", reason?.message || reason);
});

// ─── BOOT ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🤖 Polymarket Whale Copy-Trading Bot`);
  console.log(`   Bot ID:     ${BOT_ID}`);
  console.log(`   Auth token: ${CONFIG.authToken}`);
  console.log(`   Save this token — you'll need it for the dashboard.\n`);

  // Create data directory
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });

  // Initialize CLOB client (derives API creds from wallet — requires env vars)
  const clobOk = await initClobClient();

  // Initialize executor (loads settings + bot trade history; forces PAPER on boot)
  initExecutor();

  // Boot summary
  const funder = process.env.POLYMARKET_FUNDER || "not set";
  const funderDisplay = funder.length > 10 ? `${funder.slice(0, 6)}...` : funder;
  console.log(`\n📋 ${BOT_ID} bot started | Mode: PAPER | LIVE available: ${clobOk ? "yes" : "no"} | Funder: ${funderDisplay}\n`);
  if (clobOk) {
    console.log(`   CLOB client: available, funder ${funderDisplay}`);
  }

  // Start HTTP server
  server.listen(CONFIG.port, () => {
    console.log(`\n🌐 Dashboard: http://localhost:${CONFIG.port}`);
    console.log(`   API:       http://localhost:${CONFIG.port}/api/stats?token=${CONFIG.authToken}\n`);
  });

  // Connect data feeds
  connectBinance();
  startBinanceWatchdog();
  startVolSamplers();
  connectPolymarketWs();

  // Start whale polling
  startPolling();

  // Proactive contract scan
  setTimeout(proactiveContractScan, 5_000);
  setInterval(proactiveContractScan, 30_000);

  // Resolution checking
  setTimeout(checkResolutions, 10_000);
  setInterval(checkResolutions, 30_000);

  // Resolve bot positions
  setTimeout(resolvePositions, 15_000);

  // REST book refresh
  setInterval(refreshEmptyBooks, 15_000);

  // File rotation (checks on startup + every 60s)
  fs.mkdirSync(CONFIG.archiveDir, { recursive: true });
  startRotationTimer(decisionsRotationConfig, 60_000);
  startRotationTimer(botTradesRotationConfig, 60_000);
  startRotationTimer(liveEventsRotationConfig, 60_000);

  // Volatility logging
  setInterval(() => {
    const parts: string[] = [];
    for (const sym of Object.keys(marketState.assetPrices)) {
      const vol = computeRealizedVolatility(sym);
      const p = marketState.assetPrices[sym]?.price || 0;
      if (vol !== null && p > 0) {
        parts.push(`${sym.replace("USDT", "")}:${(vol * 100).toFixed(1)}%`);
      }
    }
    if (parts.length > 0) {
      console.log(`[vol] ${parts.join(" | ")}`);
    }
  }, 60_000);

  // Heartbeat every 5 minutes
  setInterval(() => {
    const uptimeSec = process.uptime();
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = hours > 0 ? `${hours}h${mins}m` : `${mins}m`;
    const s = getSettings();
    const ls = getLiveState();
    const binHealth = getBinanceHealth();
    const binStatus = binHealth.connected ? "OK" : `STALE(${Math.floor(binHealth.staleSec)}s)`;
    const polyStatus = marketState.subscribedTokens.size > 0 ? "OK" : "NO_SUBS";
    const resStatus = resolutionCache.size > 0 ? "OK" : "WAITING";
    console.log(
      `♥ alive | uptime: ${uptimeStr} | mode: ${s.mode} | whales: ${getTotalWhaleTradeCount()} | ` +
      `orders: ${ls.liveOrdersPlaced} | subsystems: binance=${binStatus} polymarket=${polyStatus} resolution=${resStatus}`
    );
  }, 300_000); // 5 minutes
}

main().catch(console.error);
