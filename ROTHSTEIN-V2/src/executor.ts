// ─── ROTHSTEIN V2 Trade Executor ──────────────────────────────────────────────
// PAPER mode: instant simulated fill at whale's price.
// LIVE mode: FOK order via @polymarket/clob-client at min(bookAsk, fokMaxPrice).
// Handles CLOB client initialization from private key → derive API creds → client.

import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { Trade, WhaleSignal, Contract, Side, Mode } from "./types";
import { ENV, URLS, getFilter } from "./config";
import { createLogger } from "./log";
import * as book from "./book";

const log = createLogger("EXECUTOR");

// ─── State ───────────────────────────────────────────────────────────────────

let clobClient: ClobClient | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let tradeCounter = 0;

// ─── CLOB Client Initialization ──────────────────────────────────────────────

async function initClobClient(): Promise<ClobClient> {
  if (clobClient) return clobClient;

  if (!ENV.polyPrivateKey) {
    throw new Error("POLY_PRIVATE_KEY not set — cannot initialize CLOB client");
  }

  log.info("Initializing CLOB client...");

  const wallet = new ethers.Wallet(ENV.polyPrivateKey);
  const chainId = 137; // Polygon mainnet

  // If API key/secret/passphrase are provided, use them directly
  if (ENV.polyApiKey && ENV.polyApiSecret && ENV.polyPassphrase) {
    clobClient = new ClobClient(
      URLS.clobApi,
      chainId,
      wallet,
      {
        key: ENV.polyApiKey,
        secret: ENV.polyApiSecret,
        passphrase: ENV.polyPassphrase,
      },
      ENV.polySignatureType
    );
  } else {
    // Derive API credentials from the private key
    clobClient = new ClobClient(
      URLS.clobApi,
      chainId,
      wallet,
      undefined,
      ENV.polySignatureType
    );
    log.info("Deriving API credentials...");
    const creds = await clobClient.createApiKey();
    clobClient = new ClobClient(
      URLS.clobApi,
      chainId,
      wallet,
      creds,
      ENV.polySignatureType
    );
    log.info("API credentials derived successfully");
  }

  return clobClient;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Execute a trade based on the whale signal and filter result.
 * Returns the completed Trade or null if execution failed.
 */
export async function execute(
  signal: WhaleSignal,
  contract: Contract,
  pipelineStartTs: number
): Promise<Trade | null> {
  const cfg = getFilter();
  const mode: Mode = ENV.mode;

  const tokenId = getTokenIdForSide(contract, signal.side);
  if (!tokenId) {
    log.error("Cannot determine tokenId for side", { side: signal.side, contract: contract.conditionId });
    return null;
  }

  // Determine entry price
  const bookData = book.getBook(tokenId);
  const bookAsk = bookData?.ask ?? signal.price;
  const entryPrice = Math.min(bookAsk, cfg.fokMaxPrice);
  const sizeUsd = cfg.betSize;
  const shares = sizeUsd / entryPrice;

  const tradeId = `R2-${Date.now()}-${++tradeCounter}`;
  const now = Date.now();
  const slippage = entryPrice - signal.price;
  const pipelineLatencyMs = now - pipelineStartTs;

  const trade: Trade = {
    id: tradeId,
    ts: now,
    conditionId: contract.conditionId,
    tokenId,
    title: contract.title,
    asset: contract.asset,
    side: signal.side,
    entryPrice,
    sizeUsd,
    shares,
    mode,
    whaleWallet: signal.wallet,
    whaleLabel: signal.walletLabel,
    whalePrice: signal.price,
    whaleSize: signal.usdcSize,
    slippage,
    pipelineLatencyMs,
    endTs: contract.endTs,
    strikePrice: contract.strikePrice || 0,
  };

  try {
    if (mode === "PAPER") {
      return executePaper(trade);
    } else {
      return await executeLive(trade);
    }
  } catch (err: any) {
    log.error(`Execution failed: ${err.message}`, { tradeId, mode });
    return null;
  }
}

// ─── Paper Execution ─────────────────────────────────────────────────────────

function executePaper(trade: Trade): Trade {
  // Instant simulated fill at whale's price
  log.info(
    `PAPER FILL: ${trade.side} ${trade.asset} $${trade.sizeUsd.toFixed(2)} @ ${trade.entryPrice.toFixed(4)} | ` +
    `whale=${trade.whaleLabel} latency=${trade.pipelineLatencyMs}ms`
  );
  return trade;
}

// ─── Live Execution ──────────────────────────────────────────────────────────

async function executeLive(trade: Trade): Promise<Trade | null> {
  const client = await initClobClient();

  log.info(
    `LIVE FOK: ${trade.side} ${trade.asset} $${trade.sizeUsd.toFixed(2)} @ ${trade.entryPrice.toFixed(4)} | ` +
    `token=${trade.tokenId.slice(0, 10)}...`
  );

  try {
    // Create and send a FOK (Fill-or-Kill) order
    const order = await client.createOrder({
      tokenID: trade.tokenId,
      price: trade.entryPrice,
      side: "BUY" as any,
      size: trade.shares,
      feeRateBps: 0,
      nonce: 0,
      expiration: 0,
    });

    const result = await client.postOrder(order, "FOK" as any);

    if (result && (result as any).orderID) {
      trade.orderId = (result as any).orderID;
      log.info(`LIVE FILLED: orderId=${trade.orderId} latency=${trade.pipelineLatencyMs}ms`);
      return trade;
    } else {
      log.warn("FOK order not filled — likely no liquidity at price");
      return null;
    }
  } catch (err: any) {
    log.error(`LIVE order failed: ${err.message}`);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTokenIdForSide(contract: Contract, side: Side): string | undefined {
  const idx = contract.outcomes.findIndex(
    (o) => o.toLowerCase() === side.toLowerCase()
  );
  return idx >= 0 ? contract.clobTokenIds[idx] : undefined;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function start(): Promise<void> {
  log.info(`Executor starting in ${ENV.mode} mode`);

  // Pre-initialize CLOB client in LIVE mode
  if (ENV.mode === "LIVE") {
    try {
      await initClobClient();
      log.info("CLOB client ready");
    } catch (err: any) {
      log.error(`CLOB client init failed: ${err.message} — will retry on first trade`);
    }
  }

  // Keep-alive ping every 30s (keeps CLOB session alive in LIVE mode)
  keepaliveTimer = setInterval(async () => {
    if (clobClient && ENV.mode === "LIVE") {
      try {
        await clobClient.getOk();
      } catch {
        log.debug("CLOB keepalive failed — will reconnect on next trade");
        clobClient = null;
      }
    }
  }, 30_000);
}

export function stop(): void {
  log.info("Stopping executor");
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  clobClient = null;
}
