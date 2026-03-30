import {
  armProbe,
  beginWebAuthnRegistration,
  completeProbe,
  completeWebAuthnRegistration,
  createChallenge,
  validateSubmission,
  siteverify,
  ErrorCode,
} from '@cernosh/server'
import type { ServerConfig, ValidationRequest } from '@cernosh/server'
import { CloudflareKVStore } from './kv-store.js'
import { CernoStateShard, CloudflareDurableObjectStore } from './durable-store.js'
import type { ClientCapabilities } from '@cernosh/core'
import { handleGitHubAuth, handleGitHubCallback, handleLogout, requireSession } from './auth.js'
import { handleRegister, handleCreateKey, handleRevokeKey, handleClaimKey, getRegistration, incrementUsage } from './register.js'
import { handleDashboard, handleGetAccount } from './dashboard.js'

export interface Env {
  CERNO_KV: KVNamespace
  CERNO_STATE?: DurableObjectNamespace
  CERNO_SECRET: string
  CERNO_MODE?: 'development' | 'test' | 'production'
  /** Enable Stroop probes (set to "true" to enable) */
  CERNO_ENABLE_PROBES?: string
  /** Enable adaptive PoW (set to "true" to enable) */
  CERNO_ADAPTIVE_POW?: string
  CERNO_WEBAUTHN_MODE?: 'off' | 'preferred' | 'required'
  CERNO_WEBAUTHN_RP_ID?: string
  CERNO_WEBAUTHN_ORIGIN?: string
  /** Optional bearer token required to call /siteverify */
  CERNO_SITEVERIFY_AUTH_TOKEN?: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  CERNO_BASE_URL: string
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  })
}

function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status)
}

function errorCodeToStatus(code: string): number {
  switch (code) {
    case ErrorCode.CHALLENGE_EXPIRED:
      return 410
    case ErrorCode.RATE_LIMITED:
      return 429
    case ErrorCode.CHALLENGE_NOT_FOUND:
    case ErrorCode.INVALID_POW:
    case ErrorCode.INVALID_PATH:
    case ErrorCode.INVALID_SIGNATURE:
    case ErrorCode.BEHAVIORAL_REJECTED:
    case ErrorCode.INVALID_REQUEST:
    case ErrorCode.PROBE_FAILED:
    case ErrorCode.WEBAUTHN_FAILED:
      return 400
    default:
      return 400
  }
}

function buildStore(env: Env) {
  if (env.CERNO_STATE) {
    return new CloudflareDurableObjectStore(env.CERNO_STATE)
  }
  return new CloudflareKVStore(env.CERNO_KV)
}

function buildConfig(env: Env, rateLimitBinding?: string): ServerConfig {
  const webAuthnMode = env.CERNO_WEBAUTHN_MODE ?? 'off'
  return {
    mode: env.CERNO_MODE ?? 'development',
    secret: env.CERNO_SECRET,
    store: buildStore(env),
    rateLimitKey: () => rateLimitBinding ?? 'missing-rate-limit-binding',
    enableProbes: env.CERNO_ENABLE_PROBES === 'true',
    adaptivePow: env.CERNO_ADAPTIVE_POW === 'true'
      ? { enabled: true }
      : undefined,
    webAuthn:
      webAuthnMode !== 'off' && env.CERNO_WEBAUTHN_RP_ID && env.CERNO_WEBAUTHN_ORIGIN
        ? {
          mode: webAuthnMode,
          rpId: env.CERNO_WEBAUTHN_RP_ID,
          expectedOrigin: env.CERNO_WEBAUTHN_ORIGIN,
        }
        : undefined,
  }
}

function getClientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')
    ?? 'unknown'
}

function buildRateLimitBinding(request: Request, siteKey: string): string {
  const origin = request.headers.get('origin') ?? 'no-origin'
  const ua = request.headers.get('user-agent') ?? 'no-ua'
  return `${siteKey}:${getClientIp(request)}:${origin}:${ua}`
}

async function getClientSignals(request: Request): Promise<{
  ip: string
  userAgent?: string
}> {
  return {
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent') ?? undefined,
  }
}

