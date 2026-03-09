// ─── Layer 3: Copy Executor ──────────────────────────────────────────────────
// Executes whale copy trades in PAPER or LIVE mode.
// Builds WhaleCopyMeta with full context for post-trade analysis.
// Pre-warmed CLOB connection via keep-alive ping.

import { TradeExecution, ScoringResult, ContractInfo, FeatureVector, WhaleSignal, WhaleCopyMeta } from "./types";
import { CONFIG, getRuntime } from "./config";
import { logger } from "./logger";
import * as polyBook from "./polymarket-book";
import * as risk from "./risk";
import * as clobClient from "./clob-client";
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
  const isLive = CONFIG.mode === "LIVE";

  // 3. Price staleness check — LIVE mode only
  // In paper mode we simulate fills at the whale's entry price, so staleness is irrelevant.
  // In live mode, reject ONLY if ask is MORE than 6 cents ABOVE whale's entry (we'd overpay).
  // If ask is LOWER than whale's price, that's a BETTER deal — always enter.
  if (isLive) {
    const askDelta = currentAsk - signal.price;  // positive = ask higher than whale, negative = better price
    if (askDelta > 0.06) {
      throw new Error(`PRICE_STALE: ask=${currentAsk.toFixed(4)} whale=${signal.price.toFixed(4)} diff=+${askDelta.toFixed(4)} (ask too high)`);
    }
    if (askDelta < 0) {
      logger.info("copy-executor", `Better price: ask=${currentAsk.toFixed(4)} < whale=${signal.price.toFixed(4)} (${Math.abs(askDelta).toFixed(4)} cheaper)`);
    }
  }

  // Entry price: paper mode uses whale's price (simulated fill), live mode uses book ask
  const entryPrice = isLive ? currentAsk : signal.price;

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
    slippageVsWhale: entryPrice - signal.price,
    bookSpreadAtEntry: features.bookSpread,
    concurrentWhaleSignals: features.concurrentWhales,
  };

  // 5. Place order (live mode only)
  let orderId: string | undefined;
  if (isLive) {
    orderId = await executeLiveOrder(tokenId, signal.side, sizeUsd, currentAsk);
  }

  // 6. Build TradeExecution
  const shares = sizeUsd / entryPrice;
  const trade: TradeExecution = {
    id: generateTradeId(),
    ts: now,
    conditionId: signal.conditionId,
    tokenId,
    title: contract.title,
    side: signal.side,
    asset: contract.asset,
    entryPrice,
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

// ─── Live Order Execution ───────────────────────────────────────────────────
// Places a real FOK market order via Polymarket's CLOB SDK.
// Always BUY — we copy the whale's position on the same outcome token.

async function executeLiveOrder(
  tokenId: string,
  side: string,
  sizeUsd: number,
  limitPrice: number
): Promise<string | undefined> {
  const client = clobClient.getClient();
  const startMs = Date.now();

  // FOK market order: spend $sizeUsd buying tokens, limitPrice = worst acceptable price
  // Let SDK auto-resolve negRisk and tickSize from CLOB API.
  // Hardcoding negRisk causes "invalid signature" if market uses neg-risk exchange.
  const response = await client.createAndPostMarketOrder(
    {
      tokenID: tokenId,
      amount: sizeUsd,
      side: clobClient.Side.BUY,
      price: limitPrice,
    },
    {} as any,  // SDK auto-resolves tickSize + negRisk per token
    clobClient.OrderType.FOK,
  );

  const latencyMs = Date.now() - startMs;

  // Log full response for debugging (CLOB SDK has inconsistent error shapes)
  logger.debug("copy-executor", `CLOB response (${latencyMs}ms): ${JSON.stringify(response)}`);

  if (!response || !response.success) {
    // SDK error responses may use `errorMsg`, `error`, or be shaped differently
    const errMsg = response?.errorMsg || response?.error || response?.status || JSON.stringify(response);
    throw new Error(`ORDER_REJECTED: ${errMsg}`);
  }

  logger.event("copy-executor", "LIVE_ORDER_FILLED", {
    orderId: response.orderID,
    status: response.status,
    side,
    amount: sizeUsd,
    price: limitPrice,
    latencyMs,
  });

  return response.orderID;
}

// ─── Live SELL Order (for TP exits) ──────────────────────────────────────────
// Places a real FOK market SELL order to close an open position.
// For SELL orders, amount = number of shares (not USD).

export async function executeLiveSell(
  tokenId: string,
  shares: number,
  limitPrice: number
): Promise<string | undefined> {
  const client = clobClient.getClient();
  const startMs = Date.now();

  try {
    const response = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: shares,
        side: clobClient.Side.SELL,
        price: limitPrice,
      },
      {} as any,  // SDK auto-resolves tickSize + negRisk per token
      clobClient.OrderType.FOK,
    );

    const latencyMs = Date.now() - startMs;
    logger.debug("copy-executor", `SELL response (${latencyMs}ms): ${JSON.stringify(response)}`);

    if (!response || !response.success) {
      const errMsg = response?.errorMsg || response?.error || response?.status || JSON.stringify(response);
      logger.error("copy-executor", `SELL_REJECTED: ${errMsg}`);
      return undefined;
    }

    logger.event("copy-executor", "LIVE_SELL_FILLED", {
      orderId: response.orderID,
      status: response.status,
      shares,
      price: limitPrice,
      latencyMs,
    });

    return response.orderID;
  } catch (e: any) {
    logger.error("copy-executor", `SELL_ERROR: ${e.message}`);
    return undefined;
  }
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
