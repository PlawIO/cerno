/**
 * Secret behavioral features computed only on the server.
 *
 * These are NOT exported from the npm package. An attacker reading
 * @cernosh/core sees 7 public features. These 5 additional features
 * are invisible to them, breaking the "read the code, tune the trace" attack.
 *
 * If you're reading this in the source repo: yes, determined attackers
 * can find this file. The defense model is layered:
 * 1. Most script-kiddie bots won't read server source
 * 2. Features here can be rotated/replaced without client changes
 * 3. The combination with public features creates a high-dimensional space
 *    that's expensive to optimize against
 */
import type { RawEvent } from '@cernosh/core'
import type { ScoringConfig } from './types.js'
import { GAUSSIAN_K, MICRO_CORRECTION_ANGLE_RAD, VELOCITY_PEAK_THRESHOLD } from './scoring-constants.js'

export interface SecretFeatures {
  /** Lag-1 velocity autocorrelation. Humans ~0.3-0.6, bots ~0 or ~1 */
  velocity_autocorrelation: number
  /** Small direction corrections below 15 degrees */
  micro_correction_rate: number
  /** Count of velocity peaks (bell-shaped sub-movements) */
  sub_movement_count: number
  /** Ratio of deceleration time to acceleration time. Humans brake slower (~1.3-1.8) */
  acceleration_asymmetry: number
  /** Mean absolute curvature along the path */
  curvature_mean: number
  /** Shannon entropy of raw inter-event interval histogram (before 60Hz resampling) */
  raw_timing_entropy: number
}

interface SecretBaseline {
  mean: number
  std: number
  weight: number
}

/**
 * Baselines for secret features. These are the scoring targets.
 * Rotate these periodically based on production data.
 */
const SECRET_BASELINES: Record<keyof SecretFeatures, SecretBaseline> = {
  velocity_autocorrelation: { mean: 0.45, std: 0.15, weight: 1.2 },
  micro_correction_rate:    { mean: 0.15, std: 0.08, weight: 1.0 },
  sub_movement_count:       { mean: 8,    std: 4,    weight: 0.8 },
  acceleration_asymmetry:   { mean: 1.5,  std: 0.3,  weight: 1.0 },
  curvature_mean:           { mean: 0.24, std: 0.12, weight: 0.8 },
  raw_timing_entropy:       { mean: 2.5,  std: 0.8,  weight: 0.5 },
}

const TOUCH_SECRET_BASELINES: Record<keyof SecretFeatures, SecretBaseline> = {
  velocity_autocorrelation: { mean: 0.35, std: 0.20, weight: 1.2 },
  micro_correction_rate:    { mean: 0.10, std: 0.06, weight: 1.0 },
  sub_movement_count:       { mean: 12,   std: 6,    weight: 0.8 },
  acceleration_asymmetry:   { mean: 1.3,  std: 0.4,  weight: 1.0 },
  curvature_mean:           { mean: 0.30, std: 0.15, weight: 0.8 },
  raw_timing_entropy:       { mean: 2.8,  std: 1.0,  weight: 0.5 },
}

const KEYBOARD_SECRET_BASELINES: Record<keyof SecretFeatures, SecretBaseline> = {
  velocity_autocorrelation: { mean: 0.20, std: 0.15, weight: 0.6 },
  micro_correction_rate:    { mean: 0.05, std: 0.04, weight: 0.6 },
  sub_movement_count:       { mean: 5,    std: 3,    weight: 0.6 },
  acceleration_asymmetry:   { mean: 1.0,  std: 0.3,  weight: 0.6 },
  curvature_mean:           { mean: 0.08, std: 0.05, weight: 0.6 },
  raw_timing_entropy:       { mean: 2.0,  std: 0.7,  weight: 0.5 },
}

function getSecretBaselines(inputType?: import('@cernosh/core').InputMode, scoringConfig?: ScoringConfig): Record<keyof SecretFeatures, SecretBaseline> {
  let base: Record<string, SecretBaseline>
  let configKey: 'mouse' | 'touch' | 'keyboard'
  switch (inputType) {
    case 'touch':
      base = { ...TOUCH_SECRET_BASELINES }
      configKey = 'touch'
      break
    case 'keyboard':
      base = { ...KEYBOARD_SECRET_BASELINES }
      configKey = 'keyboard'
      break
    default:
      base = { ...SECRET_BASELINES }
      configKey = 'mouse'
      break
  }
  const overrides = scoringConfig?.secretBaselines?.[configKey]
  if (overrides) {
    for (const [key, val] of Object.entries(overrides)) {
      if (val) base[key] = val
    }
  }
  return base as Record<keyof SecretFeatures, SecretBaseline>
}

