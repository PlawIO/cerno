import { describe, it, expect, afterEach, vi } from 'vitest'
import { MemoryStore } from './store.js'
import type { Challenge } from '@cernosh/core'

function fakeChallenge(overrides?: Partial<Challenge>): Challenge {
  return {
    id: 'ch-1',
    challenge_type: 'maze',
    maze_seed: 42,
    maze_width: 5,
    maze_height: 5,
    maze_difficulty: 0.5,
    pow_challenge: 'abc',
    pow_difficulty: 14,
    site_key: 'site-1',
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    cell_size: 40,
    ...overrides,
  }
}

describe('MemoryStore', () => {
  let store: MemoryStore

  afterEach(() => {
    store.clear()
  })

  // ── Challenge CRUD ──

  describe('challenge CRUD', () => {
    it('round-trips setChallenge + getChallenge', async () => {
      store = new MemoryStore()
      const ch = fakeChallenge()
      await store.setChallenge('c1', ch, 5_000)
      const got = await store.getChallenge('c1')
      expect(got).toEqual(ch)
    })

    it('deleteChallenge removes it', async () => {
      store = new MemoryStore()
      await store.setChallenge('c2', fakeChallenge(), 5_000)
      await store.deleteChallenge('c2')
      expect(await store.getChallenge('c2')).toBeNull()
    })

    it('getChallenge returns null for unknown ID', async () => {
      store = new MemoryStore()
      expect(await store.getChallenge('nonexistent')).toBeNull()
    })
  })

  // ── Atomic consumeChallenge ──

  describe('atomic consumeChallenge', () => {
    it('returns challenge and deletes it atomically', async () => {
      store = new MemoryStore()
      const ch = fakeChallenge()
      await store.setChallenge('c3', ch, 5_000)
      const consumed = await store.consumeChallenge('c3')
      expect(consumed).toEqual(ch)
      expect(await store.getChallenge('c3')).toBeNull()
    })

    it('second consumeChallenge returns null (single-use)', async () => {
      store = new MemoryStore()
      await store.setChallenge('c4', fakeChallenge(), 5_000)
      await store.consumeChallenge('c4')
      expect(await store.consumeChallenge('c4')).toBeNull()
    })
  })

  // ── TTL expiration ──

  describe('TTL expiration', () => {
    it('getChallenge returns null after TTL expires', async () => {
      store = new MemoryStore()
      await store.setChallenge('c5', fakeChallenge(), 50)
      await new Promise((r) => setTimeout(r, 100))
      expect(await store.getChallenge('c5')).toBeNull()
    })

    it('consumeChallenge returns null after TTL expires', async () => {
      store = new MemoryStore()
      await store.setChallenge('c6', fakeChallenge(), 50)
      await new Promise((r) => setTimeout(r, 100))
      expect(await store.consumeChallenge('c6')).toBeNull()
    })
  })

  // ── Token single-use ──

  describe('token single-use', () => {
    it('consumeToken returns true first time, false second time', async () => {
      store = new MemoryStore()
      expect(await store.consumeToken('tok-1', 5_000)).toBe(true)
      expect(await store.consumeToken('tok-1', 5_000)).toBe(false)
    })
  })

  // ── Rate limiting ──

  describe('rate limiting', () => {
    it('incrementRate returns incrementing counts', async () => {
      store = new MemoryStore()
      expect(await store.incrementRate('ip:1.2.3.4', 10_000)).toBe(1)
      expect(await store.incrementRate('ip:1.2.3.4', 10_000)).toBe(2)
      expect(await store.incrementRate('ip:1.2.3.4', 10_000)).toBe(3)
    })

    it('respects window by evicting old entries', async () => {
      store = new MemoryStore()
      await store.incrementRate('ip:window', 50)
      await new Promise((r) => setTimeout(r, 100))
      // Old entry should be evicted; count resets to 1
      expect(await store.incrementRate('ip:window', 50)).toBe(1)
    })
  })

  // ── Reputation ──

  describe('reputation', () => {
    it('round-trips setReputation + getReputation', async () => {
      store = new MemoryStore()
      const data = {
        trust_score: 0.85,
        session_count: 3,
        feature_means: {},
        last_seen: Date.now(),
      }
      await store.setReputation('rep-1', data, 5_000)
      expect(await store.getReputation('rep-1')).toEqual(data)
    })

    it('getReputation returns null for unknown key', async () => {
      store = new MemoryStore()
      expect(await store.getReputation('unknown')).toBeNull()
    })

    it('getReputation returns null after TTL expires', async () => {
      store = new MemoryStore()
      const data = {
        trust_score: 0.5,
        session_count: 1,
        feature_means: {},
        last_seen: Date.now(),
      }
      await store.setReputation('rep-ttl', data, 50)
      await new Promise((r) => setTimeout(r, 100))
      expect(await store.getReputation('rep-ttl')).toBeNull()
    })

    it('reputation entry survives past 24h cleanup timer', async () => {
      vi.useFakeTimers()
      try {
        store = new MemoryStore()
        const HOUR = 60 * 60 * 1000
        const data = {
          trust_score: 0.9,
          session_count: 5,
          feature_means: {},
          last_seen: Date.now(),
        }
        await store.setReputation('rep-long', data, 48 * HOUR)

        // Advance 25h — past the first 24h cleanup timer
        vi.advanceTimersByTime(25 * HOUR)
        expect(await store.getReputation('rep-long')).toEqual(data)

        // Advance to just past 48h total — entry should now be expired
        vi.advanceTimersByTime(24 * HOUR)
        expect(await store.getReputation('rep-long')).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ── Probe arm sessions ──

  describe('probe arm sessions', () => {
    it('round-trips setProbeArmSession + consumeProbeArmSession', async () => {
      store = new MemoryStore()
      const session = {
        id: 'arm-1',
        challenge_id: 'ch-1',
        probe_id: 'probe-1',
        site_key: 'site-1',
        session_id: 'sess-1',
        armed_at: Date.now(),
        deadline_at: Date.now() + 5_000,
      }
      await store.setProbeArmSession('arm-1', session, 5_000)
      const consumed = await store.consumeProbeArmSession('arm-1')
      expect(consumed).toEqual(session)
    })

    it('second consumeProbeArmSession returns null', async () => {
      store = new MemoryStore()
      const session = {
        id: 'arm-2',
        challenge_id: 'ch-1',
        probe_id: 'probe-1',
        site_key: 'site-1',
        session_id: 'sess-1',
        armed_at: Date.now(),
        deadline_at: Date.now() + 5_000,
      }
      await store.setProbeArmSession('arm-2', session, 5_000)
      await store.consumeProbeArmSession('arm-2')
      expect(await store.consumeProbeArmSession('arm-2')).toBeNull()
    })

    it('consumeProbeArmSession returns null for unknown ID', async () => {
      store = new MemoryStore()
      expect(await store.consumeProbeArmSession('nonexistent')).toBeNull()
    })
  })
})
