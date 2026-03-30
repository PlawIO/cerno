import Redis from 'ioredis'
import type {
  CaptchaStore,
  Challenge,
  ProbeArmSessionData,
  ReputationData,
  WebAuthnCredentialRecord,
  WebAuthnRegistrationSessionData,
} from '@cernosh/server'

export interface RedisStoreOptions {
  keyPrefix?: string
}

function prefixed(prefix: string, key: string): string {
  return prefix ? `${prefix}:${key}` : key
}

export class RedisStore implements CaptchaStore {
  readonly capabilities = {
    atomicChallengeConsume: true,
    atomicTokenConsume: true,
    strongConsistency: true,
    productionReady: true,
  } as const

  constructor(
    private redis: Redis,
    private options: RedisStoreOptions = {},
  ) {}

  async setChallenge(id: string, data: Challenge, ttlMs: number): Promise<void> {
    await this.redis.set(prefixed(this.options.keyPrefix ?? '', `challenge:${id}`), JSON.stringify(data), 'PX', ttlMs)
  }

  async getChallenge(id: string): Promise<Challenge | null> {
    const raw = await this.redis.get(prefixed(this.options.keyPrefix ?? '', `challenge:${id}`))
    return raw ? JSON.parse(raw) as Challenge : null
  }

  async deleteChallenge(id: string): Promise<void> {
    await this.redis.del(prefixed(this.options.keyPrefix ?? '', `challenge:${id}`))
  }

  async consumeChallenge(id: string): Promise<Challenge | null> {
    const raw = await this.redis.call('GETDEL', prefixed(this.options.keyPrefix ?? '', `challenge:${id}`))
    return typeof raw === 'string' ? JSON.parse(raw) as Challenge : null
  }

  async consumeToken(tokenId: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(
      prefixed(this.options.keyPrefix ?? '', `consumed:${tokenId}`),
      '1',
      'PX',
      ttlMs,
      'NX',
    )
    return result === 'OK'
  }

  async incrementRate(key: string, windowMs: number): Promise<number> {
    const now = Date.now()
    const zkey = prefixed(this.options.keyPrefix ?? '', `rate:${key}`)
    const member = `${now}:${globalThis.crypto.randomUUID()}`
    const multi = this.redis.multi()
    multi.zremrangebyscore(zkey, 0, now - windowMs)
    multi.zadd(zkey, now, member)
    multi.zcard(zkey)
    multi.pexpire(zkey, windowMs)
    const result = await multi.exec()
    return Number(result?.[2]?.[1] ?? 0)
  }

  async setProbeArmSession(id: string, data: ProbeArmSessionData, ttlMs: number): Promise<void> {
    await this.redis.set(prefixed(this.options.keyPrefix ?? '', `probe-arm:${id}`), JSON.stringify(data), 'PX', ttlMs)
  }

  async consumeProbeArmSession(id: string): Promise<ProbeArmSessionData | null> {
    const raw = await this.redis.call('GETDEL', prefixed(this.options.keyPrefix ?? '', `probe-arm:${id}`))
    return typeof raw === 'string' ? JSON.parse(raw) as ProbeArmSessionData : null
  }

  async setWebAuthnRegistrationSession(
    id: string,
    data: WebAuthnRegistrationSessionData,
    ttlMs: number,
  ): Promise<void> {
    await this.redis.set(prefixed(this.options.keyPrefix ?? '', `wa-reg:${id}`), JSON.stringify(data), 'PX', ttlMs)
  }

  async consumeWebAuthnRegistrationSession(id: string): Promise<WebAuthnRegistrationSessionData | null> {
    const raw = await this.redis.call('GETDEL', prefixed(this.options.keyPrefix ?? '', `wa-reg:${id}`))
    return typeof raw === 'string' ? JSON.parse(raw) as WebAuthnRegistrationSessionData : null
  }

  async listWebAuthnCredentials(stableId: string, siteKey: string): Promise<WebAuthnCredentialRecord[]> {
    const ids = await this.redis.smembers(prefixed(this.options.keyPrefix ?? '', `wa-idx:${siteKey}:${stableId}`))
    if (ids.length === 0) return []
    const pipeline = this.redis.pipeline()
    for (const id of ids) pipeline.hgetall(prefixed(this.options.keyPrefix ?? '', `wa-cred:${id}`))
    const rows = await pipeline.exec()
    const result: WebAuthnCredentialRecord[] = []
    for (const row of rows ?? []) {
      const data = row[1] as Record<string, string>
      if (!data || !data.credential_id) continue
      result.push({
        credential_id: data.credential_id,
        credential_public_key: data.credential_public_key,
        counter: Number(data.counter ?? 0),
        stable_id: data.stable_id,
        site_key: data.site_key,
        transports: data.transports ? JSON.parse(data.transports) as string[] : undefined,
      })
    }
    return result
  }

  async saveWebAuthnCredential(credential: WebAuthnCredentialRecord): Promise<void> {
    const key = prefixed(this.options.keyPrefix ?? '', `wa-cred:${credential.credential_id}`)
    const indexKey = prefixed(this.options.keyPrefix ?? '', `wa-idx:${credential.site_key}:${credential.stable_id}`)
    const multi = this.redis.multi()
    multi.hset(key, {
      credential_id: credential.credential_id,
      credential_public_key: credential.credential_public_key,
      counter: credential.counter.toString(),
      stable_id: credential.stable_id,
      site_key: credential.site_key,
      transports: credential.transports ? JSON.stringify(credential.transports) : '',
    })
    multi.sadd(indexKey, credential.credential_id)
    await multi.exec()
  }

  async updateWebAuthnCredentialCounter(
    _stableId: string,
    _siteKey: string,
    credentialId: string,
    nextCounter: number,
  ): Promise<void> {
    const key = prefixed(this.options.keyPrefix ?? '', `wa-cred:${credentialId}`)
    await this.redis.eval(
      `
        local current = redis.call('HGET', KEYS[1], 'counter')
        if not current then return 0 end
        if tonumber(ARGV[1]) <= tonumber(current) then return 0 end
        redis.call('HSET', KEYS[1], 'counter', ARGV[1])
        return 1
      `,
      1,
      key,
      nextCounter.toString(),
    )
  }

  async setReputation(key: string, data: ReputationData, ttlMs: number): Promise<void> {
    await this.redis.set(prefixed(this.options.keyPrefix ?? '', key), JSON.stringify(data), 'PX', ttlMs)
  }

  async getReputation(key: string): Promise<ReputationData | null> {
    const raw = await this.redis.get(prefixed(this.options.keyPrefix ?? '', key))
    return raw ? JSON.parse(raw) as ReputationData : null
  }
}
