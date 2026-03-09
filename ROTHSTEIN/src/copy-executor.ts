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

  // 3. Price logic — LIVE mode
  // The whale already swept the order book up to their fill price.
  // Our book ask may be STALE (showing pre-whale price like 0.51 when whale paid 0.74).
  // NEVER use book ask alone — use max(ask, whalePrice) as our effective entry price.
  // HARD CAP: reject if effective price > 0.70 — never enter expensive positions.
  const MAX_ENTRY_PRICE = 0.70;
  let effectiveAsk = currentAsk;
  if (isLive) {
    effectiveAsk = Math.max(currentAsk, signal.price);
    if (effectiveAsk > MAX_ENTRY_PRICE) {
      throw new Error(`PRICE_TOO_HIGH: effective=${effectiveAsk.toFixed(4)} ask=${currentAsk.toFixed(4)} whale=${signal.price.toFixed(4)} cap=${MAX_ENTRY_PRICE}`);
    }
    if (currentAsk < signal.price) {
      logger.info("copy-executor", `Stale book: ask=${currentAsk.toFixed(4)} < whale=${signal.price.toFixed(4)} — using whale price as floor`);
    } else if (currentAsk > signal.price + 0.06) {
      throw new Error(`PRICE_STALE: ask=${currentAsk.toFixed(4)} whale=${signal.price.toFixed(4)} diff=+${(currentAsk - signal.price).toFixed(4)} (ask way above whale)`);
    }
  }

  // 4. Place order (live mode only) — do this FIRST so we know the real fill price
  // Pass whale's price — executeLiveOrder adds +8¢ slippage for the GTC limit
  let orderId: string | undefined;
  let fillPrice = 0;
  let fillShares = 0;
  if (isLive) {
    const result = await executeLiveOrder(tokenId, signal.side, sizeUsd, signal.price);
    if (result) {
      orderId = result.orderId;
      fillPrice = result.fillPrice;
      fillShares = result.fillShares;
    }
  }

  // Entry price: LIVE mode uses actual fill price from CLOB, paper mode uses whale's price
  // Fallback chain: real fill → effective ask estimate → whale price
  const entryPrice = isLive
    ? (fillPrice > 0 ? fillPrice : effectiveAsk)
    : signal.price;

  // 5. Build WhaleCopyMeta (12 fields)
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

  // 6. Build TradeExecution — use real fill shares if available, else compute from entry price
  const shares = fillShares > 0 ? fillShares : sizeUsd / entryPrice;
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
// Places a GTC limit order via Polymarket's CLOB SDK.
// Limit price = whale price + 8¢ max slippage.
// GTC sits on the book and fills as liquidity arrives — no FOK kill problem.
// After placement, polls for actual fill price so dashboard shows the REAL entry.

const MAX_BUY_SLIPPAGE = 0.08;   // max 8¢ above whale price
const FILL_POLL_DELAY_MS = 1500;  // wait before checking fill
const FILL_POLL_RETRIES = 3;      // retry up to 3 times
const FILL_POLL_INTERVAL_MS = 1000;

interface LiveOrderResult {
  orderId: string;
  fillPrice: number;   // actual avg fill price (0 if unknown)
  fillShares: number;   // actual shares filled (0 if unknown)
}

async function executeLiveOrder(
  tokenId: string,
  side: string,
  sizeUsd: number,
  whalePrice: number
): Promise<LiveOrderResult | undefined> {
  const client = clobClient.getClient();
  const startMs = Date.now();

  // GTC limit order: whale price + 8¢ max slippage, hard capped at 0.70
  const limitPrice = Math.min(whalePrice + MAX_BUY_SLIPPAGE, 0.70);
  const shares = sizeUsd / limitPrice;
  logger.info("copy-executor", `BUY GTC: whale=${whalePrice.toFixed(4)} limit=${limitPrice.toFixed(4)} (+${MAX_BUY_SLIPPAGE}) size=$${sizeUsd} shares=${shares.toFixed(2)}`);

  const response = await client.createAndPostOrder(
    {
      tokenID: tokenId,
      price: limitPrice,
      side: clobClient.Side.BUY,
      size: shares,
    },
    {} as any,  // SDK auto-resolves tickSize + negRisk per token
    clobClient.OrderType.GTC,
  );

  const latencyMs = Date.now() - startMs;

  // Log full response for debugging (CLOB SDK has inconsistent error shapes)
  logger.debug("copy-executor", `CLOB response (${latencyMs}ms): ${JSON.stringify(response)}`);

  if (!response || !response.success) {
    const errMsg = response?.errorMsg || response?.error || response?.status || JSON.stringify(response);
    throw new Error(`ORDER_REJECTED: ${errMsg}`);
  }

  const orderId = response.orderID;
  logger.event("copy-executor", "LIVE_ORDER_PLACED", {
    orderId,
    status: response.status,
    side,
    sizeUsd,
    whalePrice,
    limitPrice,
    shares: shares.toFixed(4),
    latencyMs,
  });

  // ─── Poll for actual fill price ──────────────────────────────────────────
  // GTC orders may fill instantly or over time. Poll getOrder to get the
  // real fill price from associated trades so the dashboard shows truth.
  const fillResult = await pollForFill(client, orderId, limitPrice);
  return { orderId, ...fillResult };
}

