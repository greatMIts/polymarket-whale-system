// ─── Layer 3: Copy Executor ──────────────────────────────────────────────────
// Executes whale copy trades in PAPER or LIVE mode.
// Builds WhaleCopyMeta with full context for post-trade analysis.
// Pre-warmed CLOB connection via keep-alive ping.

import { TradeExecution, ScoringResult, ContractInfo, FeatureVector, WhaleSignal, WhaleCopyMeta } from "./types";
import { CONFIG, getRuntime } from "./config";
import { logger } from "./logger";
import * as polyBook from "./polymarket-book";
import * as risk from "./risk";
import * as https from "https";

// ─── Module State ────────────────────────────────────────────────────────────

let tradeCounter = 0;
let pingInterval: NodeJS.Timeout | null = null;

// Pre-warmed CLOB connection
const clobAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 4,
});

// ─── Trade ID Generator ─────────────────────────────────────────────────────

export function generateTradeId(): string {
  tradeCounter++;
  const ts = Date.now().toString(36);
  const count = tradeCounter.toString(36).padStart(4, "0");
  return `R-${ts}-${count}`;
}

// ─── Compute Size from Score Tier ────────────────────────────────────────────

export function computeSize(score: ScoringResult): number {
  const effectiveMultiplier = risk.getEffectiveSizingMultiplier();
  const runtime = getRuntime();

  // Use runtime-configurable tiers (managed from dashboard Strategy box)
  const tiers = [
    { minScore: runtime.sizingTier1Score, size: runtime.sizingTier1Size },
    { minScore: runtime.sizingTier2Score, size: runtime.sizingTier2Size },
    { minScore: runtime.sizingTier3Score, size: runtime.sizingTier3Size },
    { minScore: runtime.sizingTier4Score, size: runtime.sizingTier4Size },
  ].sort((a, b) => b.minScore - a.minScore);  // highest first

  let baseSizeUsd = tiers[tiers.length - 1].size; // default to lowest tier
  for (const tier of tiers) {
    if (score.totalScore >= tier.minScore) {
      baseSizeUsd = tier.size;
      break;
    }
  }

  const finalSize = Math.max(1, Math.round(baseSizeUsd * effectiveMultiplier * runtime.sizingMultiplier * 100) / 100);
  return finalSize;
}

// ─── Execute Copy Trade ─────────────────────────────────────────────────────

export async function executeCopy(
  signal: WhaleSignal,
  score: ScoringResult,
  features: FeatureVector,
  tokenId: string,
  contract: ContractInfo
): Promise<TradeExecution> {
  const now = Date.now();

  // 1. Compute sizing
  const sizeUsd = computeSize(score);

  // 2. Get current ask from cached book
  const book = polyBook.getBook(tokenId);
  if (!book || book.ask <= 0) {
    throw new Error("NO_BOOK_DATA");
  }
  const currentAsk = book.ask;

  // 3. Price staleness check — market moved > 3 cents since whale's entry
  if (Math.abs(currentAsk - signal.price) > 0.03) {
    throw new Error(`PRICE_STALE: ask=${currentAsk.toFixed(4)} whale=${signal.price.toFixed(4)} diff=${Math.abs(currentAsk - signal.price).toFixed(4)}`);
  }

  // 4. Build WhaleCopyMeta (12 fields)
  const whaleCopy: WhaleCopyMeta = {
    triggeredByWallet: signal.wallet,
    whaleWalletLabel: signal.walletLabel,
    whaleTier: signal.tier,
    whaleUsdcSize: signal.usdcSize,
    whaleEntryPrice: signal.price,
    whaleTradeTs: signal.ts,
    whaleDetectedAt: signal.detectedAt || now,
    pipelineLatencyMs: now - (signal.detectedAt || now),
    whaleToExecutionMs: now - signal.ts,
    slippageVsWhale: currentAsk - signal.price,
    bookSpreadAtEntry: features.bookSpread,
    concurrentWhaleSignals: features.concurrentWhales,
  };

  // 5. Place order
  let orderId: string | undefined;
  if (CONFIG.mode === "LIVE") {
    orderId = await executeLiveOrder(tokenId, signal.side, sizeUsd, currentAsk);
  }

  // 6. Build TradeExecution
  const shares = sizeUsd / currentAsk;
  const trade: TradeExecution = {
    id: generateTradeId(),
    ts: now,
    conditionId: signal.conditionId,
    tokenId,
    title: contract.title,
    side: signal.side,
    asset: contract.asset,
    entryPrice: currentAsk,
    sizeUsd,
    shares,
    score: score.totalScore,
    components: score.components,
    features,
    mode: CONFIG.mode,
    orderId,
    endTs: contract.endTs,
    strikePrice: contract.strikePrice || features.spotPrice,
    whaleCopy,
  };

  // Log execution
  logger.trade({
    id: trade.id,
    mode: trade.mode,
    conditionId: trade.conditionId,
    side: trade.side,
    asset: trade.asset,
    entryPrice: trade.entryPrice.toFixed(4),
    sizeUsd: trade.sizeUsd,
    shares: trade.shares.toFixed(4),
    score: trade.score,
    whale: signal.walletLabel,
    whaleTier: signal.tier,
    whaleSize: signal.usdcSize.toFixed(0),
    latencyMs: whaleCopy.pipelineLatencyMs,
    slippage: whaleCopy.slippageVsWhale.toFixed(4),
  });

  return trade;
}

// ─── Live Order Execution (placeholder) ─────────────────────────────────────

async function executeLiveOrder(
  tokenId: string,
  side: string,
  sizeUsd: number,
  limitPrice: number
): Promise<string | undefined> {
  // NOTE: Live trading requires py-clob-client equivalent in Node.js
  // or direct HTTP signing with Polymarket's EIP-712 order format.
  // For now, this is a placeholder that will be wired up for live mode.

  logger.warn("copy-executor", "LIVE ORDER EXECUTION NOT YET IMPLEMENTED");
  logger.warn("copy-executor", "Falling back to PAPER simulation");

  // Return a simulated order ID
  return `PAPER-${Date.now().toString(36)}`;
}

// ─── CLOB Keep-Alive Ping ────────────────────────────────────────────────────

export function startClobPing(): void {
  if (pingInterval) return;

  // Ping CLOB every 30s to keep TCP connection alive
  // Eliminates TLS handshake at execution time (~100-150ms saved)
  pingInterval = setInterval(async () => {
    try {
      // Lightweight GET to CLOB endpoint
      const url = `${CONFIG.clobApi}/time`;
      await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch {
      // Non-critical — just keeping the connection warm
    }
  }, 30_000);

  logger.debug("copy-executor", "CLOB keep-alive ping started (30s interval)");
}

export function stopClobPing(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}
