import { describe, expect, it, beforeEach } from 'vitest'
import { type RawEvent, generateMaze, RENDERING } from '@cernosh/core'
import { createChallenge, validateSubmission } from './validate.js'
import { verifyToken } from './token.js'
import { MemoryStore } from './store.js'
import type { ServerConfig } from './types.js'

const INSTRUCTION_TEXT_HEIGHT = 24

/**
 * Convert maze-grid-normalized coords to canvas-normalized coords.
 * Inverse of renormalizeEvents — simulates what the mouse collector produces.
 */
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

function makeHumanEvents(maze: ReturnType<typeof generateMaze>): RawEvent[] {
  // Generate events that trace the solution path through cell centers.
  // Output canvas-normalized coords (what the mouse collector produces)
  // so the server's renormalization pipeline is exercised.
  const events: RawEvent[] = []
  const solution = maze.solution
  let t = 0

  // Movement onset delay
  const start = toCanvasCoords(
    (solution[0].x + 0.5) / maze.width,
    (solution[0].y + 0.5) / maze.height,
    maze.width, maze.height,
  )
  events.push({ t: 0, x: start.x, y: start.y, type: 'down' })
  t += 500

  // Add several intermediate points per cell for realistic movement
  for (let i = 0; i < solution.length; i++) {
    const cell = solution[i]
    const mazeX = (cell.x + 0.5) / maze.width
    const mazeY = (cell.y + 0.5) / maze.height

    // Multiple points per cell with some jitter
    for (let j = 0; j < 5; j++) {
      t += 16 + Math.random() * 10
      const jitteredX = mazeX + (Math.random() - 0.5) * 0.01
      const jitteredY = mazeY + (Math.random() - 0.5) * 0.01
      const canvas = toCanvasCoords(jitteredX, jitteredY, maze.width, maze.height)
      events.push({ t, x: canvas.x, y: canvas.y, type: 'move' })
    }

    // Pause at some cells (decision points)
    if (i % 3 === 0 && i > 0) {
      t += 150
      const canvas = toCanvasCoords(mazeX, mazeY, maze.width, maze.height)
      events.push({ t, x: canvas.x, y: canvas.y, type: 'move' })
    }
  }

  const lastCell = solution[solution.length - 1]
  const end = toCanvasCoords(
    (lastCell.x + 0.5) / maze.width,
    (lastCell.y + 0.5) / maze.height,
    maze.width, maze.height,
  )
  events.push({ t: t + 16, x: end.x, y: end.y, type: 'up' })

  return events
}

