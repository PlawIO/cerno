import { describe, expect, it } from 'vitest'
import { computeAdaptiveDifficulty } from './adaptive-pow.js'

describe('computeAdaptiveDifficulty', () => {
  it('returns base difficulty with no signals', () => {
    expect(computeAdaptiveDifficulty(18, {})).toBe(18)
  })

  it('increases difficulty on failed attempts', () => {
    expect(computeAdaptiveDifficulty(18, { failedAttempts: 1, userAgent: 'test' })).toBe(19)
    expect(computeAdaptiveDifficulty(18, { failedAttempts: 3, userAgent: 'test' })).toBe(21)
  })

  it('caps failed attempt penalty at +4', () => {
    expect(computeAdaptiveDifficulty(18, { failedAttempts: 10, userAgent: 'test' })).toBe(22)
  })

  it('decreases difficulty for trusted users', () => {
    expect(computeAdaptiveDifficulty(18, { trustScore: 0.9, userAgent: 'test' })).toBe(17)
    expect(computeAdaptiveDifficulty(18, { trustScore: 1.0, userAgent: 'test' })).toBe(16)
  })

  it('does not discount below 0.7 trust', () => {
    expect(computeAdaptiveDifficulty(18, { trustScore: 0.5, userAgent: 'test' })).toBe(18)
  })

  it('adds 1 bit for missing user agent when IP is present', () => {
    expect(computeAdaptiveDifficulty(18, { ip: '1.2.3.4' })).toBe(19)
    expect(computeAdaptiveDifficulty(18, { ip: '1.2.3.4', userAgent: 'Mozilla' })).toBe(18)
  })

  it('does not penalize missing UA when no signals present', () => {
    expect(computeAdaptiveDifficulty(18, {})).toBe(18)
  })

  it('clamps to max difficulty', () => {
    expect(computeAdaptiveDifficulty(22, { failedAttempts: 10 }, { maxDifficulty: 24 })).toBe(24)
  })

  it('clamps to min difficulty', () => {
    expect(computeAdaptiveDifficulty(14, { trustScore: 1.0 }, { minDifficulty: 14 })).toBe(14)
  })

  it('combines multiple signals', () => {
    // Failed attempts (+2) + no UA with IP (+1) = 18 + 3 = 21
    const difficulty = computeAdaptiveDifficulty(18, {
      failedAttempts: 2,
      ip: '1.2.3.4',
    })
    expect(difficulty).toBe(21)
  })
})
