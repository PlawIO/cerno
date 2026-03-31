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
  /** K-H1: Motor event density during probe window vs baseline. Humans ~0.5, agents ~0 */
  probe_motor_continuity: number
  /** K-H2: Mean coalesced events per pointer frame. Real hardware ~3, synthetic/CDP ~1 */
  coalesced_event_ratio: number
  /** Excess kurtosis of inter-event intervals. Human log-normal ~3-15, uniform jitter ~-1.2 */
  timing_kurtosis: number
  /** R² of log(velocity) vs log(curvature) regression (2/3 power law).
   *  Observability only — weight=0 until validated on production data. */
  velocity_curvature_r2: number
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
/**
 * Calibrated from 28 production records (Chrome/macOS/AT, 2026-03-30).
 * Previous synthetic calibration had wrong baselines for real browsers:
 * Chrome reports pointer events at display-refresh rate (60Hz), giving
 * raw_timing_entropy ~1-4 (not ~5), and curvature_mean in absolute pixel
 * units 20-140 (not 620). Std widened 1.5-2x to accommodate real variation.
 * Last calibrated: 2026-03-30 (production).
 */
const SECRET_BASELINES: Record<keyof SecretFeatures, SecretBaseline> = {
  velocity_autocorrelation:  { mean: 0.89,  std: 0.08,   weight: 1.2 },
  micro_correction_rate:     { mean: 0.57,  std: 0.20,   weight: 1.5 },
  sub_movement_count:        { mean: 50,    std: 40,     weight: 0.8 },
  acceleration_asymmetry:    { mean: 1.05,  std: 0.15,   weight: 1.0 },
  curvature_mean:            { mean: 57,    std: 50,     weight: 0.8 },
  raw_timing_entropy:        { mean: 2.0,   std: 0.9,    weight: 1.5 },
  probe_motor_continuity:    { mean: 0.5,   std: 0.2,    weight: 1.0 },
  coalesced_event_ratio:     { mean: 3.0,   std: 1.5,    weight: 1.0 },
  timing_kurtosis:           { mean: 100.0, std: 80.0,   weight: 1.0 },
  velocity_curvature_r2:     { mean: 0.5,   std: 0.3,    weight: 0.0 },
}

/**
 * Touch-specific baselines. Touch has more spatial noise (finger vs cursor).
 * Production touch records show similar kinematic profile to mouse with
 * slightly lower MCR and VKA (finger is less precise). Last calibrated: 2026-03-30.
 */
const TOUCH_SECRET_BASELINES: Record<keyof SecretFeatures, SecretBaseline> = {
  velocity_autocorrelation:  { mean: 0.82,  std: 0.12,   weight: 1.2 },
  micro_correction_rate:     { mean: 0.52,  std: 0.22,   weight: 1.0 },
  sub_movement_count:        { mean: 45,    std: 40,     weight: 0.8 },
  acceleration_asymmetry:    { mean: 1.05,  std: 0.20,   weight: 1.0 },
  curvature_mean:            { mean: 65,    std: 60,     weight: 0.8 },
  raw_timing_entropy:        { mean: 2.0,   std: 1.0,    weight: 0.3 },
  probe_motor_continuity:    { mean: 0.5,   std: 0.2,    weight: 1.0 },
  coalesced_event_ratio:     { mean: 1.5,   std: 1.0,    weight: 0.6 },
  timing_kurtosis:           { mean: 80.0,  std: 70.0,   weight: 0.8 },
  velocity_curvature_r2:     { mean: 0.5,   std: 0.3,    weight: 0.0 },
}

/**
 * Keyboard baselines. Arrow-key navigation produces discrete jumps,
 * very different kinematics from pointer input. Lower weights on most features.
 */
