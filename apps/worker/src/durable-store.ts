import type {
  CaptchaStore,
  Challenge,
  ProbeArmSessionData,
  ReputationData,
  WebAuthnCredentialRecord,
  WebAuthnRegistrationSessionData,
} from '@cernosh/server'

interface OperationRequest {
  op: string
  key?: string
  value?: unknown
  ttlMs?: number
  windowMs?: number
  stableId?: string
  siteKey?: string
  credentialId?: string
}

function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return hash
}

async function requestJson<T>(stub: DurableObjectStub, body: OperationRequest): Promise<T> {
  const response = await stub.fetch('https://state.internal', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return await response.json() as T
}

export class CloudflareDurableObjectStore implements CaptchaStore {
  readonly capabilities = {
    atomicChallengeConsume: true,
    atomicTokenConsume: true,
    strongConsistency: true,
    productionReady: true,
  } as const

  constructor(
    private namespace: DurableObjectNamespace,
    private shardCount = 32,
  ) {}

  private stubFor(logicalKey: string): DurableObjectStub {
    const shard = hashString(logicalKey) % this.shardCount
    return this.namespace.get(this.namespace.idFromName(`cerno-state-${shard}`))
  }

  async setChallenge(id: string, data: Challenge, ttlMs: number): Promise<void> {
    await requestJson(this.stubFor(`challenge:${id}`), { op: 'set', key: `challenge:${id}`, value: data, ttlMs })
  }

  async getChallenge(id: string): Promise<Challenge | null> {
    return await requestJson(this.stubFor(`challenge:${id}`), { op: 'get', key: `challenge:${id}` })
  }

  async deleteChallenge(id: string): Promise<void> {
    await requestJson(this.stubFor(`challenge:${id}`), { op: 'delete', key: `challenge:${id}` })
  }

  async consumeChallenge(id: string): Promise<Challenge | null> {
    return await requestJson(this.stubFor(`challenge:${id}`), { op: 'consume', key: `challenge:${id}` })
  }

  async consumeToken(tokenId: string, ttlMs: number): Promise<boolean> {
    return await requestJson(this.stubFor(`consumed:${tokenId}`), {
      op: 'consume-token',
      key: `consumed:${tokenId}`,
      ttlMs,
    })
  }

  async incrementRate(key: string, windowMs: number): Promise<number> {
    return await requestJson(this.stubFor(`rate:${key}`), {
      op: 'increment-rate',
      key: `rate:${key}`,
      windowMs,
    })
  }

  async setProbeArmSession(id: string, data: ProbeArmSessionData, ttlMs: number): Promise<void> {
    await requestJson(this.stubFor(`probe-arm:${id}`), { op: 'set', key: `probe-arm:${id}`, value: data, ttlMs })
  }

  async consumeProbeArmSession(id: string): Promise<ProbeArmSessionData | null> {
    return await requestJson(this.stubFor(`probe-arm:${id}`), { op: 'consume', key: `probe-arm:${id}` })
  }

  async setWebAuthnRegistrationSession(
    id: string,
    data: WebAuthnRegistrationSessionData,
    ttlMs: number,
  ): Promise<void> {
    await requestJson(this.stubFor(`wa-reg:${id}`), { op: 'set', key: `wa-reg:${id}`, value: data, ttlMs })
  }

  async consumeWebAuthnRegistrationSession(id: string): Promise<WebAuthnRegistrationSessionData | null> {
    return await requestJson(this.stubFor(`wa-reg:${id}`), { op: 'consume', key: `wa-reg:${id}` })
  }

  async listWebAuthnCredentials(stableId: string, siteKey: string): Promise<WebAuthnCredentialRecord[]> {
    return await requestJson(this.stubFor(`wa-idx:${siteKey}:${stableId}`), {
      op: 'wa-list',
      stableId,
      siteKey,
    })
  }

  async saveWebAuthnCredential(credential: WebAuthnCredentialRecord): Promise<void> {
    await requestJson(this.stubFor(`wa-idx:${credential.site_key}:${credential.stable_id}`), {
      op: 'wa-save',
      stableId: credential.stable_id,
      siteKey: credential.site_key,
      value: credential,
    })
  }

  async updateWebAuthnCredentialCounter(
    stableId: string,
    siteKey: string,
    credentialId: string,
    nextCounter: number,
  ): Promise<void> {
    await requestJson(this.stubFor(`wa-idx:${siteKey}:${stableId}`), {
      op: 'wa-counter',
      stableId,
      siteKey,
      credentialId,
      value: nextCounter,
    })
  }

  async setReputation(key: string, data: ReputationData, ttlMs: number): Promise<void> {
    await requestJson(this.stubFor(key), { op: 'set', key, value: data, ttlMs })
  }

  async getReputation(key: string): Promise<ReputationData | null> {
    return await requestJson(this.stubFor(key), { op: 'get', key })
  }
}

export class CernoStateShard {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as OperationRequest
    const now = Date.now()
    const storage = this.state.storage

    const json = (value: unknown): Response =>
      new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

    const getTimed = async <T>(key: string): Promise<T | null> => {
      const entry = await storage.get<{ value: T; expiresAt?: number }>(key)
      if (!entry) return null
      if (entry.expiresAt && now > entry.expiresAt) {
        await storage.delete(key)
        return null
      }
      return entry.value
    }

    switch (body.op) {
      case 'set': {
        await storage.put(body.key!, {
          value: body.value,
          expiresAt: body.ttlMs ? now + body.ttlMs : undefined,
        })
        return json(true)
      }
      case 'get':
        return json(await getTimed(body.key!))
      case 'delete':
        await storage.delete(body.key!)
        return json(true)
      case 'consume': {
        const value = await getTimed(body.key!)
        await storage.delete(body.key!)
        return json(value)
      }
      case 'consume-token': {
        const existing = await getTimed<boolean>(body.key!)
        if (existing) return json(false)
        await storage.put(body.key!, { value: true, expiresAt: now + (body.ttlMs ?? 60_000) })
        return json(true)
      }
      case 'increment-rate': {
        const key = body.key!
        const cutoff = now - (body.windowMs ?? 300_000)
        const existing = await getTimed<number[]>(key) ?? []
        const next = existing.filter((value) => value > cutoff)
        next.push(now)
        await storage.put(key, { value: next, expiresAt: now + (body.windowMs ?? 300_000) })
        return json(next.length)
      }
      case 'wa-list': {
        const list = await getTimed<WebAuthnCredentialRecord[]>(`wa-idx:${body.siteKey}:${body.stableId}`) ?? []
        return json(list)
      }
      case 'wa-save': {
        const key = `wa-idx:${body.siteKey}:${body.stableId}`
        const existing = await getTimed<WebAuthnCredentialRecord[]>(key) ?? []
        const credential = body.value as WebAuthnCredentialRecord
        const next = existing.filter((item) => item.credential_id !== credential.credential_id)
        next.push(credential)
        await storage.put(key, { value: next })
        return json(true)
      }
      case 'wa-counter': {
        const key = `wa-idx:${body.siteKey}:${body.stableId}`
        const existing = await getTimed<WebAuthnCredentialRecord[]>(key) ?? []
        const next = existing.map((item) => {
          if (item.credential_id !== body.credentialId) return item
          const desired = Number(body.value ?? 0)
          return desired > item.counter ? { ...item, counter: desired } : item
        })
        await storage.put(key, { value: next })
        return json(true)
      }
      default:
        return new Response('unknown_op', { status: 400 })
    }
  }
}
