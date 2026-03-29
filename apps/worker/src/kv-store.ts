import type { CaptchaStore, Challenge } from '@cernosh/server'

export class CloudflareKVStore implements CaptchaStore {
  constructor(private kv: KVNamespace) {}

  async setChallenge(id: string, data: Challenge, ttlMs: number): Promise<void> {
    const ttlSeconds = Math.max(60, Math.ceil(ttlMs / 1000))
    await this.kv.put(`challenge:${id}`, JSON.stringify(data), {
      expirationTtl: ttlSeconds,
    })
  }

  async getChallenge(id: string): Promise<Challenge | null> {
    const raw = await this.kv.get(`challenge:${id}`)
    if (!raw) return null

    const challenge: Challenge = JSON.parse(raw)

    // Belt-and-suspenders: check expiry even though KV TTL should handle it.
    // KV eventual consistency means a key can linger briefly after expiration.
    if (Date.now() > challenge.expires_at) {
      await this.kv.delete(`challenge:${id}`)
      return null
    }

    return challenge
  }

  async deleteChallenge(id: string): Promise<void> {
    await this.kv.delete(`challenge:${id}`)
  }

  async markTokenConsumed(tokenId: string, ttlMs: number): Promise<void> {
    const ttlSeconds = Math.max(60, Math.ceil(ttlMs / 1000))
    await this.kv.put(`consumed:${tokenId}`, '1', {
      expirationTtl: ttlSeconds,
    })
  }

  async isTokenConsumed(tokenId: string): Promise<boolean> {
    const val = await this.kv.get(`consumed:${tokenId}`)
    return val !== null
  }

  // NOTE: KV has no atomic increment. This read-modify-write approach has a
  // small race window under concurrent requests for the same session. For MVP
  // single-user CAPTCHA flows this is acceptable. For high-traffic production
  // use, swap this out for Durable Objects or an external Redis store.
  async incrementRate(key: string, windowMs: number): Promise<number> {
    const kvKey = `rate:${key}`
    const now = Date.now()
    const cutoff = now - windowMs

    let timestamps: number[] = []
    const raw = await this.kv.get(kvKey)
    if (raw) {
      try {
        timestamps = JSON.parse(raw)
      } catch {
        timestamps = []
      }
    }

    // Evict entries outside the window
    timestamps = timestamps.filter((t) => t > cutoff)
    timestamps.push(now)

    const ttlSeconds = Math.max(60, Math.ceil(windowMs / 1000))
    await this.kv.put(kvKey, JSON.stringify(timestamps), {
      expirationTtl: ttlSeconds,
    })

    return timestamps.length
  }
}
