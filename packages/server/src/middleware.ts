import { ErrorCode } from '@cernosh/core'
import type { ServerConfig } from './types.js'
import { createChallenge, validateSubmission } from './validate.js'
import { armProbe, completeProbe } from './probe-flow.js'
import { siteverify } from './siteverify.js'

const KNOWN_PATHS = ['/challenge', '/verify', '/probe/arm', '/probe/complete', '/siteverify']

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorCodeToStatus(code: string): number {
  switch (code) {
    case ErrorCode.CHALLENGE_EXPIRED:
      return 410
    case ErrorCode.RATE_LIMITED:
      return 429
    default:
      return 400
  }
}

function matchRoute(pathname: string): string | null {
  for (const path of KNOWN_PATHS) {
    if (pathname === path) {
      return path
    }
  }
  return null
}

/**
 * Create a Web Standard request handler from a ServerConfig.
 * Routes POST requests to the appropriate Cerno pipeline function.
 */
export function cernoMiddleware(config: ServerConfig): (req: Request) => Promise<Response> {
  if (!config.store) {
    throw new Error('cernoMiddleware requires config.store')
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const route = matchRoute(url.pathname)

    if (!route) {
      return jsonResponse({ error: 'not_found' }, 404)
    }

    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method_not_allowed' }, 405)
    }

    try {
      const body = await req.json()

      switch (route) {
        case '/challenge': {
          const result = await createChallenge(config, body)
          return jsonResponse(result, 200)
        }
        case '/verify': {
          const result = await validateSubmission(config, body)
          const status = result.success ? 200 : (result.error_code ? errorCodeToStatus(result.error_code) : 400)
          return jsonResponse(result, status)
        }
        case '/probe/arm': {
          const result = await armProbe(config, body)
          return jsonResponse(result, 200)
        }
        case '/probe/complete': {
          const result = await completeProbe(config, body)
          return jsonResponse(result, 200)
        }
        case '/siteverify': {
          const siteVerifyOpts = {
            secret: config.secret,
            secrets: config.secrets,
            store: config.store,
            tokenTtlMs: config.tokenTtlMs,
          }
          const result = await siteverify(
            { token: body.token, session_id: body.session_id },
            siteVerifyOpts,
          )
          return jsonResponse(result, result.success ? 200 : 400)
        }
        default:
          return jsonResponse({ error: 'not_found' }, 404)
      }
    } catch (err) {
      console.error('cernoMiddleware error:', err)
      return jsonResponse({ error: 'internal_error' }, 500)
    }
  }
}

/**
 * Adapt a Web Standard request handler into an Express-compatible middleware.
 * Constructs a Request from the Express req, calls the handler, and pipes
 * the Response back through Express res.
 */
export function toExpressHandler(
  handler: (req: Request) => Promise<Response>,
): (req: any, res: any, next: any) => Promise<void> {
  return async (req, res, next) => {
    try {
      const protocol = req.protocol ?? 'http'
      const host = req.get?.('host') ?? req.headers?.host ?? 'localhost'
      const fullUrl = `${protocol}://${host}${req.originalUrl}`

      const headers = new Headers()
      if (req.headers) {
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') {
            headers.set(key, value)
          }
        }
      }

      let bodyInit: string | undefined
      if (req.body !== undefined && req.body !== null) {
        bodyInit = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      }

      const webReq = new Request(fullUrl, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyInit : undefined,
      })

      const response = await handler(webReq)
      res.status(response.status)
      response.headers.forEach((value: string, key: string) => {
        res.setHeader(key, value)
      })
      res.end(await response.text())
    } catch (err) {
      next(err)
    }
  }
}
