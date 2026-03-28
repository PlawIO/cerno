import { describe, expect, it, beforeEach } from 'vitest'
import { type RawEvent, generateMaze } from '@cerno/core'
import { createChallenge, validateSubmission } from './validate.js'
import { MemoryStore } from './store.js'
import type { ServerConfig } from './types.js'

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
  // Generate events that trace the solution path through cell centers
  const events: RawEvent[] = []
  const solution = maze.solution
  let t = 0

  // Movement onset delay
  events.push({ t: 0, x: (solution[0].x + 0.5) / maze.width, y: (solution[0].y + 0.5) / maze.height, type: 'down' })
  t += 500

  // Add several intermediate points per cell for realistic movement
  for (let i = 0; i < solution.length; i++) {
    const cell = solution[i]
    const cx = (cell.x + 0.5) / maze.width
    const cy = (cell.y + 0.5) / maze.height

    // Multiple points per cell with some jitter
    for (let j = 0; j < 5; j++) {
      t += 16 + Math.random() * 10
      events.push({
        t,
        x: cx + (Math.random() - 0.5) * 0.01,
        y: cy + (Math.random() - 0.5) * 0.01,
        type: 'move',
      })
    }

    // Pause at some cells (decision points)
    if (i % 3 === 0 && i > 0) {
      t += 150
      events.push({ t, x: cx, y: cy, type: 'move' })
    }
  }

  const lastCell = solution[solution.length - 1]
  events.push({
    t: t + 16,
    x: (lastCell.x + 0.5) / maze.width,
    y: (lastCell.y + 0.5) / maze.height,
    type: 'up',
  })

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
      scoreThreshold: 0.1, // Very low to focus on pipeline logic, not scoring thresholds
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
