import type { BehavioralFeatures, InputMode, MazeProfile } from '@cernosh/core'
import type { ScoringConfig, FeatureBaseline } from './types.js'
import { GAUSSIAN_K, EXTREME_OUTLIER_Z, ANOMALY_PENALTY_PER, MIN_SAMPLE_COUNT, MIN_DURATION_MS, PATH_EFFICIENCY_MEAN_RATIO, PATH_EFFICIENCY_STD_RATIO, PAUSE_PER_DECISION_POINT, PAUSE_COUNT_MIN_MEAN, PAUSE_STD_PER_DECISION_POINT, PAUSE_COUNT_MIN_STD, ANGULAR_ENTROPY_BASE, ANGULAR_ENTROPY_PER_TURN, ANGULAR_ENTROPY_MAX } from './scoring-constants.js'

type FeatureKey = keyof Pick<
  BehavioralFeatures,
  'velocity_std' | 'path_efficiency' | 'pause_count' | 'movement_onset_ms' | 'jerk_std' | 'angular_velocity_entropy' | 'timing_cv'
>

/**
 * Static baselines for motor-control features (maze-independent).
 * These measure how you move, not where you move.
 *
 * Calibrated for maze-grid-normalized coordinates (after renormalization).
 * In this space, one cell = 1/mazeWidth normalized units. Human maze solvers
 * move in discrete cell-to-cell bursts with pauses between, producing
 * velocity_std ~0.0003-0.0005 and very small jerk_std.
 */
const MOUSE_MOTOR_BASELINES: Pick<Record<FeatureKey, FeatureBaseline>,
  'velocity_std' | 'movement_onset_ms' | 'jerk_std' | 'timing_cv'
> = {
  velocity_std:      { mean: 0.0004, std: 0.0003,  weight: 1.0 },
  movement_onset_ms: { mean: 1200,   std: 600,     weight: 0.6 },
  jerk_std:          { mean: 5e-7,   std: 5e-7,    weight: 1.0 },
  // Human inter-event timing follows log-normal (CV ~0.3-0.7).
  // Constant-speed bots produce CV ~0; uniform-random bots ~0.577.
  // Widened std to avoid false rejections on real desktop users.
  timing_cv:         { mean: 0.5,    std: 0.3,     weight: 0.8 },
}

/**
 * Touch-specific motor baselines (Phase 2).
 *
 * Touch input has fundamentally different kinematics than mouse:
 * - Higher velocity variance (finger is less precise than mouse)
 * - Shorter movement onset (direct touch vs. indirect cursor)
 * - More jerk (finger lifts/drops vs. continuous cursor motion)
 * - Higher timing CV (touch events fire at screen refresh rate, not pointer poll rate)
 */
const TOUCH_MOTOR_BASELINES: Pick<Record<FeatureKey, FeatureBaseline>,
  'velocity_std' | 'movement_onset_ms' | 'jerk_std' | 'timing_cv'
> = {
  velocity_std:      { mean: 0.0006, std: 0.0005,  weight: 1.0 },
  movement_onset_ms: { mean: 500,    std: 300,     weight: 0.6 },
  jerk_std:          { mean: 8e-7,   std: 6e-7,    weight: 1.0 },
  // Touch timing CV is wildly variable across devices and OS touch stacks.
  // Real mobile users produce timing_cv from 0.3 to 2.5+. Old std=0.25
  // caused z=7.5 instant-rejection on legitimate mobile users.
  timing_cv:         { mean: 0.8,    std: 0.8,     weight: 0.6 },
}

/**
 * Keyboard baselines. Arrow-key navigation produces discrete,
 * cell-to-cell jumps with consistent timing between key presses.
 */
const KEYBOARD_MOTOR_BASELINES: Pick<Record<FeatureKey, FeatureBaseline>,
  'velocity_std' | 'movement_onset_ms' | 'jerk_std' | 'timing_cv'
> = {
  velocity_std:      { mean: 0.001,  std: 0.0008,  weight: 0.6 },
  movement_onset_ms: { mean: 600,    std: 300,     weight: 0.6 },
  jerk_std:          { mean: 1e-6,   std: 1e-6,    weight: 0.6 },
  timing_cv:         { mean: 0.4,    std: 0.2,     weight: 1.0 },
}

function getMotorBaselines(inputType?: InputMode, scoringConfig?: ScoringConfig) {
  let base: Record<string, FeatureBaseline>
  let configKey: 'mouse' | 'touch' | 'keyboard'
  switch (inputType) {
    case 'touch':
      base = { ...TOUCH_MOTOR_BASELINES }
      configKey = 'touch'
      break
    case 'keyboard':
      base = { ...KEYBOARD_MOTOR_BASELINES }
      configKey = 'keyboard'
      break
    default:
      base = { ...MOUSE_MOTOR_BASELINES }
      configKey = 'mouse'
      break
  }
  const overrides = scoringConfig?.motorBaselines?.[configKey]
  if (overrides) {
    for (const [key, val] of Object.entries(overrides)) {
      if (val) base[key] = val
    }
  }
  return base as Record<FeatureKey, FeatureBaseline>
}

/**
 * Fallback baselines when no maze profile is available.
 * From published mouse-movement research. Inaccurate for maze-constrained
 * interaction but better than nothing.
 */