function resampleTo60Hz(events: RawEvent[]): RawEvent[] {
  if (events.length < 2) return events
  const INTERVAL = 1000 / 60
  const MAX_SAMPLES = 10_000
  const resampled: RawEvent[] = []
  const start = events[0].t
  const end = events[events.length - 1].t
  let idx = 0

  for (let t = start; t <= end && resampled.length < MAX_SAMPLES; t += INTERVAL) {
    while (idx < events.length - 1 && events[idx + 1].t < t) idx++
    if (idx >= events.length - 1) {
      resampled.push({ ...events[events.length - 1], t })
      break
    }
    const e0 = events[idx]
    const e1 = events[idx + 1]
    const dt = e1.t - e0.t
    const ratio = dt === 0 ? 0 : (t - e0.t) / dt
    resampled.push({
      t,
      x: e0.x + (e1.x - e0.x) * ratio,
      y: e0.y + (e1.y - e0.y) * ratio,
      type: 'move',
    })
  }
  return resampled
}

export function extractSecretFeatures(events: RawEvent[]): SecretFeatures {
  const moveEvents = events.filter(
    (e) => e.type === 'move' || e.type === 'down' || e.type === 'up',
  )

  if (moveEvents.length < 3) {
    return {
      velocity_autocorrelation: 0,
      micro_correction_rate: 0,
      sub_movement_count: 0,
      acceleration_asymmetry: 1,
      curvature_mean: 0,
      raw_timing_entropy: 0,
    }
  }

  // ── Raw timing entropy (before 60Hz resampling) ──
  // Compute Shannon entropy of inter-event interval histogram.
  // Real hardware: clustered intervals (OS scheduler jitter, USB poll rate).
  // Synthetic: smoother/uniform distribution even with jitter.
  let raw_timing_entropy = 0
  if (moveEvents.length >= 3) {
    const intervals: number[] = []
    for (let i = 1; i < moveEvents.length; i++) {
      const dt = moveEvents[i].t - moveEvents[i - 1].t
      if (dt > 0) intervals.push(dt)
    }
    if (intervals.length >= 2) {
      // Bin intervals into 1ms buckets, compute Shannon entropy
      const bins = new Map<number, number>()
      for (const dt of intervals) {
        const bin = Math.round(dt) // 1ms resolution
        bins.set(bin, (bins.get(bin) ?? 0) + 1)
      }
      const n = intervals.length
      for (const count of bins.values()) {
        const p = count / n
        if (p > 0) raw_timing_entropy -= p * Math.log2(p)
      }
    }
  }

  const sampled = resampleTo60Hz(moveEvents)
  if (sampled.length < 3) {
    return {
      velocity_autocorrelation: 0,
      micro_correction_rate: 0,
      sub_movement_count: 0,
      acceleration_asymmetry: 1,
      curvature_mean: 0,
      raw_timing_entropy,
    }
  }

  // ── Velocities ──
  const velocities: number[] = []
  for (let i = 1; i < sampled.length; i++) {
    const dx = sampled[i].x - sampled[i - 1].x
    const dy = sampled[i].y - sampled[i - 1].y
    const dt = sampled[i].t - sampled[i - 1].t
    const dist = Math.sqrt(dx * dx + dy * dy)
    velocities.push(dt > 0 ? dist / dt : 0)
  }

  // ── 1. Velocity autocorrelation (lag-1) ──
  // Pearson correlation between v[i] and v[i+1]
  let velocity_autocorrelation = 0
  if (velocities.length >= 4) {
    const n = velocities.length - 1
    let sumXY = 0, sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0
    for (let i = 0; i < n; i++) {
      const x = velocities[i]
      const y = velocities[i + 1]
      sumX += x; sumY += y
      sumXY += x * y
      sumX2 += x * x; sumY2 += y * y
    }
    const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY))
    // Clamp to [-1, 1] to guard against floating-point drift
    velocity_autocorrelation = denom > 1e-12
      ? Math.max(-1, Math.min(1, (n * sumXY - sumX * sumY) / denom))
      : 0
  }

  // ── 2. Micro-correction rate ──
  // Fraction of direction changes below 15 degrees (0.26 radians)
  const MICRO_ANGLE = MICRO_CORRECTION_ANGLE_RAD
  let microCount = 0
  let totalAngles = 0
  for (let i = 2; i < sampled.length; i++) {
    const dx1 = sampled[i - 1].x - sampled[i - 2].x
    const dy1 = sampled[i - 1].y - sampled[i - 2].y
    const dx2 = sampled[i].x - sampled[i - 1].x
    const dy2 = sampled[i].y - sampled[i - 1].y
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1)
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2)
    if (len1 > 1e-8 && len2 > 1e-8) {
      const dot = dx1 * dx2 + dy1 * dy2
      const cosAngle = Math.max(-1, Math.min(1, dot / (len1 * len2)))
      const angle = Math.acos(cosAngle)
      totalAngles++
      if (angle > 0 && angle < MICRO_ANGLE) microCount++
    }
  }
  const micro_correction_rate = totalAngles > 0 ? microCount / totalAngles : 0

  // ── 3. Sub-movement count ──
  // Velocity peaks: local maxima where v[i] > v[i-1] and v[i] > v[i+1]
  let sub_movement_count = 0
  const PEAK_THRESHOLD = VELOCITY_PEAK_THRESHOLD // ignore noise-level peaks
  for (let i = 1; i < velocities.length - 1; i++) {
    if (
      velocities[i] > velocities[i - 1] &&
      velocities[i] > velocities[i + 1] &&
      velocities[i] > PEAK_THRESHOLD
    ) {
      sub_movement_count++
    }
  }

  // ── 4. Acceleration asymmetry ──
  // Time spent decelerating / time spent accelerating
  // Humans brake slower than they accelerate (Fitts' law)
  let accelSamples = 0
  let decelSamples = 0
  for (let i = 1; i < velocities.length; i++) {
    if (velocities[i] > velocities[i - 1]) accelSamples++
    else if (velocities[i] < velocities[i - 1]) decelSamples++
  }
  const acceleration_asymmetry = accelSamples > 0 ? decelSamples / accelSamples : 1

  // ── 5. Curvature mean ──
  // Menger curvature: 2 * |cross product| / (|a||b||c|) = 4 * area / (|a||b||c|) for 3 consecutive points
  const curvatures: number[] = []
  for (let i = 1; i < sampled.length - 1; i++) {
    const ax = sampled[i - 1].x, ay = sampled[i - 1].y
    const bx = sampled[i].x, by = sampled[i].y
    const cx = sampled[i + 1].x, cy = sampled[i + 1].y
    const area2 = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay))
    const ab = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2)
    const bc = Math.sqrt((cx - bx) ** 2 + (cy - by) ** 2)
    const ac = Math.sqrt((cx - ax) ** 2 + (cy - ay) ** 2)
    const denom = ab * bc * ac
    if (denom > 1e-12) {
      curvatures.push((2 * area2) / denom)
    }
  }
  const curvature_mean = curvatures.length > 0
    ? curvatures.reduce((a, b) => a + b, 0) / curvatures.length
    : 0

  return {
    velocity_autocorrelation,
    micro_correction_rate,
    sub_movement_count,
    acceleration_asymmetry,
    curvature_mean,
    raw_timing_entropy,
  }
}

