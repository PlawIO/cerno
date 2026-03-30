import type { Env } from './index.js'

export interface RegistrationRecord {
  api_secret_hash: string   // hex(sha256(api_secret))
  github_id: string | null  // null = anonymous
  created_at: number
  month: string             // "2026-03" format
  count: number             // verifications this month
  label?: string
  revoked?: boolean
}

// ---------------------------------------------------------------------------
// Helpers (not exported)
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function currentMonth(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status)
}

function getClientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for') ??
    'unknown'
  )
}

async function checkRegRateLimit(
  ip: string,
  kv: KVNamespace,
): Promise<boolean> {
  const kvKey = `rate:reg:${ip}`
  const now = Date.now()
  const windowMs = 60 * 60 * 1000 // 1 hour

  let timestamps: number[] = []
  const raw = await kv.get(kvKey)
  if (raw) {
    try {
      timestamps = JSON.parse(raw)
    } catch {
      timestamps = []
    }
  }

  timestamps = timestamps.filter((t) => t > now - windowMs)

  if (timestamps.length >= 5) {
    return false // rate limited
  }

  timestamps.push(now)
  const ttlSeconds = Math.max(60, Math.ceil(windowMs / 1000))
  await kv.put(kvKey, JSON.stringify(timestamps), {
    expirationTtl: ttlSeconds,
  })

  return true // allowed
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleRegister(
  request: Request,
  env: Env,
): Promise<Response> {
  const ip = getClientIp(request)
  const allowed = await checkRegRateLimit(ip, env.CERNO_KV)
  if (!allowed) {
    return errorResponse('Rate limit exceeded', 429)
  }

  const siteKey = 'ck_' + randomHex(16)
  const apiSecret = 'sk_live_' + randomHex(32)
  const apiSecretHash = await sha256Hex(apiSecret)

  const record: RegistrationRecord = {
    api_secret_hash: apiSecretHash,
    github_id: null,
    created_at: Date.now(),
    month: currentMonth(),
    count: 0,
  }

  await env.CERNO_KV.put(`reg:${siteKey}`, JSON.stringify(record))

  return jsonResponse({ site_key: siteKey, api_secret: apiSecret }, 201)
}

export async function handleCreateKey(
  request: Request,
  env: Env,
  githubId: string,
): Promise<Response> {
  const ip = getClientIp(request)
  const allowed = await checkRegRateLimit(ip, env.CERNO_KV)
  if (!allowed) {
    return errorResponse('Rate limit exceeded', 429)
  }

  const siteKey = 'ck_' + randomHex(16)
  const apiSecret = 'sk_live_' + randomHex(32)
  const apiSecretHash = await sha256Hex(apiSecret)

  const record: RegistrationRecord = {
    api_secret_hash: apiSecretHash,
    github_id: githubId,
    created_at: Date.now(),
    month: currentMonth(),
    count: 0,
  }

  await env.CERNO_KV.put(`reg:${siteKey}`, JSON.stringify(record))

  // Add to account key index
  const indexKey = `account:keys:${githubId}`
  const raw = await env.CERNO_KV.get(indexKey)
  const keys: string[] = raw ? JSON.parse(raw) : []
  keys.push(siteKey)
  await env.CERNO_KV.put(indexKey, JSON.stringify(keys))

  return jsonResponse({ site_key: siteKey, api_secret: apiSecret }, 201)
}

export async function handleRevokeKey(
  request: Request,
  env: Env,
  githubId: string,
): Promise<Response> {
  let body: { site_key?: string }
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.site_key || typeof body.site_key !== 'string') {
    return errorResponse('Missing or invalid site_key', 400)
  }

  const raw = await env.CERNO_KV.get(`reg:${body.site_key}`)
  if (!raw) {
    return errorResponse('Key not found', 404)
  }

  const record: RegistrationRecord = JSON.parse(raw)

  if (record.github_id !== githubId) {
    return errorResponse('Forbidden', 403)
  }

  record.revoked = true
  await env.CERNO_KV.put(`reg:${body.site_key}`, JSON.stringify(record))

  // Remove from account key index
  const indexKey = `account:keys:${githubId}`
  const indexRaw = await env.CERNO_KV.get(indexKey)
  if (indexRaw) {
    const keys: string[] = JSON.parse(indexRaw)
    const filtered = keys.filter((k) => k !== body.site_key)
    await env.CERNO_KV.put(indexKey, JSON.stringify(filtered))
  }

  return jsonResponse({ success: true })
}

export async function handleClaimKey(
  request: Request,
  env: Env,
  githubId: string,
): Promise<Response> {
  let body: { site_key?: string; api_secret?: string }
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (
    !body.site_key ||
    typeof body.site_key !== 'string' ||
    !body.api_secret ||
    typeof body.api_secret !== 'string'
  ) {
    return errorResponse('Missing or invalid site_key / api_secret', 400)
  }

  const raw = await env.CERNO_KV.get(`reg:${body.site_key}`)
  if (!raw) {
    return errorResponse('Key not found', 404)
  }

  const record: RegistrationRecord = JSON.parse(raw)

  if (record.github_id !== null) {
    return errorResponse('Key already claimed', 409)
  }

  const hash = await sha256Hex(body.api_secret)
  if (hash !== record.api_secret_hash) {
    return errorResponse('Invalid api_secret', 403)
  }

  record.github_id = githubId
  await env.CERNO_KV.put(`reg:${body.site_key}`, JSON.stringify(record))

  // Add to account key index
  const indexKey = `account:keys:${githubId}`
  const indexRaw = await env.CERNO_KV.get(indexKey)
  const keys: string[] = indexRaw ? JSON.parse(indexRaw) : []
  keys.push(body.site_key)
  await env.CERNO_KV.put(indexKey, JSON.stringify(keys))

  return jsonResponse({ success: true })
}

// ---------------------------------------------------------------------------
// Utilities for other modules
// ---------------------------------------------------------------------------

export async function getRegistration(
  siteKey: string,
  kv: KVNamespace,
): Promise<RegistrationRecord | null> {
  const raw = await kv.get(`reg:${siteKey}`)
  if (!raw) return null
  return JSON.parse(raw) as RegistrationRecord
}

export async function incrementUsage(
  siteKey: string,
  kv: KVNamespace,
): Promise<{ allowed: boolean; count: number }> {
  const raw = await kv.get(`reg:${siteKey}`)
  if (!raw) {
    return { allowed: false, count: 0 }
  }

  const record: RegistrationRecord = JSON.parse(raw)
  const month = currentMonth()

  if (record.month !== month) {
    record.month = month
    record.count = 0
  }

  record.count += 1
  await kv.put(`reg:${siteKey}`, JSON.stringify(record))

  return { allowed: record.count <= 10_000, count: record.count }
}
