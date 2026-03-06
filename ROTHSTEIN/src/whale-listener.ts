// ─── Layer 1: Whale Listener ────────────────────────────────────────────────
// Connects to spy server WS and receives whale trade events as bonus signals.
// Graceful degradation: ROTHSTEIN continues without whales if spy is down.

import WebSocket from "ws";
import { WhaleSignal, Side } from "./types";
import { CONFIG } from "./config";
import { logger } from "./logger";

// ─── State ──────────────────────────────────────────────────────────────────

const recentWhales = new Map<string, WhaleSignal[]>();  // conditionId → signals
let ws: WebSocket | null = null;
let connected = false;
let reconnectMs = 3000;
let lastMessage = 0;
let pingInterval: NodeJS.Timeout | null = null;

// ─── Public API ─────────────────────────────────────────────────────────────

export function getWhaleActivity(conditionId: string): WhaleSignal[] {
  const signals = recentWhales.get(conditionId) || [];
  // Only return non-expired signals
  const cutoff = Date.now() - CONFIG.whaleSignalExpireMs;
  return signals.filter(s => s.ts > cutoff);
}

export function isConnected(): boolean { return connected; }
export function getLastHeartbeat(): number { return lastMessage; }

// ─── Connection ─────────────────────────────────────────────────────────────

export function connect(): void {
  if (ws) {
    try { ws.terminate(); } catch {}
  }
  connected = false;

  try {
    ws = new WebSocket(CONFIG.spyServerUrl);
  } catch (e: any) {
    logger.warn("whale", `Cannot connect to spy server: ${e.message}`);
    scheduleReconnect();
    return;
  }

  ws.on("open", () => {
    connected = true;
    reconnectMs = 3000;
    logger.info("whale", `Connected to spy server at ${CONFIG.spyServerUrl}`);

    // PING keepalive every 30s — spy server may drop idle connections
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && connected) {
        try { ws.ping(); } catch {}
      }
    }, 30_000);
  });

  ws.on("message", (raw) => {
    lastMessage = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "state") return;

      // Extract whale trades from spy server's state broadcast
      const trades = msg.recentTrades || [];
      processWhaleTrades(trades);
    } catch {}
  });

  ws.on("close", () => {
    connected = false;
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    logger.warn("whale", "Spy server disconnected");
    scheduleReconnect();
  });

  ws.on("error", (e: Error) => {
    logger.debug("whale", `Spy server error: ${e.message}`);
  });
}

function scheduleReconnect(): void {
  setTimeout(() => connect(), reconnectMs);
  reconnectMs = Math.min(reconnectMs * 2, 60_000);
}

function processWhaleTrades(trades: any[]): void {
  const now = Date.now();
  const cutoff = now - CONFIG.whaleSignalExpireMs;

  // Only process recent trades (last 2 minutes)
  for (const t of trades) {
    const tradeTs = new Date(t.ts).getTime();
    if (tradeTs < cutoff) continue;

    const conditionId = t.conditionId;
    if (!conditionId) continue;

    const walletLabel = t.walletLabel || "";
    const tier = CONFIG.walletTiers[walletLabel] || 3;

    const signal: WhaleSignal = {
      ts: tradeTs,
      wallet: t.wallet || "",
      walletLabel,
      side: (t.outcome === "Up" ? "Up" : "Down") as Side,
      outcome: t.outcome || "",
      price: parseFloat(t.price) || 0,
      usdcSize: parseFloat(t.usdcSize) || 0,
      conditionId,
      tier,
    };

    if (!recentWhales.has(conditionId)) {
      recentWhales.set(conditionId, []);
    }
    const existing = recentWhales.get(conditionId)!;

    // Dedup by wallet + timestamp
    const isDupe = existing.some(s =>
      s.walletLabel === signal.walletLabel && Math.abs(s.ts - signal.ts) < 2000
    );
    if (!isDupe) {
      existing.push(signal);
    }
  }

  // Cleanup expired entries
  for (const [condId, signals] of recentWhales) {
    const fresh = signals.filter(s => s.ts > cutoff);
    if (fresh.length === 0) {
      recentWhales.delete(condId);
    } else {
      recentWhales.set(condId, fresh);
    }
  }
}

export function disconnect(): void {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (ws) {
    try { ws.terminate(); } catch {}
    ws = null;
    connected = false;
  }
}
