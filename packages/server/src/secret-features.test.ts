import { describe, expect, it } from 'vitest'
import { extractSecretFeatures, scoreSecretFeatures } from './secret-features.js'
import type { RawEvent } from '@cernosh/core'

function makeHumanTrace(): RawEvent[] {
  const events: RawEvent[] = []
  const duration = 5000
  const steps = 300
  const dt = duration / steps
  let x = 0.05, y = 0.05, t = 0

  events.push({ t: 0, x, y, type: 'down' })

  for (let i = 0; i < steps; i++) {
    t += dt
    const phase = i / steps
    const speed = 0.002 + Math.sin(i * 0.1) * 0.001
    if (i % 40 < 20) {
      x += speed + (Math.random() - 0.5) * 0.0005
    } else {
      y += speed + (Math.random() - 0.5) * 0.0005
    }
    // Occasional pauses
    if (i % 60 === 0 && i > 0) {
      for (let p = 0; p < 5; p++) {
        t += dt
        events.push({ t, x: x + (Math.random() - 0.5) * 0.0001, y, type: 'move' })
      }
    }
    x = Math.max(0, Math.min(1, x))
    y = Math.max(0, Math.min(1, y))
    events.push({ t, x, y, type: 'move' })
  }

  events.push({ t, x, y, type: 'up' })
  return events
}

function makeBotTrace(): RawEvent[] {
  const events: RawEvent[] = []
  for (let i = 0; i < 100; i++) {
    const t = i * 30
    const progress = i / 99
    events.push({
      t,
      x: 0.05 + progress * 0.9,
      y: 0.05 + progress * 0.9,
      type: i === 0 ? 'down' : i === 99 ? 'up' : 'move',
    })
  }
  return events
}

describe('extractSecretFeatures', () => {
  it('returns zeroed features for too few events', () => {
    const features = extractSecretFeatures([
      { t: 0, x: 0.1, y: 0.1, type: 'down' },
    ])
    expect(features.velocity_autocorrelation).toBe(0)
    expect(features.micro_correction_rate).toBe(0)
    expect(features.sub_movement_count).toBe(0)
    expect(features.acceleration_asymmetry).toBe(1)
    expect(features.curvature_mean).toBe(0)
  })

  it('extracts features from human trace', () => {
    const features = extractSecretFeatures(makeHumanTrace())
    expect(features.velocity_autocorrelation).toBeGreaterThan(-1)
    expect(features.velocity_autocorrelation).toBeLessThan(1)
    expect(features.micro_correction_rate).toBeGreaterThanOrEqual(0)
    expect(features.micro_correction_rate).toBeLessThanOrEqual(1)
    expect(features.sub_movement_count).toBeGreaterThan(0)
    expect(features.acceleration_asymmetry).toBeGreaterThan(0)
    expect(features.curvature_mean).toBeGreaterThanOrEqual(0)
    expect(features.raw_timing_entropy).toBeGreaterThan(0)
  })

  it('velocity autocorrelation is within valid range', () => {
    const human = extractSecretFeatures(makeHumanTrace())
    const bot = extractSecretFeatures(makeBotTrace())
    // Both should be in [-1, 1]
    expect(human.velocity_autocorrelation).toBeGreaterThanOrEqual(-1)
    expect(human.velocity_autocorrelation).toBeLessThanOrEqual(1)
    expect(bot.velocity_autocorrelation).toBeGreaterThanOrEqual(-1)
    expect(bot.velocity_autocorrelation).toBeLessThanOrEqual(1)
  })

  it('human has more sub-movements than bot', () => {
    const human = extractSecretFeatures(makeHumanTrace())
    const bot = extractSecretFeatures(makeBotTrace())
    expect(human.sub_movement_count).toBeGreaterThan(bot.sub_movement_count)
  })
})

describe('raw_timing_entropy', () => {
  it('hardware-like clustered intervals have moderate entropy', () => {
    // Simulate hardware: events clustered around 16ms (60Hz) with OS jitter
    const events: RawEvent[] = []
    for (let i = 0; i < 200; i++) {
      const jitter = (Math.random() - 0.5) * 2 // +/- 1ms
      events.push({ t: i * 16.67 + jitter, x: i * 0.004, y: 0.1, type: 'move' })
    }
    const features = extractSecretFeatures(events)
    // Clustered intervals → low-moderate entropy (most intervals in same 1ms bins)
    expect(features.raw_timing_entropy).toBeGreaterThan(0)
    expect(features.raw_timing_entropy).toBeLessThan(5)
  })

  it('synthetic uniform intervals have different entropy than clustered', () => {
    // Synthetic: perfectly uniform 30ms intervals
    const uniform: RawEvent[] = []
    for (let i = 0; i < 200; i++) {
      uniform.push({ t: i * 30, x: i * 0.004, y: 0.1, type: 'move' })
    }
    const uniformFeatures = extractSecretFeatures(uniform)

    // Clustered (hardware-like)
    const clustered: RawEvent[] = []
    for (let i = 0; i < 200; i++) {
      const jitter = (Math.random() - 0.5) * 4
      clustered.push({ t: i * 16.67 + jitter, x: i * 0.004, y: 0.1, type: 'move' })
    }
    const clusteredFeatures = extractSecretFeatures(clustered)

    // Uniform intervals → all in one bin → entropy near 0
    // Clustered with jitter → spread across a few bins → higher entropy
    expect(uniformFeatures.raw_timing_entropy).not.toBe(clusteredFeatures.raw_timing_entropy)
  })

  it('<3 events returns 0 entropy', () => {
    const features = extractSecretFeatures([
      { t: 0, x: 0, y: 0, type: 'down' },
      { t: 100, x: 0.1, y: 0.1, type: 'up' },
    ])
    expect(features.raw_timing_entropy).toBe(0)
  })
})

