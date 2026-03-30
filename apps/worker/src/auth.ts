import type { Env } from './index.js'

export type AccountRecord = {
  github_id: string
  login: string
  name?: string
  email?: string
  avatar_url?: string
  created_at: number
}

type SessionRecord = {
  github_id: string
  created_at: number
  expires_at: number
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? match[1] : null
}

const THIRTY_DAYS = 30 * 24 * 60 * 60

export async function handleGitHubAuth(
  request: Request,
  env: Env,
): Promise<Response> {
  const state = randomHex(16)
  await env.CERNO_KV.put(`state:${state}`, '1', { expirationTtl: 300 })

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${env.CERNO_BASE_URL}/auth/github/callback`,
    scope: 'read:user,user:email',
    state,
  })

  return Response.redirect(
    `https://github.com/login/oauth/authorize?${params.toString()}`,
    302,
  )
}

export async function handleGitHubCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  try {
    if (!code || !state) {
      throw new Error('missing code or state')
    }

    // Validate and consume state token
    const stored = await env.CERNO_KV.get(`state:${state}`)
    if (!stored) {
      throw new Error('invalid or expired state')
    }
    await env.CERNO_KV.delete(`state:${state}`)

    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    })

    const tokenData = (await tokenRes.json()) as {
      access_token?: string
      error?: string
    }
    if (!tokenData.access_token) {
      throw new Error(tokenData.error ?? 'no access_token in response')
    }

    // Fetch user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'cerno-worker',
      },
    })

    if (!userRes.ok) {
      throw new Error(`GitHub user fetch failed: ${userRes.status}`)
    }

    const user = (await userRes.json()) as {
      id: number
      login: string
      name?: string
      email?: string
      avatar_url?: string
    }

    const githubId = String(user.id)

    // Upsert account
    const account: AccountRecord = {
      github_id: githubId,
      login: user.login,
      name: user.name ?? undefined,
      email: user.email ?? undefined,
      avatar_url: user.avatar_url ?? undefined,
      created_at: Date.now(),
    }
    await env.CERNO_KV.put(`account:${githubId}`, JSON.stringify(account))

    // Create session
    const sessionToken = randomHex(32)
    const now = Date.now()
    const session: SessionRecord = {
      github_id: githubId,
      created_at: now,
      expires_at: now + THIRTY_DAYS * 1000,
    }
    await env.CERNO_KV.put(`session:${sessionToken}`, JSON.stringify(session), {
      expirationTtl: THIRTY_DAYS,
    })

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/dashboard',
        'Set-Cookie': `cerno_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${THIRTY_DAYS}`,
      },
    })
  } catch (err) {
    console.error('GitHub OAuth callback error:', err)
    return Response.redirect(`${env.CERNO_BASE_URL}/dashboard?error=auth_failed`, 302)
  }
}

export async function handleLogout(
  request: Request,
  env: Env,
): Promise<Response> {
  const cookieHeader = request.headers.get('cookie')
  const token = parseCookie(cookieHeader, 'cerno_session')

  if (token) {
    await env.CERNO_KV.delete(`session:${token}`)
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie':
        'cerno_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    },
  })
}

export async function requireSession(
  request: Request,
  env: Env,
): Promise<{ github_id: string; login: string } | null> {
  const cookieHeader = request.headers.get('cookie')
  const token = parseCookie(cookieHeader, 'cerno_session')

  if (!token) return null

  const raw = await env.CERNO_KV.get(`session:${token}`)
  if (!raw) return null

  const session = JSON.parse(raw) as SessionRecord
  if (session.expires_at < Date.now()) return null

  const accountRaw = await env.CERNO_KV.get(`account:${session.github_id}`)
  if (!accountRaw) return null

  const account = JSON.parse(accountRaw) as AccountRecord
  return { github_id: session.github_id, login: account.login }
}
