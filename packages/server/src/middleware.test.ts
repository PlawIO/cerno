import { describe, expect, it, beforeEach, vi } from 'vitest'
import { type RawEvent, generateMaze, RENDERING } from '@cernosh/core'
import { MemoryStore } from './store.js'
import { generateSyntheticHumanTrace } from './test-utils.js'
import { cernoMiddleware, toExpressHandler } from './middleware.js'
import type { ServerConfig } from './types.js'

const INSTRUCTION_TEXT_HEIGHT = 24

// ── Crypto helpers (same pattern as validate.test.ts) ──

async function generateTestKeyPair(): Promise<{
  publicKeyBase64: string
  privateKey: CryptoKey
}> {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const publicKeyBase64 = btoa(JSON.stringify(jwk))
  return { publicKeyBase64, privateKey: keyPair.privateKey }
}

async function signChallengeId(
  bindingPayload: string,
  privateKey: CryptoKey,
): Promise<string> {
  const data = new TextEncoder().encode(bindingPayload)
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    data,
  )
  const bytes = new Uint8Array(signature)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

async function computeEventsDigest(
  events: Array<{ t: number; x: number; y: number; type: string; pointer_type?: string | null; coalesced_count?: number | null }>,
): Promise<string> {
  const canonical = JSON.stringify(events.map(e => [e.t, e.x, e.y, e.type, e.pointer_type ?? null, e.coalesced_count ?? null]))
  const bytes = new TextEncoder().encode(canonical)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const arr = new Uint8Array(digest)
  let hex = ''
  for (const b of arr) hex += b.toString(16).padStart(2, '0')
  return hex
}

async function signWithEvents(
  challenge: { id: string; site_key: string; expires_at: number },
  events: Array<{ t: number; x: number; y: number; type: string }>,
  privateKey: CryptoKey,
): Promise<string> {
  const digest = await computeEventsDigest(events)
  return signChallengeId(
    `${challenge.id}:${challenge.site_key}:${challenge.expires_at}:${digest}`,
    privateKey,
  )
}

function toCanvasCoords(
  x: number, y: number, mazeWidth: number, mazeHeight: number,
): { x: number; y: number } {
  const cellSize = RENDERING.CELL_SIZE
  const margin = RENDERING.MARGIN
  const mazePixelW = mazeWidth * cellSize
  const mazePixelH = mazeHeight * cellSize
  const canvasW = mazePixelW + margin * 2
  const canvasH = mazePixelH + margin * 2 + INSTRUCTION_TEXT_HEIGHT
  return {
    x: (x * mazePixelW + margin) / canvasW,
    y: (y * mazePixelH + margin) / canvasH,
  }
}

async function solvePoW(challenge: string, difficulty: number): Promise<{ nonce: number; hash: string }> {
  let nonce = 0
  while (true) {
    const input = challenge + nonce.toString()
    const encoded = new TextEncoder().encode(input)
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded)
    const hashArray = new Uint8Array(hashBuffer)
    let zeroBits = 0
    for (const byte of hashArray) {
      if (byte === 0) { zeroBits += 8 } else { zeroBits += Math.clz32(byte) - 24; break }
    }
    if (zeroBits >= difficulty) {
      let hex = ''
      for (const b of hashArray) hex += b.toString(16).padStart(2, '0')
      return { nonce, hash: hex }
    }
    nonce++
  }
}

function makeHumanEvents(maze: ReturnType<typeof generateMaze>, seed = 42): RawEvent[] {
  const trace = generateSyntheticHumanTrace(maze, { seed })
  return trace.map((e) => {
    const canvas = toCanvasCoords(e.x, e.y, maze.width, maze.height)
    return { t: e.t, x: canvas.x, y: canvas.y, type: e.type }
  })
}

describe('cernoMiddleware', () => {
  let store: MemoryStore
  let config: ServerConfig
  let handler: (req: Request) => Promise<Response>

  beforeEach(() => {
    store = new MemoryStore()
    config = {
      secret: 'test-middleware-secret',
      store,
      powDifficulty: 4,
      scoreThreshold: 0.3,
      mazeWidth: 8,
      mazeHeight: 8,
      mazeDifficulty: 0.3,
    }
    handler = cernoMiddleware(config)
  })

  it('POST /challenge returns challenge', async () => {
    const req = new Request('http://localhost/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site_key: 'test' }),
    })

    const res = await handler(req)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.id).toBeDefined()
    expect(body.maze_seed).toBeTypeOf('number')
    expect(body.pow_challenge).toBeDefined()
    expect(body.pow_difficulty).toBe(4)
    expect(body.site_key).toBe('test')
  })

  it('POST /verify returns result (full round-trip)', async () => {
    // 1. Create challenge via middleware
    const challengeReq = new Request('http://localhost/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site_key: 'test' }),
    })
    const challengeRes = await handler(challengeReq)
    const challenge = await challengeRes.json()

    // 2. Solve the maze and PoW
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)
    const keyPair = await generateTestKeyPair()
    const signature = await signWithEvents(challenge, events, keyPair.privateKey)

    // 3. Submit verification via middleware
    const verifyReq = new Request('http://localhost/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challenge.id,
        site_key: 'test',
        session_id: 'session-mw',
        maze_seed: challenge.maze_seed,
        events,
        pow_proof: powProof,
        public_key: keyPair.publicKeyBase64,
        signature,
        timestamp: Date.now(),
      }),
    })

    const verifyRes = await handler(verifyReq)
    expect(verifyRes.status).toBe(200)

    const result = await verifyRes.json()
    expect(result.success).toBe(true)
    expect(result.token).toBeDefined()
  })

  it('unknown route returns 404', async () => {
    const req = new Request('http://localhost/unknown', {
      method: 'GET',
    })

    const res = await handler(req)
    expect(res.status).toBe(404)

    const body = await res.json()
    expect(body.error).toBe('not_found')
  })

  it('GET to known route returns 405', async () => {
    const req = new Request('http://localhost/challenge', {
      method: 'GET',
    })

    const res = await handler(req)
    expect(res.status).toBe(405)

    const body = await res.json()
    expect(body.error).toBe('method_not_allowed')
  })

  it('throws if config.store is missing', () => {
    expect(() => cernoMiddleware({ secret: 'x' } as any)).toThrow('config.store')
  })
})

describe('toExpressHandler', () => {
  it('converts Response to Express res calls', async () => {
    const fixedHandler = async (_req: Request) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-custom': 'val' },
      })

    const expressHandler = toExpressHandler(fixedHandler)

    const setHeaders: Record<string, string> = {}
    const mockReq = {
      method: 'POST',
      protocol: 'https',
      originalUrl: '/api/challenge',
      get: (name: string) => (name === 'host' ? 'example.com' : undefined),
      headers: { 'content-type': 'application/json' },
      body: { site_key: 'test' },
    }
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn((k: string, v: string) => { setHeaders[k] = v }),
      end: vi.fn(),
    }
    const mockNext = vi.fn()

    await expressHandler(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(201)
    expect(mockRes.end).toHaveBeenCalled()
    expect(mockNext).not.toHaveBeenCalled()
  })
})
