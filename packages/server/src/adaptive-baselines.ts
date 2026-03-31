/**
 * Adaptive baselines — Phase 1: Welford online statistics collection.
 *
 * Collects running mean/variance for all secret features from high-confidence
 * human validation sessions. No shadow scoring, no enforcement. Just data
 * collection for future baseline calibration.
 *
 * Welford's algorithm: numerically stable single-pass online mean/variance.
 * See Knuth TAOCP Vol 2, 3rd ed, p.232.
 */
import type { InputMode } from '@cernosh/core'
import type { AdaptiveState, CaptchaStore } from './types.js'
import type { SecretFeatures } from './secret-features.js'

/** Minimum score threshold for a sample to be considered high-confidence human */
const QUALITY_GATE_SCORE = 0.80

/** Apply one Welford update step */
function welfordUpdate(state: AdaptiveState, value: number): AdaptiveState {
  const count = state.count + 1
  const delta = value - state.mean
  const mean = state.mean + delta / count
  const delta2 = value - mean
  const m2 = state.m2 + delta * delta2
  return { ...state, count, mean, m2, last_updated: Date.now() }
}

/** Derive variance from Welford state. Returns 0 if count < 2. */
export function welfordVariance(state: AdaptiveState): number {
  return state.count >= 2 ? state.m2 / (state.count - 1) : 0
}

/** Derive standard deviation from Welford state. */
export function welfordStd(state: AdaptiveState): number {
  return Math.sqrt(welfordVariance(state))
}

/** Storage key for a feature's adaptive state */
function adaptiveKey(featureKey: string, inputType: string): string {
  return `adaptive:${inputType}:${featureKey}`
}

/**
 * Update adaptive baselines for all secret features from a validated session.
 * Only accepts high-confidence human samples (score > QUALITY_GATE_SCORE).
 * Skips NaN feature values (unsupported APIs, missing data).
 */
export async function updateAdaptiveBaselines(
  store: CaptchaStore,
  features: SecretFeatures,
  inputType: InputMode,
  score: number,
): Promise<void> {
  if (score < QUALITY_GATE_SCORE) return
  if (!store.setAdaptiveState || !store.getAdaptiveState) return

  const keys = Object.keys(features) as Array<keyof SecretFeatures>
  for (const featureKey of keys) {
    const value = features[featureKey]
    if (Number.isNaN(value)) continue

    const key = adaptiveKey(featureKey, inputType)
    const existing = await store.getAdaptiveState(key)
    const state: AdaptiveState = existing ?? {
      feature_key: featureKey,
      input_type: inputType,
      count: 0,
      mean: 0,
      m2: 0,
      last_updated: 0,
    }
    const updated = welfordUpdate(state, value)
    await store.setAdaptiveState(key, updated)
  }
}
