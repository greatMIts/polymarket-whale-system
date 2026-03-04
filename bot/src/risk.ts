/**
 * risk.ts — Risk Gates + Session Loss Tracking
 *
 * Layer 0b — Imports only types.
 * Pure risk checks with proposedSize parameter + session loss accumulator.
 */

import { BotSettings, BotTrade } from './types';

let sessionLoss = 0;
let hourlyLosses: { ts: number; amount: number }[] = [];

export function recordLoss(amount: number) {
  sessionLoss += amount;
  hourlyLosses.push({ ts: Date.now(), amount });
}

export function resetSessionLosses() {
  sessionLoss = 0;
  hourlyLosses = [];
}

export function getSessionLoss(): number { return sessionLoss; }

export function pruneHourlyLosses(): void {
  const cutoff = Date.now() - 3_600_000;
  let firstValid = 0;
  while (firstValid < hourlyLosses.length && hourlyLosses[firstValid].ts <= cutoff) {
    firstValid++;
  }
  if (firstValid > 0) hourlyLosses.splice(0, firstValid);
}

export function getHourlyLoss(): number {
  let sum = 0;
  for (const entry of hourlyLosses) sum += entry.amount;
  return sum;
}

export function checkRisk(
  s: BotSettings,
  open: readonly BotTrade[],
  currentExposure: number,
  proposedSize: number,
): { pass: boolean; reason?: string } {

  if (open.length >= s.maxOpenPositions)
    return { pass: false, reason: 'MAX_POSITIONS' };

  if (currentExposure + proposedSize > s.maxExposureUSD)
    return { pass: false, reason: 'MAX_EXPOSURE' };

  if (getHourlyLoss() >= s.maxLossPerHour)
    return { pass: false, reason: 'HOURLY_LOSS' };

  if (sessionLoss >= s.maxLossPerSession)
    return { pass: false, reason: 'SESSION_LOSS' };

  return { pass: true };
}
