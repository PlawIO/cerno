import type { Challenge } from '@agentcaptcha/core'
import type { CaptchaStore } from './types.js'

interface TimedEntry<T> {
  value: T
  expiresAt: number
}

/**
 * In-memory CaptchaStore for dev/testing.
 * Production deployments should use a Redis or KV adapter.
 */
export class MemoryStore implements CaptchaStore {
  private challenges = new Map<string, TimedEntry<Challenge>>()
  private consumedTokens = new Map<string, TimedEntry<boolean>>()
  private rateBuckets = new Map<string, number[]>()
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

  async markTokenConsumed(tokenId: string, ttlMs: number): Promise<void> {
    const expiresAt = Date.now() + ttlMs
    this.consumedTokens.set(tokenId, { value: true, expiresAt })
    this.scheduleCleanup(`token:${tokenId}`, ttlMs, () => {
      this.consumedTokens.delete(tokenId)
    })
  }

  async isTokenConsumed(tokenId: string): Promise<boolean> {
    const entry = this.consumedTokens.get(tokenId)
    if (!entry) return false
    if (Date.now() > entry.expiresAt) {
      this.consumedTokens.delete(tokenId)
      return false
    }
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

  /** Remove all entries and cancel timers. Useful for test teardown. */
  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.challenges.clear()
    this.consumedTokens.clear()
    this.rateBuckets.clear()
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