const KEYBOARD_SECRET_BASELINES: Record<keyof SecretFeatures, SecretBaseline> = {
  velocity_autocorrelation:  { mean: 0.20,  std: 0.15,   weight: 0.6 },
  micro_correction_rate:     { mean: 0.05,  std: 0.04,   weight: 0.6 },
  sub_movement_count:        { mean: 15,    std: 10,     weight: 0.6 },
  acceleration_asymmetry:    { mean: 1.0,   std: 0.3,    weight: 0.6 },
  curvature_mean:            { mean: 200,   std: 200,    weight: 0.6 },
  raw_timing_entropy:        { mean: 4.0,   std: 1.0,    weight: 0.5 },
  probe_motor_continuity:    { mean: 0.5,   std: 0.2,    weight: 0.0 },
  coalesced_event_ratio:     { mean: 1.0,   std: 0.5,    weight: 0.0 },
  timing_kurtosis:           { mean: 8.0,   std: 8.0,    weight: 0.5 },
  velocity_curvature_r2:     { mean: 0.5,   std: 0.3,    weight: 0.0 },
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

/** K-H1: Probe timing data for motor-stream correlation analysis */
export interface ProbeTimingData {
  /** When probe was shown, relative to collector start time (ms) */
  probe_shown_at: number
  /** Reaction time to respond to probe (ms) */
  reaction_time_ms: number
}

export function extractSecretFeatures(events: RawEvent[], probeTimings?: ProbeTimingData[]): SecretFeatures {
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
      probe_motor_continuity: NaN,
      coalesced_event_ratio: NaN,
      timing_kurtosis: NaN,
      velocity_curvature_r2: NaN,
    }
  }

  // ── Raw timing entropy (before 60Hz resampling) ──
  // Compute Shannon entropy of inter-event interval histogram.
  // Real hardware: clustered intervals (OS scheduler jitter, USB poll rate).
  // Synthetic: smoother/uniform distribution even with jitter.
  let raw_timing_entropy = 0
  let timing_kurtosis = NaN
  const rawIntervals: number[] = []
  if (moveEvents.length >= 3) {
    for (let i = 1; i < moveEvents.length; i++) {
      const dt = moveEvents[i].t - moveEvents[i - 1].t
      if (dt > 0) rawIntervals.push(dt)
    }
    if (rawIntervals.length >= 2) {
      // Bin intervals into 1ms buckets, compute Shannon entropy
      const bins = new Map<number, number>()
      for (const dt of rawIntervals) {
        const bin = Math.round(dt) // 1ms resolution
        bins.set(bin, (bins.get(bin) ?? 0) + 1)
      }
      const n = rawIntervals.length
      for (const count of bins.values()) {
        const p = count / n
        if (p > 0) raw_timing_entropy -= p * Math.log2(p)
      }
    }
    // ── Timing kurtosis (excess kurtosis of inter-event intervals) ──
    // Human hardware produces log-normal intervals with heavy tails (kurtosis > 1).
    // Uniform jitter produces platykurtic distribution (kurtosis ≈ -1.2).
    // CDP / constant timing produces near-zero variance (kurtosis ≈ 0).
    // This discriminates timing distribution SHAPE, not just spread (entropy) or regularity (CV).
    if (rawIntervals.length >= 10) {
      const n = rawIntervals.length
      const mean = rawIntervals.reduce((a, b) => a + b, 0) / n
      const m2 = rawIntervals.reduce((s, v) => s + (v - mean) ** 2, 0) / n
      const m4 = rawIntervals.reduce((s, v) => s + (v - mean) ** 4, 0) / n
      timing_kurtosis = m2 > 1e-10 ? m4 / (m2 * m2) - 3 : 0
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
      probe_motor_continuity: NaN,
      coalesced_event_ratio: NaN,
      timing_kurtosis,
      velocity_curvature_r2: NaN,
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

  // ── Velocity-curvature power law R² (observability only) ──
  // Humans exhibit V ∝ R^(1/3) (the 2/3 power law). R² of log(V) vs log(R)
  // regression measures adherence. Straight segments produce zero curvature
  // (log ill-conditioned), so filter to points with curvature > threshold.
  let velocity_curvature_r2 = NaN
  if (velocities.length >= 10 && curvatures.length >= 10) {
    // curvatures[i] corresponds to sampled[i+1] (center of 3-point window),
    // velocities[i] corresponds to sampled[i] → sampled[i+1], so
    // curvatures[i] pairs with velocities[i+1] (velocity leaving center point).
    const logPairs: Array<[number, number]> = []
    for (let i = 0; i < curvatures.length && i + 1 < velocities.length; i++) {
      const c = curvatures[i]
      const v = velocities[i + 1]
      if (c > 1e-6 && v > 1e-6) {
        logPairs.push([Math.log(1 / c), Math.log(v)]) // log(R) = log(1/curvature)
      }
    }
    if (logPairs.length >= 5) {
      const n = logPairs.length
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
      for (const [lx, ly] of logPairs) {
        sx += lx; sy += ly
        sxx += lx * lx; syy += ly * ly
        sxy += lx * ly
      }
      const denom = (n * sxx - sx * sx) * (n * syy - sy * sy)
      if (denom > 1e-20) {
        const r = (n * sxy - sx * sy) / Math.sqrt(denom)
        velocity_curvature_r2 = r * r
      }
    }
  }

  // ── K-H1: Probe-motor continuity ──
  // Measure motor event density in ±500ms window around each probe display.
  // Humans maintain ~50% of baseline event rate during cognitive interrupts.
  // Agents halt entirely (observe-reason-act serialization).
  const PROBE_WINDOW_MS = 500
  let probe_motor_continuity = NaN // NaN = no probe data, excluded from scoring
  // Empty array (not undefined) means probes were issued but client omitted timing
  // data — treat as zero continuity (agent-like evasion).
  if (probeTimings && probeTimings.length === 0) {
    probe_motor_continuity = 0
  } else if (probeTimings && probeTimings.length > 0 && moveEvents.length > 10) {
    const totalDuration = moveEvents[moveEvents.length - 1].t - moveEvents[0].t
    const baselineRate = totalDuration > 0 ? moveEvents.length / totalDuration : 0

    let totalProbeRate = 0
    let probeCount = 0
    for (const probe of probeTimings) {
      const windowStart = probe.probe_shown_at - PROBE_WINDOW_MS
      const windowEnd = probe.probe_shown_at + PROBE_WINDOW_MS
      const windowEvents = moveEvents.filter(e => e.t >= windowStart && e.t <= windowEnd)
      const windowDuration = PROBE_WINDOW_MS * 2
      const windowRate = windowDuration > 0 ? windowEvents.length / windowDuration : 0
      totalProbeRate += baselineRate > 0 ? windowRate / baselineRate : 0
      probeCount++
    }
    probe_motor_continuity = probeCount > 0 ? totalProbeRate / probeCount : 0.5
  }

  // ── K-H2: Coalesced event ratio ──
  // Real hardware at 120Hz+ coalesces 2-8 events per pointer frame.
  // CDP/synthetic dispatches exactly 1 event per call.
  const coalescedEvents = moveEvents.filter(e => e.coalesced_count != null)
  let coalesced_event_ratio: number
  if (coalescedEvents.length >= 5) {
    const totalCoalesced = coalescedEvents.reduce((sum, e) => sum + (e.coalesced_count ?? 1), 0)
    coalesced_event_ratio = totalCoalesced / coalescedEvents.length
  } else {
    // No coalesced data (browser doesn't support getCoalescedEvents).
    // Use NaN sentinel — scoreSecretFeatures will exclude from scoring.
    coalesced_event_ratio = NaN
  }

  return {
    velocity_autocorrelation,
    micro_correction_rate,
    sub_movement_count,
    acceleration_asymmetry,
    curvature_mean,
    raw_timing_entropy,
    probe_motor_continuity,
    coalesced_event_ratio,
    timing_kurtosis,
    velocity_curvature_r2,
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
  const baseK = scoringConfig?.gaussianK ?? GAUSSIAN_K

  // Secret features use tighter Gaussian (k * 0.75) than public features.
  // This makes the scorer more sensitive in the z=1-2 range where bots live.
  // Humans cluster at z < 0.5 and are barely affected. Bots at z=1-2 get
  // significantly lower per-feature scores (e.g. z=1.5: 0.607 vs 0.754).
  const k = baseK * 0.75

  for (const key of keys) {
    const baseline = baselines[key]
    const value = features[key]
    // Skip features with no data (NaN sentinel from unsupported APIs)
    if (Number.isNaN(value) || baseline.weight === 0) {
      zScores[key] = 0
      continue
    }
    const zScore = baseline.std > 0
      ? Math.abs(value - baseline.mean) / baseline.std
      : 0
    zScores[key] = zScore
    const featureScore = Math.exp(-0.5 * (zScore / k) ** 2)
    weightedSum += featureScore * baseline.weight
    totalWeight += baseline.weight
  }

  let score = totalWeight > 0 ? weightedSum / totalWeight : 0

  // ── Hard anomaly gates ──
  // These catch bot signals that Gaussian scoring is too forgiving on.
  // Gates compound multiplicatively.

  // Gate 1: Timing kurtosis gradient penalty.
  // Human inter-event intervals are log-normal (hardware poll + OS scheduling),
  // producing excess kurtosis >> 0 (calibration: min=0.86, median=10.1).
  // Synthetic timing (uniform jitter, constant intervals) produces kurtosis ≤ -1.
  // Gradient: full penalty below 0, linear ramp 0→3, no penalty above 3.
  if (!Number.isNaN(features.timing_kurtosis) && features.timing_kurtosis < 3.0) {
    const multiplier = Math.max(0.25, (features.timing_kurtosis + 1) / 4)
    score *= multiplier
  }

  // Gate 2: Directional bias detection (4 kinematic features: VKA, MCR, CM, RTE).
  // Bots are systematically off-center vs humans. Signed z-score mean (production calibrated):
  //   Human:     mean≈0, range [-0.40, +0.60]
  //   Naive bot: mean≈-1.19, range [-1.74, -0.72]  → lower gate at -0.4
  //   Tuned bot: mean≈+1.57, range [+1.20, +1.80]  → upper gate at +0.5
  // Lower = lazy/random movement. Upper = mechanical sharp-turn paths.
  // timing_kurtosis intentionally excluded: high TK is a human signal (Chrome
  // 60Hz polling produces peaked interval distribution, kurtosis 60-220).
  // Including it here would penalize real users via the over-shoot gate.
  // TK is still scored via Gaussian above and catches bots in Gate 1 (TK < 3).
  const DIRECTIONAL_KEYS: Array<keyof SecretFeatures> = [
    'velocity_autocorrelation', 'micro_correction_rate',
    'curvature_mean', 'raw_timing_entropy',
  ]
  const signedZ = DIRECTIONAL_KEYS
    .filter(key => !Number.isNaN(features[key]) && baselines[key].std > 0)
    .map(key => (features[key] - baselines[key].mean) / baselines[key].std)
  if (signedZ.length >= 3) {
    const meanSignedZ = signedZ.reduce((a, b) => a + b, 0) / signedZ.length
    if (meanSignedZ < -0.4) {
      // Gradient: -0.4 → no penalty, -0.8 → floor at 0.20
      const multiplier = Math.max(0.20, 1.0 + (meanSignedZ + 0.4) * 2.0)
      score *= multiplier
    } else if (meanSignedZ > 0.5) {
      // Over-shoot gate: mechanical sharp-turn movement (tuned bot signature).
      // Real humans max at +0.41 (production data, 68 records). BFS-path bots
      // hit +0.54 to +0.67 (Mode B) due to high RTE from synthetic timing spread,
      // and +1.15 to +1.53 (naive bots) from 90° turns at constant speed.
      // Gradient: +0.5 → no penalty, +0.9 → floor at 0.15
      const multiplier = Math.max(0.15, 1.0 - (meanSignedZ - 0.5) * 2.5)
      score *= multiplier
    }
  }

  // Gate 3: K-H1 probe-motor continuity.
  // Near-zero with probe data means motor stream died during cognitive task —
  // the observe-reason-act serialization signature.
  if (!Number.isNaN(features.probe_motor_continuity) && features.probe_motor_continuity < 0.1) {
    score *= 0.5
  }

  // Gate 4: High raw timing entropy floor (mouse only).
  // Human Chrome 60Hz produces clustered inter-event intervals → RTE 0.67-4.25.
  // CDP/scripted dispatch produces spread intervals → RTE 4.9-5.1.
  // Threshold at 4.5 gives 0.25 margin above human max (4.25, which failed anyway).
  // All 10 Mode B bot records have RTE > 4.5.
  // Mouse-only: keyboard baseline has RTE mean=4.0, std=1.0 (key-repeat patterns
  // naturally produce higher entropy). Touch also excluded (different timing profile).
  if (inputType !== 'touch' && inputType !== 'keyboard'
    && !Number.isNaN(features.raw_timing_entropy) && features.raw_timing_entropy > 4.5) {
    score *= 0.15
  }

  // Gate 5: Low VKA + high sub-movement count = scripted path tracing (mouse only).
  // BFS-path bots generate many velocity peaks (SMC 99-183) with low autocorrelation
  // (VKA 0.694-0.799) because synthetic noise doesn't preserve inter-frame velocity
  // correlation. No human has both VKA < 0.80 AND SMC > 80 (human min VKA=0.787
  // has SMC=59; human max SMC=209 has VKA=0.845).
  // Mouse-only: touch baseline has VKA mean=0.82, std=0.12 so VKA=0.70 is only
  // 1σ below mean. Firing this gate on touch would reject normal mobile users.
  if (inputType !== 'touch' && inputType !== 'keyboard'
    && features.velocity_autocorrelation < 0.80 && features.sub_movement_count > 80) {
    score *= 0.20
  }

  // Gate 6: VKA floor for mouse input.
  // Playwright bypass bot produces VKA 0.634-0.742 (linear interpolation between cell
  // centers with noise). All production humans have VKA > 0.787. Threshold at 0.75
  // gives 0.037 margin (0.46σ). Codex flagged the original 0.78 (margin 0.007) as too
  // tight; widened after VP Eng review. Catches 15/15 Playwright bypass records.
  if (inputType !== 'touch' && inputType !== 'keyboard'
    && features.velocity_autocorrelation < 0.75) {
    score *= 0.25
  }

  // Gate 7: RTE + TK compound gate for mouse input.
  // Playwright bypass: RTE 3.48-3.99, TK 7.8-20.1. No human has BOTH RTE > 3.0 AND
  // TK < 30. Pre-TK humans with high RTE (3.6-4.25) have TK=NaN, so the isNaN checks
  // skip them safely. Compound condition makes this much safer than either alone.
  // Human min TK (with data) = 61.5. Gap from gate threshold: 31.5 units.
  if (inputType !== 'touch' && inputType !== 'keyboard'
    && !Number.isNaN(features.raw_timing_entropy)
    && !Number.isNaN(features.timing_kurtosis)
    && features.raw_timing_entropy > 3.0
    && features.timing_kurtosis < 30) {
    score *= 0.15
  }

  if (Number.isNaN(score)) return { score: 0, zScores }
  return { score: Math.max(0, Math.min(1, score)), zScores }
}
