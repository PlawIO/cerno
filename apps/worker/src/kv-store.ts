import type {
  CaptchaStore,
  Challenge,
  ProbeArmSessionData,
  WebAuthnCredentialRecord,
  WebAuthnRegistrationSessionData,
} from '@cernosh/server'

export class CloudflareKVStore implements CaptchaStore {
  readonly capabilities = {
    atomicChallengeConsume: false,
    atomicTokenConsume: false,
    strongConsistency: false,
    productionReady: false,
  } as const

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

  async consumeChallenge(id: string): Promise<Challenge | null> {
    const challenge = await this.getChallenge(id)
    if (!challenge) return null
    await this.deleteChallenge(id)
    return challenge
  }

  async consumeToken(tokenId: string, ttlMs: number): Promise<boolean> {
    const existing = await this.kv.get(`consumed:${tokenId}`)
    if (existing !== null) return false
    const ttlSeconds = Math.max(60, Math.ceil(ttlMs / 1000))
    await this.kv.put(`consumed:${tokenId}`, '1', {
      expirationTtl: ttlSeconds,
    })
    return true
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

  async setProbeArmSession(id: string, data: ProbeArmSessionData, ttlMs: number): Promise<void> {
    const ttlSeconds = Math.max(60, Math.ceil(ttlMs / 1000))
    await this.kv.put(`probe-arm:${id}`, JSON.stringify(data), {
      expirationTtl: ttlSeconds,
    })
  }

  async consumeProbeArmSession(id: string): Promise<ProbeArmSessionData | null> {
    const raw = await this.kv.get(`probe-arm:${id}`)
    if (!raw) return null
    await this.kv.delete(`probe-arm:${id}`)
    return JSON.parse(raw) as ProbeArmSessionData
  }

  async setWebAuthnRegistrationSession(
    id: string,
    data: WebAuthnRegistrationSessionData,
    ttlMs: number,
  ): Promise<void> {
    const ttlSeconds = Math.max(60, Math.ceil(ttlMs / 1000))
    await this.kv.put(`wa-reg:${id}`, JSON.stringify(data), {
      expirationTtl: ttlSeconds,
    })
  }

  async consumeWebAuthnRegistrationSession(id: string): Promise<WebAuthnRegistrationSessionData | null> {
    const raw = await this.kv.get(`wa-reg:${id}`)
    if (!raw) return null
    await this.kv.delete(`wa-reg:${id}`)
    return JSON.parse(raw) as WebAuthnRegistrationSessionData
  }

  async listWebAuthnCredentials(stableId: string, siteKey: string): Promise<WebAuthnCredentialRecord[]> {
    const list = await this.kv.get<WebAuthnCredentialRecord[]>(`wa-idx:${siteKey}:${stableId}`, 'json')
    return Array.isArray(list) ? list : []
  }

  async saveWebAuthnCredential(credential: WebAuthnCredentialRecord): Promise<void> {
    const indexKey = `wa-idx:${credential.site_key}:${credential.stable_id}`
    const existing = await this.listWebAuthnCredentials(credential.stable_id, credential.site_key)
    const next = existing.filter((item) => item.credential_id !== credential.credential_id)
    next.push(credential)
    await this.kv.put(indexKey, JSON.stringify(next))
  }

  async updateWebAuthnCredentialCounter(
    stableId: string,
    siteKey: string,
    credentialId: string,
    nextCounter: number,
  ): Promise<void> {
    const indexKey = `wa-idx:${siteKey}:${stableId}`
    const existing = await this.kv.get<WebAuthnCredentialRecord[]>(indexKey, 'json')
    if (!Array.isArray(existing)) return
    const next = existing.map((credential) =>
      credential.credential_id === credentialId
        ? { ...credential, counter: nextCounter }
        : credential,
    )
    await this.kv.put(indexKey, JSON.stringify(next))
  }
}
