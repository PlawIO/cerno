/**
 * Cross-session behavioral reputation (Phase 3).
 *
 * Builds a trust profile over time. Same human solving multiple challenges
 * accumulates trust. Behavioral consistency across sessions is extremely
 * hard to fake at scale.
 *
 * This is Cerno's software equivalent of World.org's iris hash:
 * not "do you have a body" but "do you behave consistently like the
 * same human over time."
 */
import type { BehavioralFeatures } from '@cernosh/core'
import type { CaptchaStore, ReputationData } from './types.js'

const DEFAULT_REPUTATION_TTL = 30 * 24 * 60 * 60 * 1000 // 30 days
const TRUST_DECAY = 0.95 // EMA decay factor per session

const FINGERPRINT_KEYS: Array<keyof BehavioralFeatures> = [
  'velocity_std',
  'path_efficiency',
  'pause_count',
  'jerk_std',
  'angular_velocity_entropy',
  'timing_cv',
]

/**
 * Compute a reputation key from a session identifier.
 * In production, this would be derived from IP + user agent hash,
 * or a device fingerprint. For now, use the public_key_hash
 * (different per session) or a consumer-provided key.
 */
export function reputationKey(publicKeyHash: string): string {
  return `rep:${publicKeyHash}`
}

/**
 * Query the trust score for a session. Returns 0.5 (neutral) if unknown.
 */
export async function queryReputation(
  store: CaptchaStore,
  key: string,
): Promise<number> {
  if (!store.getReputation) return 0.5
  const data = await store.getReputation(key)
  if (!data) return 0.5

  // Decay trust if stale (more than 7 days since last seen)
  const staleDays = (Date.now() - data.last_seen) / (24 * 60 * 60 * 1000)
  if (staleDays > 7) {
    const decayFactor = Math.pow(0.9, staleDays / 7)
    return data.trust_score * decayFactor
  }

  return data.trust_score
}

/**
 * Update reputation after a validated session.
 * Uses exponential moving average to blend new score with history.
 */
export async function updateReputation(
  store: CaptchaStore,
  key: string,
  score: number,
  features: BehavioralFeatures,
  ttlMs?: number,
): Promise<void> {
  if (!store.setReputation || !store.getReputation) return

  const existing = await store.getReputation(key)
  const ttl = ttlMs ?? DEFAULT_REPUTATION_TTL

  if (!existing) {
    // First session: initialize
    const featureMeans: Partial<BehavioralFeatures> = {}
    for (const k of FINGERPRINT_KEYS) {
      featureMeans[k] = features[k]
    }
    await store.setReputation(key, {
      trust_score: score,
      session_count: 1,
      feature_means: featureMeans,
      last_seen: Date.now(),
    }, ttl)
    return
  }

  // Blend new features with historical means (EMA)
  const newMeans: Partial<BehavioralFeatures> = {}
  for (const k of FINGERPRINT_KEYS) {
    const prev = existing.feature_means[k] ?? features[k]
    newMeans[k] = prev * TRUST_DECAY + features[k] * (1 - TRUST_DECAY)
  }

  // Behavioral consistency bonus: if features are close to historical means,
  // this person behaves consistently = more trust
  let consistencyBonus = 0
  let comparisons = 0
  for (const k of FINGERPRINT_KEYS) {
    const mean = existing.feature_means[k]
    if (mean !== undefined && mean !== 0) {
      const deviation = Math.abs(features[k] - mean) / Math.abs(mean)
      // Low deviation = high consistency
      consistencyBonus += Math.exp(-deviation * 2)
      comparisons++
    }
  }
  const consistency = comparisons > 0 ? consistencyBonus / comparisons : 0.5

  // Blend: 60% session score, 20% historical trust, 20% consistency
  const blendedScore = score * 0.6 + existing.trust_score * 0.2 + consistency * 0.2

  await store.setReputation(key, {
    trust_score: Math.max(0, Math.min(1, blendedScore)),
    session_count: existing.session_count + 1,
    feature_means: newMeans,
    last_seen: Date.now(),
  }, ttl)
}

/**
 * Compute a consistency score between current features and historical fingerprint.
 * High consistency + good history = strong signal of same human.
 */
export function computeConsistencyBonus(
  features: BehavioralFeatures,
  reputation: ReputationData,
): number {
  if (reputation.session_count < 2) return 0 // Need history

  let totalSim = 0
  let count = 0

  for (const k of FINGERPRINT_KEYS) {
    const mean = reputation.feature_means[k]
    if (mean !== undefined && mean !== 0) {
      const deviation = Math.abs(features[k] - mean) / Math.abs(mean)
      totalSim += Math.exp(-deviation * 2)
      count++
    }
  }

  if (count === 0) return 0

  const avgSimilarity = totalSim / count
  // Scale by session count (more history = more confidence)
  const confidenceWeight = Math.min(reputation.session_count / 10, 1)

  return avgSimilarity * confidenceWeight * 0.1 // Max +0.1 bonus
}
