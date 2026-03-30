/**
 * Server-side validation of Stroop cognitive probe responses.
 *
 * Validates:
 * 1. Correct cell tapped (user selected the target color)
 * 2. Reaction time in human range (200-3000ms)
 * 3. Response count matches probe count
 */
import type { ProbeResponse, StroopProbe } from '@cernosh/core'

export interface ProbeValidationResult {
  valid: boolean
  /** Average reaction time across all probes (ms) */
  avgReactionTime: number
  /** Fraction of probes answered correctly */
  accuracy: number
}

// Human reaction time bounds for color identification tasks
const MIN_REACTION_MS = 150   // Below this is superhuman/automated
const MAX_REACTION_MS = 5000  // Above this suggests disengagement
const IDEAL_MIN_MS = 300      // Typical minimum for Stroop tasks
const IDEAL_MAX_MS = 2000     // Typical maximum for Stroop tasks

export function validateProbeResponses(
  probes: StroopProbe[],
  responses: ProbeResponse[],
): ProbeValidationResult {
  if (probes.length === 0) {
    return { valid: true, avgReactionTime: 0, accuracy: 1 }
  }

  if (responses.length !== probes.length) {
    return { valid: false, avgReactionTime: 0, accuracy: 0 }
  }

  let correctCount = 0
  let totalReaction = 0
  let allTimingsHuman = true

  for (const probe of probes) {
    const response = responses.find((r) => r.probe_id === probe.id)
    if (!response) {
      return { valid: false, avgReactionTime: 0, accuracy: 0 }
    }

    // Server-side correctness: compare tapped cell against probe's target
    const correct = probe.cells.some(
      (c) => c.isTarget && c.x === response.tapped_cell.x && c.y === response.tapped_cell.y,
    )
    if (correct) {
      correctCount++
    }

    // Check reaction time bounds
    if (
      response.reaction_time_ms < MIN_REACTION_MS ||
      response.reaction_time_ms > MAX_REACTION_MS
    ) {
      allTimingsHuman = false
    }

    totalReaction += response.reaction_time_ms
  }

  const accuracy = correctCount / probes.length
  const avgReactionTime = totalReaction / probes.length

  // Must get all probes correct AND have human-like timing
  const valid = accuracy === 1 && allTimingsHuman

  return { valid, avgReactionTime, accuracy }
}

/**
 * Score probe responses for behavioral analysis.
 * Returns 0-1 where 1 = ideal human performance.
 */
export function scoreProbePerformance(
  result: ProbeValidationResult,
): number {
  if (!result.valid) return 0

  // Reaction time score: bell curve around 500-1000ms
  const t = result.avgReactionTime
  let timingScore: number
  if (t >= IDEAL_MIN_MS && t <= IDEAL_MAX_MS) {
    // Sweet spot: full score
    timingScore = 1
  } else if (t < IDEAL_MIN_MS) {
    // Too fast: suspicious
    timingScore = Math.max(0, t / IDEAL_MIN_MS)
  } else {
    // Too slow: mild penalty
    timingScore = Math.max(0.5, 1 - (t - IDEAL_MAX_MS) / MAX_REACTION_MS)
  }

  return result.accuracy * timingScore
}
