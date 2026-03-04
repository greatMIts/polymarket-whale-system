/**
 * clob-client.ts — Polymarket CLOB client for live order execution.
 *
 * Initializes only when POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER env vars are set.
 * When not configured, the bot runs PAPER-only.
 *
 * Wallet type: POLY_PROXY (signatureType = 1) — Magic Link wallet
 */

import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { logLiveEvent } from "./live-events";

// Re-export Side and OrderType for use in executor
export { Side, OrderType };

let clobClient: ClobClient | null = null;
let clobReady = false;

// ─── WALLET BALANCE TRACKING ────────────────────────────────────────────────
let cachedBalance: number | null = null;
let cachedAllowance: number | null = null;
let balanceLastChecked: number = 0;
const BALANCE_STALE_MS = 120_000; // consider stale after 2 minutes

export async function initClobClient(): Promise<boolean> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;

  if (!privateKey || !funder) {
    console.log("CLOB client not initialized — POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER not set");
    console.log("LIVE mode unavailable. Bot will run in PAPER mode only.");
    return false;
  }

  const MAX_RETRIES = 3;
  const BACKOFF_BASE_MS = 3000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const signer = new Wallet(privateKey);
      const tempClient = new ClobClient("https://clob.polymarket.com", 137, signer);
      const apiCreds = await tempClient.createOrDeriveApiKey();

      clobClient = new ClobClient(
        "https://clob.polymarket.com",
        137,
        signer,
        apiCreds,
        1,       // POLY_PROXY — Magic Link wallet
        funder
      );

      clobReady = true;
      console.log(`CLOB client initialized (attempt ${attempt}/${MAX_RETRIES}) — signer: ${signer.address}, funder: ${funder}, signatureType: 1 (POLY_PROXY)`);

      logLiveEvent({
        event: "CLOB_INITIALIZED",
        signerAddress: signer.address,
        funderAddress: funder,
        signatureType: 1,
        attempt,
      });

      // Query initial balance (non-blocking)
      queryBalance().then(bal => {
        if (bal) console.log(`[CLOB] Initial balance: $${bal.balance.toFixed(2)}, allowance: $${bal.allowance.toFixed(2)}`);
      }).catch(() => {});

      return true;
    } catch (error: any) {
      console.error(`CLOB client init attempt ${attempt}/${MAX_RETRIES} FAILED: ${error.message}`);
      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * attempt;
        console.log(`  Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.error(`CLOB client initialization FAILED after ${MAX_RETRIES} attempts — LIVE mode unavailable until restart`);
  clobReady = false;
  return false;
}

export function getClobClient(): ClobClient | null {
  return clobClient;
}

export function isClobReady(): boolean {
  return clobReady;
}

/**
 * Query wallet USDC balance and allowance from the Polymarket CLOB API.
 * Uses the L2 getBalanceAllowance({ asset_type: "COLLATERAL" }) method.
 *
 * CAVEAT: Polymarket's getBalanceAllowance has a known bug (GitHub issue #128)
 * where it can return 0 even when the wallet has funds. We handle this by:
 * - Calling updateBalanceAllowance() first to refresh the server-side cache
 * - Never overwriting a known-good balance with a 0 response
 * - Treating null/stale data as "unknown" (never blocking trades on bad data)
 */
export async function queryBalance(): Promise<{ balance: number; allowance: number } | null> {
  if (!clobClient || !clobReady) return null;

  try {
    // Refresh the server-side balance cache first
    await clobClient.updateBalanceAllowance({ asset_type: "COLLATERAL" as any });
    const result = await clobClient.getBalanceAllowance({ asset_type: "COLLATERAL" as any });

    const balance = parseFloat(result.balance) || 0;
    const allowance = parseFloat(result.allowance) || 0;

    if (balance > 0 || allowance > 0) {
      cachedBalance = balance;
      cachedAllowance = allowance;
      balanceLastChecked = Date.now();
    } else if (cachedBalance !== null && cachedBalance > 0) {
      // Had a real balance before, now getting 0 — likely the known API bug.
      console.warn("[CLOB] getBalanceAllowance returned 0 but we previously had $" +
        cachedBalance.toFixed(2) + " — keeping cached value (likely Polymarket API bug #128)");
    } else {
      cachedBalance = balance;
      cachedAllowance = allowance;
      balanceLastChecked = Date.now();
    }

    return { balance: cachedBalance ?? 0, allowance: cachedAllowance ?? 0 };
  } catch (error: any) {
    console.error("[CLOB] Balance query failed:", error.message);
    if (cachedBalance !== null) {
      return { balance: cachedBalance, allowance: cachedAllowance ?? 0 };
    }
    return null;
  }
}

/**
 * Get cached balance without making an API call.
 */
export function getCachedBalance(): { balance: number | null; allowance: number | null; lastChecked: number } {
  return { balance: cachedBalance, allowance: cachedAllowance, lastChecked: balanceLastChecked };
}

/**
 * Soft pre-trade balance check using cached data.
 * Returns true (allow trade) if:
 * - Balance was never queried (null) — don't block on missing data
 * - Balance data is stale (>2min) — let the API be the judge
 * - Cached balance >= order size * 1.15 (15% buffer for fees)
 * Returns false only when we have fresh, confident data showing balance is too low.
 */
export function hasEnoughBalance(sizeUsdc: number): boolean {
  if (cachedBalance === null) return true;
  if (Date.now() - balanceLastChecked > BALANCE_STALE_MS) return true;
  return cachedBalance >= sizeUsdc * 1.15;
}

/**
 * Re-derive API credentials and rebuild the CLOB client at runtime.
 * Called when consecutive balance errors suggest the API session is stale.
 */
export async function reconnectClobClient(): Promise<boolean> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;

  if (!privateKey || !funder) {
    console.error("[CLOB] reconnect failed — env vars missing");
    return false;
  }

  console.log("[CLOB] Reconnecting — re-deriving API credentials...");
  clobReady = false;

  try {
    const signer = new Wallet(privateKey);
    const tempClient = new ClobClient("https://clob.polymarket.com", 137, signer);
    const apiCreds = await tempClient.createOrDeriveApiKey();

    clobClient = new ClobClient(
      "https://clob.polymarket.com",
      137,
      signer,
      apiCreds,
      1,       // POLY_PROXY
      funder
    );

    clobReady = true;
    // Reset balance cache so it gets re-queried with fresh session
    cachedBalance = null;
    cachedAllowance = null;
    balanceLastChecked = 0;

    console.log("[CLOB] Reconnected successfully — new API credentials derived");
    logLiveEvent({ event: "CLOB_RECONNECTED", signerAddress: signer.address, funderAddress: funder });

    // Query balance with the fresh session
    queryBalance().then(bal => {
      if (bal) console.log(`[CLOB] Post-reconnect balance: $${bal.balance.toFixed(2)}`);
    }).catch(() => {});

    return true;
  } catch (error: any) {
    console.error("[CLOB] Reconnect FAILED:", error.message);
    clobReady = false;
    logLiveEvent({ event: "CLOB_RECONNECT_FAILED", error: error.message });
    return false;
  }
}
