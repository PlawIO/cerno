import type { ClientSignals } from './types.js'

const DEFAULT_MIN = 14
const DEFAULT_MAX = 24

/**
 * Compute adaptive PoW difficulty based on client signals.
 *
 * Higher difficulty = more SHA-256 iterations = more cost for automated farming.
 * Trusted clients (high reputation, no failures) get easier PoW.
 * Suspicious clients (repeated failures, no reputation) get harder PoW.
 *
 * Each +1 bit doubles the expected work. 14 bits ≈ 16K iterations (~50ms).
 * 24 bits ≈ 16M iterations (~30-60s on mobile). That's the ceiling.
 */
export function computeAdaptiveDifficulty(
  baseDifficulty: number,
  signals: ClientSignals,
  options?: { maxDifficulty?: number; minDifficulty?: number },
): number {
  const maxDiff = options?.maxDifficulty ?? DEFAULT_MAX
  const minDiff = options?.minDifficulty ?? DEFAULT_MIN

  let difficulty = baseDifficulty

  // Failed attempts: each failure adds 1 bit of difficulty
  if (signals.failedAttempts && signals.failedAttempts > 0) {
    difficulty += Math.min(signals.failedAttempts, 4) // cap at +4 bits
  }

  // Trust score: trusted users get a discount (up to -2 bits)
  if (signals.trustScore !== undefined && signals.trustScore > 0.7) {
    const discount = Math.floor((signals.trustScore - 0.7) * (2 / 0.3))
    difficulty -= discount
  }

  // No user agent is suspicious (+1 bit), but only when we have
  // other context (like IP) indicating a real request. Empty signals = no penalty.
  if (signals.ip && !signals.userAgent) {
    difficulty += 1
  }

  return Math.max(minDiff, Math.min(maxDiff, Math.round(difficulty)))
}
