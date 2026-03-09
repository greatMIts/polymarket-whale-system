// ─── ROTHSTEIN V2 Logger ──────────────────────────────────────────────────────
// Simple logger with timestamps, levels, and category tags.
// All output goes to console — no file I/O, no dependencies.

type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

const LEVEL_PRIORITY: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const LEVEL_COLOR: Record<Level, string> = {
  DEBUG: "\x1b[90m",  // gray
  INFO: "\x1b[36m",   // cyan
  WARN: "\x1b[33m",   // yellow
  ERROR: "\x1b[31m",  // red
};

const RESET = "\x1b[0m";

let minLevel: Level = "INFO";

/** Set the minimum log level. Messages below this level are suppressed. */
export function setLevel(level: Level): void {
  minLevel = level;
}

function formatTs(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function emit(level: Level, category: string, msg: string, data?: unknown): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const ts = formatTs();
  const color = LEVEL_COLOR[level];
  const prefix = `${color}[${ts}] ${level.padEnd(5)}${RESET} [${category}]`;

  if (data !== undefined) {
    const serialized = typeof data === "object" ? JSON.stringify(data) : String(data);
    console.log(`${prefix} ${msg} ${serialized}`);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

/** Create a category-scoped logger. */
export function createLogger(category: string) {
  return {
    info: (msg: string, data?: unknown) => emit("INFO", category, msg, data),
    warn: (msg: string, data?: unknown) => emit("WARN", category, msg, data),
    error: (msg: string, data?: unknown) => emit("ERROR", category, msg, data),
    debug: (msg: string, data?: unknown) => emit("DEBUG", category, msg, data),
  };
}
