import { describe, expect, it } from 'vitest'
import { validateProbeResponses, scoreProbePerformance } from './probe-validator.js'
import type { StroopProbe, ProbeResponse } from '@cernosh/core'

function makeProbe(id = 'probe-1'): StroopProbe {
  return {
    id,
    type: 'color_tap',
    instruction: 'Tap the blue cell',
    target_color: '#3b82f6',
    distractor_colors: ['#ef4444', '#22c55e'],
    cells: [
      { x: 3, y: 4, color: '#3b82f6', isTarget: true },
      { x: 4, y: 4, color: '#ef4444', isTarget: false },
      { x: 3, y: 5, color: '#22c55e', isTarget: false },
    ],
    trigger_cell: { x: 3, y: 3 },
  }
}

describe('validateProbeResponses', () => {
  it('passes with no probes', () => {
    const result = validateProbeResponses([], [])
    expect(result.valid).toBe(true)
    expect(result.accuracy).toBe(1)
  })

  it('fails with mismatched probe/response count', () => {
    const result = validateProbeResponses([makeProbe()], [])
    expect(result.valid).toBe(false)
  })

  it('passes with correct response and human timing', () => {
    const probe = makeProbe()
    const response: ProbeResponse = {
      probe_id: 'probe-1',
      tapped_cell: { x: 3, y: 4 },
      reaction_time_ms: 600,
    }
    const result = validateProbeResponses([probe], [response])
    expect(result.valid).toBe(true)
    expect(result.accuracy).toBe(1)
    expect(result.avgReactionTime).toBe(600)
  })

  it('fails with incorrect cell tapped', () => {
    const probe = makeProbe()
    const response: ProbeResponse = {
      probe_id: 'probe-1',
      tapped_cell: { x: 4, y: 4 }, // Wrong cell
      reaction_time_ms: 600,
    }
    const result = validateProbeResponses([probe], [response])
    expect(result.valid).toBe(false)
    expect(result.accuracy).toBe(0)
  })

  it('fails with superhuman reaction time (<150ms)', () => {
    const probe = makeProbe()
    const response: ProbeResponse = {
      probe_id: 'probe-1',
      tapped_cell: { x: 3, y: 4 },
      reaction_time_ms: 50, // Too fast
    }
    const result = validateProbeResponses([probe], [response])
    expect(result.valid).toBe(false) // Correct but timing suspicious
  })

  it('fails with extremely slow reaction time (>5000ms)', () => {
    const probe = makeProbe()
    const response: ProbeResponse = {
      probe_id: 'probe-1',
      tapped_cell: { x: 3, y: 4 },
      reaction_time_ms: 6000, // Too slow
    }
    const result = validateProbeResponses([probe], [response])
    expect(result.valid).toBe(false)
  })

  it('validates multiple probes', () => {
    const p1 = makeProbe('p1')
    const p2 = makeProbe('p2')
    const responses: ProbeResponse[] = [
      { probe_id: 'p1', tapped_cell: { x: 3, y: 4 }, reaction_time_ms: 500 },
      { probe_id: 'p2', tapped_cell: { x: 3, y: 4 }, reaction_time_ms: 700 },
    ]
    const result = validateProbeResponses([p1, p2], responses)
    expect(result.valid).toBe(true)
    expect(result.avgReactionTime).toBe(600)
  })
})

describe('scoreProbePerformance', () => {
  it('returns 0 for invalid result', () => {
    expect(scoreProbePerformance({ valid: false, avgReactionTime: 0, accuracy: 0 })).toBe(0)
  })

  it('returns high score for ideal timing', () => {
    const score = scoreProbePerformance({ valid: true, avgReactionTime: 600, accuracy: 1 })
    expect(score).toBe(1)
  })

  it('returns lower score for slow but valid timing', () => {
    const score = scoreProbePerformance({ valid: true, avgReactionTime: 3000, accuracy: 1 })
    expect(score).toBeLessThan(1)
    expect(score).toBeGreaterThan(0)
  })
})
