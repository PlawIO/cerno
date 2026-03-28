import type { BehavioralFeatures, RawEvent } from './types.js'

/** Resample raw events to fixed 60Hz intervals */
function resampleTo60Hz(events: RawEvent[]): RawEvent[] {
  if (events.length < 2) return events

  const INTERVAL = 1000 / 60 // ~16.67ms
  const MAX_SAMPLES = 10_000 // Cap at ~2.8 minutes of 60Hz data
  const resampled: RawEvent[] = []
  const start = events[0].t
  const end = events[events.length - 1].t
  let eventIdx = 0

  for (let t = start; t <= end && resampled.length < MAX_SAMPLES; t += INTERVAL) {
    // Find surrounding events for interpolation
    while (eventIdx < events.length - 1 && events[eventIdx + 1].t < t) {
      eventIdx++
    }

    if (eventIdx >= events.length - 1) {
      resampled.push({ ...events[events.length - 1], t })
      break
    }

    const e0 = events[eventIdx]
    const e1 = events[eventIdx + 1]
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

function std(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function shannonEntropy(values: number[], binCount: number): number {
  if (values.length === 0) return 0
  let min = values[0]
  let max = values[0]
  for (let i = 1; i < values.length; i++) {
    if (values[i] < min) min = values[i]
    if (values[i] > max) max = values[i]
  }
  const range = max - min
  if (range === 0) return 0

  const bins = new Array(binCount).fill(0)
  for (const v of values) {
    const bin = Math.min(Math.floor(((v - min) / range) * binCount), binCount - 1)
    bins[bin]++
  }

  let entropy = 0
  for (const count of bins) {
    if (count === 0) continue
    const p = count / values.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/**
 * Extract 6 MVP behavioral features from raw events.
 * Shared between client (preview) and server (trustless re-extraction).
 */
export function extractFeatures(events: RawEvent[]): BehavioralFeatures {
  const moveEvents = events.filter(
    (e) => e.type === 'move' || e.type === 'down' || e.type === 'up',
  )

  if (moveEvents.length < 2) {
    return {
      velocity_std: 0,
      path_efficiency: 0,
      pause_count: 0,
      movement_onset_ms: 0,
      jerk_std: 0,
      angular_velocity_entropy: 0,
      sample_count: moveEvents.length,
      total_duration_ms: moveEvents.length > 0 ? moveEvents[moveEvents.length - 1].t - moveEvents[0].t : 0,
    }
  }

  // Resample to 60Hz for consistent feature computation
  const sampled = resampleTo60Hz(moveEvents)

  if (sampled.length < 2) {
    return {
      velocity_std: 0,
      path_efficiency: 0,
      pause_count: 0,
      movement_onset_ms: events.length > 0 ? events[0].t : 0,
      jerk_std: 0,
      angular_velocity_entropy: 0,
      sample_count: sampled.length,
      total_duration_ms: 0,
    }
  }

  // ── Velocities ──
  const velocities: number[] = []
  let totalPathLength = 0

  for (let i = 1; i < sampled.length; i++) {
    const dx = sampled[i].x - sampled[i - 1].x
    const dy = sampled[i].y - sampled[i - 1].y
    const dt = sampled[i].t - sampled[i - 1].t
    const dist = Math.sqrt(dx * dx + dy * dy)
    totalPathLength += dist
    velocities.push(dt > 0 ? dist / dt : 0)
  }

  const velocity_std = std(velocities)

  // ── Path efficiency ──
  const euclidean = Math.sqrt(
    (sampled[sampled.length - 1].x - sampled[0].x) ** 2 +
      (sampled[sampled.length - 1].y - sampled[0].y) ** 2,
  )
  const path_efficiency = totalPathLength > 0 ? euclidean / totalPathLength : 0

  // ── Pause count (>100ms of near-zero movement) ──
  let pause_count = 0
  let pauseStart = -1
  const PAUSE_THRESHOLD = 0.0005 // normalized units/ms
  const PAUSE_MIN_MS = 100

  for (let i = 0; i < velocities.length; i++) {
    if (velocities[i] < PAUSE_THRESHOLD) {
      if (pauseStart === -1) pauseStart = i
    } else {
      if (pauseStart !== -1) {
        const duration = sampled[i].t - sampled[pauseStart].t
        if (duration >= PAUSE_MIN_MS) pause_count++
        pauseStart = -1
      }
    }
  }
  // Check trailing pause
  if (pauseStart !== -1) {
    const duration = sampled[sampled.length - 1].t - sampled[pauseStart].t
    if (duration >= PAUSE_MIN_MS) pause_count++
  }

  // ── Movement onset ──
  // Time from first event to first significant movement
  const ONSET_THRESHOLD = 0.001
  let movement_onset_ms = 0
  for (let i = 0; i < velocities.length; i++) {
    if (velocities[i] > ONSET_THRESHOLD) {
      movement_onset_ms = sampled[i].t - sampled[0].t
      break
    }
  }

  // ── Jerk (derivative of acceleration) ──
  const accelerations: number[] = []
  for (let i = 1; i < velocities.length; i++) {
    const dt = sampled[i + 1 < sampled.length ? i + 1 : i].t - sampled[i].t
    accelerations.push(dt > 0 ? (velocities[i] - velocities[i - 1]) / dt : 0)
  }

  const jerks: number[] = []
  for (let i = 1; i < accelerations.length; i++) {
    const dt = sampled[i + 2 < sampled.length ? i + 2 : i + 1 < sampled.length ? i + 1 : i].t - sampled[i + 1 < sampled.length ? i + 1 : i].t
    jerks.push(dt > 0 ? (accelerations[i] - accelerations[i - 1]) / dt : 0)
  }

  const jerk_std = std(jerks)

  // ── Angular velocity entropy ──
  // Direction changes binned into 16 angular bins
  const angles: number[] = []
  for (let i = 1; i < sampled.length; i++) {
    const dx = sampled[i].x - sampled[i - 1].x
    const dy = sampled[i].y - sampled[i - 1].y
    if (Math.abs(dx) > 1e-8 || Math.abs(dy) > 1e-8) {
      angles.push(Math.atan2(dy, dx))
    }
  }

  const angularVelocities: number[] = []
  for (let i = 1; i < angles.length; i++) {
    let dAngle = angles[i] - angles[i - 1]
    // Normalize to [-pi, pi]
    while (dAngle > Math.PI) dAngle -= 2 * Math.PI
    while (dAngle < -Math.PI) dAngle += 2 * Math.PI
    angularVelocities.push(dAngle)
  }

  const angular_velocity_entropy = shannonEntropy(angularVelocities, 16)

  const total_duration_ms = sampled[sampled.length - 1].t - sampled[0].t

  return {
    velocity_std,
    path_efficiency,
    pause_count,
    movement_onset_ms,
    jerk_std,
    angular_velocity_entropy,
    sample_count: sampled.length,
    total_duration_ms,
  }
}