describe('validate pipeline', () => {
  let store: MemoryStore
  let config: ServerConfig

  beforeEach(() => {
    store = new MemoryStore()
    config = {
      secret: 'test-secret-for-validation',
      store,
      powDifficulty: 4, // Very low for fast tests
      scoreThreshold: 0.5, // Default threshold — tests must pass with realistic scoring
      mazeWidth: 8,
      mazeHeight: 8,
      mazeDifficulty: 0.3,
    }
  })

  it('creates a challenge with valid fields', async () => {
    const challenge = await createChallenge(config, 'test-site')
    expect(challenge.id).toBeDefined()
    expect(challenge.maze_seed).toBeTypeOf('number')
    expect(challenge.pow_challenge.length).toBe(32)
    expect(challenge.pow_difficulty).toBe(4)
    expect(challenge.site_key).toBe('test-site')
    expect(challenge.expires_at).toBeGreaterThan(challenge.created_at)
    expect(challenge.maze_width).toBe(8)
    expect(challenge.maze_height).toBe(8)
    expect(challenge.maze_difficulty).toBe(0.3)
  })

  it('happy path: valid submission returns success + token', async () => {
    const challenge = await createChallenge(config, 'test-site')
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)

    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-1',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: 'test-public-key',
      timestamp: Date.now(),
    })

    expect(result.success).toBe(true)
    expect(result.token).toBeDefined()
    expect(result.score).toBeGreaterThan(0)
  })

  it('rejects unknown challenge_id', async () => {
    const result = await validateSubmission(config, {
      challenge_id: 'nonexistent',
      site_key: 'test-site',
      session_id: 'session-1',
      maze_seed: 42,
      events: [],
      pow_proof: { nonce: 0, hash: 'bad' },
      public_key: 'pk',
      timestamp: Date.now(),
    })
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('challenge_not_found')
  })

  it('rejects replay (challenge used twice)', async () => {
    const challenge = await createChallenge(config, 'test-site')
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)

    const req = {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-1',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: 'test-public-key',
      timestamp: Date.now(),
    }

    // First submission should succeed
    const first = await validateSubmission(config, req)
    expect(first.success).toBe(true)

    // Second submission (replay) should fail
    const second = await validateSubmission(config, req)
    expect(second.success).toBe(false)
    expect(second.error_code).toBe('challenge_not_found')
  })

  it('rejects invalid PoW', async () => {
    const challenge = await createChallenge(config, 'test-site')
    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-1',
      maze_seed: challenge.maze_seed,
      events: [],
      pow_proof: { nonce: 0, hash: '0000000000000000' },
      public_key: 'pk',
      timestamp: Date.now(),
    })
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('invalid_pow')
  })

  it('end-to-end: validate then verifyToken round-trip', async () => {
    const challenge = await createChallenge(config, 'test-site')
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)

    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-e2e',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: 'test-public-key',
      timestamp: Date.now(),
    })

    expect(result.success).toBe(true)
    expect(result.token).toBeDefined()

    // Verify the token round-trips correctly
    const verified = await verifyToken(result.token!, {
      secret: config.secret,
      sessionId: 'session-e2e',
      store,
      tokenTtlMs: 60000,
    })
    expect(verified.valid).toBe(true)
    expect(verified.score).toBeGreaterThan(0)

    // Second use of same token should fail (single-use)
    const replay = await verifyToken(result.token!, {
      secret: config.secret,
      sessionId: 'session-e2e',
      store,
      tokenTtlMs: 60000,
    })
    expect(replay.valid).toBe(false)
    expect(replay.error).toBe('token_already_consumed')
  })

  it('rejects oversized events array', async () => {
    const challenge = await createChallenge(config, 'test-site')
    const hugeEvents = new Array(50_001).fill({ t: 0, x: 0, y: 0, type: 'move' })

    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-dos',
      maze_seed: challenge.maze_seed,
      events: hugeEvents,
      pow_proof: { nonce: 0, hash: 'bad' },
      public_key: 'pk',
      timestamp: Date.now(),
    })
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('invalid_request')
  })

  it('rejects site_key mismatch between challenge and request', async () => {
    const challenge = await createChallenge(config, 'site-alpha')

    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'site-beta', // Different from 'site-alpha'
      session_id: 'session-mismatch',
      maze_seed: challenge.maze_seed,
      events: [],
      pow_proof: { nonce: 0, hash: 'bad' },
      public_key: 'pk',
      timestamp: Date.now(),
    })
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('challenge_not_found')
  })

  it('rate limits after max attempts', async () => {
    config.maxAttempts = 2
    config.rateLimitWindowMs = 60000

    // Burn through attempts
    for (let i = 0; i < 2; i++) {
      const challenge = await createChallenge(config, 'test-site')
      await validateSubmission(config, {
        challenge_id: challenge.id,
        site_key: 'test-site',
        session_id: 'same-session',
        maze_seed: 0,
        events: [],
        pow_proof: { nonce: 0, hash: 'bad' },
        public_key: 'pk',
        timestamp: Date.now(),
      })
    }

    // Third attempt should be rate limited
    const challenge = await createChallenge(config, 'test-site')
    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'same-session',
      maze_seed: 0,
      events: [],
      pow_proof: { nonce: 0, hash: 'bad' },
      public_key: 'pk',
      timestamp: Date.now(),
    })
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('rate_limited')
  })
})