async function handleChallenge(request: Request, env: Env): Promise<Response> {
  let body: { site_key?: string; stable_id?: string; public_key?: string; client_capabilities?: ClientCapabilities }
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.site_key || typeof body.site_key !== 'string') {
    return errorResponse('Missing or invalid site_key', 400)
  }

  // Validate site_key is registered
  const reg = await getRegistration(body.site_key, env.CERNO_KV)
  if (!reg) {
    return errorResponse('Invalid site_key', 403)
  }
  if (reg.revoked) {
    return errorResponse('Site key revoked', 403)
  }

  try {
    const rateLimitBinding = buildRateLimitBinding(request, body.site_key)
    const config = buildConfig(env, rateLimitBinding)
    const challenge = await createChallenge(config, {
      site_key: body.site_key,
      stable_id: body.stable_id,
      public_key: body.public_key,
      client_capabilities: body.client_capabilities,
      client_signals: await getClientSignals(request),
      rate_limit_binding: rateLimitBinding,
    })
    return json(challenge)
  } catch (err) {
    console.error('createChallenge failed:', err)
    return errorResponse('Internal server error', 500)
  }
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  let body: ValidationRequest
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.challenge_id || !body.site_key || !body.session_id) {
    return errorResponse('Missing required fields', 400)
  }

  try {
    const rateLimitBinding = buildRateLimitBinding(request, body.site_key)
    const config = buildConfig(env, rateLimitBinding)
    const result = await validateSubmission(config, {
      ...body,
      rate_limit_binding: rateLimitBinding,
    })

    if (result.success) {
      return json(result)
    }

    const status = result.error_code ? errorCodeToStatus(result.error_code) : 400
    return json(result, status)
  } catch (err) {
    console.error('validateSubmission failed:', err)
    return errorResponse('Internal server error', 500)
  }
}

async function handleProbeArm(request: Request, env: Env): Promise<Response> {
  let body: {
    challenge_id?: string
    site_key?: string
    session_id?: string
    probe_id?: string
    events?: ValidationRequest['events']
  }
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.challenge_id || !body.site_key || !body.session_id || !body.probe_id || !Array.isArray(body.events)) {
    return errorResponse('Missing required fields', 400)
  }

  const config = buildConfig(env, buildRateLimitBinding(request, body.site_key))
  const result = await armProbe(config, {
    challenge_id: body.challenge_id,
    site_key: body.site_key,
    session_id: body.session_id,
    probe_id: body.probe_id,
    events: body.events,
    rate_limit_binding: buildRateLimitBinding(request, body.site_key),
  })
  return json(result, result.success ? 200 : 400)
}

async function handleProbeComplete(request: Request, env: Env): Promise<Response> {
  let body: {
    challenge_id?: string
    session_id?: string
    probe_ticket?: string
    tapped_cell?: { x: number; y: number }
  }
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.challenge_id || !body.session_id || !body.probe_ticket || !body.tapped_cell) {
    return errorResponse('Missing required fields', 400)
  }

  const config = buildConfig(env)
  const result = await completeProbe(config, {
    challenge_id: body.challenge_id,
    session_id: body.session_id,
    probe_ticket: body.probe_ticket,
    tapped_cell: body.tapped_cell,
  })
  return json(result, result.success ? 200 : 400)
}

async function handleBeginWebAuthnRegistration(request: Request, env: Env): Promise<Response> {
  let body: { site_key?: string; stable_id?: string }
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }
  if (!body.site_key || !body.stable_id) {
    return errorResponse('Missing required fields: site_key, stable_id', 400)
  }

  try {
    const result = await beginWebAuthnRegistration(buildConfig(env), {
      site_key: body.site_key,
      stable_id: body.stable_id,
    })
    return json(result)
  } catch (err) {
    console.error('beginWebAuthnRegistration failed:', err)
    return errorResponse('Internal server error', 500)
  }
}

async function handleCompleteWebAuthnRegistration(request: Request, env: Env): Promise<Response> {
  let body: { session_id?: string; response?: unknown }
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }
  if (!body.session_id || !body.response) {
    return errorResponse('Missing required fields: session_id, response', 400)
  }

  try {
    const result = await completeWebAuthnRegistration(buildConfig(env), {
      session_id: body.session_id,
      response: body.response as never,
    })
    return json(result, result.success ? 200 : 400)
  } catch (err) {
    console.error('completeWebAuthnRegistration failed:', err)
    return errorResponse('Internal server error', 500)
  }
}

/** Parse form-encoded body into a plain object */
async function parseFormBody(request: Request): Promise<Record<string, string>> {
  const text = await request.text()
  const params = new URLSearchParams(text)
  const obj: Record<string, string> = {}
  for (const [key, value] of params) {
    obj[key] = value
  }
  return obj
}

/** Create a new Request with a JSON body from a plain object */
function jsonRequest(original: Request, body: Record<string, string>): Request {
  return new Request(original.url, {
    method: original.method,
    headers: new Headers([...original.headers.entries(), ['content-type', 'application/json']]),
    body: JSON.stringify(body),
  })
}

