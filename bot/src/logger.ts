/**
 * logger.ts — Typed event log with fixed-size buffer + monotonic IDs.
 *
 * Layer 0a — Zero imports from bot modules. Standalone utility.
 */

type EventType = 'info' | 'trade' | 'risk' | 'resolution' | 'system';

interface LogEntry { id: number; ts: number; msg: string; type: EventType; }
interface VolSnapshot { openCount: number; exposure: number; hourlyTrades: number; }

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];
let nextId = 1;

export function logEvent(msg: string, type: EventType = 'info') {
  buffer.push({ id: nextId++, ts: Date.now(), msg, type });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function getEventLog(): readonly LogEntry[] { return buffer; }

export function logVolStats(snap: VolSnapshot) {
  logEvent(
    `STATS: ${snap.openCount} open, $${snap.exposure.toFixed(0)} exposed, ${snap.hourlyTrades} trades/hr`,
    'info'
  );
}

export function logHeartbeat() {
  const mem = process.memoryUsage();
  logEvent(
    `HEARTBEAT: up ${Math.floor(process.uptime() / 60)}m, heap ${Math.floor(mem.heapUsed / 1e6)}MB, buf ${buffer.length}`,
    'system'
  );
}
