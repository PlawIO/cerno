import { describe, expect, it } from 'vitest'
import type { BehavioralFeatures } from '@cerno/core'
import { scoreBehavior } from './behavioral-scoring.js'

function humanFeatures(overrides: Partial<BehavioralFeatures> = {}): BehavioralFeatures {
  return {
    velocity_std: 0.008,
    path_efficiency: 0.35,
    pause_count: 3,
    movement_onset_ms: 800,
    jerk_std: 0.0001,
    angular_velocity_entropy: 3.5,
    sample_count: 300,
    total_duration_ms: 5000,
    ...overrides,
  }
}

describe('scoreBehavior', () => {
  it('scores perfect human baseline close to 1.0', () => {
    const score = scoreBehavior(humanFeatures())
    expect(score).toBeGreaterThan(0.8)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('penalizes very low sample count', () => {
    const normal = scoreBehavior(humanFeatures())
    const lowSamples = scoreBehavior(humanFeatures({ sample_count: 5 }))
    expect(lowSamples).toBeLessThan(normal)
    expect(lowSamples).toBeLessThan(0.5)
  })

  it('penalizes very fast completion', () => {
    const normal = scoreBehavior(humanFeatures())
    const fast = scoreBehavior(humanFeatures({ total_duration_ms: 500 }))
    expect(fast).toBeLessThan(normal)
  })

  it('scores bot-like straight line low', () => {
    const botFeatures = humanFeatures({
      velocity_std: 0.0001, // near-zero variance = constant speed
      path_efficiency: 0.99, // straight line
      pause_count: 0,
      movement_onset_ms: 0,
      jerk_std: 0,
      angular_velocity_entropy: 0.5, // low entropy
      total_duration_ms: 1000, // very fast
    })
    const score = scoreBehavior(botFeatures)
    expect(score).toBeLessThan(0.3)
  })

  it('returns score in [0, 1] range for extreme values', () => {
    const extreme = humanFeatures({
      velocity_std: 1000,
      path_efficiency: 0,
      pause_count: 1000,
      movement_onset_ms: 100000,
      jerk_std: 1000,
      angular_velocity_entropy: 100,
    })
    const score = scoreBehavior(extreme)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('returns 0 for completely empty features', () => {
    const score = scoreBehavior(humanFeatures({
      velocity_std: 0,
      path_efficiency: 0,
      pause_count: 0,
      movement_onset_ms: 0,
      jerk_std: 0,
      angular_velocity_entropy: 0,
      sample_count: 0,
      total_duration_ms: 0,
    }))
    expect(score).toBe(0)
  })
})
