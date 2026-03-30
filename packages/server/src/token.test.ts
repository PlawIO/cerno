import { describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { generateToken, verifyToken } from './token.js'
import { MemoryStore } from './store.js'

const SECRET = 'test-secret-key-for-captcha-tokens'

describe('token', () => {
  it('generates and verifies a valid token', async () => {
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'session-123',
        public_key_hash: 'abc123',
        challenge_id: 'challenge-456',
      },
      SECRET,
      60000,
    )

    expect(typeof token).toBe('string')
    expect(token.split('.').length).toBe(3) // JWT has 3 parts

    const result = await verifyToken(token, {
      secret: SECRET,
      sessionId: 'session-123',
    })
    expect(result.valid).toBe(true)
    // Score is stripped from JWT payload (B3)
    expect(result.score).toBe(0)
  })

  it('rejects token with wrong secret', async () => {
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'session-123',
        public_key_hash: 'abc123',
        challenge_id: 'challenge-789',
      },
      SECRET,
      60000,
    )

    const result = await verifyToken(token, {
      secret: 'wrong-secret',
      sessionId: 'session-123',
    })
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('rejects token with wrong session_id', async () => {
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'session-123',
        public_key_hash: 'abc123',
        challenge_id: 'challenge-000',
      },
      SECRET,
      60000,
    )

    const result = await verifyToken(token, {
      secret: SECRET,
      sessionId: 'different-session',
    })
    expect(result.valid).toBe(false)
    expect(result.error).toBe('session_mismatch')
  })

  it('rejects replayed token (single-use enforcement)', async () => {
    const store = new MemoryStore()
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'session-123',
        public_key_hash: 'abc123',
        challenge_id: 'challenge-replay',
      },
      SECRET,
      60000,
    )

    // First verification should succeed and mark consumed
    const first = await verifyToken(token, {
      secret: SECRET,
      sessionId: 'session-123',
      store,
      tokenTtlMs: 60000,
    })
    expect(first.valid).toBe(true)

    // Second verification of same token should fail
    const second = await verifyToken(token, {
      secret: SECRET,
      sessionId: 'session-123',
      store,
      tokenTtlMs: 60000,
    })
    expect(second.valid).toBe(false)
    expect(second.error).toBe('token_already_consumed')

    store.clear()
  })

  it('rejects expired token', async () => {
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'session-123',
        public_key_hash: 'abc123',
        challenge_id: 'challenge-exp',
      },
      SECRET,
      -1000, // Already expired
    )

    const result = await verifyToken(token, {
      secret: SECRET,
      sessionId: 'session-123',
    })
    expect(result.valid).toBe(false)
  })

  it('rejects token without type claim', async () => {
    const secretKey = new TextEncoder().encode(SECRET)
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({
      site_key: 'test-site',
      session_id: 'session-123',
      public_key_hash: 'abc123',
      challenge_id: 'challenge-notype',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti(crypto.randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(secretKey)

    const result = await verifyToken(token, {
      secret: SECRET,
      sessionId: 'session-123',
    })
    expect(result.valid).toBe(false)
    expect(result.error).toBe('invalid_token_type')
  })

  it('rejects probe-kind token', async () => {
    const secretKey = new TextEncoder().encode(SECRET)
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({
      kind: 'probe-completion',
      probe_id: 'probe-1',
      site_key: 'test-site',
      session_id: 'session-123',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti(crypto.randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(secretKey)

    const result = await verifyToken(token, {
      secret: SECRET,
      sessionId: 'session-123',
    })
    expect(result.valid).toBe(false)
    expect(result.error).toBe('invalid_token_type')
  })

  it('JTI consumption uses provided tokenTtlMs', async () => {
    const store = new MemoryStore()
    const ttlMs = 120_000
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'session-123',
        public_key_hash: 'abc123',
        challenge_id: 'challenge-ttl',
      },
      SECRET,
      ttlMs,
    )

    // Spy on store.consumeToken to verify the TTL passed through
    let capturedTtl: number | undefined
    const origConsumeToken = store.consumeToken.bind(store)
    store.consumeToken = async (tokenId: string, ttl: number) => {
      capturedTtl = ttl
      return origConsumeToken(tokenId, ttl)
    }

    const result = await verifyToken(token, {
      secret: SECRET,
      sessionId: 'session-123',
      store,
      tokenTtlMs: ttlMs,
    })
    expect(result.valid).toBe(true)
    expect(capturedTtl).toBe(120_000)

    store.clear()
  })
})
