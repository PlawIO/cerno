import type { Challenge } from '@cernosh/core'
import type {
  AdaptiveState,
  CaptchaStore,
  ProbeArmSessionData,
  ReputationData,
  WebAuthnCredentialRecord,
  WebAuthnRegistrationSessionData,
} from './types.js'

interface TimedEntry<T> {
  value: T
  expiresAt: number
}

/**
 * In-memory CaptchaStore for dev/testing.
 * Production deployments should use a Redis or KV adapter.
 */
export class MemoryStore implements CaptchaStore {
  readonly capabilities = {
    atomicChallengeConsume: true,
    atomicTokenConsume: true,
    strongConsistency: true,
    productionReady: false,
  } as const

  private challenges = new Map<string, TimedEntry<Challenge>>()
  private consumedTokens = new Map<string, TimedEntry<boolean>>()
  private rateBuckets = new Map<string, number[]>()
  private reputation = new Map<string, TimedEntry<ReputationData>>()
  private probeArmSessions = new Map<string, TimedEntry<ProbeArmSessionData>>()
  private webAuthnRegistrationSessions = new Map<string, TimedEntry<WebAuthnRegistrationSessionData>>()
  private webAuthnCredentials = new Map<string, WebAuthnCredentialRecord>()
  private adaptiveStates = new Map<string, AdaptiveState>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  async setChallenge(id: string, data: Challenge, ttlMs: number): Promise<void> {
    const expiresAt = Date.now() + ttlMs
    this.challenges.set(id, { value: data, expiresAt })
    this.scheduleCleanup(`challenge:${id}`, ttlMs, () => {
      this.challenges.delete(id)
    })
  }

