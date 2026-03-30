import { describe, expect, it } from 'vitest'
import { extractFeatures } from './feature-extractor.js'
import type { RawEvent } from './types.js'

function makeHumanLikeTrace(): RawEvent[] {
  // Simulate a human-like maze trace: ~5 seconds, moderate speed,
  // some pauses at decision points, varied velocity, direction changes
  const events: RawEvent[] = []
  const duration = 5000
  const steps = 300
  const dt = duration / steps

  let x = 0.05
  let y = 0.05
  let t = 0

  events.push({ t: 0, x, y, type: 'down' })

  // Add movement onset delay
  for (let i = 0; i < 30; i++) {
    t += dt
    events.push({ t, x, y, type: 'move' })
  }

  // Trace a winding path with natural variation
  for (let i = 0; i < steps - 30; i++) {
    t += dt

    // Add natural jitter and speed variation
    const phase = i / (steps - 30)
    const speed = 0.002 + Math.sin(i * 0.1) * 0.001

    // Mostly move right and down with variation
    if (i % 40 < 20) {
      x += speed + (Math.random() - 0.5) * 0.0005
    } else {
      y += speed + (Math.random() - 0.5) * 0.0005
    }

    // Add pauses at "decision points"
    if (i % 60 === 0 && i > 0) {
      for (let p = 0; p < 8; p++) {
        t += dt
        events.push({ t, x: x + (Math.random() - 0.5) * 0.0001, y: y + (Math.random() - 0.5) * 0.0001, type: 'move' })
      }
    }

    x = Math.max(0, Math.min(1, x))
    y = Math.max(0, Math.min(1, y))
    events.push({ t, x, y, type: 'move' })
  }

  events.push({ t, x, y, type: 'up' })
  return events
}

function makeBotStraightLine(): RawEvent[] {
  // Bot: perfectly straight line, constant velocity, no pauses, instant start
  const events: RawEvent[] = []
  const steps = 100
  const dt = 30 // Very fast, 3 seconds total

  for (let i = 0; i < steps; i++) {
    const t = i * dt
    const progress = i / (steps - 1)
    events.push({
      t,
      x: 0.05 + progress * 0.9,
      y: 0.05 + progress * 0.9,
      type: i === 0 ? 'down' : i === steps - 1 ? 'up' : 'move',
    })
  }
  return events
}

describe('extractFeatures', () => {
  it('returns zeroed features for empty events', () => {
    const features = extractFeatures([])
    expect(features.velocity_std).toBe(0)
    expect(features.path_efficiency).toBe(0)
    expect(features.pause_count).toBe(0)
    expect(features.sample_count).toBe(0)
  })

  it('returns zeroed features for single event', () => {
    const features = extractFeatures([{ t: 0, x: 0.5, y: 0.5, type: 'down' }])
    expect(features.velocity_std).toBe(0)
    expect(features.sample_count).toBe(1)
  })

  it('extracts reasonable features from human-like trace', () => {
    const events = makeHumanLikeTrace()
    const features = extractFeatures(events)

    expect(features.sample_count).toBeGreaterThan(10)
    expect(features.total_duration_ms).toBeGreaterThan(1000)
    expect(features.velocity_std).toBeGreaterThan(0)
    expect(features.path_efficiency).toBeGreaterThan(0)
    expect(features.path_efficiency).toBeLessThanOrEqual(1)
    expect(features.pause_count).toBeGreaterThanOrEqual(0)
    expect(features.movement_onset_ms).toBeGreaterThanOrEqual(0)
    expect(features.angular_velocity_entropy).toBeGreaterThan(0)
  })

  it('bot straight-line has high path efficiency (close to 1)', () => {
    const events = makeBotStraightLine()
    const features = extractFeatures(events)

    // Straight line has very high path efficiency (near 1.0)
    expect(features.path_efficiency).toBeGreaterThan(0.9)
    // Very low pause count
    expect(features.pause_count).toBeLessThanOrEqual(1)
    // Near-zero movement onset (starts immediately)
    expect(features.movement_onset_ms).toBeLessThan(100)
  })

  it('human trace has lower path efficiency than bot', () => {
    const human = extractFeatures(makeHumanLikeTrace())
    const bot = extractFeatures(makeBotStraightLine())

    // Human takes a winding path, bot goes straight
    expect(human.path_efficiency).toBeLessThan(bot.path_efficiency)
  })

  it('human trace has more angular velocity entropy than bot', () => {
    const human = extractFeatures(makeHumanLikeTrace())
    const bot = extractFeatures(makeBotStraightLine())

    // Human changes direction more randomly
    expect(human.angular_velocity_entropy).toBeGreaterThan(
      bot.angular_velocity_entropy,
    )
  })

  it('extracts timing_cv for human trace', () => {
    const events = makeHumanLikeTrace()
    const features = extractFeatures(events)

    // Human timing has measurable variance (CV > 0)
    expect(features.timing_cv).toBeGreaterThan(0)
    // But not wildly unstable
    expect(features.timing_cv).toBeLessThan(5)
  })

  it('bot constant-speed has low timing_cv', () => {
    const bot = extractFeatures(makeBotStraightLine())
    const human = extractFeatures(makeHumanLikeTrace())

    // Constant-speed bot has very regular timing after resampling
    // Human has more timing variation
    expect(bot.timing_cv).toBeLessThan(human.timing_cv)
  })

  it('handles high-frequency events (120Hz → resampled to 60Hz)', () => {
    // 120Hz input: events every ~8.3ms
    const events: RawEvent[] = []
    for (let i = 0; i < 600; i++) {
      events.push({
        t: i * 8.33,
        x: 0.1 + (i / 600) * 0.8 + Math.sin(i * 0.05) * 0.02,
        y: 0.1 + (i / 600) * 0.8 + Math.cos(i * 0.05) * 0.02,
        type: i === 0 ? 'down' : i === 599 ? 'up' : 'move',
      })
    }
    const features = extractFeatures(events)

    // Should process without error and produce valid features
    expect(features.sample_count).toBeGreaterThan(0)
    // Resampled count should be roughly half of input (60Hz vs 120Hz)
    expect(features.sample_count).toBeLessThan(events.length)
    expect(features.velocity_std).toBeGreaterThan(0)
  })

  it('does not crash on two events', () => {
    const features = extractFeatures([
      { t: 0, x: 0.1, y: 0.1, type: 'down' },
      { t: 1000, x: 0.9, y: 0.9, type: 'up' },
    ])
    expect(features.sample_count).toBeGreaterThanOrEqual(2)
    expect(features.path_efficiency).toBeGreaterThan(0)
  })

  it('filters to only movement events', () => {
    const events: RawEvent[] = [
      { t: 0, x: 0.1, y: 0.1, type: 'down' },
      { t: 100, x: 0.2, y: 0.2, type: 'move' },
      { t: 200, x: 0.3, y: 0.3, type: 'keydown', key: 'ArrowRight' },
      { t: 300, x: 0.4, y: 0.4, type: 'move' },
      { t: 400, x: 0.5, y: 0.5, type: 'up' },
    ]
    const features = extractFeatures(events)
    // Should handle mixed event types without crashing
    expect(features.sample_count).toBeGreaterThan(0)
  })
})
