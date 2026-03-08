// ─── Layer 2: Pricing Engine ────────────────────────────────────────────────
// Black-Scholes binary option pricing, edgeVsSpot, midEdge.
// Pure functions — no state, no side effects.
// Ported from spy-server.ts (battle-tested).

import { PricePoint } from "./types";

// ─── Standard Normal CDF ────────────────────────────────────────────────────
// Abramowitz & Stegun rational approximation (max error 1.5e-7)

export function normalCDF(x: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 0.5 * (1.0 + sign * y);
}

// ─── Binary Option Fair Value ───────────────────────────────────────────────
// P(up) = N(d2) where d2 = [ln(S/K) - σ²T/2] / (σ√T)
// S = current spot price, K = strike (price at contract window start)
// σ = annualized volatility, T = time to expiry in years

export function computeBinaryFairValue(
  currentPrice: number,
  strikePrice: number,
  secondsRemaining: number,
  annualizedVol: number,
  direction: "UP" | "DOWN"
): number {
  const T = secondsRemaining / (365.25 * 24 * 3600);

  // Near expiry (<1s): outcome is effectively determined
  if (T < 1e-10 || secondsRemaining < 1) {
    const pUp = currentPrice > strikePrice ? 0.99
              : currentPrice < strikePrice ? 0.01
              : 0.50;
    return direction === "UP" ? pUp : 1 - pUp;
  }

  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(currentPrice / strikePrice) - (annualizedVol ** 2 / 2) * T)
             / (annualizedVol * sqrtT);

  let pUp = normalCDF(d2);
  pUp = Math.min(0.99, Math.max(0.01, pUp));  // clamp to [0.01, 0.99]

  return direction === "UP" ? pUp : 1 - pUp;
}

// ─── Edge vs Spot ───────────────────────────────────────────────────────────
// How much our fair value differs from market price.
// Positive = market underpricing the outcome (we have edge).

export function computeEdgeVsSpot(fairValue: number, marketPrice: number): number {
  return fairValue - marketPrice;
}

// ─── Mid Edge ───────────────────────────────────────────────────────────────
// How far below (or above) the book midpoint our entry is.
// Positive = buying below mid (good entry). Negative = above mid.
// Matches spy-server logic: polyMid - price.

export function computeMidEdge(polyMid: number, entryPrice: number): number {
  return polyMid - entryPrice;
}

// ─── Realized Volatility ────────────────────────────────────────────────────
// Rolling annualized volatility from price history.
// Resamples at 5s intervals over a 5-minute lookback window.
// Returns value between 0.20 (floor) and 2.00 (cap).

export function computeRealizedVol(history: PricePoint[], nowMs?: number): number | null {
  const now = nowMs || Date.now();
  const lookbackMs = 300_000;   // 5 minutes
  const sampleMs = 5_000;       // sample every 5 seconds

  // Resample at fixed intervals
  const samples: number[] = [];
  for (let t = now - lookbackMs; t <= now; t += sampleMs) {
    // Find latest price at or before time t
    let best: PricePoint | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].ts <= t) { best = history[i]; break; }
    }
    if (best) samples.push(best.price);
  }

  if (samples.length < 20) return null;  // need ~100s of data

  // Compute log returns
  const logReturns: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] > 0) {
      logReturns.push(Math.log(samples[i] / samples[i - 1]));
    }
  }
  if (logReturns.length < 10) return null;

  // Standard deviation of log returns
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Annualize: periods_per_year = ms_per_year / sampleMs
  const periodsPerYear = (365.25 * 24 * 3600 * 1000) / sampleMs;
  const annualized = stdDev * Math.sqrt(periodsPerYear);

  // Floor 20%, cap 200%
  return Math.min(2.0, Math.max(0.20, annualized));
}
