import type { BehavioralFeatures, MazeProfile } from '@cerno/core'

interface FeatureBaseline {
  mean: number
  std: number
  weight: number
}

type FeatureKey = keyof Pick<
  BehavioralFeatures,
  'velocity_std' | 'path_efficiency' | 'pause_count' | 'movement_onset_ms' | 'jerk_std' | 'angular_velocity_entropy'
>

/**
 * Static baselines for motor-control features (maze-independent).
 * These measure how you move, not where you move.
 */
const MOTOR_BASELINES: Pick<Record<FeatureKey, FeatureBaseline>,
  'velocity_std' | 'movement_onset_ms' | 'jerk_std'
> = {
  velocity_std:      { mean: 0.008,  std: 0.003,   weight: 1.0 },
  movement_onset_ms: { mean: 800,    std: 400,     weight: 0.6 },
  jerk_std:          { mean: 0.0001, std: 0.00005, weight: 1.5 },
}

/**
 * Fallback baselines when no maze profile is available.
 * From published mouse-movement research. Inaccurate for maze-constrained
 * interaction but better than nothing.
 */
const FALLBACK_BASELINES: Record<FeatureKey, FeatureBaseline> = {
  ...MOTOR_BASELINES,
  path_efficiency:          { mean: 0.35, std: 0.08, weight: 1.0 },
  pause_count:              { mean: 3.0,  std: 1.5,  weight: 0.8 },
  angular_velocity_entropy: { mean: 3.5,  std: 0.5,  weight: 1.5 },
}

/**
 * Compute maze-relative baselines for topology-dependent features.
 * A human solving THIS maze has different expected behavior than
 * a human moving freely. The BFS solution, decision points, and
 * turn count tell us what to expect.
 */
function computeBaselines(profile?: MazeProfile): Record<FeatureKey, FeatureBaseline> {
  if (!profile) return FALLBACK_BASELINES

  return {
    ...MOTOR_BASELINES,
    path_efficiency: {
      // Humans trace ~85-95% as efficiently as the BFS optimal path.
      // Micro-corrections, slight overshoots, and exploring dead ends reduce efficiency.
      mean: profile.optimalEfficiency * 0.9,
      std: profile.optimalEfficiency * 0.15,
      weight: 1.0,
    },
    pause_count: {
      // Humans hesitate at ~60% of decision points (forks in the maze).
      // More forks = more expected pauses.
      mean: Math.max(profile.decisionPointCount * 0.6, 1),
      std: Math.max(profile.decisionPointCount * 0.3, 0.5),
      weight: 0.8,
    },
    angular_velocity_entropy: {
      // More turns in the solution = more direction changes = higher entropy.
      // Capped at 4.0 bits (max for 16-bin Shannon entropy).
      mean: Math.min(1.0 + profile.turnCount * 0.15, 4.0),
      std: 0.5,
      weight: 1.5,
    },
  }
}

const FEATURE_KEYS = Object.keys(FALLBACK_BASELINES) as FeatureKey[]

/**
 * Deterministic behavioral scoring. No ML inference.
 *
 * For each feature: compute z-score against baselines (maze-relative
 * when a MazeProfile is provided, static fallbacks otherwise),
 * convert to a 0-1 score via sigmoid-like transform, then
 * weighted average across all features.
 *
 * Additional penalties for low sample count or suspiciously fast completion.
 */
export function scoreBehavior(features: BehavioralFeatures, profile?: MazeProfile): number {
  const baselines = computeBaselines(profile)
  let weightedSum = 0
  let totalWeight = 0

  for (const key of FEATURE_KEYS) {
    const baseline = baselines[key]
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
