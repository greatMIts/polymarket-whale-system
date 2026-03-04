/**
 * server.ts — HTTP + WebSocket server
 *
 * Layer 4 — Imports nearly everything (read-only aggregation).
 * Version-gated WS broadcasts, REST API, auth middleware.
 */

import http from 'http';
import path from 'path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { CONFIG, BOT_ID } from './config';
import { BotSettings } from './types';
import * as settings from './settings';
import * as positions from './positions';
import * as trader from './trader';
import * as whaleWatcher from './whale-watcher';
import * as marketData from './market-data';
import * as clob from './clob';
import * as logger from './logger';
import * as risk from './risk';
import * as persistence from './persistence';
import * as filter from './filter';

// ── Explicit server setup ──
const app = express();
app.use(express.json());
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

let stateVersion = 0;
let lastBroadcastVersion = -1;
let broadcastTickCount = 0;

let cachedPayload: string | null = null;
let cachedPayloadVersion = -1;

export function incrementVersion() {
  stateVersion++;
  cachedPayload = null;
}

// ── WS Auth ──
const authenticatedClients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  const authTimer = setTimeout(() => ws.close(1008, 'Auth timeout'), 5000);
  ws.once('message', (msg) => {
    clearTimeout(authTimer);
    try {
      const { type, token } = JSON.parse(msg.toString());
      if (type === 'auth' && token === CONFIG.authToken) {
        authenticatedClients.add(ws);
        ws.send(JSON.stringify({ type: 'auth_ok' }));

        // Handle subsequent messages (settings updates, mode toggle, etc.)
        ws.on('message', (raw) => {
          try {
            const parsed = JSON.parse(raw.toString());
            if (parsed.type === 'update_settings' && parsed.settings) {
              const result = settings.update(parsed.settings);
              if (result.rejected) {
                ws.send(JSON.stringify({ type: 'settings_updated', rejected: result.rejected }));
              } else {
                // Broadcast updated settings to ALL connected clients
                const payload = JSON.stringify({ type: 'settings_updated', settings: settings.get() });
                for (const client of authenticatedClients) {
                  client.send(payload);
                }
              }
            }
          } catch { /* ignore malformed messages */ }
        });
      } else {
        ws.close(1008, 'Invalid auth');
      }
    } catch {
      ws.close(1008, 'Malformed auth');
    }
  });
  ws.on('close', () => authenticatedClients.delete(ws));
});

// ── Auth Middleware ──
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ')
    ? header.slice(7)
    : req.query.token;
  if (token !== CONFIG.authToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── REST Endpoints ──
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, '../bot-dashboard.html')));

app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  botId: BOT_ID,
  clobReady: clob.isClobReady(),
  binanceStale: marketData.isBinanceStale?.() ?? false,
}));

app.use('/api', authMiddleware);

app.get('/api/state', (req, res) => res.json(buildState()));

app.post('/api/settings', (req, res) => {
  const result = settings.update(req.body);
  res.json(result.rejected ? { ok: false, rejected: result.rejected } : { ok: true });
});

app.post('/api/reset-stats', (req, res) => {
  positions.resetStats();
  risk.resetSessionLosses();
  incrementVersion();
  res.json({ ok: true });
});

app.get('/api/export-trades.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.send(persistence.getTradesCsv());
});

app.get('/api/export-decisions.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.send(persistence.getDecisionsCsv());
});

app.get('/api/archives', (req, res) => res.json(persistence.listArchives()));

app.get('/api/archives/:filename', (req, res) => {
  const data = persistence.readArchive(req.params.filename);
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/csv');
  res.send(data);
});

// ── WebSocket Broadcasts ──
function getStatePayload(): string {
  if (cachedPayloadVersion === stateVersion && cachedPayload) return cachedPayload;
  const state = buildState();
  cachedPayload = JSON.stringify({ type: 'state', data: state });
  cachedPayloadVersion = stateVersion;
  return cachedPayload;
}

export function broadcastState() {
  broadcastTickCount++;
  const forceSync = broadcastTickCount % 10 === 0;
  if (stateVersion === lastBroadcastVersion && !forceSync) return;
  lastBroadcastVersion = stateVersion;

  // On forceSync, invalidate cache to pick up non-versioned changes
  // (new events, Binance prices, whale trades, resolution data, etc.)
  if (forceSync) cachedPayload = null;

  const payload = getStatePayload();
  for (const ws of authenticatedClients) {
    ws.send(payload);
  }
}

export function pushStateNow() {
  lastBroadcastVersion = stateVersion;
  cachedPayload = null;
  const payload = getStatePayload();
  for (const ws of authenticatedClients) {
    ws.send(payload);
  }
}

const booksCache = new Map<string, { bestBid: number; bestAsk: number }>();

function buildState() {
  const openPositions = positions.getOpen();

  booksCache.clear();
  for (const pos of openPositions) {
    const book = marketData.getBook(pos.asset);
    booksCache.set(pos.conditionId, { bestBid: book.bestBid, bestAsk: book.bestAsk });
  }

  return {
    settings: settings.get(),
    firstBootDefaults: settings.getDefaults(),

    openPositions: openPositions.map(pos => ({
      ...pos,
      currentBid: booksCache.get(pos.conditionId)?.bestBid ?? 0,
      currentAsk: booksCache.get(pos.conditionId)?.bestAsk ?? 0,
    })),
    closedPositions: positions.getRecentClosed(),
    stats: positions.getStats(),
    todayPnl: positions.getTodayPnl(),
    todayTradeCount: positions.getTodayTradeCount(),
    tpInFlightIds: positions.getTpInFlightIds(),
    currentExposure: positions.getTotalExposure(),

    ...trader.getLiveState(),
    clobReady: clob.isClobReady(),

    binancePrices: marketData.getBinancePrices(),
    binanceHealth: marketData.getBinanceHealth(),
    recentWhaleTrades: whaleWatcher.getRecentTrades(),

    hourlyLoss: risk.getHourlyLoss(),
    sessionLoss: risk.getSessionLoss(),

    filterStats: filter.getFilterStats(),

    eventLog: logger.getEventLog(),

    botId: BOT_ID,
    uptime: process.uptime(),
    timestamp: Date.now(),
    stateVersion,
    isDormant: trader.isCurrentlyDormant(),
  };
}

export function listen(): void {
  httpServer.listen(CONFIG.port, () => {
    logger.logEvent(`Server listening on port ${CONFIG.port}`, 'system');
  });
}
