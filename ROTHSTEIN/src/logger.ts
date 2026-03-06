// ─── Layer 0: Structured Logger ─────────────────────────────────────────────
// Consistent logging with timestamps, module tags, and structured events.
// Every log line is parseable for post-session analysis.

const BOOT_TIME = Date.now();

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG" | "EVENT";

function formatTs(): string {
  return new Date().toISOString();
}

function formatUptime(): string {
  const secs = Math.floor((Date.now() - BOOT_TIME) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
}

function log(level: LogLevel, module: string, message: string, data?: Record<string, any>): void {
  const ts = formatTs();
  const up = formatUptime();
  const prefix = `[${ts}] [${up}] [${level}] [${module}]`;
  const line = data
    ? `${prefix} ${message} ${JSON.stringify(data)}`
    : `${prefix} ${message}`;

  if (level === "ERROR") {
    console.error(line);
  } else if (level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const logger = {
  info: (module: string, msg: string, data?: Record<string, any>) =>
    log("INFO", module, msg, data),

  warn: (module: string, msg: string, data?: Record<string, any>) =>
    log("WARN", module, msg, data),

  error: (module: string, msg: string, data?: Record<string, any>) =>
    log("ERROR", module, msg, data),

  debug: (module: string, msg: string, data?: Record<string, any>) =>
    log("DEBUG", module, msg, data),

  // Structured events for important state changes
  event: (module: string, eventName: string, data?: Record<string, any>) =>
    log("EVENT", module, eventName, data),

  // Special: trade decision log (always logged, regardless of level)
  decision: (data: Record<string, any>) =>
    log("EVENT", "scorer", "DECISION", data),

  // Special: trade execution log
  trade: (data: Record<string, any>) =>
    log("EVENT", "trader", "TRADE", data),

  // Special: position resolution
  resolution: (data: Record<string, any>) =>
    log("EVENT", "positions", "RESOLVED", data),

  // Boot banner
  banner: () => {
    console.log("");
    console.log("  ╔══════════════════════════════════════════════════╗");
    console.log("  ║                                                  ║");
    console.log("  ║   R O T H S T E I N                              ║");
    console.log("  ║   Independent Prediction Engine                   ║");
    console.log("  ║   Polymarket 5-min BTC/ETH Contracts              ║");
    console.log("  ║                                                  ║");
    console.log("  ║   \"I never gamble. I calculate.\"                  ║");
    console.log("  ║                                                  ║");
    console.log("  ╚══════════════════════════════════════════════════╝");
    console.log("");
  },

  getBootTime: () => BOOT_TIME,
};
