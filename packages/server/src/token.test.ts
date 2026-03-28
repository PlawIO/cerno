import { describe, expect, it } from 'vitest'
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
        score: 0.85,
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
    expect(result.score).toBe(0.85)
  })

  it('rejects token with wrong secret', async () => {
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'session-123',
        public_key_hash: 'abc123',
        score: 0.7,
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
        score: 0.9,
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
        score: 0.85,
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
        score: 0.8,
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
})
