/**
 * persistence.ts — File I/O for trades and decisions.
 *
 * Layer 1b — Imports config, file-rotation, live-events, types.
 * JSONL append-only storage with dedup-on-load, CSV export, rotation.
 */

import * as fs from 'fs';
import { BotTrade, Decision } from './types';
import { CONFIG, FILE_PREFIX } from './config';
import { checkRotation, type RotationConfig, listArchives as listRotationArchives, readArchive as readRotationArchive } from './file-rotation';
import { liveEventsRotationConfig } from './live-events';

// RFC 4180 CSV escaping
function escapeCsv(field: unknown): string {
  const str = String(field ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ── Rotation Configs ──
const tradesRotationConfig: RotationConfig = {
  jsonlPath: `${CONFIG.dataDir}/${FILE_PREFIX}-trades.jsonl`,
  archiveDir: `${CONFIG.dataDir}/archives`,
  archivePrefix: `${FILE_PREFIX}-trades`,
  maxLines: 70_000,
  maxArchives: 20,
  toCsvRow: (t: BotTrade) => [
    t.id, t.createdAt, t.asset, t.assetLabel, t.side, t.entryPrice, t.size,
    t.shares, t.status, t.pnl ?? '', t.exitPrice ?? '', t.resolvedAt ?? '',
    t.resolutionSource ?? '', t.mode, t.walletAddress,
    t.sizeReason, t.stackEntry, t.contractDuration, t.filterPreset,
    t.latencyMs, t.polyMidAtDecision, t.bookSpread,
    t.title ?? '', t.whaleTxHash ?? '', t.midEdge ?? '',
    t.negRisk ?? false,
  ].map(escapeCsv).join(','),
  csvHeader: 'id,createdAt,asset,assetLabel,side,entryPrice,size,shares,status,pnl,exitPrice,resolvedAt,resolutionSource,mode,wallet,sizeReason,stackEntry,contractDuration,filterPreset,latencyMs,polyMidAtDecision,bookSpread,title,whaleTxHash,midEdge,negRisk',
};

const decisionsRotationConfig: RotationConfig = {
  jsonlPath: `${CONFIG.dataDir}/${FILE_PREFIX}-decisions.jsonl`,
  archiveDir: `${CONFIG.dataDir}/archives`,
  archivePrefix: `${FILE_PREFIX}-decisions`,
  maxLines: 70_000,
  maxArchives: 20,
  toCsvRow: (d: Decision) => [d.timestamp, d.conditionId, d.asset, d.side, d.reason].map(escapeCsv).join(','),
  csvHeader: 'timestamp,conditionId,asset,side,reason',
};

// ── Trade JSONL ──
export function appendTrade(trade: BotTrade): void {
  try {
    fs.appendFileSync(tradesRotationConfig.jsonlPath, JSON.stringify(trade) + '\n');
  } catch (e: any) {
    console.error('[persistence] appendTrade failed:', e.message);
  }
}

export function updateTrade(trade: BotTrade): void {
  // Append updated record — dedup on load keeps last entry per ID
  appendTrade(trade);
}

export function loadTradeHistory(): BotTrade[] {
  const filePath = tradesRotationConfig.jsonlPath;
  if (!fs.existsSync(filePath)) return [];

  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const deduped = new Map<string, BotTrade>();
    for (const line of lines) {
      try {
        const trade = JSON.parse(line) as BotTrade;
        if (trade.id) deduped.set(trade.id, trade);
      } catch {
        // skip malformed lines
      }
    }
    return [...deduped.values()];
  } catch (e: any) {
    console.error('[persistence] loadTradeHistory failed:', e.message);
    return [];
  }
}

// ── Decision JSONL ──
export function appendDecision(d: Decision): void {
  try {
    fs.appendFileSync(decisionsRotationConfig.jsonlPath, JSON.stringify(d) + '\n');
  } catch (e: any) {
    console.error('[persistence] appendDecision failed:', e.message);
  }
}

// ── CSV Export ──
export function getTradesCsv(): string {
  const trades = loadTradeHistory();
  const header = tradesRotationConfig.csvHeader;
  const rows = trades.map(t => tradesRotationConfig.toCsvRow(t));
  return header + '\n' + rows.join('\n');
}

export function getDecisionsCsv(): string {
  const filePath = decisionsRotationConfig.jsonlPath;
  if (!fs.existsSync(filePath)) return decisionsRotationConfig.csvHeader + '\n';

  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const header = decisionsRotationConfig.csvHeader;
    const rows = lines.map(line => {
      try {
        return decisionsRotationConfig.toCsvRow(JSON.parse(line));
      } catch {
        return null;
      }
    }).filter(Boolean);
    return header + '\n' + rows.join('\n');
  } catch (e: any) {
    console.error('[persistence] getDecisionsCsv failed:', e.message);
    return decisionsRotationConfig.csvHeader + '\n';
  }
}

// ── Archives ──
export function listArchives(): { trades: any[]; decisions: any[]; liveEvents: any[] } {
  return {
    trades: listRotationArchives(tradesRotationConfig),
    decisions: listRotationArchives(decisionsRotationConfig),
    liveEvents: listRotationArchives(liveEventsRotationConfig),
  };
}

export function readArchive(filename: string): string | null {
  return readRotationArchive(tradesRotationConfig, filename)
    ?? readRotationArchive(decisionsRotationConfig, filename)
    ?? readRotationArchive(liveEventsRotationConfig, filename);
}

// ── Rotation ──
export function checkAndRotate(): void {
  checkRotation(tradesRotationConfig);
  checkRotation(decisionsRotationConfig);
  checkRotation(liveEventsRotationConfig);
}

// Post-rotation safeguard: re-append all open positions so they survive rotation
export function rewriteOpenPositions(openPositions: readonly BotTrade[]): void {
  for (const pos of openPositions) {
    appendTrade(pos);
  }
}
