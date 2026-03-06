// ─── Layer 1: Persistence ───────────────────────────────────────────────────
// JSONL append-only logging. CSV rotation. File I/O.
// Every decision and position change is persisted to survive crashes.

import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";
import { logger } from "./logger";

// ─── Ensure data directory exists ───────────────────────────────────────────

export function ensureDataDir(): void {
  const dir = CONFIG.dataDir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info("persistence", `Created data dir: ${dir}`);
  }
  const archiveDir = path.join(dir, "archives");
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }
}

// ─── JSONL Append ───────────────────────────────────────────────────────────

const lineCounters = new Map<string, number>();

export function appendJsonl(filename: string, data: Record<string, any>): void {
  const filePath = path.resolve(CONFIG.dataDir, filename);
  const line = JSON.stringify(data) + "\n";

  try {
    fs.appendFileSync(filePath, line);
    const count = (lineCounters.get(filename) || 0) + 1;
    lineCounters.set(filename, count);

    // Rotate if needed
    if (count >= CONFIG.rotationMaxLines) {
      rotateFile(filename);
      lineCounters.set(filename, 0);
    }
  } catch (e: any) {
    logger.error("persistence", `Failed to write ${filename}: ${e.message}`);
  }
}

// ─── File Rotation ──────────────────────────────────────────────────────────

function rotateFile(filename: string): void {
  const filePath = path.resolve(CONFIG.dataDir, filename);
  const archiveDir = path.join(CONFIG.dataDir, "archives");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const archiveName = `${base}_${ts}${ext}`;
  const archivePath = path.join(archiveDir, archiveName);

  try {
    fs.renameSync(filePath, archivePath);
    logger.info("persistence", `Rotated ${filename} → archives/${archiveName}`);

    // Cleanup old archives (keep max N)
    const archives = fs.readdirSync(archiveDir)
      .filter(f => f.startsWith(base))
      .sort()
      .reverse();

    for (let i = CONFIG.maxArchives; i < archives.length; i++) {
      fs.unlinkSync(path.join(archiveDir, archives[i]));
    }
  } catch (e: any) {
    logger.error("persistence", `Rotation failed for ${filename}: ${e.message}`);
  }
}

// ─── Read JSONL (for crash recovery) ────────────────────────────────────────

export function readJsonl<T>(filename: string): T[] {
  const filePath = path.resolve(CONFIG.dataDir, filename);
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(l => l.trim());
    return lines.map(l => JSON.parse(l) as T);
  } catch (e: any) {
    logger.error("persistence", `Failed to read ${filename}: ${e.message}`);
    return [];
  }
}

// ─── CSV Export ─────────────────────────────────────────────────────────────

export function exportCsv(data: Record<string, any>[], filename: string): string {
  if (data.length === 0) return "";

  const headers = Object.keys(data[0]);
  const lines = [headers.join(",")];

  for (const row of data) {
    const values = headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined) return "";
      if (typeof v === "string" && (v.includes(",") || v.includes('"'))) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      if (typeof v === "object") return `"${JSON.stringify(v).replace(/"/g, '""')}"`;
      return String(v);
    });
    lines.push(values.join(","));
  }

  const content = lines.join("\n");
  const filePath = path.resolve(CONFIG.dataDir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}