const FALLBACK_BASELINES: Record<FeatureKey, FeatureBaseline> = {
  ...MOUSE_MOTOR_BASELINES,
  path_efficiency:          { mean: 0.35, std: 0.08, weight: 1.0 },
  pause_count:              { mean: 5.0,  std: 2.5,  weight: 0.8 },
  angular_velocity_entropy: { mean: 1.5,  std: 0.5,  weight: 1.5 },
  // timing_cv inherited from MOTOR_BASELINES (maze-independent feature)
}

/**
 * Compute maze-relative baselines for topology-dependent features.
 * A human solving THIS maze has different expected behavior than
 * a human moving freely. The BFS solution, decision points, and
 * turn count tell us what to expect.
 */
function computeBaselines(profile?: MazeProfile, inputType?: InputMode, scoringConfig?: ScoringConfig): Record<FeatureKey, FeatureBaseline> {
  const motorBaselines = getMotorBaselines(inputType, scoringConfig)
  if (!profile) {
    return { ...FALLBACK_BASELINES, ...motorBaselines }
  }

  const mr = scoringConfig?.mazeRelative
  return {
    ...motorBaselines,
    path_efficiency: {
      mean: profile.optimalEfficiency * (mr?.pathEfficiencyMeanRatio ?? PATH_EFFICIENCY_MEAN_RATIO),
      std: profile.optimalEfficiency * (mr?.pathEfficiencyStdRatio ?? PATH_EFFICIENCY_STD_RATIO),
      weight: 1.0,
    },
    pause_count: {
      mean: Math.max(profile.decisionPointCount * (mr?.pausePerDecisionPoint ?? PAUSE_PER_DECISION_POINT), PAUSE_COUNT_MIN_MEAN),
      std: Math.max(profile.decisionPointCount * PAUSE_STD_PER_DECISION_POINT, PAUSE_COUNT_MIN_STD),
      weight: 0.8,
    },
    angular_velocity_entropy: {
      mean: Math.min((mr?.angularEntropyBase ?? ANGULAR_ENTROPY_BASE) + profile.turnCount * (mr?.angularEntropyPerTurn ?? ANGULAR_ENTROPY_PER_TURN), ANGULAR_ENTROPY_MAX),
      std: 0.5,
      weight: 1.5,
    },
  }
}

const FEATURE_KEYS = Object.keys(FALLBACK_BASELINES) as FeatureKey[]

/**
 * Detect suspicious cross-feature correlations that suggest automation.
 * Individual features may look normal, but their combination is unlikely
 * for a human.
 */
function detectFeatureAnomalies(
  features: BehavioralFeatures,
  baselines: Record<FeatureKey, FeatureBaseline>,
): number {
  let anomalyCount = 0

  const zOf = (key: FeatureKey): number => {
    const b = baselines[key]
    return b.std > 0 ? (features[key] - b.mean) / b.std : 0
  }

  // Smooth velocity (normal z) + abnormally low jerk = constant-speed bot
  const velZ = Math.abs(zOf('velocity_std'))
  const jerkZ = zOf('jerk_std') // negative z means below mean
  if (velZ < 2 && jerkZ < -3) anomalyCount++

  // High path efficiency + low angular entropy = straight-line bot
  if (features.path_efficiency > 0.9 && Math.abs(zOf('angular_velocity_entropy')) < 1) anomalyCount++

  // Normal timing CV + instant movement onset = pre-programmed start
  if (Math.abs(zOf('timing_cv')) < 2 && features.movement_onset_ms < 50) anomalyCount++

  return anomalyCount
}

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
export function scoreBehavior(
  features: BehavioralFeatures,
  profile?: MazeProfile,
  inputType?: InputMode,
  scoringConfig?: ScoringConfig,
): { score: number; zScores: Record<string, number> } {
  const baselines = computeBaselines(profile, inputType, scoringConfig)
  let weightedSum = 0
  let totalWeight = 0
  let maxZ = 0
  const zScores: Record<string, number> = {}

  const k = scoringConfig?.gaussianK ?? GAUSSIAN_K
  const outlierZ = scoringConfig?.extremeOutlierZ ?? EXTREME_OUTLIER_Z
  const anomalyPenalty = scoringConfig?.anomalyPenaltyPer ?? ANOMALY_PENALTY_PER

  for (const key of FEATURE_KEYS) {
    const baseline = baselines[key]
    const value = features[key]

    const zScore = baseline.std > 0
      ? Math.abs(value - baseline.mean) / baseline.std
      : 0

    zScores[key] = zScore

    if (baseline.weight >= 0.5) maxZ = Math.max(maxZ, zScore)

    const featureScore = Math.exp(-0.5 * (zScore / k) ** 2)

    weightedSum += featureScore * baseline.weight
    totalWeight += baseline.weight
  }

  let score = totalWeight > 0 ? weightedSum / totalWeight : 0

  if (maxZ > outlierZ) {
    score *= Math.exp(-0.5 * ((maxZ - outlierZ) / 2) ** 2)
  }

  const anomalyCount = detectFeatureAnomalies(features, baselines)
  if (anomalyCount > 0) {
    score *= 1 - anomalyPenalty * anomalyCount
  }

  if (features.sample_count < MIN_SAMPLE_COUNT) {
    const sampleRatio = Math.max(features.sample_count, 0) / MIN_SAMPLE_COUNT
    score *= sampleRatio
  }

  if (features.total_duration_ms < MIN_DURATION_MS) {
    const durationRatio = Math.max(features.total_duration_ms, 0) / MIN_DURATION_MS
    score *= durationRatio
  }

  if (Number.isNaN(score)) return { score: 0, zScores }

  return { score: Math.max(0, Math.min(1, score)), zScores }
}