/**
 * Poll getOrder + getTrades to find the actual average fill price.
 * Returns { fillPrice, fillShares } — falls back to 0 if we can't determine.
 */
async function pollForFill(
  client: any,
  orderId: string,
  limitPrice: number
): Promise<{ fillPrice: number; fillShares: number }> {
  // Wait a moment for the matching engine to process
  await new Promise(r => setTimeout(r, FILL_POLL_DELAY_MS));

  for (let attempt = 0; attempt < FILL_POLL_RETRIES; attempt++) {
    try {
      const order = await client.getOrder(orderId);
      logger.debug("copy-executor", `getOrder attempt ${attempt + 1}: ${JSON.stringify(order)}`);

      const sizeMatched = parseFloat(order?.size_matched || "0");
      if (sizeMatched <= 0) {
        // Not filled yet — wait and retry
        if (attempt < FILL_POLL_RETRIES - 1) {
          await new Promise(r => setTimeout(r, FILL_POLL_INTERVAL_MS));
          continue;
        }
        logger.warn("copy-executor", `Order ${orderId} not yet filled after ${FILL_POLL_RETRIES} polls — using limit as estimate`);
        return { fillPrice: limitPrice, fillShares: 0 };
      }

      // Order has fills — try to get actual trade prices
      const trades: string[] = order.associate_trades || [];
      if (trades.length > 0) {
        // Fetch our recent trades to compute VWAP
        try {
          const recentTrades = await client.getTrades({ asset_id: order.asset_id }, true);
          // Filter to trades that match our order
          const ourFills = (recentTrades || []).filter(
            (t: any) => t.taker_order_id === orderId || trades.includes(t.id)
          );

          if (ourFills.length > 0) {
            // Compute volume-weighted average fill price
            let totalValue = 0;
            let totalSize = 0;
            for (const fill of ourFills) {
              const p = parseFloat(fill.price || "0");
              const s = parseFloat(fill.size || "0");
              if (p > 0 && s > 0) {
                totalValue += p * s;
                totalSize += s;
              }
            }
            if (totalSize > 0) {
              const vwap = totalValue / totalSize;
              logger.info("copy-executor", `Fill VWAP: ${vwap.toFixed(4)} from ${ourFills.length} trades, ${totalSize.toFixed(2)} shares`);
              return { fillPrice: vwap, fillShares: totalSize };
            }
          }
        } catch (e: any) {
          logger.debug("copy-executor", `getTrades failed: ${e.message} — falling back to order price`);
        }
      }

      // Fallback: order has size_matched but we couldn't get trade details
      // Use the order's price (our limit) — the fill is at or better than this
      const orderPrice = parseFloat(order.price || String(limitPrice));
      logger.info("copy-executor", `Fill detected: ${sizeMatched.toFixed(2)} shares matched, using order price ${orderPrice.toFixed(4)}`);
      return { fillPrice: orderPrice, fillShares: sizeMatched };

    } catch (e: any) {
      logger.debug("copy-executor", `getOrder poll attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt < FILL_POLL_RETRIES - 1) {
        await new Promise(r => setTimeout(r, FILL_POLL_INTERVAL_MS));
      }
    }
  }

  // All polls failed — fall back to limit price as upper bound estimate
  logger.warn("copy-executor", `Could not determine fill price for ${orderId} — using limit ${limitPrice.toFixed(4)}`);
  return { fillPrice: limitPrice, fillShares: 0 };
}

// ─── Live SELL Order (for TP exits) ──────────────────────────────────────────
// Places a GTC limit SELL order to close an open position.
// Limit price = current bid - 8¢ slippage (willing to accept less for guaranteed fill).

const MAX_SELL_SLIPPAGE = 0.08;   // max 8¢ below bid for TP exits

export async function executeLiveSell(
  tokenId: string,
  shares: number,
  bidPrice: number
): Promise<string | undefined> {
  const client = clobClient.getClient();
  const startMs = Date.now();

  try {
    // GTC limit sell: bid - 8¢ slippage, floored at 0.01
    const limitPrice = Math.max(bidPrice - MAX_SELL_SLIPPAGE, 0.01);
    logger.info("copy-executor", `SELL GTC: bid=${bidPrice.toFixed(4)} limit=${limitPrice.toFixed(4)} (-${MAX_SELL_SLIPPAGE}) shares=${shares.toFixed(2)}`);

    const response = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: limitPrice,
        side: clobClient.Side.SELL,
        size: shares,
      },
      {} as any,  // SDK auto-resolves tickSize + negRisk per token
      clobClient.OrderType.GTC,
    );

    const latencyMs = Date.now() - startMs;
    logger.debug("copy-executor", `SELL response (${latencyMs}ms): ${JSON.stringify(response)}`);

    if (!response || !response.success) {
      const errMsg = response?.errorMsg || response?.error || response?.status || JSON.stringify(response);
      logger.error("copy-executor", `SELL_REJECTED: ${errMsg}`);
      return undefined;
    }

    logger.event("copy-executor", "LIVE_SELL_PLACED", {
      orderId: response.orderID,
      status: response.status,
      shares: shares.toFixed(4),
      bidPrice,
      limitPrice,
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
