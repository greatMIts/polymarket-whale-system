/**
 * trader.ts — Trade Execution (Orchestrator)
 *
 * Layer 3 — Has the most imports by design.
 * Receives WhaleTrade from whale-watcher, builds signal, filters, sizes, executes.
 * NOTE: NO live-events import — BUY_FILL logging is via onTradeOpened callback.
 */

import { BOT_ID } from './config';
import * as settings from './settings';
import * as positions from './positions';
import * as filter from './filter';
import * as risk from './risk';
import * as clob from './clob';
import * as marketData from './market-data';
import * as logger from './logger';
import * as persistence from './persistence';
import { BotSettings, BotTrade, WhaleTrade, TradeSignal, Decision } from './types';

// ── State (private) ──
const cooldownMap = new Map<string, number>();
const orderTracker = new Map<string, { count: number; pending: boolean }>();
const circuitBreaker = {
  consecutiveFailures: 0,
  consecutiveBalanceErrors: 0,
  autoFallbackReason: null as string | null,
  pauseUntil: 0,
};
const counters = { liveOrdersPlaced: 0, liveOrdersFailed: 0, paperFills: 0 };
let lastKnownBalance = 0;

// ── Callback (injected by index.ts) ──
type OnTradeOpenedFn = (trade: BotTrade) => void;
let onTradeOpenedCallback: OnTradeOpenedFn | null = null;
export function setOnTradeOpened(fn: OnTradeOpenedFn) { onTradeOpenedCallback = fn; }

export async function executeCopyTrade(whaleTrade: WhaleTrade): Promise<BotTrade | null> {
  const s = settings.get();
  if (!s.botEnabled) return null;

  // ── Step 0: Inactive hours check ──
  if (isInactiveHour(s.inactiveHoursUTC)) return null;

  // ── Step 1: Fetch LIVE market data ──
  let book = marketData.getBook(whaleTrade.asset);
  let bookAge = Date.now() - book.lastUpdateTs;

  // If book is stale, try REST fallback before rejecting
  // (WS subscription may not have delivered first snapshot yet)
  if (bookAge > 15_000) {
    await marketData.fetchBookFromRest(whaleTrade.asset);
    book = marketData.getBook(whaleTrade.asset);
    bookAge = Date.now() - book.lastUpdateTs;
    if (bookAge > 15_000) {
      // Only log if book was once populated (genuinely went stale)
      // Skip silently if never populated (expired contract / no market)
      if (book.lastUpdateTs > 0) {
        logger.logEvent(`REJECT: book stale (${bookAge}ms) ${whaleTrade.assetLabel}`, 'risk');
      }
      return null;
    }
  }
  const clobMid = (book.bestBid + book.bestAsk) / 2;
  const binanceSpot = marketData.getBinancePrice(whaleTrade.assetLabel);

  // ── Step 2: Compute LIVE edge ──
  const liveEdge = binanceSpot > 0 ? (clobMid - binanceSpot) / binanceSpot : 0;

  // ── Step 3: Build signal with LIVE data ──
  const entryPrice = clobMid;
  const signal: TradeSignal = {
    conditionId: whaleTrade.conditionId,
    asset: whaleTrade.asset,
    assetLabel: whaleTrade.assetLabel,
    side: whaleTrade.side,
    entryPrice,
    edge: liveEdge,
    midEdge: whaleTrade.midEdge,
    whaleSize: whaleTrade.usdcSize,
    walletAddress: whaleTrade.walletAddress,
    contractDuration: whaleTrade.contractDuration,
    secsRemaining5m: whaleTrade.secsRemaining5m,
    secsRemaining15m: whaleTrade.secsRemaining15m,
    momentum: whaleTrade.momentumAligned,
  };

  // ── Step 4: Signal filter ──
  const filterResult = filter.evaluateTrade(signal, s);
  if (!filterResult.pass) {
    persistence.appendDecision({
      conditionId: signal.conditionId,
      asset: signal.asset,
      side: signal.side,
      reason: filterResult.reason!,
      timestamp: Date.now(),
    });
    return null;
  }

  // ── Step 5: Sizing (BEFORE risk check) ──
  const sizeUsd = getTradeSize(entryPrice, s);
  const sizeShares = sizeUsd / entryPrice;

  // V7.3 C1: Side-aware CLOB order size
  const orderSize = signal.side === 'BUY' ? sizeUsd : sizeShares;

  // V7.4 C1: Side-aware limit price with slippage buffer
  const limitPrice = signal.side === 'BUY'
    ? Math.round((book.bestAsk + 0.01) * 100) / 100
    : Math.round((book.bestBid - 0.01) * 100) / 100;

  // V7.4 M2: negRisk from contract metadata
  const contractMeta = marketData.getContractMeta(whaleTrade.conditionId);
  const negRisk = contractMeta?.negRisk ?? false;

  // ── Step 6: Risk check (receives proposedSize in USD) ──
  const currentExposure = positions.getTotalExposure();
  const riskResult = risk.checkRisk(s, positions.getOpen(), currentExposure, sizeUsd);
  if (!riskResult.pass) {
    persistence.appendDecision({
      conditionId: signal.conditionId,
      asset: signal.asset,
      side: signal.side,
      reason: riskResult.reason!,
      timestamp: Date.now(),
    });
    return null;
  }

  // ── Step 7: Order tracking ──
  if (!canPlaceOrder(whaleTrade.conditionId, whaleTrade.usdcSize, s)) return null;

  // ── Step 8: Mark pending ──
  const stackEntry = recordOrder(whaleTrade.conditionId);

  // ── Step 9: Execute ──
  if (s.mode === "PAPER") {
    const trade = buildPaperTrade(whaleTrade, signal, entryPrice, sizeUsd, sizeShares, stackEntry, book, negRisk);
    confirmOrder(whaleTrade.conditionId);
    positions.addPosition(trade);
    persistence.appendTrade(trade);
    logger.logEvent(`PAPER ${signal.side} ${trade.assetLabel} @ ${entryPrice}`, 'trade');
    counters.paperFills++;
    if (onTradeOpenedCallback) onTradeOpenedCallback(trade);
    return trade;
  }

  if (s.mode === "LIVE") {
    const balance = await clob.getBalance();
    lastKnownBalance = balance;

    // V7.4 P1: Side-aware balance check
    const requiredBalance = signal.side === 'BUY'
      ? sizeUsd
      : (1 - entryPrice) * sizeShares;
    if (balance < requiredBalance) {
      cancelPendingOrder(whaleTrade.conditionId);
      handleBalanceError();
      return null;
    }

    const result = await clob.placeFokOrder({
      tokenId: whaleTrade.asset,
      side: signal.side,
      size: orderSize,
      price: limitPrice,
      negRisk,
      timeout: 8_000,
    });

    if (result.status === 'FILLED') {
      confirmOrder(whaleTrade.conditionId);
      // V7.3 C1: side-aware fill interpretation
      const fillUsd = signal.side === 'BUY' ? result.fillSize! : result.fillSize! * result.fillPrice!;
      const fillShares = signal.side === 'BUY' ? result.fillSize! / result.fillPrice! : result.fillSize!;
      const trade = buildLiveTrade(
        whaleTrade, signal, result.fillPrice!, fillUsd, fillShares,
        stackEntry, book, entryPrice, negRisk
      );
      positions.addPosition(trade);
      persistence.appendTrade(trade);
      logger.logEvent(`LIVE ${signal.side} ${trade.assetLabel} @ ${result.fillPrice}`, 'trade');
      counters.liveOrdersPlaced++;
      resetCircuitBreaker();
      if (onTradeOpenedCallback) onTradeOpenedCallback(trade);
      return trade;
    }

    cancelPendingOrder(whaleTrade.conditionId);
    if (result.status === 'TIMEOUT') {
      logger.logEvent(`ORDER_TIMEOUT ${whaleTrade.conditionId}`, 'risk');
    }
    counters.liveOrdersFailed++;
    handleOrderFailure(result);
    return null;
  }

  return null;
}

