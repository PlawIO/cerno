import {
  type Challenge,
  type ValidationRequest,
  type ValidationResult,
  ErrorCode,
  extractFeatures,
} from '@agentcaptcha/core'
import type { ServerConfig } from './types.js'
import { verifyPow } from './pow-verify.js'
import { validateMazePath } from './maze-solver.js'
import { scoreBehavior } from './behavioral-scoring.js'
import { generateToken } from './token.js'

const DEFAULTS = {
  mazeDifficulty: 0.3,
  mazeWidth: 10,
  mazeHeight: 10,
  powDifficulty: 18,
  challengeTtlMs: 120_000,
  tokenTtlMs: 60_000,
  scoreThreshold: 0.5,
  calibrationScoreThreshold: 0.3,
  maxAttempts: 5,
  rateLimitWindowMs: 300_000,
} as const

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  let hex = ''
  for (const b of buf) {
    hex += b.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Create a new CAPTCHA challenge for a site.
 */
export async function createChallenge(
  config: ServerConfig,
  siteKey: string,
): Promise<Challenge> {
  const id = globalThis.crypto.randomUUID()
  const mazeSeed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
  const powChallenge = randomHex(16) // 32 hex chars
  const powDifficulty = config.powDifficulty ?? DEFAULTS.powDifficulty
  const ttl = config.challengeTtlMs ?? DEFAULTS.challengeTtlMs
  const now = Date.now()

  const challenge: Challenge = {
    id,
    maze_seed: mazeSeed,
    pow_challenge: powChallenge,
    pow_difficulty: powDifficulty,
    site_key: siteKey,
    created_at: now,
    expires_at: now + ttl,
  }

  await config.store.setChallenge(id, challenge, ttl)

  return challenge
}

/**
 * Main validation pipeline. Six rejection paths, one success path.
 */
export async function validateSubmission(
  config: ServerConfig,
  request: ValidationRequest,
): Promise<ValidationResult> {
  const store = config.store
  const maxAttempts = config.maxAttempts ?? DEFAULTS.maxAttempts
  const rateLimitWindow = config.rateLimitWindowMs ?? DEFAULTS.rateLimitWindowMs
  const threshold = config.scoreThreshold ??
    (config.calibrationMode ? DEFAULTS.calibrationScoreThreshold : DEFAULTS.scoreThreshold)

  // 1. Rate limit check
  const rateKey = `rate:${request.session_id}`
  const attempts = await store.incrementRate(rateKey, rateLimitWindow)
  if (attempts > maxAttempts) {
    return {
      success: false,
      score: 0,
      error_code: ErrorCode.RATE_LIMITED,
    }
  }

  // 2. Retrieve challenge
  const challenge = await store.getChallenge(request.challenge_id)
  if (!challenge) {
    return {
      success: false,
      score: 0,
      error_code: ErrorCode.CHALLENGE_NOT_FOUND,
    }
  }

  // Delete challenge immediately to prevent replay (single-use)
  await store.deleteChallenge(request.challenge_id)

  // 3. Check expiry
  if (Date.now() > challenge.expires_at) {
    return {
      success: false,
      score: 0,
      error_code: ErrorCode.CHALLENGE_EXPIRED,
    }
  }

  // 4. Verify PoW
  const powValid = await verifyPow(
    challenge.pow_challenge,
    request.pow_proof,
    challenge.pow_difficulty,
  )
  if (!powValid) {
    return {
      success: false,
      score: 0,
      error_code: ErrorCode.INVALID_POW,
    }
  }

  // 5. Verify maze path
  const mazeWidth = config.mazeWidth ?? DEFAULTS.mazeWidth
  const mazeHeight = config.mazeHeight ?? DEFAULTS.mazeHeight
  const mazeDifficulty = config.mazeDifficulty ?? DEFAULTS.mazeDifficulty

  const mazeResult = validateMazePath(
    request.maze_seed,
    request.events,
    mazeWidth,
    mazeHeight,
    mazeDifficulty,
  )
  if (!mazeResult.valid) {
    return {
      success: false,
      score: 0,
      error_code: ErrorCode.INVALID_PATH,
    }
  }

  // 6. Extract features server-side (trustless) and score
  const features = extractFeatures(request.events)
  const score = scoreBehavior(features)

  if (score < threshold) {
    return {
      success: false,
      score,
      error_code: ErrorCode.BEHAVIORAL_REJECTED,
    }
  }

  // 7. All checks passed -- generate token
  const tokenTtl = config.tokenTtlMs ?? DEFAULTS.tokenTtlMs

  // Hash the public key for the token payload
  const pkBytes = new TextEncoder().encode(request.public_key)
  const pkHashBuf = await globalThis.crypto.subtle.digest('SHA-256', pkBytes)
  const pkHashArr = new Uint8Array(pkHashBuf)
  let publicKeyHash = ''
  for (const b of pkHashArr) {
    publicKeyHash += b.toString(16).padStart(2, '0')
  }

  const token = await generateToken(
    {
      site_key: request.site_key,
      session_id: request.session_id,
      public_key_hash: publicKeyHash,
      score,
      challenge_id: request.challenge_id,
    },
    config.secret,
    tokenTtl,
  )

  return {
    success: true,
    token,
    score,
  }
}
