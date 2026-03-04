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
 * Re-derive API credentials and rebuild the CLOB client.
 * Called when consecutive balance errors suggest a stale session.
 * Returns true if reconnection succeeded.
 */
export async function reconnectClobClient(): Promise<boolean> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;

  if (!privateKey || !funder) {
    console.error("[CLOB] reconnect failed — env vars missing");
    return false;
  }

  console.log("[CLOB] Reconnecting — re-deriving API credentials...");
  clobReady = false; // mark unavailable during reconnect

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
    console.log("[CLOB] Reconnected successfully — new API credentials derived");

    logLiveEvent({
      event: "CLOB_RECONNECTED",
      signerAddress: signer.address,
      funderAddress: funder,
    });

    return true;
  } catch (error: any) {
    console.error("[CLOB] Reconnect FAILED:", error.message);
    clobReady = false;

    logLiveEvent({
      event: "CLOB_RECONNECT_FAILED",
      error: error.message,
    });

    return false;
  }
}
