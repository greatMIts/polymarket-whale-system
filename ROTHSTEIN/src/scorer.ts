// ─── Layer 2: Scoring Engine ────────────────────────────────────────────────
// Converts a FeatureVector into a 0-100 confidence score.
// Pure function — no state, no side effects.
// All thresholds sourced from config.ts.

import { FeatureVector, ScoreComponents, ScoringResult, ScoreRecommendation } from "./types";
import { CONFIG, getRuntime } from "./config";

// ─── Score Component: EdgeVsSpot (0-30 points) ─────────────────────────────

function scoreEdge(edgeVsSpot: number): number {
  if (edgeVsSpot >= 0.15 && edgeVsSpot <= 0.25) return 30;  // sweet spot
  if (edgeVsSpot >= 0.25 && edgeVsSpot <= 0.30) return 25;
  if (edgeVsSpot >= 0.10 && edgeVsSpot < 0.15) return 20;
  if (edgeVsSpot > 0.30) return 15;                          // overshoot risk
  if (edgeVsSpot >= 0.05 && edgeVsSpot < 0.10) return 10;
  return 0;
}

// ─── Score Component: MidEdge (0-20 points) ─────────────────────────────────

function scoreMidEdge(midEdge: number): number {
  if (midEdge < -0.20) return 20;     // extreme bargain entry
  if (midEdge < -0.10) return 15;     // good entry
  if (midEdge < 0) return 10;         // acceptable
  if (midEdge < 0.05) return 5;       // neutral
  return 0;                            // above mid, no advantage
}

// ─── Score Component: Momentum Alignment (0-15 points) ──────────────────────

function scoreMomentum(momentumAligned: boolean, delta30s: number): number {
  if (momentumAligned) return 15;      // +9.5% WR lift from data
  if (Math.abs(delta30s) < 0.005) return 5;  // flat, neutral
  return 0;                            // opposing direction
}

// ─── Score Component: Seconds Remaining (0-10 points) ───────────────────────

function scoreTiming(secsRemaining: number): number {
  if (secsRemaining >= 240 && secsRemaining <= 270) return 10;  // best bucket
  if (secsRemaining >= 270 && secsRemaining <= 300) return 8;
  if (secsRemaining >= 210 && secsRemaining < 240) return 8;
  if (secsRemaining >= 180 && secsRemaining < 210) return 6;
  if (secsRemaining >= 120 && secsRemaining < 180) return 4;
  if (secsRemaining >= 90 && secsRemaining < 120) return 2;
  return 0;
}

// ─── Score Component: Market Activity / Volatility (0-10 points) ────────────

function scoreActivity(delta30s: number): number {
  const abs = Math.abs(delta30s);
  if (abs > 0.10) return 10;    // active market, ~54% WR, highest PnL
  if (abs > 0.05) return 7;     // moderate activity
  if (abs > 0.02) return 3;     // sluggish
  return 0;                      // dead market
}

// ─── Score Component: Whale Bonus (0-15 points) ────────────────────────────

function scoreWhale(
  concurrentWhales: number,
  bestWalletTier: number,
  whaleMaxSize: number,
  whaleAgreement: boolean
): number {
  if (concurrentWhales === 0) return 0;

  let score = 0;

  // Tier 1 wallet with conviction ($20+)
  if (bestWalletTier === 1 && whaleMaxSize >= 20) score = 15;
  else if (bestWalletTier === 1) score = 10;
  // Any wallet with high conviction ($50+)
  else if (whaleMaxSize >= 50) score = 12;
  // Tier 2 wallet with conviction
  else if (bestWalletTier === 2 && whaleMaxSize >= 20) score = 8;
  // Multiple whales agreeing
  else if (concurrentWhales >= 2 && whaleAgreement) score = 7;
  // Single whale, low conviction
  else score = 3;

  return Math.min(15, score);
}

// ─── Score Component: Hour of Day Bonus (-5 to +5 points) ──────────────────

function scoreHour(hourOfDay: number): number {
  return CONFIG.hourScoring[hourOfDay] || 0;
}

// ─── Recommendation from Score ──────────────────────────────────────────────

function getRecommendation(score: number): ScoreRecommendation {
  if (score >= 90) return "MAXIMUM";
  if (score >= 80) return "HIGH";
  if (score >= 70) return "ELEVATED";
  if (score >= 60) return "STANDARD";
  if (score >= 50) return "LOG_ONLY";
  return "SKIP";
}

// ─── Suggested Bet Size ─────────────────────────────────────────────────────

function getSuggestedSize(score: number): number {
  const runtime = getRuntime();
  const multiplier = runtime.sizingMultiplier;

  for (const tier of CONFIG.sizingTiers) {
    if (score >= tier.minScore) {
      return Math.round(tier.size * multiplier * 100) / 100;
    }
  }
  return 0;
}

// ─── Main Scoring Function ──────────────────────────────────────────────────

export function computeScore(features: FeatureVector): ScoringResult {
  const components: ScoreComponents = {
    edgeScore: scoreEdge(features.edgeVsSpot),
    midEdgeScore: scoreMidEdge(features.midEdge),
    momentumScore: scoreMomentum(features.momentumAligned, features.delta30s),
    timingScore: scoreTiming(features.secsRemaining),
    activityScore: scoreActivity(features.delta30s),
    whaleBonus: scoreWhale(
      features.concurrentWhales,
      features.bestWalletTier,
      features.whaleMaxSize,
      features.whaleAgreement
    ),
    hourBonus: scoreHour(features.hourOfDay),
  };

  const totalScore = Math.max(0, Math.min(100,
    components.edgeScore +
    components.midEdgeScore +
    components.momentumScore +
    components.timingScore +
    components.activityScore +
    components.whaleBonus +
    components.hourBonus
  ));

  return {
    totalScore,
    components,
    recommendation: getRecommendation(totalScore),
    suggestedSize: getSuggestedSize(totalScore),
  };
}
