import { SignJWT, jwtVerify, decodeProtectedHeader } from 'jose'
import type { CaptchaStore, SigningKey, TokenPayload, VerifyTokenResult } from './types.js'

type TokenInput = Omit<TokenPayload, 'jti' | 'iat' | 'exp'>

/**
 * Derive a kid from a secret string (first 8 hex chars of SHA-256).
 * Used when no explicit kid is provided.
 */
async function deriveKid(secret: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  )
  const bytes = new Uint8Array(hash)
  let hex = ''
  for (let i = 0; i < 4; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Generate a signed JWT containing the validation result.
 * Includes kid header for key rotation support.
 */
export async function generateToken(
  payload: TokenInput,
  secret: string,
  ttlMs: number,
  kid?: string,
): Promise<string> {
  const jti = globalThis.crypto.randomUUID()
  const secretKey = new TextEncoder().encode(secret)
  const now = Math.floor(Date.now() / 1000)
  const exp = now + Math.floor(ttlMs / 1000)
  const resolvedKid = kid ?? await deriveKid(secret)

  const jwt = await new SignJWT({
    type: 'captcha',
    site_key: payload.site_key,
    session_id: payload.session_id,
    public_key_hash: payload.public_key_hash,
    challenge_id: payload.challenge_id,
  })
    .setProtectedHeader({ alg: 'HS256', kid: resolvedKid })
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secretKey)

  return jwt
}

/**
 * Verify a CAPTCHA token's signature, expiry, and session binding.
 * Supports key rotation: tries matching kid first, then falls back to all keys.
 */
export async function verifyToken(
  token: string,
  options: {
    secret: string
    secrets?: SigningKey[]
    sessionId: string
    store?: CaptchaStore
    tokenTtlMs?: number
  },
): Promise<VerifyTokenResult> {
  // Build ordered list of keys to try
  const keysToTry: string[] = []

  if (options.secrets?.length) {
    // Try to match by kid first
    try {
      const header = decodeProtectedHeader(token)
      if (header.kid) {
        const matched = options.secrets.find((s) => s.kid === header.kid)
        if (matched) keysToTry.push(matched.value)
      }
    } catch {
      // Invalid token header, will fail verification below
    }
    // Add all secrets as fallback (deduped)
    for (const s of options.secrets) {
      if (!keysToTry.includes(s.value)) keysToTry.push(s.value)
    }
  }

  // Always include the primary secret
  if (!keysToTry.includes(options.secret)) keysToTry.push(options.secret)

  let lastError: unknown

  for (const secret of keysToTry) {
    try {
      const secretKey = new TextEncoder().encode(secret)
      const { payload } = await jwtVerify(token, secretKey, {
        algorithms: ['HS256'],
      })

      const claims = payload as unknown as TokenPayload

      if (claims.type !== 'captcha') {
        return { valid: false, score: 0, error: 'invalid_token_type' }
      }

      if (claims.session_id !== options.sessionId) {
        return { valid: false, score: 0, error: 'session_mismatch' }
      }

      // Single-use enforcement: atomically consume the token JTI.
      if (options.store && claims.jti) {
        const ttl = options.tokenTtlMs ?? 60_000
        const consumed = await options.store.consumeToken(claims.jti, ttl)
        if (!consumed) {
          return { valid: false, score: 0, error: 'token_already_consumed' }
        }
      }

      return { valid: true, score: 0 }
    } catch (err) {
      lastError = err
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'unknown_error'
  return { valid: false, score: 0, error: message }
}
