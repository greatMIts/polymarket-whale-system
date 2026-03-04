/**
 * file-rotation.ts — JSONL file rotation with CSV archival.
 *
 * When a JSONL file exceeds maxLines, it:
 * 1. Converts to CSV using a provided formatter
 * 2. Saves as archive_{YYYYMMDD_HHMMSS}.csv in the archives dir
 * 3. Clears the JSONL file
 * 4. Keeps only the last maxArchives rotated files
 */

import * as fs from "fs";
import * as path from "path";

export interface RotationConfig {
  /** Path to the JSONL file being rotated */
  jsonlPath: string;
  /** Directory to store rotated CSV archives */
  archiveDir: string;
  /** Prefix for archive filenames (e.g. "decisions" → "decisions_20260228_103000.csv") */
  archivePrefix: string;
  /** Max lines before rotation triggers */
  maxLines: number;
  /** Max archived files to keep (oldest deleted first) */
  maxArchives: number;
  /** Converts a parsed JSON line to a CSV row string */
  toCsvRow: (obj: any) => string;
  /** CSV header line */
  csvHeader: string;
  /** Optional callback when rotation happens */
  onRotate?: (archivePath: string, lineCount: number) => void;
}

/** Track append counts between rotation checks */
const appendCounts = new Map<string, number>();

/**
 * Count lines in a file without reading the whole thing into memory.
 */
function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.trim()) return 0;
    return content.trim().split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Generate timestamp string for archive filename: YYYYMMDD_HHMMSS
 */
function archiveTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Get sorted list of existing archives for a given prefix.
 */
function getArchiveFiles(archiveDir: string, prefix: string): string[] {
  if (!fs.existsSync(archiveDir)) return [];
  return fs.readdirSync(archiveDir)
    .filter(f => f.startsWith(prefix + "_") && f.endsWith(".csv"))
    .sort(); // lexicographic = chronological with YYYYMMDD format
}

/**
 * Perform rotation: convert JSONL → CSV archive, clear JSONL, prune old archives.
 */
function rotate(config: RotationConfig): boolean {
  const { jsonlPath, archiveDir, archivePrefix, maxArchives, toCsvRow, csvHeader, onRotate } = config;

  if (!fs.existsSync(jsonlPath)) return false;

  const content = fs.readFileSync(jsonlPath, "utf-8").trim();
  if (!content) return false;

  const lines = content.split("\n").filter(Boolean);
  if (lines.length < config.maxLines) return false;

  // Ensure archive dir exists
  fs.mkdirSync(archiveDir, { recursive: true });

  // Convert to CSV
  const csvRows: string[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      csvRows.push(toCsvRow(obj));
    } catch {}
  }

  const archiveName = `${archivePrefix}_${archiveTimestamp()}.csv`;
  const archivePath = path.join(archiveDir, archiveName);
  fs.writeFileSync(archivePath, csvHeader + "\n" + csvRows.join("\n") + "\n");

  // Clear the JSONL file
  fs.writeFileSync(jsonlPath, "");

  // Reset append counter
  appendCounts.set(jsonlPath, 0);

  // Prune old archives (keep last maxArchives)
  const archives = getArchiveFiles(archiveDir, archivePrefix);
  if (archives.length > maxArchives) {
    const toDelete = archives.slice(0, archives.length - maxArchives);
    for (const f of toDelete) {
      try { fs.unlinkSync(path.join(archiveDir, f)); } catch {}
    }
  }

  if (onRotate) {
    onRotate(archivePath, lines.length);
  }

  console.log(`[rotation] ${path.basename(jsonlPath)} → ${archiveName} (${lines.length} lines)`);
  return true;
}

/**
 * Check if rotation is needed and perform it if so.
 */
export function checkRotation(config: RotationConfig): boolean {
  return rotate(config);
}

/**
 * Track an append and trigger rotation check every 1000 appends.
 */
export function trackAppend(config: RotationConfig): void {
  const count = (appendCounts.get(config.jsonlPath) || 0) + 1;
  appendCounts.set(config.jsonlPath, count);
  if (count >= 1000) {
    rotate(config);
  }
}

/**
 * Start periodic rotation checks (every intervalMs).
 * Also runs an immediate check on startup.
 */
export function startRotationTimer(config: RotationConfig, intervalMs: number = 60_000): void {
  // Immediate check on startup
  rotate(config);
  // Periodic check
  setInterval(() => rotate(config), intervalMs);
}

/**
 * List all archive files for a config, with metadata.
 */
export function listArchives(config: RotationConfig): { name: string; path: string; sizeBytes: number; created: string }[] {
  const files = getArchiveFiles(config.archiveDir, config.archivePrefix);
  return files.map(f => {
    const fullPath = path.join(config.archiveDir, f);
    const stat = fs.statSync(fullPath);
    return {
      name: f,
      path: fullPath,
      sizeBytes: stat.size,
      created: stat.mtime.toISOString(),
    };
  });
}

/**
 * Read an archive file's contents (for download endpoint).
 */
export function readArchive(config: RotationConfig, filename: string): string | null {
  // Sanitize filename to prevent directory traversal
  const safeName = path.basename(filename);
  if (!safeName.startsWith(config.archivePrefix + "_") || !safeName.endsWith(".csv")) {
    return null;
  }
  const fullPath = path.join(config.archiveDir, safeName);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, "utf-8");
}
