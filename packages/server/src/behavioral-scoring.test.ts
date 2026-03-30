import { describe, expect, it } from 'vitest'
import type { BehavioralFeatures, MazeProfile } from '@cernosh/core'
import type { ScoringConfig } from './types.js'
import { scoreBehavior } from './behavioral-scoring.js'

function humanFeatures(overrides: Partial<BehavioralFeatures> = {}): BehavioralFeatures {
  return {
    velocity_std: 0.0004,
    path_efficiency: 0.35,
    pause_count: 5,
    movement_onset_ms: 1200,
    jerk_std: 5e-7,
    angular_velocity_entropy: 1.5,
    timing_cv: 0.5,
    sample_count: 300,
    total_duration_ms: 5000,
    ...overrides,
  }
}

describe('scoreBehavior', () => {
  it('scores perfect human baseline close to 1.0', () => {
    const { score } = scoreBehavior(humanFeatures())
    expect(score).toBeGreaterThan(0.8)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('penalizes very low sample count', () => {
    const { score: normal } = scoreBehavior(humanFeatures())
    const { score: lowSamples } = scoreBehavior(humanFeatures({ sample_count: 5 }))
    expect(lowSamples).toBeLessThan(normal)
    expect(lowSamples).toBeLessThan(0.5)
  })

  it('penalizes very fast completion', () => {
    const { score: normal } = scoreBehavior(humanFeatures())
    const { score: fast } = scoreBehavior(humanFeatures({ total_duration_ms: 500 }))
    expect(fast).toBeLessThan(normal)
  })

  it('scores bot-like straight line low', () => {
    const botFeatures = humanFeatures({
      velocity_std: 0.00001,
      path_efficiency: 0.99,
      pause_count: 0,
      movement_onset_ms: 0,
      jerk_std: 0,
      angular_velocity_entropy: 0.5,
      timing_cv: 0.01,
      total_duration_ms: 1000,
    })
    const { score } = scoreBehavior(botFeatures)
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
    const { score } = scoreBehavior(extreme)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('returns 0 for NaN features (prevents NaN bypass)', () => {
    const { score } = scoreBehavior(humanFeatures({
      velocity_std: NaN,
      jerk_std: NaN,
    }))
    expect(score).toBe(0)
  })

  it('returns 0 for completely empty features', () => {
    const { score } = scoreBehavior(humanFeatures({
      velocity_std: 0,
      path_efficiency: 0,
      pause_count: 0,
      movement_onset_ms: 0,
      jerk_std: 0,
      angular_velocity_entropy: 0,
      timing_cv: 0,
      sample_count: 0,
      total_duration_ms: 0,
    }))
    expect(score).toBe(0)
  })

  it('backward compat: works without maze profile', () => {
    const { score: withProfile } = scoreBehavior(humanFeatures(), undefined)
    const { score: withoutProfile } = scoreBehavior(humanFeatures())
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
    const features = humanFeatures({
      path_efficiency: 0.54,
      pause_count: 1.8,
      angular_velocity_entropy: 1.9,
    })
    const { score: simpleScore } = scoreBehavior(features, simpleProfile)
    const { score: complexScore } = scoreBehavior(features, complexProfile)

    expect(simpleScore).toBeGreaterThan(complexScore)
  })

  it('adapts pause_count baseline to decision points', () => {
    const fewPauses = humanFeatures({
      pause_count: 2,
      path_efficiency: 0.54,
      angular_velocity_entropy: 1.9,
    })
    const { score: simpleScore } = scoreBehavior(fewPauses, simpleProfile)
    const { score: complexScore } = scoreBehavior(fewPauses, complexProfile)

    expect(simpleScore).toBeGreaterThan(complexScore)
  })

  it('adapts angular entropy baseline to turn count', () => {
    const lowEntropy = humanFeatures({ angular_velocity_entropy: 1.5 })
    const { score: simpleScore } = scoreBehavior(lowEntropy, simpleProfile)
    const { score: complexScore } = scoreBehavior(lowEntropy, complexProfile)

    expect(simpleScore).toBeGreaterThan(complexScore)
  })

  it('motor control features remain constant regardless of maze', () => {
    const botMotor = humanFeatures({
      velocity_std: 0.00001,
      jerk_std: 0,
      movement_onset_ms: 0,
    })
    const { score: humanSimple } = scoreBehavior(humanFeatures(), simpleProfile)
    const { score: botSimple } = scoreBehavior(botMotor, simpleProfile)
    const { score: botComplex } = scoreBehavior(botMotor, complexProfile)

    expect(botSimple).toBeLessThan(humanSimple)
    expect(botSimple).not.toBe(botComplex)
  })

  it('human-like features score high with matching maze profile', () => {
    const matched = humanFeatures({
      path_efficiency: 0.54,
      pause_count: 2,
      angular_velocity_entropy: 2.0,
    })
    const { score } = scoreBehavior(matched, simpleProfile)
    expect(score).toBeGreaterThan(0.7)
  })
})

describe('scoreBehavior with ScoringConfig (Phase G)', () => {
  it('ScoringConfig overrides motor baselines', () => {
    const features = humanFeatures()
    const { score: defaultScore } = scoreBehavior(features)

    // Override velocity_std baseline to something very different
    const config: ScoringConfig = {
      motorBaselines: {
        mouse: {
          velocity_std: { mean: 0.01, std: 0.005, weight: 1.0 },
        },
      },
    }
    const { score: overriddenScore } = scoreBehavior(features, undefined, undefined, config)

    // Score should differ because baseline moved far from the feature value
    expect(overriddenScore).not.toBe(defaultScore)
  })

  it('ScoringConfig overrides maze-relative multipliers', () => {
    const profile: MazeProfile = {
      solutionLength: 12,
      decisionPointCount: 3,
      turnCount: 6,
      optimalEfficiency: 0.6,
    }
    const features = humanFeatures({ path_efficiency: 0.54 })

    const { score: defaultScore } = scoreBehavior(features, profile)

    const config: ScoringConfig = {
      mazeRelative: { pathEfficiencyMeanRatio: 0.5 },
    }
    const { score: overriddenScore } = scoreBehavior(features, profile, undefined, config)

    expect(overriddenScore).not.toBe(defaultScore)
  })

  it('ScoringConfig overrides gaussianK', () => {
    // Use features with moderate deviation so k matters
    const features = humanFeatures({
      velocity_std: 0.001, // ~2 std from mean
      jerk_std: 1e-6,      // ~1 std from mean
    })
    const { score: k3Score } = scoreBehavior(features, undefined, undefined, { gaussianK: 3 })
    const { score: k1Score } = scoreBehavior(features, undefined, undefined, { gaussianK: 1 })

    // Tighter k penalizes deviations harder
    expect(k1Score).toBeLessThan(k3Score)
  })

  it('scoreBehavior returns zScores', () => {
    const { zScores } = scoreBehavior(humanFeatures())
    expect(zScores).toHaveProperty('velocity_std')
    expect(zScores).toHaveProperty('path_efficiency')
    expect(zScores).toHaveProperty('pause_count')
    expect(zScores).toHaveProperty('movement_onset_ms')
    expect(zScores).toHaveProperty('jerk_std')
    expect(zScores).toHaveProperty('angular_velocity_entropy')
    expect(zScores).toHaveProperty('timing_cv')
    // z-scores should be non-negative (absolute values)
    for (const z of Object.values(zScores)) {
      expect(z).toBeGreaterThanOrEqual(0)
    }
  })
})
