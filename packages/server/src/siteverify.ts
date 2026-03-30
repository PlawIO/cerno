/**
 * Server-to-server token verification (like reCAPTCHA siteverify).
 *
 * Usage: POST /siteverify { token, session_id }
 * Returns: { success, score, challenge_id, session_id, site_key }
 *
 * This is the recommended integration pattern for production.
 * Instead of decoding JWTs client-side, your backend sends the token
 * to Cerno's API and gets a verified result back.
 */
import { verifyToken } from './token.js'
import type { SiteverifyOptions, SiteverifyRequest, SiteverifyResult } from './types.js'

export async function siteverify(
  request: SiteverifyRequest,
  options: SiteverifyOptions,
): Promise<SiteverifyResult> {
  if (!request.token || !request.session_id) {
    return { success: false, score: 0, error: 'missing_required_fields' }
  }

  const result = await verifyToken(request.token, {
    secret: options.secret,
    secrets: options.secrets,
    sessionId: request.session_id,
    store: options.store,
    tokenTtlMs: options.tokenTtlMs,
  })

  if (!result.valid) {
    return {
      success: false,
      score: 0,
      error: result.error,
    }
  }

  // Decode claims for the response (token already verified above)
  try {
    const parts = request.token.split('.')
    const payload = JSON.parse(atob(parts[1]))
    return {
      success: true,
      score: 0, // Score stripped from external responses
      challenge_id: payload.challenge_id,
      session_id: payload.session_id,
      site_key: payload.site_key,
    }
  } catch {
    return {
      success: true,
      score: 0,
    }
  }
}
