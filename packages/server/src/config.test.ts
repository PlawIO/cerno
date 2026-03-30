import { describe, expect, it } from 'vitest'
import type { Challenge } from '@cernosh/core'
import { validateServerConfig } from './config.js'
import type { CaptchaStore, ServerConfig } from './types.js'

function makeStore(overrides?: Partial<CaptchaStore>): CaptchaStore {
  return {
    capabilities: {
      atomicChallengeConsume: true,
      atomicTokenConsume: true,
      strongConsistency: true,
      productionReady: true,
    },
    async setChallenge(_id: string, _data: Challenge, _ttlMs: number): Promise<void> {},
    async getChallenge(_id: string): Promise<Challenge | null> { return null },
    async deleteChallenge(_id: string): Promise<void> {},
    async consumeChallenge(_id: string): Promise<Challenge | null> { return null },
    async consumeToken(_tokenId: string, _ttlMs: number): Promise<boolean> { return true },
    async incrementRate(_key: string, _windowMs: number): Promise<number> { return 1 },
    ...overrides,
  }
}

function makeConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    mode: 'production',
    secret: 'test-secret',
    store: makeStore(),
    rateLimitKey: () => 'server-derived-key',
    ...overrides,
  }
}

describe('validateServerConfig', () => {
  it('allows non-production configs without production guarantees', () => {
    expect(() => validateServerConfig({
      mode: 'development',
      secret: 'test-secret',
      store: makeStore({
        capabilities: {
          atomicChallengeConsume: false,
          atomicTokenConsume: false,
          strongConsistency: false,
          productionReady: false,
        },
      }),
    })).not.toThrow()
  })

  it('rejects production without a server-derived rate limit key', () => {
    expect(() => validateServerConfig(makeConfig({ rateLimitKey: undefined })))
      .toThrowError('production_mode_requires_server_rate_limit_key')
  })

  it('rejects production with a weak store', () => {
    expect(() => validateServerConfig(makeConfig({
      store: makeStore({
        capabilities: {
          atomicChallengeConsume: false,
          atomicTokenConsume: true,
          strongConsistency: true,
          productionReady: true,
        },
      }),
    }))).toThrowError('production_mode_requires_atomic_challenge_consume')

    expect(() => validateServerConfig(makeConfig({
      store: makeStore({
        capabilities: {
          atomicChallengeConsume: true,
          atomicTokenConsume: false,
          strongConsistency: true,
          productionReady: true,
        },
      }),
    }))).toThrowError('production_mode_requires_atomic_token_consume')

    expect(() => validateServerConfig(makeConfig({
      store: makeStore({
        capabilities: {
          atomicChallengeConsume: true,
          atomicTokenConsume: true,
          strongConsistency: false,
          productionReady: true,
        },
      }),
    }))).toThrowError('production_mode_requires_strong_consistency_store')

    expect(() => validateServerConfig(makeConfig({
      store: makeStore({
        capabilities: {
          atomicChallengeConsume: true,
          atomicTokenConsume: true,
          strongConsistency: true,
          productionReady: false,
        },
      }),
    }))).toThrowError('production_mode_requires_production_ready_store')
  })

  it('rejects production webauthn when only stub verification is configured', () => {
    expect(() => validateServerConfig(makeConfig({
      webAuthn: {
        mode: 'required',
        rpId: 'example.com',
        expectedOrigin: 'https://example.com',
      },
      store: makeStore({
        consumeWebAuthnRegistrationSession: undefined,
        listWebAuthnCredentials: undefined,
        saveWebAuthnCredential: undefined,
        updateWebAuthnCredentialCounter: undefined,
      }),
    }))).toThrowError('production_mode_requires_webauthn_store')
  })

  it('rejects production reputation without durable reputation methods', () => {
    expect(() => validateServerConfig(makeConfig({
      enableReputation: true,
      store: makeStore({
        getReputation: undefined,
        setReputation: undefined,
      }),
    }))).toThrowError('production_mode_requires_reputation_store')
  })

  it('accepts a production-safe configuration', () => {
    expect(() => validateServerConfig(makeConfig({
      webAuthn: {
        mode: 'required',
        rpId: 'example.com',
        expectedOrigin: 'https://example.com',
      },
      enableReputation: true,
      enableProbes: true,
      store: makeStore({
        async getReputation() {
          return null
        },
        async setReputation() {},
        async setProbeArmSession() {},
        async consumeProbeArmSession() {
          return null
        },
        async setWebAuthnRegistrationSession() {},
        async consumeWebAuthnRegistrationSession() {
          return null
        },
        async listWebAuthnCredentials() {
          return []
        },
        async saveWebAuthnCredential() {},
        async updateWebAuthnCredentialCounter() {},
      }),
    }))).not.toThrow()
  })
})
