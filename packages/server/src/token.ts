import { SignJWT, jwtVerify } from 'jose'
import type { CaptchaStore, TokenPayload, VerifyTokenResult } from './types.js'

type TokenInput = Omit<TokenPayload, 'jti' | 'iat' | 'exp'>

/**
 * Generate a signed JWT containing the validation result.
 */
export async function generateToken(
  payload: TokenInput,
  secret: string,
  ttlMs: number,
): Promise<string> {
  const jti = globalThis.crypto.randomUUID()
  const secretKey = new TextEncoder().encode(secret)
  const now = Math.floor(Date.now() / 1000)
  const exp = now + Math.floor(ttlMs / 1000)

  const jwt = await new SignJWT({
    site_key: payload.site_key,
    session_id: payload.session_id,
    public_key_hash: payload.public_key_hash,
    score: payload.score,
    challenge_id: payload.challenge_id,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secretKey)

  return jwt
}

/**
 * Verify a CAPTCHA token's signature, expiry, and session binding.
 */
export async function verifyToken(
  token: string,
  options: { secret: string; sessionId: string; store?: CaptchaStore; tokenTtlMs?: number },
): Promise<VerifyTokenResult> {
  const secretKey = new TextEncoder().encode(options.secret)

  try {
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ['HS256'],
    })

    const claims = payload as unknown as TokenPayload

    if (claims.session_id !== options.sessionId) {
      return { valid: false, score: 0, error: 'session_mismatch' }
    }

    // Single-use enforcement: check if token has already been consumed
    if (options.store && claims.jti) {
      const consumed = await options.store.isTokenConsumed(claims.jti)
      if (consumed) {
        return { valid: false, score: 0, error: 'token_already_consumed' }
      }
      // Mark consumed with TTL matching token expiry
      const ttl = options.tokenTtlMs ?? 60_000
      await options.store.markTokenConsumed(claims.jti, ttl)
    }

    return { valid: true, score: claims.score }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error'
    return { valid: false, score: 0, error: message }
  }
}
