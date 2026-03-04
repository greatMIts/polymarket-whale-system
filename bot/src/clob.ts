/**
 * clob.ts — V7.5 wrapper around clob-client.ts
 *
 * Layer 2 — Imports config, live-events, types.
 * Provides init, isClobReady, getBalance, reconnect, placeFokOrder.
 * Logs CLOB_INITIALIZED, ORDER_PLACED, ORDER_FAILED to live-events.
 */

import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { logLiveEvent } from "./live-events";
import type { SellOrder, SellResult } from "./types";

let clobClient: ClobClient | null = null;
let clobReady = false;

// ── Balance cache (handles Polymarket API #128 bug) ──
let cachedBalance: number | null = null;

export async function init(): Promise<void> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;

  if (!privateKey || !funder) {
    console.log("[CLOB] Not initialized — POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER not set");
    console.log("[CLOB] LIVE mode unavailable. Bot will run in PAPER mode only.");
    return;
  }

  const delays = [1000, 2000, 4000]; // 3x retry with 1s/2s/4s backoff

  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      const signer = new Wallet(privateKey);
      const tempClient = new ClobClient("https://clob.polymarket.com", 137, signer);

      // Use deriveApiKey() first to avoid noisy 400 error from createOrDeriveApiKey().
      // The library's createOrDeriveApiKey() tries CREATE first (logs a 400 error if key
      // already exists), then falls back to DERIVE. By calling derive directly we skip
      // the noisy error entirely in the common case.
      let apiCreds;
      try {
        apiCreds = await tempClient.deriveApiKey();
        console.log("[CLOB] API key derived successfully");
      } catch {
        console.log("[CLOB] deriveApiKey failed, trying createApiKey...");
        apiCreds = await tempClient.createApiKey();
        console.log("[CLOB] API key created successfully");
      }

      clobClient = new ClobClient(
        "https://clob.polymarket.com",
        137,
        signer,
        apiCreds,
        1,       // POLY_PROXY — Magic Link wallet
        funder
      );

      clobReady = true;
      console.log(`[CLOB] Initialized (attempt ${attempt + 1}/3) — signer: ${signer.address}`);

      logLiveEvent({
        event: "CLOB_INITIALIZED",
        signerAddress: signer.address,
        funderAddress: funder,
        signatureType: 1,
        attempt: attempt + 1,
      });

      // Query initial balance and log it
      getBalance()
        .then(bal => console.log(`[CLOB] Initial balance: $${bal.toFixed(2)}`))
        .catch(() => console.warn("[CLOB] Initial balance query failed"));
      return;
    } catch (error: any) {
      console.error(`[CLOB] Init attempt ${attempt + 1}/3 FAILED: ${error.message}`);
      if (attempt < delays.length - 1) {
        await new Promise(r => setTimeout(r, delays[attempt]));
      }
    }
  }

  console.error("[CLOB] Initialization FAILED after 3 attempts — LIVE mode unavailable");
  clobReady = false;
}

export function isClobReady(): boolean {
  return clobReady;
}

export async function getBalance(): Promise<number> {
  if (!clobClient || !clobReady) return cachedBalance ?? 0;

  try {
    await clobClient.updateBalanceAllowance({ asset_type: "COLLATERAL" as any });
    const result = await clobClient.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
    const balance = parseFloat(result.balance) || 0;

    if (balance > 0) {
      cachedBalance = balance;
    } else if (cachedBalance !== null && cachedBalance > 0) {
      // Known Polymarket API bug #128 — keep cached value
      console.warn(`[CLOB] getBalance returned 0 but cached $${cachedBalance.toFixed(2)} — keeping cached`);
    } else {
      cachedBalance = balance;
    }

    return cachedBalance ?? 0;
  } catch (error: any) {
    console.error("[CLOB] Balance query failed:", error.message);
    return cachedBalance ?? 0;
  }
}

export async function reconnect(): Promise<void> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;

  if (!privateKey || !funder) {
    console.error("[CLOB] Reconnect failed — env vars missing");
    return;
  }

  console.log("[CLOB] Reconnecting — re-deriving API credentials...");
  clobReady = false;

  try {
    const signer = new Wallet(privateKey);
    const tempClient = new ClobClient("https://clob.polymarket.com", 137, signer);

    let apiCreds;
    try {
      apiCreds = await tempClient.deriveApiKey();
    } catch {
      apiCreds = await tempClient.createApiKey();
    }

    clobClient = new ClobClient(
      "https://clob.polymarket.com",
      137,
      signer,
      apiCreds,
      1,       // POLY_PROXY
      funder
    );

    clobReady = true;
    cachedBalance = null;

    console.log("[CLOB] Reconnected successfully");
    logLiveEvent({ event: "CLOB_RECONNECTED", signerAddress: signer.address, funderAddress: funder });

    getBalance()
      .then(bal => console.log(`[CLOB] Balance after reconnect: $${bal.toFixed(2)}`))
      .catch(() => console.warn("[CLOB] Balance query failed after reconnect"));
  } catch (error: any) {
    console.error("[CLOB] Reconnect FAILED:", error.message);
    clobReady = false;
    logLiveEvent({ event: "CLOB_RECONNECT_FAILED", error: error.message });
  }
}

/**
 * Place a Fill-or-Kill order on the Polymarket CLOB.
 *
 * V7.4 M1+M2: tokenId + negRisk params.
 * Size unit: BUY = USDC amount to spend. SELL = token count to sell.
 */
export async function placeFokOrder(params: SellOrder): Promise<SellResult> {
  if (!clobClient || !clobReady) {
    return { status: 'FAILED', reason: 'CLOB_NOT_READY' };
  }

  try {
    logLiveEvent({
      event: "ORDER_PLACED",
      tokenID: params.tokenId,
      side: params.side,
      requestedSize: params.size,
      requestedPrice: params.price,
      negRisk: params.negRisk,
    });

    const result = await Promise.race([
      clobClient.createAndPostMarketOrder({
        tokenID: params.tokenId,
        price: params.price,
        side: params.side === 'BUY' ? Side.BUY : Side.SELL,
        amount: params.size,
        feeRateBps: 1000,
      }, {
        tickSize: "0.01",
        negRisk: params.negRisk,
      }, OrderType.FOK),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ORDER_TIMEOUT')), params.timeout)
      ),
    ]);

    // Parse response
    const res = result as any;
    if (res?.success || res?.orderID) {
      const fillPrice = Number(res.averagePrice || res.price || params.price);
      const fillSize = Number(res.size || params.size);
      return {
        status: 'FILLED',
        fillPrice,
        fillSize,
      };
    }

    const reason = res?.errorMessage || res?.reason || 'FOK_REJECTED';
    logLiveEvent({ event: "ORDER_FAILED", tokenID: params.tokenId, reason });
    return { status: 'FAILED', reason };
  } catch (error: any) {
    if (error.message === 'ORDER_TIMEOUT') {
      logLiveEvent({ event: "ORDER_FAILED", tokenID: params.tokenId, reason: 'TIMEOUT' });
      return { status: 'TIMEOUT', reason: 'TIMEOUT' };
    }

    logLiveEvent({ event: "ORDER_FAILED", tokenID: params.tokenId, error: error.message });
    return { status: 'FAILED', reason: error.message };
  }
}
