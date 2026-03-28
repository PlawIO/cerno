import type { BehavioralFeatures } from '@cerno/core'

interface FeatureBaseline {
  mean: number
  std: number
  weight: number
}

const BASELINES: Record<keyof Pick<
  BehavioralFeatures,
  'velocity_std' | 'path_efficiency' | 'pause_count' | 'movement_onset_ms' | 'jerk_std' | 'angular_velocity_entropy'
>, FeatureBaseline> = {
  velocity_std:             { mean: 0.008,  std: 0.003,   weight: 1.0 },
  path_efficiency:          { mean: 0.35,   std: 0.08,    weight: 1.0 },
  pause_count:              { mean: 3.0,    std: 1.5,     weight: 0.8 },
  movement_onset_ms:        { mean: 800,    std: 400,     weight: 0.6 },
  jerk_std:                 { mean: 0.0001, std: 0.00005, weight: 1.5 },
  angular_velocity_entropy: { mean: 3.5,    std: 0.5,     weight: 1.5 },
}

const FEATURE_KEYS = Object.keys(BASELINES) as (keyof typeof BASELINES)[]

/**
 * Deterministic behavioral scoring. No ML inference.
 *
 * For each feature: compute z-score against human baselines,
 * convert to a 0-1 score via sigmoid-like transform, then
 * weighted average across all features.
 *
 * Additional penalties for low sample count or suspiciously fast completion.
 */
export function scoreBehavior(features: BehavioralFeatures): number {
  let weightedSum = 0
  let totalWeight = 0

  for (const key of FEATURE_KEYS) {
    const baseline = BASELINES[key]
    const value = features[key]

    // Guard against division by zero: if baseline std is 0, treat as perfect match
    const zScore = baseline.std > 0
      ? Math.abs(value - baseline.mean) / baseline.std
      : 0

    // Sigmoid-like: 1.0 = perfect human, approaches 0 for extreme deviation
    const featureScore = 1 / (1 + zScore)

    weightedSum += featureScore * baseline.weight
    totalWeight += baseline.weight
  }

  // Guard against zero total weight (shouldn't happen with constants, but be safe)
  let score = totalWeight > 0 ? weightedSum / totalWeight : 0

  // Penalty: too few data points is suspicious
  if (features.sample_count < 20) {
    const sampleRatio = Math.max(features.sample_count, 0) / 20
    score *= sampleRatio
  }

  // Penalty: completing too fast is suspicious
  if (features.total_duration_ms < 2000) {
    const durationRatio = Math.max(features.total_duration_ms, 0) / 2000
    score *= durationRatio
  }

  // NaN guard: if any feature produced NaN, reject (score 0)
  if (Number.isNaN(score)) return 0

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, score))
}
