import { describe, expect, it } from 'vitest'
import type { BehavioralFeatures, MazeProfile } from '@cerno/core'
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

  it('returns 0 for NaN features (prevents NaN bypass)', () => {
    const score = scoreBehavior(humanFeatures({
      velocity_std: NaN,
      jerk_std: NaN,
    }))
    expect(score).toBe(0)
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

  it('backward compat: works without maze profile', () => {
    const withProfile = scoreBehavior(humanFeatures(), undefined)
    const withoutProfile = scoreBehavior(humanFeatures())
    expect(withProfile).toBe(withoutProfile)
    expect(withProfile).toBeGreaterThan(0.5)
  })
})

describe('scoreBehavior with MazeProfile (maze-relative)', () => {
  const simpleProfile: MazeProfile = {
    solutionLength: 12,
    decisionPointCount: 3,
    turnCount: 6,
    optimalEfficiency: 0.6,
  }

  const complexProfile: MazeProfile = {
    solutionLength: 30,
    decisionPointCount: 10,
    turnCount: 18,
    optimalEfficiency: 0.25,
  }

  it('adapts path_efficiency baseline to maze topology', () => {
    // Human with efficiency ~0.54 (90% of optimal 0.6) should score well on simple maze
    const features = humanFeatures({ path_efficiency: 0.54 })
    const simpleScore = scoreBehavior(features, simpleProfile)

    // Same efficiency on a complex maze (where optimal is 0.25) should score worse
    // because 0.54 is way above the expected ~0.225
    const complexScore = scoreBehavior(features, complexProfile)

    expect(simpleScore).toBeGreaterThan(complexScore)
  })

  it('adapts pause_count baseline to decision points', () => {
    // Control for confounds: set path_efficiency and angular_velocity_entropy
    // to match the simple profile so only pause_count drives the difference
    const fewPauses = humanFeatures({
      pause_count: 2,
      path_efficiency: 0.54,          // matches simple baseline (0.6 * 0.9)
      angular_velocity_entropy: 1.9,  // matches simple baseline (1.0 + 6*0.15)
    })
    const simpleScore = scoreBehavior(fewPauses, simpleProfile)

    // Same features on complex maze: all three topology features now mismatch
    // (pause: 2 vs expected 6, path_eff: 0.54 vs expected 0.225, entropy: 1.9 vs expected 3.7)
    const complexScore = scoreBehavior(fewPauses, complexProfile)

    expect(simpleScore).toBeGreaterThan(complexScore)
  })

  it('adapts angular entropy baseline to turn count', () => {
    // Low angular entropy is more suspicious in a maze with many turns
    const lowEntropy = humanFeatures({ angular_velocity_entropy: 1.5 })
    const simpleScore = scoreBehavior(lowEntropy, simpleProfile)
    const complexScore = scoreBehavior(lowEntropy, complexProfile)

    // Simple maze (6 turns) expects ~1.9 entropy, complex (18 turns) expects ~3.7
    // So 1.5 is closer to expected on simple maze
    expect(simpleScore).toBeGreaterThan(complexScore)
  })

  it('motor control features remain constant regardless of maze', () => {
    // Bot with constant velocity (zero std) should score equally bad on both mazes
    const botMotor = humanFeatures({
      velocity_std: 0.0001,
      jerk_std: 0,
      movement_onset_ms: 0,
    })
    const simpleScore = scoreBehavior(botMotor, simpleProfile)
    const complexScore = scoreBehavior(botMotor, complexProfile)

    // Both should be low, and the motor-control portion should be identical
    // (topology-dependent features differ, but motor features dominate with higher weight)
    expect(simpleScore).toBeLessThan(0.5)
    expect(complexScore).toBeLessThan(0.5)
  })

  it('human-like features score high with matching maze profile', () => {
    // Features that match what we'd expect from the simple maze
    const matched = humanFeatures({
      path_efficiency: 0.54, // ~90% of 0.6 optimal
      pause_count: 2,        // ~60% of 3 decision points
      angular_velocity_entropy: 2.0, // close to 1.0 + 6*0.15 = 1.9
    })
    const score = scoreBehavior(matched, simpleProfile)
    expect(score).toBeGreaterThan(0.7)
  })
})