// ── Build Trade Helpers ──
function buildPaperTrade(
  w: WhaleTrade, signal: TradeSignal, price: number,
  sizeUsd: number, sizeShares: number,
  stackEntry: number, book: { bestBid: number; bestAsk: number },
  negRisk: boolean
): BotTrade {
  return {
    id: `paper_${Date.now()}_${w.conditionId.slice(0, 8)}`,
    conditionId: w.conditionId,
    asset: w.asset,
    assetLabel: w.assetLabel,
    title: w.title,
    side: signal.side,
    entryPrice: price,
    size: sizeUsd,
    shares: sizeShares,
    status: 'OPEN',
    createdAt: Date.now(),
    mode: 'PAPER',
    walletAddress: w.walletAddress,
    whaleSize: w.usdcSize,
    negRisk,
    latencyMs: w.detectedAt ? Date.now() - w.detectedAt : 0,
    polyMidAtDecision: (book.bestBid + book.bestAsk) / 2,
    bookSpread: book.bestAsk - book.bestBid,
    sizeReason: price >= settings.get().highConvictionThreshold ? 'HIGH_CONVICTION' : 'STANDARD',
    stackEntry,
    contractDuration: w.contractDuration,
    filterPreset: BOT_ID,
    whaleTxHash: w.txHash,
    midEdge: w.midEdge,
  };
}

