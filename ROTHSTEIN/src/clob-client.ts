// ─── CLOB Trading Client ────────────────────────────────────────────────────
// Initializes the Polymarket CLOB SDK for live order placement.
// Derives API credentials from the private key at boot.
// Only initialized in LIVE mode.

import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { CONFIG } from "./config";
import { logger } from "./logger";

// ─── Module State ──────────────────────────────────────────────────────────

let client: ClobClient | null = null;

// ─── Initialization ────────────────────────────────────────────────────────

export async function initClobClient(): Promise<void> {
  if (CONFIG.mode !== "LIVE") {
    logger.info("clob-client", "Paper mode — CLOB trading client not needed");
    return;
  }

  if (!CONFIG.polyPrivateKey) {
    throw new Error("LIVE mode requires POLY_PRIVATE_KEY env var");
  }
  if (!CONFIG.polyWalletAddress) {
    throw new Error("LIVE mode requires POLY_WALLET_ADDRESS (funder) env var");
  }

  const signer = new Wallet(CONFIG.polyPrivateKey);
  const signerAddress = await signer.getAddress();
  logger.info("clob-client", `Signer address: ${signerAddress}`);
  logger.info("clob-client", `Funder address: ${CONFIG.polyWalletAddress}`);

  // Step 1: Derive API credentials from private key
  // This calls POST /auth/api-key with an EIP-712 signed message
  logger.info("clob-client", "Deriving API credentials...");
  const tempClient = new ClobClient(CONFIG.clobApi, 137, signer);
  const apiCreds = await tempClient.createOrDeriveApiKey();
  logger.info("clob-client", `API key derived: ${apiCreds.key.substring(0, 8)}...`);

  // Step 2: Initialize full L2 trading client
  // Signature type: 0=EOA, 1=POLY_PROXY(Magic/Email), 2=GNOSIS_SAFE
  // Default to 1 (Magic/Email login) per SDK README — most Polymarket accounts use this.
  const sigType = CONFIG.polySignatureType;
  logger.info("clob-client", `Signature type: ${sigType} (0=EOA, 1=MagicLink, 2=GnosisSafe)`);
  client = new ClobClient(
    CONFIG.clobApi,
    137,  // Polygon mainnet
    signer,
    apiCreds,
    sigType,
    CONFIG.polyWalletAddress,
  );

  logger.info("clob-client", "CLOB trading client initialized");
}

// ─── Public API ────────────────────────────────────────────────────────────

export function getClient(): ClobClient {
  if (!client) throw new Error("CLOB client not initialized — is MODE=LIVE?");
  return client;
}

export function isReady(): boolean {
  return client !== null;
}

export { Side, OrderType };
