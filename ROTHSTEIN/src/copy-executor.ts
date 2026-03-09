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

// ─── Compute Size — flat $13 per trade ───────────────────────────────────────

export function computeSize(): number {
  const effectiveMultiplier = risk.getEffectiveSizingMultiplier();
  const runtime = getRuntime();
  const baseSizeUsd = runtime.betSizeUsdc;
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

  // 1. Compute sizing — flat $13
  const sizeUsd = computeSize();

  // 2. Get current ask from cached book
  const book = polyBook.getBook(tokenId);
  if (!book || book.ask <= 0) {
    throw new Error("NO_BOOK_DATA");
  }
  const currentAsk = book.ask;
  const isLive = CONFIG.mode === "LIVE";

  // 3. Price logic — price at CURRENT ASK (not whale price + slippage)
  // The whale already swept the book. Our ask reflects post-whale reality.
  // Use max(ask, whalePrice) as floor — book can be stale showing pre-whale price.
  // HARD CAP: reject if effective price > maxPrice (default 0.70).
  const runtime = getRuntime();
  const MAX_ENTRY_PRICE = runtime.maxPrice;
  let effectiveAsk = currentAsk;
  if (isLive) {
    effectiveAsk = Math.max(currentAsk, signal.price);
    if (effectiveAsk > MAX_ENTRY_PRICE) {
      throw new Error(`PRICE_TOO_HIGH: effective=${effectiveAsk.toFixed(4)} ask=${currentAsk.toFixed(4)} whale=${signal.price.toFixed(4)} cap=${MAX_ENTRY_PRICE}`);
    }
  }

  // 4. Place order (live mode only) — FOK at effective ask price
  // FOK = Fill-or-Kill: instant fill or immediate cancel, no polling needed
  let orderId: string | undefined;
  let fillPrice = 0;
  let fillShares = 0;
  if (isLive) {
    const result = await executeLiveOrder(tokenId, signal.side, sizeUsd, effectiveAsk);
    if (result) {
      orderId = result.orderId;
      fillPrice = result.fillPrice;
      fillShares = result.fillShares;
    }

    // CRITICAL: abort if FOK order was not filled (prevents phantom trades)
    if (result && result.fillShares === 0) {
      throw new Error(`NO_FILL: FOK order ${result.orderId} not matched at ask=${effectiveAsk.toFixed(4)}`);
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
// Places a FOK (Fill-or-Kill) order via Polymarket's CLOB SDK.
// FOK: instant fill at the specified price or immediate cancel — no waiting.
// Price = current ask (capped at maxPrice), not whale price + slippage.

interface LiveOrderResult {
  orderId: string;
  fillPrice: number;   // actual avg fill price (0 if unknown)
  fillShares: number;   // actual shares filled (0 if unknown)
}

async function executeLiveOrder(
  tokenId: string,
  side: string,
  sizeUsd: number,
  askPrice: number
): Promise<LiveOrderResult | undefined> {
  const client = clobClient.getClient();
  const startMs = Date.now();

  // FOK market order: SDK uses createAndPostMarketOrder with amount in USD
  // The SDK calculates the optimal price from the order book automatically.
  // We pass askPrice as the price cap — won't pay more than this.
  logger.info("copy-executor", `BUY FOK: ask=${askPrice.toFixed(4)} amount=$${sizeUsd}`);

  const response = await client.createAndPostMarketOrder(
    {
      tokenID: tokenId,
      price: askPrice,   // price cap — SDK won't fill above this
      amount: sizeUsd,   // USD amount to spend
      side: clobClient.Side.BUY,
    },
    {} as any,  // SDK auto-resolves tickSize + negRisk per token
    clobClient.OrderType.FOK,
  );

  const latencyMs = Date.now() - startMs;

  // Log full response for debugging (CLOB SDK has inconsistent error shapes)
  logger.debug("copy-executor", `CLOB FOK response (${latencyMs}ms): ${JSON.stringify(response)}`);

  if (!response || !response.success) {
    const errMsg = response?.errorMsg || response?.error || response?.status || JSON.stringify(response);
    throw new Error(`ORDER_REJECTED: ${errMsg}`);
  }

  const orderId = response.orderID;
  logger.event("copy-executor", "LIVE_FOK_PLACED", {
    orderId,
    status: response.status,
    side,
    sizeUsd,
    askPrice,
    latencyMs,
  });

  // FOK fills instantly — check order for fill details (single call, no polling)
  try {
    // Short delay for matching engine to process
    await new Promise(r => setTimeout(r, 500));
    const order = await client.getOrder(orderId);
    logger.debug("copy-executor", `FOK getOrder: ${JSON.stringify(order)}`);

    const sizeMatched = parseFloat(order?.size_matched || "0");
    if (sizeMatched <= 0) {
      // FOK was killed — no fill
      logger.warn("copy-executor", `FOK order ${orderId} killed — no liquidity at ${askPrice.toFixed(4)}`);
      return { orderId, fillPrice: askPrice, fillShares: 0 };
    }

    // Try to get actual fill VWAP from trades
    const trades: string[] = order.associate_trades || [];
    if (trades.length > 0) {
      try {
        const recentTrades = await client.getTrades({ asset_id: order.asset_id }, true);
        const ourFills = (recentTrades || []).filter(
          (t: any) => t.taker_order_id === orderId || trades.includes(t.id)
        );
        if (ourFills.length > 0) {
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
            logger.info("copy-executor", `FOK fill VWAP: ${vwap.toFixed(4)} from ${ourFills.length} trades, ${totalSize.toFixed(2)} shares`);
            return { orderId, fillPrice: vwap, fillShares: totalSize };
          }
        }
      } catch (e: any) {
        logger.debug("copy-executor", `getTrades failed: ${e.message}`);
      }
    }

    // Fallback: size_matched but no trade details — use ask price
    const orderPrice = parseFloat(order.price || String(askPrice));
    logger.info("copy-executor", `FOK fill: ${sizeMatched.toFixed(2)} shares at ${orderPrice.toFixed(4)}`);
    return { orderId, fillPrice: orderPrice, fillShares: sizeMatched };

  } catch (e: any) {
    logger.debug("copy-executor", `FOK getOrder failed: ${e.message} — assuming no fill`);
    // Can't confirm fill — treat as no fill to be safe (prevents phantom trades)
    return { orderId, fillPrice: askPrice, fillShares: 0 };
  }
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