  async getChallenge(id: string): Promise<Challenge | null> {
    const entry = this.challenges.get(id)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.challenges.delete(id)
      return null
    }
    return entry.value
  }

  async deleteChallenge(id: string): Promise<void> {
    this.challenges.delete(id)
    this.clearTimer(`challenge:${id}`)
  }

  async consumeChallenge(id: string): Promise<Challenge | null> {
    const entry = this.challenges.get(id)
    if (!entry) return null
    // Atomic: delete before returning, so concurrent calls get null
    this.challenges.delete(id)
    this.clearTimer(`challenge:${id}`)
    if (Date.now() > entry.expiresAt) return null
    return entry.value
  }

  async consumeToken(tokenId: string, ttlMs: number): Promise<boolean> {
    const entry = this.consumedTokens.get(tokenId)
    if (entry && Date.now() <= entry.expiresAt) {
      return false
    }
    if (entry && Date.now() > entry.expiresAt) {
      this.consumedTokens.delete(tokenId)
    }
    const expiresAt = Date.now() + ttlMs
    this.consumedTokens.set(tokenId, { value: true, expiresAt })
    this.scheduleCleanup(`token:${tokenId}`, ttlMs, () => {
      this.consumedTokens.delete(tokenId)
    })
    return true
  }

  async incrementRate(key: string, windowMs: number): Promise<number> {
    const now = Date.now()
    const cutoff = now - windowMs
    let timestamps = this.rateBuckets.get(key)

    if (!timestamps) {
      timestamps = []
      this.rateBuckets.set(key, timestamps)
    }

    // Evict expired entries
    const valid = timestamps.filter((t) => t > cutoff)
    valid.push(now)
    this.rateBuckets.set(key, valid)

    // Schedule cleanup of the entire key if no activity
    this.clearTimer(`rate:${key}`)
    this.scheduleCleanup(`rate:${key}`, windowMs, () => {
      this.rateBuckets.delete(key)
    })

    return valid.length
  }

  async setProbeArmSession(id: string, data: ProbeArmSessionData, ttlMs: number): Promise<void> {
    const expiresAt = Date.now() + ttlMs
    this.probeArmSessions.set(id, { value: data, expiresAt })
    this.scheduleCleanup(`probe-arm:${id}`, ttlMs, () => {
      this.probeArmSessions.delete(id)
    })
  }

  async consumeProbeArmSession(id: string): Promise<ProbeArmSessionData | null> {
    const entry = this.probeArmSessions.get(id)
    if (!entry) return null
    this.probeArmSessions.delete(id)
    this.clearTimer(`probe-arm:${id}`)
    if (Date.now() > entry.expiresAt) return null
    return entry.value
  }

  async setWebAuthnRegistrationSession(
    id: string,
    data: WebAuthnRegistrationSessionData,
    ttlMs: number,
  ): Promise<void> {
    const expiresAt = Date.now() + ttlMs
    this.webAuthnRegistrationSessions.set(id, { value: data, expiresAt })
    this.scheduleCleanup(`wa-reg:${id}`, ttlMs, () => {
      this.webAuthnRegistrationSessions.delete(id)
    })
  }

  async consumeWebAuthnRegistrationSession(id: string): Promise<WebAuthnRegistrationSessionData | null> {
    const entry = this.webAuthnRegistrationSessions.get(id)
    if (!entry) return null
    this.webAuthnRegistrationSessions.delete(id)
    this.clearTimer(`wa-reg:${id}`)
    if (Date.now() > entry.expiresAt) return null
    return entry.value
  }

  async listWebAuthnCredentials(stableId: string, siteKey: string): Promise<WebAuthnCredentialRecord[]> {
    const values: WebAuthnCredentialRecord[] = []
    for (const credential of this.webAuthnCredentials.values()) {
      if (credential.stable_id === stableId && credential.site_key === siteKey) {
        values.push(credential)
      }
    }
    return values
  }

  async saveWebAuthnCredential(credential: WebAuthnCredentialRecord): Promise<void> {
    this.webAuthnCredentials.set(credential.credential_id, credential)
  }

  async updateWebAuthnCredentialCounter(
    _stableId: string,
    _siteKey: string,
    credentialId: string,
    nextCounter: number,
  ): Promise<void> {
    const existing = this.webAuthnCredentials.get(credentialId)
    if (!existing) return
    this.webAuthnCredentials.set(credentialId, {
      ...existing,
      counter: nextCounter,
    })
  }

  // ── Reputation store (Phase 3) ──

  async setReputation(key: string, data: ReputationData, ttlMs: number): Promise<void> {
    const MAX_DELAY = 24 * 60 * 60 * 1000
    const expiresAt = Date.now() + ttlMs
    this.reputation.set(key, { value: data, expiresAt })

    const scheduleCheck = () => {
      const entry = this.reputation.get(key)
      if (!entry) return
      const remaining = entry.expiresAt - Date.now()
      if (remaining <= 0) {
        this.reputation.delete(key)
        return
      }
      const delay = Math.min(remaining, MAX_DELAY)
      this.scheduleCleanup(`rep:${key}`, delay, scheduleCheck)
    }

    // Cap initial cleanup timer at 24h to avoid 32-bit overflow (2^31 ms ≈ 24.8 days)
    const safeDelay = Math.min(ttlMs, MAX_DELAY)
    this.scheduleCleanup(`rep:${key}`, safeDelay, scheduleCheck)
  }

  async getReputation(key: string): Promise<ReputationData | null> {
    const entry = this.reputation.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.reputation.delete(key)
      return null
    }
    return entry.value
  }

  // ── Adaptive baselines store (Phase B) ──

  async setAdaptiveState(key: string, state: AdaptiveState): Promise<void> {
    this.adaptiveStates.set(key, state)
  }

  async getAdaptiveState(key: string): Promise<AdaptiveState | null> {
    return this.adaptiveStates.get(key) ?? null
  }

  /** Remove all entries and cancel timers. Useful for test teardown. */
  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.challenges.clear()
    this.consumedTokens.clear()
    this.rateBuckets.clear()
    this.reputation.clear()
    this.probeArmSessions.clear()
    this.webAuthnRegistrationSessions.clear()
    this.webAuthnCredentials.clear()
    this.adaptiveStates.clear()
  }

  private scheduleCleanup(timerKey: string, delayMs: number, fn: () => void): void {
    this.clearTimer(timerKey)
    const timer = setTimeout(() => {
      fn()
      this.timers.delete(timerKey)
    }, delayMs)
    // Unref so the timer doesn't keep the process alive
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref()
    }
    this.timers.set(timerKey, timer)
  }

  private clearTimer(timerKey: string): void {
    const existing = this.timers.get(timerKey)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(timerKey)
    }
  }
}
