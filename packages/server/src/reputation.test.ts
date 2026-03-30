import { describe, expect, it, beforeEach } from 'vitest'
import { queryReputation, updateReputation, computeConsistencyBonus, reputationKey } from './reputation.js'
import { MemoryStore } from './store.js'
import type { BehavioralFeatures } from '@cernosh/core'

const baseFeatures: BehavioralFeatures = {
  velocity_std: 0.0004,
  path_efficiency: 0.35,
  pause_count: 3,
  movement_onset_ms: 800,
  jerk_std: 5e-7,
  angular_velocity_entropy: 3.5,
  timing_cv: 0.5,
  sample_count: 200,
  total_duration_ms: 5000,
}

describe('reputation', () => {
  let store: MemoryStore
  const key = reputationKey('test-hash')

  beforeEach(() => {
    store = new MemoryStore()
  })

  it('returns 0.5 for unknown user', async () => {
    const trust = await queryReputation(store, key)
    expect(trust).toBe(0.5)
  })

  it('initializes reputation on first session', async () => {
    await updateReputation(store, key, 0.8, baseFeatures, 60000)
    const trust = await queryReputation(store, key)
    expect(trust).toBe(0.8)
  })

  it('blends reputation across sessions', async () => {
    await updateReputation(store, key, 0.8, baseFeatures, 60000)
    await updateReputation(store, key, 0.9, baseFeatures, 60000)
    const trust = await queryReputation(store, key)
    // Should be blended, not just 0.9
    expect(trust).toBeGreaterThan(0.7)
    expect(trust).toBeLessThanOrEqual(1)
  })

  it('reputationKey produces consistent keys', () => {
    expect(reputationKey('abc')).toBe('rep:abc')
    expect(reputationKey('abc')).toBe(reputationKey('abc'))
  })
})

describe('computeConsistencyBonus', () => {
  it('returns 0 for first session', () => {
    const bonus = computeConsistencyBonus(baseFeatures, {
      trust_score: 0.8,
      session_count: 1,
      feature_means: baseFeatures,
      last_seen: Date.now(),
    })
    expect(bonus).toBe(0)
  })

  it('returns positive bonus for consistent behavior', () => {
    const bonus = computeConsistencyBonus(baseFeatures, {
      trust_score: 0.8,
      session_count: 10,
      feature_means: baseFeatures, // Identical = max consistency
      last_seen: Date.now(),
    })
    expect(bonus).toBeGreaterThan(0)
    expect(bonus).toBeLessThanOrEqual(0.1)
  })

  it('returns lower bonus for inconsistent behavior', () => {
    const differentFeatures = {
      ...baseFeatures,
      velocity_std: 0.002, // Very different
      path_efficiency: 0.8, // Very different
    }
    const bonus = computeConsistencyBonus(differentFeatures, {
      trust_score: 0.8,
      session_count: 10,
      feature_means: baseFeatures,
      last_seen: Date.now(),
    })
    // Should be lower than consistent case
    const consistentBonus = computeConsistencyBonus(baseFeatures, {
      trust_score: 0.8,
      session_count: 10,
      feature_means: baseFeatures,
      last_seen: Date.now(),
    })
    expect(bonus).toBeLessThan(consistentBonus)
  })
})
