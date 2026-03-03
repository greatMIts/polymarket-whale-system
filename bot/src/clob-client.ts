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

  try {
    const signer = new Wallet(privateKey);

    // Derive API credentials from wallet signature
    const tempClient = new ClobClient("https://clob.polymarket.com", 137, signer);
    const apiCreds = await tempClient.createOrDeriveApiKey();

    // signatureType = 1 for POLY_PROXY (Magic Link wallet)
    clobClient = new ClobClient(
      "https://clob.polymarket.com",
      137,
      signer,
      apiCreds,
      1,       // POLY_PROXY — Magic Link wallet
      funder   // Polymarket deposit/proxy address
    );

    clobReady = true;
    console.log(`CLOB client initialized — signer: ${signer.address}, funder: ${funder}, signatureType: 1 (POLY_PROXY)`);

    logLiveEvent({
      event: "CLOB_INITIALIZED",
      signerAddress: signer.address,
      funderAddress: funder,
      signatureType: 1,
    });

    return true;
  } catch (error: any) {
    console.error("CLOB client initialization FAILED:", error.message);
    clobReady = false;
    return false;
  }
}

export function getClobClient(): ClobClient | null {
  return clobClient;
}

export function isClobReady(): boolean {
  return clobReady;
}
