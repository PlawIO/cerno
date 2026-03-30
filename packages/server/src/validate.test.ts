import { describe, expect, it, beforeEach } from 'vitest'
import { type RawEvent, generateMaze, RENDERING } from '@cernosh/core'
import { createChallenge, validateSubmission } from './validate.js'
import { verifyToken } from './token.js'
import { MemoryStore } from './store.js'
import { generateSyntheticHumanTrace } from './test-utils.js'
import type { ServerConfig, SecretFeaturesProvider, ScoringContext, ValidationEvent } from './types.js'

const INSTRUCTION_TEXT_HEIGHT = 24

// ── Crypto helpers for test ──

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

function buildChallengeBindingPayload(
  challengeId: string,
  siteKey: string,
  expiresAt: number,
): string {
  return `${challengeId}:${siteKey}:${expiresAt}`
}

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

function makeHumanEvents(maze: ReturnType<typeof generateMaze>, seed = 42): RawEvent[] {
  // Use the proper synthetic human trace generator (produces maze-normalized [0,1] coords),
  // then convert to canvas-relative coords so the server's renormalization pipeline is exercised.
  const trace = generateSyntheticHumanTrace(maze, { seed })
  return trace.map((e) => {
    const canvas = toCanvasCoords(e.x, e.y, maze.width, maze.height)
    return { t: e.t, x: canvas.x, y: canvas.y, type: e.type }
  })
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
      scoreThreshold: 0.3, // Low for synthetic test traces (k=2 tightens scoring)
      mazeWidth: 8,
      mazeHeight: 8,
      mazeDifficulty: 0.3,
    }
  })

  it('creates a challenge with valid fields', async () => {
    const challenge = await createChallenge(config, { site_key: 'test-site' })
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

  it('issues probes regardless of reduced_motion', async () => {
    config.enableProbes = true
    config.probeProbability = 1

    const challenge = await createChallenge(config, {
      site_key: 'test-site',
      client_capabilities: { reduced_motion: true },
    })

    expect(challenge.requirements?.probe.mode).toBe('required')
    expect(challenge.probes?.length).toBe(1)
  })

  it('issues webauthn request options for registered stable ids', async () => {
    config.webAuthn = {
      mode: 'required',
      rpId: 'example.com',
      expectedOrigin: 'https://example.com',
    }
    await store.saveWebAuthnCredential?.({
      credential_id: 'cred-1',
      credential_public_key: 'AA',
      counter: 0,
      stable_id: 'stable-user',
      site_key: 'test-site',
    })

    const challenge = await createChallenge(config, {
      site_key: 'test-site',
      stable_id: 'stable-user',
      client_capabilities: { webauthn_available: true },
    })

    expect(challenge.requirements?.webauthn.mode).toBe('required')
    expect(challenge.webauthn_request_options?.challenge).toBeDefined()
  })

  it('happy path: valid submission returns success + token', async () => {
    const challenge = await createChallenge(config, { site_key: 'test-site' })
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)
    const keyPair = await generateTestKeyPair()
    const signature = await signChallengeId(buildChallengeBindingPayload(challenge.id, challenge.site_key, challenge.expires_at), keyPair.privateKey)

    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-1',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: keyPair.publicKeyBase64,
      signature,
      timestamp: Date.now(),
    })

    expect(result.success).toBe(true)
    expect(result.token).toBeDefined()
    // K1: score and input_type now returned for Phase K battery
    expect(result.score).toBeGreaterThan(0)
    expect(result.input_type).toBeDefined()
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
    const challenge = await createChallenge(config, { site_key: 'test-site' })
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)
    const keyPair = await generateTestKeyPair()
    const signature = await signChallengeId(buildChallengeBindingPayload(challenge.id, challenge.site_key, challenge.expires_at), keyPair.privateKey)

    const req = {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-1',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: keyPair.publicKeyBase64,
      signature,
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
    const challenge = await createChallenge(config, { site_key: 'test-site' })
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

  it('rejects invalid signature', async () => {
    const challenge = await createChallenge(config, { site_key: 'test-site' })
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)
    const keyPair = await generateTestKeyPair()

    // Sign wrong data (not the challenge_id)
    const badSignature = await signChallengeId('wrong-challenge-id', keyPair.privateKey)

    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-sig',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: keyPair.publicKeyBase64,
      signature: badSignature,
      timestamp: Date.now(),
    })
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('invalid_signature')
  })

  it('end-to-end: validate then verifyToken round-trip', async () => {
    const challenge = await createChallenge(config, { site_key: 'test-site' })
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)
    const keyPair = await generateTestKeyPair()
    const signature = await signChallengeId(buildChallengeBindingPayload(challenge.id, challenge.site_key, challenge.expires_at), keyPair.privateKey)

    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-e2e',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: keyPair.publicKeyBase64,
      signature,
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
    // Score is stripped from JWT payload (B3)
    expect(verified.score).toBe(0)

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
    const challenge = await createChallenge(config, { site_key: 'test-site' })
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
    const challenge = await createChallenge(config, { site_key: 'site-alpha' })

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

  it('rejects cross-session replay (session_id mismatch)', async () => {
    const challenge = await createChallenge(config, {
      site_key: 'test-site',
      session_id: 'session-A',
    })

    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-B', // Different from 'session-A'
      events: [],
      pow_proof: { nonce: 0, hash: 'bad' },
      public_key: 'pk',
      timestamp: Date.now(),
    })
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('challenge_not_found')
  })

  it('rejects a verification attempt with the wrong rate-limit binding', async () => {
    const challenge = await createChallenge(config, {
      site_key: 'test-site',
      rate_limit_binding: 'issuer-binding',
    })
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)
    const keyPair = await generateTestKeyPair()
    const signature = await signChallengeId(
      buildChallengeBindingPayload(challenge.id, challenge.site_key, challenge.expires_at),
      keyPair.privateKey,
    )

    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-binding',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: keyPair.publicKeyBase64,
      signature,
      timestamp: Date.now(),
      rate_limit_binding: 'different-binding',
    })

    expect(result.success).toBe(false)
    expect(result.error_code).toBe('challenge_not_found')
  })

  it('rate limits after max attempts', async () => {
    config.maxAttempts = 2
    config.rateLimitWindowMs = 60000

    // Burn through attempts
    for (let i = 0; i < 2; i++) {
      const challenge = await createChallenge(config, { site_key: 'test-site' })
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
    const challenge = await createChallenge(config, { site_key: 'test-site' })
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

  it('SecretFeaturesProvider injected via config is called', async () => {
    let providerCalled = false
    let receivedCtx: ScoringContext | null = null

    const provider: SecretFeaturesProvider = {
      score(ctx) {
        providerCalled = true
        receivedCtx = ctx
        return { score: 0.9, zScores: { custom_feature: 0.5 } }
      },
    }

    const providerConfig: ServerConfig = {
      ...config,
      secretFeaturesProvider: provider,
    }

    const challenge = await createChallenge(providerConfig, { site_key: 'test-site' })
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)
    const keyPair = await generateTestKeyPair()
    const signature = await signChallengeId(
      buildChallengeBindingPayload(challenge.id, challenge.site_key, challenge.expires_at),
      keyPair.privateKey,
    )

    const result = await validateSubmission(providerConfig, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-provider',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: keyPair.publicKeyBase64,
      signature,
      timestamp: Date.now(),
    })

    expect(providerCalled).toBe(true)
    expect(receivedCtx).not.toBeNull()
    expect(receivedCtx!.challengeId).toBe(challenge.id)
    expect(receivedCtx!.siteKey).toBe('test-site')
    expect(receivedCtx!.publicFeatures).toBeDefined()
    expect(receivedCtx!.publicZScores).toBeDefined()
    expect(result.success).toBe(true)
  })

  it('SecretFeaturesProvider that throws falls back gracefully', async () => {
    const provider: SecretFeaturesProvider = {
      score() {
        throw new Error('provider exploded')
      },
    }

    const providerConfig: ServerConfig = {
      ...config,
      secretFeaturesProvider: provider,
    }

    const challenge = await createChallenge(providerConfig, { site_key: 'test-site' })
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)
    const keyPair = await generateTestKeyPair()
    const signature = await signChallengeId(
      buildChallengeBindingPayload(challenge.id, challenge.site_key, challenge.expires_at),
      keyPair.privateKey,
    )

    const result = await validateSubmission(providerConfig, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-fallback',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: keyPair.publicKeyBase64,
      signature,
      timestamp: Date.now(),
    })

    // Should not crash, falls back to built-in scoring
    expect(result.success).toBe(true)
  })

  it('onValidation emits feature_z_scores', async () => {
    let capturedEvent: ValidationEvent | null = null

    const observableConfig: ServerConfig = {
      ...config,
      onValidation: (event) => {
        capturedEvent = event
      },
    }

    const challenge = await createChallenge(observableConfig, { site_key: 'test-site' })
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)
    const keyPair = await generateTestKeyPair()
    const signature = await signChallengeId(
      buildChallengeBindingPayload(challenge.id, challenge.site_key, challenge.expires_at),
      keyPair.privateKey,
    )

    await validateSubmission(observableConfig, {
      challenge_id: challenge.id,
      site_key: 'test-site',
      session_id: 'session-observe',
      maze_seed: challenge.maze_seed,
      events,
      pow_proof: powProof,
      public_key: keyPair.publicKeyBase64,
      signature,
      timestamp: Date.now(),
    })

    expect(capturedEvent).not.toBeNull()
    expect(capturedEvent!.feature_z_scores).toBeDefined()
    expect(Object.keys(capturedEvent!.feature_z_scores!).length).toBeGreaterThan(0)
    // Should have both public and secret z-scores
    expect(capturedEvent!.feature_z_scores).toHaveProperty('velocity_std')
    expect(capturedEvent!.feature_z_scores).toHaveProperty('velocity_autocorrelation')
    expect(capturedEvent!.input_type).toBeDefined()
  })
})