function buildLiveTrade(
  w: WhaleTrade, signal: TradeSignal,
  fillPrice: number, fillUsd: number, fillShares: number,
  stackEntry: number, book: { bestBid: number; bestAsk: number },
  decisionPrice: number, negRisk: boolean
): BotTrade {
  return {
    id: `live_${Date.now()}_${w.conditionId.slice(0, 8)}`,
    conditionId: w.conditionId,
    asset: w.asset,
    assetLabel: w.assetLabel,
    title: w.title,
    side: signal.side,
    entryPrice: fillPrice,
    size: fillUsd,
    shares: fillShares,
    status: 'OPEN',
    createdAt: Date.now(),
    mode: 'LIVE',
    walletAddress: w.walletAddress,
    whaleSize: w.usdcSize,
    negRisk,
    latencyMs: w.detectedAt ? Date.now() - w.detectedAt : 0,
    polyMidAtDecision: (book.bestBid + book.bestAsk) / 2,
    bookSpread: book.bestAsk - book.bestBid,
    sizeReason: decisionPrice >= settings.get().highConvictionThreshold
      ? 'HIGH_CONVICTION' : 'STANDARD',
    stackEntry,
    contractDuration: w.contractDuration,
    filterPreset: BOT_ID,
    whaleTxHash: w.txHash,
    midEdge: w.midEdge,
  };
}

// ── Circuit Breaker ──
function handleBalanceError(): void {
  circuitBreaker.consecutiveBalanceErrors++;
  if (circuitBreaker.consecutiveBalanceErrors >= 3) {
    settings.update({ mode: 'PAPER' });
    circuitBreaker.autoFallbackReason = 'BALANCE_ERRORS';
    logger.logEvent('CIRCUIT_BREAKER: 3 balance errors → PAPER fallback', 'risk');
  }
}

function handleOrderFailure(result: { status: string; reason?: string }): void {
  circuitBreaker.consecutiveFailures++;
  if (circuitBreaker.consecutiveFailures >= 5) {
    logger.logEvent('CIRCUIT_BREAKER: 5 consecutive failures → 30s pause + CLOB reconnect', 'risk');
    circuitBreaker.pauseUntil = Date.now() + 30_000;
    clob.reconnect().catch(err => logger.logEvent(`CLOB reconnect failed: ${err.message}`, 'risk'));
  }
}

function resetCircuitBreaker(): void {
  circuitBreaker.consecutiveFailures = 0;
  circuitBreaker.consecutiveBalanceErrors = 0;
  circuitBreaker.autoFallbackReason = null;
  circuitBreaker.pauseUntil = 0;
}

// ── Cooldown Map ──
export function clearOldCooldowns(): void {
  const tenMinAgo = Date.now() - 600_000;
  for (const [id, ts] of cooldownMap) {
    if (ts < tenMinAgo) cooldownMap.delete(id);
  }
}

// ── Order Tracking + minStackSize ──
function canPlaceOrder(conditionId: string, whaleSize: number, s: BotSettings): boolean {
  if (circuitBreaker.pauseUntil && Date.now() < circuitBreaker.pauseUntil) return false;
  const lastTrade = cooldownMap.get(conditionId);
  if (lastTrade && (Date.now() - lastTrade) < s.cooldownMs) return false;
  const existing = orderTracker.get(conditionId);
  if (existing?.pending) return false;
  if (!existing || existing.count === 0) return true;
  if (existing.count >= s.maxEntriesPerContract) return false;
  if (whaleSize < s.minStackSize) return false;
  return true;
}

function recordOrder(conditionId: string): number {
  const existing = orderTracker.get(conditionId) ?? { count: 0, pending: false };
  orderTracker.set(conditionId, { count: existing.count, pending: true });
  return existing.count + 1;
}

function confirmOrder(conditionId: string): void {
  const existing = orderTracker.get(conditionId) ?? { count: 0, pending: false };
  orderTracker.set(conditionId, { count: existing.count + 1, pending: false });
  cooldownMap.set(conditionId, Date.now());
}

function cancelPendingOrder(conditionId: string): void {
  const existing = orderTracker.get(conditionId);
  if (existing) {
    orderTracker.set(conditionId, { count: existing.count, pending: false });
  }
}

export function cleanupResolvedContracts(resolvedIds: string[]): void {
  for (const id of resolvedIds) {
    orderTracker.delete(id);
    cooldownMap.delete(id);
  }
}

// ── Sizing ──
function getTradeSize(entryPrice: number, s: BotSettings): number {
  if (entryPrice >= s.highConvictionThreshold) return s.highConvictionSize;
  return s.standardSize;
}

// ── Inactive Hours ──
function isInactiveHour([start, end]: [number, number]): boolean {
  if (start === 0 && end === 0) return false;
  const hour = new Date().getUTCHours();
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function getLiveState() {
  return {
    consecutiveFailures: circuitBreaker.consecutiveFailures,
    consecutiveBalanceErrors: circuitBreaker.consecutiveBalanceErrors,
    walletBalance: lastKnownBalance,
    autoFallbackReason: circuitBreaker.autoFallbackReason,
    liveOrdersPlaced: counters.liveOrdersPlaced,
    liveOrdersFailed: counters.liveOrdersFailed,
    paperFills: counters.paperFills,
  };
}

export function isCurrentlyDormant(): boolean {
  return isInactiveHour(settings.get().inactiveHoursUTC);
}
