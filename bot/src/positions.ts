/**
 * positions.ts — Position State + Resolution + Take-Profit
 *
 * Layer 3 — Imports pnl, settings, market-data, logger, persistence, types.
 * All callbacks injected by index.ts to avoid circular imports.
 */

import { BotTrade, BotSettings, SellOrder, SellResult, ContractOutcome } from './types';
import { computeResolutionPnl, computeTakeProfitPnl, computeUnrealizedPnl, computeExpiredPnl } from './pnl';
import * as settings from './settings';
import * as marketData from './market-data';
import * as logger from './logger';
import * as persistence from './persistence';

// ── State ──
let open: BotTrade[] = [];
let closed: BotTrade[] = [];
let recentClosed: BotTrade[] = [];                   // capped FIFO, max 50
let takeProfitInFlight: Set<string> = new Set();
let tpInFlightIdsCache: string[] = [];               // pre-built array for buildState
let recentTradeTimestamps: number[] = [];
let lastResetAt = 0;
let cachedExposure = 0;

// ── Incremental stats cache (avoids full-array iteration) ──
let statsCache = { wins: 0, losses: 0, totalPnl: 0 };
let todayCache = { pnl: 0, tradeCount: 0, dayStart: getTodayUTCStart() };

function getTodayUTCStart(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// ── Callbacks (injected at boot by index.ts — no circular imports) ──
type SellExecutorFn = (order: SellOrder) => Promise<SellResult>;
type OnClosedFn = (pos: BotTrade) => void;
type OnResolutionFn = () => void;
type OnMutationFn = () => void;

let sellExecutor: SellExecutorFn | null = null;
let onClosedCallback: OnClosedFn | null = null;
let onResolutionCallback: OnResolutionFn | null = null;
let onMutationCallback: OnMutationFn | null = null;

export function setSellExecutor(fn: SellExecutorFn) { sellExecutor = fn; }
export function setOnClosed(fn: OnClosedFn) { onClosedCallback = fn; }
export function setOnResolution(fn: OnResolutionFn) { onResolutionCallback = fn; }
export function setOnMutation(fn: OnMutationFn) { onMutationCallback = fn; }

// ── Boot ──
export function loadFromHistory(trades: BotTrade[]) {
  open = [];
  closed = [];
  recentClosed = [];
  recentTradeTimestamps = [];
  statsCache = { wins: 0, losses: 0, totalPnl: 0 };
  todayCache = { pnl: 0, tradeCount: 0, dayStart: getTodayUTCStart() };

  const deduped = new Map<string, BotTrade>();
  for (const t of trades) deduped.set(t.id, t);

  const oneHourAgo = Date.now() - 3_600_000;

  for (const t of deduped.values()) {
    if (t.status === 'OPEN') {
      open.push(t);
    } else {
      closed.push(t);
      // Rebuild stats cache from history
      if ((t.resolvedAt ?? 0) > lastResetAt) {
        if (t.status === 'WON' || t.status === 'TP_FILLED') statsCache.wins++;
        else if (t.status === 'LOST' || t.status === 'EXPIRED') statsCache.losses++;
        statsCache.totalPnl += t.pnl ?? 0;
      }
      // Rebuild today cache
      if ((t.resolvedAt ?? 0) > todayCache.dayStart) {
        todayCache.pnl += t.pnl ?? 0;
      }
    }
    if (t.createdAt > oneHourAgo) recentTradeTimestamps.push(t.createdAt);
    if (t.createdAt > todayCache.dayStart) todayCache.tradeCount++;
  }

  recentClosed = closed.slice(-50);
  recomputeExposure();
  console.log(`[positions] Loaded: ${open.length} open, ${closed.length} closed`);
}

// ── Accessors (all zero-cost on hot path) ──
export function getOpen(): readonly BotTrade[] { return open; }
export function getClosed(): readonly BotTrade[] { return closed; }
export function getRecentClosed(): readonly BotTrade[] { return recentClosed; }
export function getTpInFlightIds(): readonly string[] { return tpInFlightIdsCache; }

export function getStats() {
  // Check for UTC midnight rollover
  const currentDayStart = getTodayUTCStart();
  if (currentDayStart !== todayCache.dayStart) {
    todayCache = { pnl: 0, tradeCount: 0, dayStart: currentDayStart };
    for (const t of closed) {
      if ((t.resolvedAt ?? 0) > currentDayStart) todayCache.pnl += t.pnl ?? 0;
      if (t.createdAt > currentDayStart) todayCache.tradeCount++;
    }
    for (const t of open) {
      if (t.createdAt > currentDayStart) todayCache.tradeCount++;
    }
  }
  const total = statsCache.wins + statsCache.losses;
  return {
    totalTrades: total,
    wins: statsCache.wins,
    losses: statsCache.losses,
    totalPnl: statsCache.totalPnl,
    winRate: total > 0 ? statsCache.wins / total : 0,
    avgReturn: total > 0 ? statsCache.totalPnl / total : 0,
  };
}

export function getTodayPnl(): number { return todayCache.pnl; }
export function getTodayTradeCount(): number { return todayCache.tradeCount; }
export function getTotalExposure(): number { return cachedExposure; }

function recomputeExposure(): void {
  cachedExposure = 0;
  for (const p of open) cachedExposure += p.size;
}

export function getHourlyTradeCount(): number {
  return recentTradeTimestamps.length;
}

export function pruneRecentTimestamps(): void {
  const cutoff = Date.now() - 3_600_000;
  let firstValid = 0;
  while (firstValid < recentTradeTimestamps.length && recentTradeTimestamps[firstValid] <= cutoff) {
    firstValid++;
  }
  if (firstValid > 0) recentTradeTimestamps.splice(0, firstValid);
}

export function resetStats() {
  lastResetAt = Date.now();
  statsCache = { wins: 0, losses: 0, totalPnl: 0 };
}

// ── Add ──
export function addPosition(trade: BotTrade) {
  open.push(trade);
  recentTradeTimestamps.push(trade.createdAt);
  cachedExposure += trade.size;
  todayCache.tradeCount++;
  if (onMutationCallback) onMutationCallback();
}

// ── Resolution (runs every 15s via index.ts) ──
export function resolveSettled() {
  const cache = marketData.getResolutionCache();
  const now = Date.now();

  for (let i = open.length - 1; i >= 0; i--) {
    const pos = open[i];
    if (takeProfitInFlight.has(pos.conditionId)) continue;

    const outcome = cache.get(pos.conditionId);
    if (outcome) {
      const pnl = computeResolutionPnl(pos, outcome);
      pos.status = pnl > 0 ? 'WON' : 'LOST';
      pos.pnl = pnl;
      pos.resolvedAt = now;
      pos.resolutionSource = 'GAMMA';
      moveToClosedAndNotify(pos, i);
      continue;
    }

    // Stale fallback: contract ended 10+ min ago, no resolution in cache
    const contractMeta = marketData.getContractMeta(pos.conditionId);
    if (contractMeta?.endTime && (now - contractMeta.endTime > 600_000)) {
      const book = marketData.getBook(pos.asset);
      if (book.bestBid >= 0.95) {
        const pnl = computeResolutionPnl(pos, { resolved: true, outcome: 'YES', resolvedAt: now });
        pos.status = pnl > 0 ? 'WON' : 'LOST';
        pos.pnl = pnl;
        pos.resolvedAt = now;
        pos.resolutionSource = 'STALE_FALLBACK';
        moveToClosedAndNotify(pos, i);
      } else if (book.bestBid <= 0.05) {
        const pnl = computeResolutionPnl(pos, { resolved: true, outcome: 'NO', resolvedAt: now });
        pos.status = pnl > 0 ? 'WON' : 'LOST';
        pos.pnl = pnl;
        pos.resolvedAt = now;
        pos.resolutionSource = 'STALE_FALLBACK';
        moveToClosedAndNotify(pos, i);
      } else if (now - contractMeta.endTime > 3_600_000) {
        // EXPIRED — 1hr past end, book ambiguous
        pos.status = 'EXPIRED';
        pos.pnl = computeExpiredPnl(pos);
        pos.resolvedAt = now;
        pos.resolutionSource = 'EXPIRED';
        moveToClosedAndNotify(pos, i);
      }
    }
  }
}

// ── Take Profit (runs every 10s via index.ts) ──
export function checkTakeProfit() {
  const s = settings.get();
  if (!s.takeProfitEnabled) return;

  let tpSetChanged = false;

  for (let i = open.length - 1; i >= 0; i--) {
    const pos = open[i];
    if (takeProfitInFlight.has(pos.conditionId)) continue;

    const book = marketData.getBook(pos.asset);

    // PnL-based TP trigger (side-agnostic)
    const tpThresholdPerShare = s.takeProfitPrice - pos.entryPrice;
    if (tpThresholdPerShare <= 0) continue;

    const unrealizedPnl = computeUnrealizedPnl(pos, book.bestBid, book.bestAsk);
    const tpThreshold = tpThresholdPerShare * pos.shares;

    if (unrealizedPnl < tpThreshold) continue;

    const exitPrice = pos.side === 'BUY' ? book.bestBid : book.bestAsk;

    if (s.mode === 'PAPER') {
      const pnl = computeTakeProfitPnl(pos, exitPrice);
      pos.status = 'TP_FILLED';
      pos.pnl = pnl;
      pos.exitPrice = exitPrice;
      pos.resolvedAt = Date.now();
      pos.resolutionSource = 'TAKE_PROFIT';
      moveToClosedAndNotify(pos, i);
      logger.logEvent(`PAPER TP ${pos.side === 'BUY' ? 'SELL' : 'BUY'} ${pos.assetLabel} @ ${exitPrice} (pnl: $${pnl.toFixed(2)})`, 'trade');
    } else if (s.mode === 'LIVE') {
      if (!sellExecutor) {
        logger.logEvent('TP: no sell executor wired', 'risk');
        continue;
      }
      takeProfitInFlight.add(pos.conditionId);
      tpSetChanged = true;

      const tpSide: 'SELL' | 'BUY' = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const tpPrice = pos.side === 'BUY'
        ? exitPrice - 0.01
        : exitPrice + 0.01;

      // V7.4 C2: Side-aware TP order size
      const tpSize = tpSide === 'SELL'
        ? pos.shares                      // token count for SELL
        : pos.shares * tpPrice;           // USDC for BUY-back

      sellExecutor({
        tokenId: pos.asset,
        side: tpSide,
        size: tpSize,
        price: tpPrice,
        negRisk: pos.negRisk,
        timeout: 8_000,
      }).then(result => {
        takeProfitInFlight.delete(pos.conditionId);
        rebuildTpInFlightCache();
        if (result.status === 'FILLED') {
          const pnl = computeTakeProfitPnl(pos, result.fillPrice!);
          pos.status = 'TP_FILLED';
          pos.pnl = pnl;
          pos.exitPrice = result.fillPrice;
          pos.resolvedAt = Date.now();
          pos.resolutionSource = 'TAKE_PROFIT';
          moveToClosedAndNotify(pos, open.indexOf(pos));
          logger.logEvent(`LIVE TP ${tpSide} ${pos.assetLabel} @ ${result.fillPrice}`, 'trade');
        } else {
          logger.logEvent(`LIVE TP ${tpSide} FAILED: ${result.reason}`, 'risk');
        }
      }).catch(err => {
        takeProfitInFlight.delete(pos.conditionId);
        rebuildTpInFlightCache();
        logger.logEvent(`LIVE TP ERROR: ${err.message}`, 'risk');
      });
    }
  }

  if (tpSetChanged) rebuildTpInFlightCache();
}

// ── Internal ──
function moveToClosedAndNotify(pos: BotTrade, openIndex: number) {
  if (openIndex >= 0 && openIndex < open.length && open[openIndex] === pos) {
    open.splice(openIndex, 1);
  } else {
    const idx = open.indexOf(pos);
    if (idx !== -1) open.splice(idx, 1);
  }

  closed.push(pos);

  recentClosed.push(pos);
  if (recentClosed.length > 50) recentClosed.shift();

  recomputeExposure();

  // Update incremental stats cache
  if ((pos.resolvedAt ?? 0) > lastResetAt) {
    if (pos.status === 'WON' || pos.status === 'TP_FILLED') statsCache.wins++;
    else if (pos.status === 'LOST' || pos.status === 'EXPIRED') statsCache.losses++;
    statsCache.totalPnl += pos.pnl ?? 0;
  }
  if ((pos.resolvedAt ?? 0) > todayCache.dayStart) {
    todayCache.pnl += pos.pnl ?? 0;
  }

  persistence.updateTrade(pos);

  if (onClosedCallback) onClosedCallback(pos);
  if (onMutationCallback) onMutationCallback();
  if (onResolutionCallback) onResolutionCallback();
}

function rebuildTpInFlightCache(): void {
  tpInFlightIdsCache = [...takeProfitInFlight];
}