function isFormEncoded(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Startup guard
    if (!env.CERNO_SECRET) {
      return new Response('Server misconfigured: missing CERNO_SECRET', { status: 500 })
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    const path = url.pathname

    switch (request.method) {
      case 'GET':
        switch (path) {
          case '/auth/github':
            return handleGitHubAuth(request, env)
          case '/auth/github/callback':
            return handleGitHubCallback(request, env)
          case '/dashboard': {
            const session = await requireSession(request, env)
            if (!session) return new Response(null, { status: 302, headers: { Location: '/auth/github' } })
            return handleDashboard(request, env, session)
          }
          case '/api/account': {
            const session = await requireSession(request, env)
            if (!session) return errorResponse('Unauthorized', 401)
            return handleGetAccount(request, env, session)
          }
          default:
            return errorResponse('Not found', 404)
        }

      case 'POST':
        switch (path) {
          // Browser-facing CAPTCHA routes
          case '/challenge':
            return handleChallenge(request, env)
          case '/verify':
            return handleVerify(request, env)
          case '/probe/arm':
            return handleProbeArm(request, env)
          case '/probe/complete':
            return handleProbeComplete(request, env)
          case '/webauthn/register/options':
            return handleBeginWebAuthnRegistration(request, env)
          case '/webauthn/register/verify':
            return handleCompleteWebAuthnRegistration(request, env)

          // Server-to-server
          case '/siteverify':
            return handleSiteverify(request, env)
          case '/register':
            return handleRegister(request, env)

          // Auth
          case '/auth/logout':
            return handleLogout(request, env)

          // Dashboard account actions (handle both form and JSON)
          case '/api/account/keys': {
            const session = await requireSession(request, env)
            if (!session) return errorResponse('Unauthorized', 401)
            const result = await handleCreateKey(request, env, session.github_id)
            if (isFormEncoded(request)) {
              const data = (await result.json()) as { site_key: string; api_secret: string }
              const params = new URLSearchParams({
                new_site_key: data.site_key,
                new_api_secret: data.api_secret,
                success: 'key_created',
              })
              return new Response(null, { status: 303, headers: { Location: `/dashboard?${params}` } })
            }
            return result
          }
          case '/api/account/keys/revoke': {
            const session = await requireSession(request, env)
            if (!session) return errorResponse('Unauthorized', 401)
            if (isFormEncoded(request)) {
              const formBody = await parseFormBody(request)
              const result = await handleRevokeKey(jsonRequest(request, formBody), env, session.github_id)
              const data = (await result.json()) as { success?: boolean; error?: string }
              const loc = data.success ? '/dashboard?success=key_revoked' : `/dashboard?error=${data.error ?? 'revoke_failed'}`
              return new Response(null, { status: 303, headers: { Location: loc } })
            }
            return handleRevokeKey(request, env, session.github_id)
          }
          case '/api/account/keys/claim': {
            const session = await requireSession(request, env)
            if (!session) return errorResponse('Unauthorized', 401)
            if (isFormEncoded(request)) {
              const formBody = await parseFormBody(request)
              const result = await handleClaimKey(jsonRequest(request, formBody), env, session.github_id)
              const data = (await result.json()) as { success?: boolean; error?: string }
              const loc = data.success ? '/dashboard?success=key_claimed' : `/dashboard?error=${data.error ?? 'claim_failed'}`
              return new Response(null, { status: 303, headers: { Location: loc } })
            }
            return handleClaimKey(request, env, session.github_id)
          }

          default:
            return errorResponse('Not found', 404)
        }

      default:
        return errorResponse('Method not allowed', 405)
    }
  },
}

/**
 * Server-to-server token verification.
 * Authenticates via per-site-key api_secret (Authorization: Bearer {api_secret}).
 * Falls back to global CERNO_SITEVERIFY_AUTH_TOKEN if set (legacy).
 */
async function handleSiteverify(request: Request, env: Env): Promise<Response> {
  let body: { token?: string; session_id?: string; site_key?: string }
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.token || !body.session_id) {
    return errorResponse('Missing required fields: token, session_id', 400)
  }

  const authHeader = request.headers.get('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  // Per-site-key auth (primary path)
  if (body.site_key) {
    const reg = await getRegistration(body.site_key, env.CERNO_KV)
    if (!reg) {
      return errorResponse('Invalid site_key', 403)
    }
    if (reg.revoked) {
      return errorResponse('Site key revoked', 403)
    }
    if (!bearerToken) {
      return errorResponse('Missing Authorization header', 401)
    }
    // Hash the provided secret and compare against stored hash
    const encoder = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(bearerToken))
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    if (hashHex !== reg.api_secret_hash) {
      return errorResponse('Invalid api_secret', 401)
    }

    // Increment usage counter
    const usage = await incrementUsage(body.site_key, env.CERNO_KV)
    if (!usage.allowed) {
      return json({ success: false, error: 'rate_limit_exceeded', usage: usage.count, limit: 10_000 }, 429)
    }
  } else {
    // Legacy: global bearer token fallback
    const expectedAuthToken = env.CERNO_SITEVERIFY_AUTH_TOKEN
    if (expectedAuthToken) {
      if (!bearerToken || bearerToken !== expectedAuthToken) {
        return errorResponse('Unauthorized', 401)
      }
    }
  }

  try {
    const store = buildStore(env)
    const result = await siteverify(
      { token: body.token, session_id: body.session_id },
      { secret: env.CERNO_SECRET, store },
    )
    return json(result, result.success ? 200 : 400)
  } catch (err) {
    console.error('siteverify failed:', err)
    return errorResponse('Internal server error', 500)
  }
}

export { CernoStateShard }