describe('scoreSecretFeatures', () => {
  it('scores human trace reasonably', () => {
    const features = extractSecretFeatures(makeHumanTrace())
    const { score } = scoreSecretFeatures(features)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('returns z-scores for observability', () => {
    const features = extractSecretFeatures(makeHumanTrace())
    const { zScores } = scoreSecretFeatures(features)
    expect(zScores).toHaveProperty('velocity_autocorrelation')
    expect(zScores).toHaveProperty('micro_correction_rate')
    expect(zScores).toHaveProperty('sub_movement_count')
    expect(zScores).toHaveProperty('acceleration_asymmetry')
    expect(zScores).toHaveProperty('curvature_mean')
    expect(zScores).toHaveProperty('raw_timing_entropy')
  })

  it('scores zeroed features low', () => {
    const { score } = scoreSecretFeatures({
      velocity_autocorrelation: 0,
      micro_correction_rate: 0,
      sub_movement_count: 0,
      acceleration_asymmetry: 1,
      curvature_mean: 0,
      raw_timing_entropy: 0,
      probe_motor_continuity: 0,
      coalesced_event_ratio: 1,
      timing_kurtosis: NaN,
      velocity_curvature_r2: NaN,
    })
    expect(score).toBeLessThan(0.9)
  })

  it('excludes NaN features from scoring (unsupported browser)', () => {
    // With NaN coalesced_event_ratio, scorer should skip it entirely
    const withNaN = scoreSecretFeatures({
      velocity_autocorrelation: 0.83,
      micro_correction_rate: 0.70,
      sub_movement_count: 65,
      acceleration_asymmetry: 1.01,
      curvature_mean: 620,
      raw_timing_entropy: 5.17,
      probe_motor_continuity: 0.5,
      coalesced_event_ratio: NaN,
      timing_kurtosis: 12.0,
      velocity_curvature_r2: NaN,
    })
    // Same features but with a valid coalesced_event_ratio near baseline
    const withValid = scoreSecretFeatures({
      velocity_autocorrelation: 0.83,
      micro_correction_rate: 0.70,
      sub_movement_count: 65,
      acceleration_asymmetry: 1.01,
      curvature_mean: 620,
      raw_timing_entropy: 5.17,
      probe_motor_continuity: 0.5,
      coalesced_event_ratio: 3.0, // At baseline mean
      timing_kurtosis: 12.0,
      velocity_curvature_r2: NaN,
    })
    // NaN version should not be penalized (score should be similar or higher
    // than version with a value at the mean)
    expect(withNaN.score).toBeGreaterThan(0)
    expect(withNaN.zScores.coalesced_event_ratio).toBe(0)
  })
})

describe('K-H1: probe_motor_continuity', () => {
  it('returns NaN when no probes provided (excluded from scoring)', () => {
    const features = extractSecretFeatures(makeHumanTrace())
    expect(features.probe_motor_continuity).toBeNaN() // No probe data → excluded
  })

  it('detects motor continuity during probe window for human trace', () => {
    const events = makeHumanTrace()
    // Simulate a probe at t=2500ms (middle of trace)
    const probeTimings = [{ probe_shown_at: 2500, reaction_time_ms: 800 }]
    const features = extractSecretFeatures(events, probeTimings)
    // Human should have events in the probe window
    expect(features.probe_motor_continuity).toBeGreaterThan(0.1)
  })

  it('returns 0 when probes issued but client omits responses (empty array)', () => {
    const features = extractSecretFeatures(makeHumanTrace(), [])
    expect(features.probe_motor_continuity).toBe(0) // Empty = evasion, not excluded
  })

  it('detects zero motor activity for agent-like gap', () => {
    // Create trace with a gap at t=2500
    const events: RawEvent[] = []
    for (let i = 0; i < 300; i++) {
      const t = i * 16.67
      // Skip events in the 2000-3000ms range (simulating agent pause)
      if (t >= 2000 && t <= 3000) continue
      events.push({
        t,
        x: 0.05 + (i / 300) * 0.9,
        y: 0.05 + Math.sin(i * 0.1) * 0.05,
        type: i === 0 ? 'down' : 'move',
      })
    }
    const probeTimings = [{ probe_shown_at: 2500, reaction_time_ms: 1200 }]
    const features = extractSecretFeatures(events, probeTimings)
    expect(features.probe_motor_continuity).toBe(0)
  })
})

describe('K-H2: coalesced_event_ratio', () => {
  it('returns NaN when no coalesced_count data (excluded from scoring)', () => {
    const features = extractSecretFeatures(makeHumanTrace())
    expect(features.coalesced_event_ratio).toBeNaN()
  })

  it('computes ratio from coalesced_count', () => {
    const events: RawEvent[] = []
    for (let i = 0; i < 100; i++) {
      events.push({
        t: i * 16.67,
        x: 0.05 + (i / 100) * 0.9,
        y: 0.5,
        type: i === 0 ? 'down' : 'move',
        coalesced_count: i === 0 ? undefined : 3, // Simulating 120Hz mouse
      })
    }
    const features = extractSecretFeatures(events)
    expect(features.coalesced_event_ratio).toBeCloseTo(3, 0)
  })

  it('detects synthetic CDP dispatch (coalesced_count=1)', () => {
    const events: RawEvent[] = []
    for (let i = 0; i < 100; i++) {
      events.push({
        t: i * 16.67,
        x: 0.05 + (i / 100) * 0.9,
        y: 0.5,
        type: i === 0 ? 'down' : 'move',
        coalesced_count: 1,
      })
    }
    const features = extractSecretFeatures(events)
    expect(features.coalesced_event_ratio).toBe(1)
  })
})
