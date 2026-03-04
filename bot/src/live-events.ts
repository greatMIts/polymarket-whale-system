/**
 * live-events.ts — Audit trail for live money trading events.
 *
 * File: {PREFIX}_live_events.jsonl — rotated at 70K lines like other CSVs.
 *
 * Event types:
 *   CLOB_INITIALIZED — on boot when CLOB client is ready
 *   MODE_SWITCH      — when user toggles PAPER <-> LIVE
 *   ORDER_PLACED     — successful order submission
 *   ORDER_FAILED     — order error (includes error message)
 *   ORDER_SKIPPED    — order skipped (balance, FOK, max entries)
 *   AUTO_FALLBACK    — automatic switch to PAPER (includes reason)
 */

import * as fs from "fs";
import { CONFIG, FILE_PREFIX } from "./config";
import { trackAppend, type RotationConfig } from "./file-rotation";

const liveEventsPath = `${CONFIG.dataDir}/${FILE_PREFIX}-live-events.jsonl`;

// CSV header for live events archive
const LIVE_EVENTS_CSV_HEADER = "ts,event,orderID,orderType,tokenID,conditionId,side," +
  "requestedPrice,requestedSize,whalePrice,whaleTxHash,slippage," +
  "reason,error,from,to,signerAddress,funderAddress,signatureType," +
  "existingCount,existingUSD,maxEntries";

function liveEventToCsvRow(d: any): string {
  return [
    d.ts || "",
    d.event || "",
    d.orderID || "",
    d.orderType || "",
    d.tokenID || "",
    d.conditionId || "",
    d.side || "",
    d.requestedPrice !== null && d.requestedPrice !== undefined ? d.requestedPrice : "",
    d.requestedSize !== null && d.requestedSize !== undefined ? d.requestedSize : "",
    d.whalePrice !== null && d.whalePrice !== undefined ? d.whalePrice : "",
    d.whaleTxHash || "",
    d.slippage !== null && d.slippage !== undefined ? d.slippage : "",
    d.reason || "",
    d.error ? `"${String(d.error).replace(/"/g, '""')}"` : "",
    d.from || "",
    d.to || "",
    d.signerAddress || "",
    d.funderAddress || "",
    d.signatureType !== null && d.signatureType !== undefined ? d.signatureType : "",
    d.existingCount !== null && d.existingCount !== undefined ? d.existingCount : "",
    d.existingUSD !== null && d.existingUSD !== undefined ? d.existingUSD : "",
    d.maxEntries !== null && d.maxEntries !== undefined ? d.maxEntries : "",
  ].join(",");
}

export const liveEventsRotationConfig: RotationConfig = {
  jsonlPath: liveEventsPath,
  archiveDir: CONFIG.archiveDir,
  archivePrefix: `${FILE_PREFIX}_live_events`,
  maxLines: CONFIG.rotationMaxLines,
  maxArchives: CONFIG.rotationMaxArchives,
  toCsvRow: liveEventToCsvRow,
  csvHeader: LIVE_EVENTS_CSV_HEADER,
  onRotate: (archivePath, lineCount) => {
    const name = archivePath.split(/[/\\]/).pop();
    console.log(`[rotation] live_events.jsonl → ${name} (${lineCount.toLocaleString()} lines)`);
  },
};

export function logLiveEvent(data: Record<string, any>) {
  const entry: Record<string, any> = { ts: new Date().toISOString(), ...data };
  try {
    fs.appendFileSync(liveEventsPath, JSON.stringify(entry) + "\n");
    trackAppend(liveEventsRotationConfig);
  } catch (e: any) {
    console.error("[LIVE EVENT] Failed to write:", e.message);
  }
  console.log("[LIVE EVENT]", entry.event, JSON.stringify(entry));
}
