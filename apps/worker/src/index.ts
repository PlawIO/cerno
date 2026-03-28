import { createChallenge, validateSubmission, ErrorCode } from '@cerno/server'
import type { ServerConfig, ValidationRequest } from '@cerno/server'
import { CloudflareKVStore } from './kv-store.js'

export interface Env {
  CERNO_KV: KVNamespace
  CERNO_SECRET: string
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
    case ErrorCode.BEHAVIORAL_REJECTED:
    case ErrorCode.INVALID_REQUEST:
      return 400
    default:
      return 400
  }
}

function buildConfig(env: Env): ServerConfig {
  return {
    secret: env.CERNO_SECRET,
    store: new CloudflareKVStore(env.CERNO_KV),
  }
}

async function handleChallenge(request: Request, env: Env): Promise<Response> {
  let body: { site_key?: string }
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.site_key || typeof body.site_key !== 'string') {
    return errorResponse('Missing or invalid site_key', 400)
  }

  try {
    const config = buildConfig(env)
    const challenge = await createChallenge(config, body.site_key)
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
    const config = buildConfig(env)
    const result = await validateSubmission(config, body)

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    const path = url.pathname

    if (request.method !== 'POST') {
      return errorResponse('Method not allowed', 405)
    }

    switch (path) {
      case '/challenge':
        return handleChallenge(request, env)
      case '/verify':
        return handleVerify(request, env)
      default:
        return errorResponse('Not found', 404)
    }
  },
}
