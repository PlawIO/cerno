import { describe, expect, it, beforeEach } from 'vitest'
import { SignJWT } from 'jose'
import { siteverify } from './siteverify.js'
import { generateToken } from './token.js'
import { MemoryStore } from './store.js'

describe('siteverify', () => {
  const secret = 'test-siteverify-secret'
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
  })

  it('rejects missing fields', async () => {
    const result = await siteverify({ token: '', session_id: '' }, { secret })
    expect(result.success).toBe(false)
    expect(result.error).toBe('missing_required_fields')
  })

  it('verifies a valid token', async () => {
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'sess-1',
        public_key_hash: 'abc123',
        challenge_id: 'ch-1',
      },
      secret,
      60000,
    )

    const result = await siteverify(
      { token, session_id: 'sess-1' },
      { secret, store },
    )

    expect(result.success).toBe(true)
    // Score is stripped from external responses (B3)
    expect(result.score).toBe(0)
    expect(result.site_key).toBe('test-site')
    expect(result.session_id).toBe('sess-1')
    expect(result.challenge_id).toBe('ch-1')
  })

  it('rejects token with wrong secret', async () => {
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'sess-1',
        public_key_hash: 'abc123',
        challenge_id: 'ch-1',
      },
      secret,
      60000,
    )

    const result = await siteverify(
      { token, session_id: 'sess-1' },
      { secret: 'wrong-secret', store },
    )

    expect(result.success).toBe(false)
  })

  it('rejects token with wrong session_id', async () => {
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'sess-1',
        public_key_hash: 'abc123',
        challenge_id: 'ch-1',
      },
      secret,
      60000,
    )

    const result = await siteverify(
      { token, session_id: 'wrong-session' },
      { secret, store },
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('session_mismatch')
  })

  it('enforces single-use with store', async () => {
    const token = await generateToken(
      {
        site_key: 'test-site',
        session_id: 'sess-1',
        public_key_hash: 'abc123',
        challenge_id: 'ch-1',
      },
      secret,
      60000,
    )

    const first = await siteverify({ token, session_id: 'sess-1' }, { secret, store })
    expect(first.success).toBe(true)

    const second = await siteverify({ token, session_id: 'sess-1' }, { secret, store })
    expect(second.success).toBe(false)
    expect(second.error).toBe('token_already_consumed')
  })

  it('rejects probe completion token at siteverify', async () => {
    const secretKey = new TextEncoder().encode(secret)
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({
      kind: 'probe-completion',
      probe_id: 'probe-1',
      site_key: 'test-site',
      session_id: 'sess-1',
      challenge_id: 'ch-1',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti(crypto.randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(secretKey)

    const result = await siteverify(
      { token, session_id: 'sess-1' },
      { secret, store },
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe('invalid_token_type')
  })
})