/**
 * Score secret features against baselines.
 * Returns a 0-1 score (same Gaussian transform as public features).
 * Also returns per-feature z-scores for observability.
 */
export function scoreSecretFeatures(
  features: SecretFeatures,
  inputType?: import('@cernosh/core').InputMode,
  scoringConfig?: ScoringConfig,
): { score: number; zScores: Record<string, number> } {
  const baselines = getSecretBaselines(inputType, scoringConfig)
  const keys = Object.keys(baselines) as Array<keyof SecretFeatures>
  let weightedSum = 0
  let totalWeight = 0
  const zScores: Record<string, number> = {}
  const k = scoringConfig?.gaussianK ?? GAUSSIAN_K

  for (const key of keys) {
    const baseline = baselines[key]
    const value = features[key]
    const zScore = baseline.std > 0
      ? Math.abs(value - baseline.mean) / baseline.std
      : 0
    zScores[key] = zScore
    const featureScore = Math.exp(-0.5 * (zScore / k) ** 2)
    weightedSum += featureScore * baseline.weight
    totalWeight += baseline.weight
  }

  const score = totalWeight > 0 ? weightedSum / totalWeight : 0
  if (Number.isNaN(score)) return { score: 0, zScores }
  return { score: Math.max(0, Math.min(1, score)), zScores }
}
