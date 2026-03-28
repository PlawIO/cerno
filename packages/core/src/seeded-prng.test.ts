import { describe, expect, it } from 'vitest'
import { mulberry32 } from './seeded-prng.js'

describe('mulberry32', () => {
  it('produces deterministic output for the same seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const valuesA = Array.from({ length: 100 }, () => a())
    const valuesB = Array.from({ length: 100 }, () => b())
    expect(valuesA).toEqual(valuesB)
  })

  it('produces different output for different seeds', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    const valA = a()
    const valB = b()
    expect(valA).not.toEqual(valB)
  })

  it('produces values in [0, 1)', () => {
    const rand = mulberry32(12345)
    for (let i = 0; i < 10000; i++) {
      const v = rand()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('has reasonable distribution (chi-squared rough check)', () => {
    const rand = mulberry32(99)
    const buckets = new Array(10).fill(0)
    const N = 10000
    for (let i = 0; i < N; i++) {
      const bin = Math.floor(rand() * 10)
      buckets[bin]++
    }
    const expected = N / 10
    for (const count of buckets) {
      // Each bucket should be within 20% of expected
      expect(count).toBeGreaterThan(expected * 0.8)
      expect(count).toBeLessThan(expected * 1.2)
    }
  })
})
