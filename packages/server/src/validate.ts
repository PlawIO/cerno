import {
  type Challenge,
  type InputMode,
  type RawEvent,
  type ValidationRequest,
  type ValidationResult,
  type WebAuthnAuthenticationResponseJSON,
  ErrorCode,
  extractFeatures,
  computeMazeProfile,
  generateStroopProbe,
  RENDERING,
  renormalizeEvents,
  mulberry32,
} from '@cernosh/core'
import type { CreateChallengeRequest, ScoringConfig, ScoringContext, ServerConfig, ValidationEvent } from './types.js'
import { verifyPow } from './pow-verify.js'
import { validateMazePath } from './maze-solver.js'
import { scoreBehavior } from './behavioral-scoring.js'
import { generateToken } from './token.js'
import { extractSecretFeatures, scoreSecretFeatures } from './secret-features.js'
import { computeAdaptiveDifficulty } from './adaptive-pow.js'
import { scoreProbePerformance } from './probe-validator.js'
import { updateReputation, reputationKey, computeConsistencyBonus } from './reputation.js'
import { verifyProbeCompletionTokens } from './probe-flow.js'
import { buildWebAuthnRequestOptions, verifyWebAuthnAuthentication } from './webauthn.js'
import { validateServerConfig } from './config.js'
import { sha256Hex } from './crypto-utils.js'
import { PUBLIC_SCORE_WEIGHT, SECRET_SCORE_WEIGHT, PROBE_BONUS_MAX, MAX_EVENTS } from './scoring-constants.js'

/**
 * Verify that the client signed the challenge_id with the ephemeral private key
 * matching the submitted public key. Prevents request replay from different contexts.
 */
function buildChallengeBindingPayload(
  challengeId: string,
  siteKey: string,
  expiresAt: number,
): string {
  return `${challengeId}:${siteKey}:${expiresAt}`
}

async function verifyCryptoBinding(
  bindingPayload: string,
  signatureBase64: string,
  publicKeyBase64: string,
): Promise<boolean> {
  try {
    const jwk = JSON.parse(atob(publicKeyBase64))
    const publicKey = await globalThis.crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )

    // Decode base64 signature to ArrayBuffer
    const sigBinary = atob(signatureBase64)
    const sigBytes = new Uint8Array(sigBinary.length)
    for (let i = 0; i < sigBinary.length; i++) {
      sigBytes[i] = sigBinary.charCodeAt(i)
    }

    const data = new TextEncoder().encode(bindingPayload)
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBytes,
      data,
    )
  } catch {
    return false
  }
}

/** Infer input type from raw events instead of trusting client-supplied value */
function inferInputType(events: RawEvent[]): InputMode {
  for (const e of events) {
    if (e.type === 'keydown' || e.type === 'keyup') return 'keyboard'
    if (e.pointer_type === 'touch') return 'touch'
  }
  return 'mouse'
}

const DEFAULTS = {
  mazeDifficulty: 0.3,
  mazeWidth: 8,
  mazeHeight: 8,
  powDifficulty: 18,
  challengeTtlMs: 120_000,
  tokenTtlMs: 60_000,
  scoreThreshold: 0.72,
  calibrationScoreThreshold: 0.3,
  maxAttempts: 3,
  rateLimitWindowMs: 300_000,
  probeProbability: 0.5,
  reputationTtlMs: 30 * 24 * 60 * 60 * 1000,
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
 * Supports adaptive PoW (Phase 2) and Stroop probes (Phase 3).
 */
export async function createChallenge(
  config: ServerConfig,
  request: CreateChallengeRequest,
): Promise<Challenge> {
  validateServerConfig(config)

  const siteKey = request.site_key
  const id = globalThis.crypto.randomUUID()
  const mazeSeed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
  const powChallenge = randomHex(16)
  // Per-challenge overrides (Phase K battery) only honored when config opts in.
  // Without allowChallengeOverrides, an untrusted client via middleware cannot
  // downgrade difficulty or shrink the maze to weaken behavioral signal collection.
  const clamp = (v: number | undefined, min: number, max: number, fallback: number) =>
    v != null ? Math.max(min, Math.min(max, Math.floor(v))) : fallback
  const overrides = config.allowChallengeOverrides ? request : ({} as typeof request)
  const mazeWidth = clamp(overrides.maze_width, 4, 16, config.mazeWidth ?? DEFAULTS.mazeWidth)
  const mazeHeight = clamp(overrides.maze_height, 4, 16, config.mazeHeight ?? DEFAULTS.mazeHeight)
  const rawDiff = overrides.maze_difficulty ?? config.mazeDifficulty ?? DEFAULTS.mazeDifficulty
  const mazeDifficulty = Math.max(0.01, Math.min(1, rawDiff))
  const ttl = config.challengeTtlMs ?? DEFAULTS.challengeTtlMs
  const now = Date.now()

  // Adaptive PoW: scale difficulty based on client signals
  let powDifficulty = config.powDifficulty ?? DEFAULTS.powDifficulty
  if (config.adaptivePow?.enabled && request.client_signals) {
    powDifficulty = computeAdaptiveDifficulty(powDifficulty, request.client_signals, {
      maxDifficulty: config.adaptivePow.maxDifficulty,
      minDifficulty: config.adaptivePow.minDifficulty,
    })
  }

  // Compute public key hash if provided (binds key at issuance)
  let publicKeyHash: string | undefined
  if (request.public_key) {
    publicKeyHash = await sha256Hex(request.public_key)
  }

  const rateLimitBindingHash = request.rate_limit_binding
    ? await sha256Hex(request.rate_limit_binding)
    : undefined

  // Determine challenge type (Phase 3: probes)
  const enableProbes = config.enableProbes ?? false
  const probeProbability = config.probeProbability ?? DEFAULTS.probeProbability
  const rand = mulberry32(mazeSeed)
  const shouldProbe = enableProbes
    && rand() < probeProbability
  const webauthnRequestOptions = request.client_capabilities?.webauthn_available
    ? await buildWebAuthnRequestOptions(config, siteKey, request.stable_id)
    : undefined
  const webauthnMode = webauthnRequestOptions ? (config.webAuthn?.mode ?? 'off') : 'off'

  const challenge: Challenge = {
    id,
    challenge_type: shouldProbe ? 'maze_stroop' : 'maze',
    maze_seed: mazeSeed,
    maze_width: mazeWidth,
    maze_height: mazeHeight,
    maze_difficulty: mazeDifficulty,
    pow_challenge: powChallenge,
    pow_difficulty: powDifficulty,
    site_key: siteKey,
    created_at: now,
    expires_at: now + ttl,
    public_key_hash: publicKeyHash,
    cell_size: config.cellSize ?? RENDERING.CELL_SIZE,
    rate_limit_binding_hash: rateLimitBindingHash,
    session_id: request.session_id,
    requirements: {
      probe: {
        mode: 'off',
        required_completion_count: 0,
      },
      webauthn: {
        mode: webauthnMode,
      },
    },
    webauthn_request_options: webauthnRequestOptions,
    scoring_version: config.scoringVersion,
  }

  // Generate Stroop probes if enabled
  if (shouldProbe) {
    const { generateMaze } = await import('@cernosh/core')
    const maze = generateMaze({
      width: mazeWidth,
      height: mazeHeight,
      difficulty: mazeDifficulty,
      seed: mazeSeed,
    })
    const probe = generateStroopProbe(maze, rand, globalThis.crypto.randomUUID())
    if (probe) {
      challenge.probes = [probe]
      challenge.requirements!.probe.mode = 'required'
      challenge.requirements!.probe.required_completion_count = 1
    } else {
      // Maze too small for probes, fall back to plain maze
      challenge.challenge_type = 'maze'
    }
  }

  await config.store.setChallenge(id, challenge, ttl)

  return challenge
}

/**
 * Main validation pipeline.
 * 10-step verification with Phase 2+3 enhancements.
 */
export async function validateSubmission(
  config: ServerConfig,
  request: ValidationRequest,
): Promise<ValidationResult> {
  validateServerConfig(config)

  const startTime = Date.now()
  const store = config.store
  const maxAttempts = config.maxAttempts ?? DEFAULTS.maxAttempts
  const rateLimitWindow = config.rateLimitWindowMs ?? DEFAULTS.rateLimitWindowMs
  const threshold = config.scoreThreshold ??
    (config.calibrationMode ? DEFAULTS.calibrationScoreThreshold : DEFAULTS.scoreThreshold)

  // Helper to emit observability events
  const emit = async (event: Partial<ValidationEvent>) => {
    if (!config.onValidation) return
    try {
      await config.onValidation({
        timestamp: Date.now(),
        site_key: request.site_key,
        session_id: request.session_id,
        challenge_id: request.challenge_id,
        success: false,
        score: 0,
        duration_ms: Date.now() - startTime,
        ...event,
      })
    } catch {
      // Observability should never break validation
    }
  }

  // 0. Input validation: bound events array to prevent DoS
  if (!Array.isArray(request.events) || request.events.length > MAX_EVENTS) {
    await emit({ error_code: ErrorCode.INVALID_REQUEST })
    return {
      success: false,
      error_code: ErrorCode.INVALID_REQUEST,
    }
  }

  // 1. Rate limit check
  const rateLimitId = config.rateLimitKey
    ? await config.rateLimitKey(request)
    : request.rate_limit_binding ?? request.session_id
  const rateKey = `rate:${rateLimitId}`
  const attempts = await store.incrementRate(rateKey, rateLimitWindow)
  if (attempts > maxAttempts) {
    await emit({ error_code: ErrorCode.RATE_LIMITED })
    return {
      success: false,
      error_code: ErrorCode.RATE_LIMITED,
    }
  }

  // 2. Retrieve and atomically consume challenge (prevents TOCTOU race)
  const challenge = await store.consumeChallenge(request.challenge_id)
  if (!challenge) {
    await emit({ error_code: ErrorCode.CHALLENGE_NOT_FOUND })
    return {
      success: false,
      error_code: ErrorCode.CHALLENGE_NOT_FOUND,
    }
  }

  // 2b. Verify site_key matches (prevents using challenge from site A on site B)
  if (challenge.site_key !== request.site_key) {
    await emit({ error_code: ErrorCode.CHALLENGE_NOT_FOUND })
    return {
      success: false,
      error_code: ErrorCode.CHALLENGE_NOT_FOUND,
    }
  }

  // 2d. Verify request is bound to the same server-derived rate-limit identity.
  if (challenge.rate_limit_binding_hash) {
    const requestRateLimitHash = request.rate_limit_binding
      ? await sha256Hex(request.rate_limit_binding)
      : ''
    if (requestRateLimitHash !== challenge.rate_limit_binding_hash) {
      await emit({ error_code: ErrorCode.CHALLENGE_NOT_FOUND })
      return {
        success: false,
        error_code: ErrorCode.CHALLENGE_NOT_FOUND,
      }
    }
  }

  // 2e. Verify session_id matches (if bound at issuance, prevents cross-session replay).
  // If the challenge was issued with a session_id, the request MUST provide the same one.
  // Omitting it is a rejection (prevents bypass via empty/missing field).
  if (challenge.session_id) {
    if (!request.session_id || challenge.session_id !== request.session_id) {
      await emit({ error_code: ErrorCode.CHALLENGE_NOT_FOUND })
      return {
        success: false,
        error_code: ErrorCode.CHALLENGE_NOT_FOUND,
      }
    }
  }

  // 2c. Verify public key matches challenge binding (if bound at issuance)
  if (challenge.public_key_hash && request.public_key) {
    const requestPkHash = await sha256Hex(request.public_key)
    if (requestPkHash !== challenge.public_key_hash) {
      await emit({ error_code: ErrorCode.PUBLIC_KEY_MISMATCH })
      return {
        success: false,
        error_code: ErrorCode.PUBLIC_KEY_MISMATCH,
      }
    }
  }

  // 3. Check expiry
  if (Date.now() > challenge.expires_at) {
    await emit({ error_code: ErrorCode.CHALLENGE_EXPIRED })
    return {
      success: false,
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
    await emit({ error_code: ErrorCode.INVALID_POW })
    return {
      success: false,
      error_code: ErrorCode.INVALID_POW,
    }
  }

  // 5. Verify crypto binding (ECDSA signature of challenge_id)
  //    Signature is required — unsigned requests are rejected.
  if (!request.signature || !request.public_key) {
    await emit({ error_code: ErrorCode.INVALID_SIGNATURE })
    return {
      success: false,
      error_code: ErrorCode.INVALID_SIGNATURE,
    }
  }
  const sigValid = await verifyCryptoBinding(
    buildChallengeBindingPayload(challenge.id, challenge.site_key, challenge.expires_at),
    request.signature,
    request.public_key,
  )
  if (!sigValid) {
    await emit({ error_code: ErrorCode.INVALID_SIGNATURE })
    return {
      success: false,
      error_code: ErrorCode.INVALID_SIGNATURE,
    }
  }

  // 6. Verify WebAuthn attestation (Phase 3, optional)
  if (challenge.requirements?.webauthn.mode === 'required') {
    if (!request.webauthn || !challenge.webauthn_request_options) {
      await emit({ error_code: ErrorCode.WEBAUTHN_FAILED })
      return {
        success: false,
        error_code: ErrorCode.WEBAUTHN_FAILED,
      }
    }
  }
  if (request.webauthn && challenge.webauthn_request_options) {
    const webauthnResult = await verifyWebAuthnAuthentication(
      config,
      request.site_key,
      request.stable_id,
      challenge.webauthn_request_options.challenge,
      {
        ...(request.webauthn as WebAuthnAuthenticationResponseJSON),
        authenticatorAttachment:
          (request.webauthn as WebAuthnAuthenticationResponseJSON).authenticatorAttachment ?? undefined,
        clientExtensionResults:
          (request.webauthn as WebAuthnAuthenticationResponseJSON).clientExtensionResults ?? {},
        response: {
          ...(request.webauthn as WebAuthnAuthenticationResponseJSON).response,
          userHandle: (request.webauthn as WebAuthnAuthenticationResponseJSON).response.userHandle ?? undefined,
        },
      },
    )
    if (!webauthnResult.valid) {
      await emit({ error_code: ErrorCode.WEBAUTHN_FAILED })
      return {
        success: false,
        error_code: ErrorCode.WEBAUTHN_FAILED,
      }
    }
  }

  // 7. Renormalize events from canvas-relative to maze-grid-relative coordinates.
  //    Use server-controlled cell_size from challenge, not client-supplied value.
  const cellSize = challenge.cell_size ?? RENDERING.CELL_SIZE
  const correctedEvents = renormalizeEvents(
    request.events,
    challenge.maze_width,
    challenge.maze_height,
    cellSize,
  )

  // 8. Verify maze path (use challenge's authoritative seed, not client-supplied)
  const mazeResult = validateMazePath(
    challenge.maze_seed,
    correctedEvents,
    challenge.maze_width,
    challenge.maze_height,
    challenge.maze_difficulty,
  )
  if (!mazeResult.valid) {
    await emit({ error_code: ErrorCode.INVALID_PATH })
    return {
      success: false,
      error_code: ErrorCode.INVALID_PATH,
    }
  }

  // 9. Validate Stroop probe responses (Phase 3)
  //    Cache result so step 10c can reuse without re-validating.
  let cachedProbeResult:
    | {
      valid: boolean
      avgReactionTime: number
      accuracy: number
    }
    | undefined
  let probeResults: Array<{ probe_id: string; correct: boolean; reaction_time_ms: number }> = []
  if (challenge.requirements?.probe.mode === 'required' && challenge.probes && challenge.probes.length > 0) {
    const verifiedProbeTokens = await verifyProbeCompletionTokens(
      config,
      challenge,
      request.session_id,
      request.probe_completion_tokens ?? [],
    )
    if (!verifiedProbeTokens.valid) {
      await emit({
        error_code: ErrorCode.PROBE_FAILED,
        probe_results: [],
      })
      return {
        success: false,
        error_code: ErrorCode.PROBE_FAILED,
      }
    }
    probeResults = verifiedProbeTokens.results
    const avgReactionTime = probeResults.reduce((sum, item) => sum + item.reaction_time_ms, 0) / Math.max(probeResults.length, 1)
    const accuracy = probeResults.every((item) => item.correct) ? 1 : 0
    cachedProbeResult = {
      valid: accuracy === 1,
      avgReactionTime,
      accuracy,
    }
  }

  // 10. Extract features and score behavior
  const features = extractFeatures(correctedEvents)
  const mazeProfile = computeMazeProfile(mazeResult.maze)
  const derivedInputType = inferInputType(correctedEvents)

  // Resolve scoring config: challenge-pinned version > live config > dev defaults
  const scoringConfig: ScoringConfig | undefined =
    (challenge.scoring_version ? config.scoringVersions?.[challenge.scoring_version] : undefined)
    ?? config.scoring

  const publicResult = scoreBehavior(features, mazeProfile, derivedInputType, scoringConfig)
  let score = publicResult.score
  const publicWeight = scoringConfig?.publicScoreWeight ?? PUBLIC_SCORE_WEIGHT
  const secretWeight = scoringConfig?.secretScoreWeight ?? SECRET_SCORE_WEIGHT

  // Fetch reputation once for use in both provider context and reputation bonus
  const repKey = request.stable_id ? reputationKey(request.stable_id) : undefined
  const repData = (repKey && config.enableReputation !== false && store.getReputation)
    ? await store.getReputation(repKey)
    : null

  // K-H1: Build probe timing data for motor-stream correlation
  // Cross-validate: probe_id must match a challenge-issued probe, timestamps must fall
  // within trace time range, count capped at challenge probe count.
  const traceEnd = correctedEvents.length > 0
    ? correctedEvents[correctedEvents.length - 1].t
    : 0
  const challengeProbeIds = new Set(challenge.probes?.map(p => p.id) ?? [])
  // Only accept probe timings if the challenge actually issued probes.
  // Without this gate, a client can fabricate probe_responses on plain maze challenges.
  // If probes were issued but client omits probe_responses, treat as zero motor
  // continuity (empty array) so the K-H1 gate fires instead of being bypassed.
  const hasIssuedProbes = challengeProbeIds.size > 0
  const probeTimings = hasIssuedProbes
    ? (request.probe_responses
        ?.filter(pr =>
          pr.probe_shown_at != null &&
          pr.probe_shown_at >= 0 &&
          pr.probe_shown_at <= traceEnd + 1000 && // allow 1s slack for async dispatch
          challengeProbeIds.has(pr.probe_id), // must match issued probe
        )
        .slice(0, challengeProbeIds.size) // never accept more probes than issued
        .map(pr => ({ probe_shown_at: pr.probe_shown_at!, reaction_time_ms: pr.reaction_time_ms }))
      ) ?? [] // P2 fix: missing probe_responses → empty array → probe_motor_continuity=0
    : undefined

  // 10b. Secret feature scoring (Phase 2 + Phase G provider)
  let secretZScores: Record<string, number> | undefined
  let rawSecretFeatures: Record<string, number> | undefined
  if (config.secretFeaturesProvider) {
    // Managed service: use pluggable provider
    const ctx: ScoringContext = {
      events: correctedEvents,
      inputType: derivedInputType,
      mazeProfile,
      publicFeatures: features,
      publicZScores: publicResult.zScores,
      challengeId: challenge.id,
      siteKey: challenge.site_key,
      reputationData: repData,
      probeTimings,
    }
    try {
      const result = await config.secretFeaturesProvider.score(ctx)
      secretZScores = result.zScores
      score = score * publicWeight + Math.max(0, Math.min(1, result.score)) * secretWeight
    } catch {
      // Provider failed, fall back to built-in scoring
      const secretFeatures = extractSecretFeatures(correctedEvents, probeTimings)
      rawSecretFeatures = secretFeatures as unknown as Record<string, number>
      const secretResult = scoreSecretFeatures(secretFeatures, derivedInputType, scoringConfig)
      secretZScores = secretResult.zScores
      score = score * publicWeight + secretResult.score * secretWeight
    }
  } else if (config.enableSecretFeatures !== false) {
    // Built-in default (ships in npm, good baseline for self-hosters)
    const secretFeatures = extractSecretFeatures(correctedEvents, probeTimings)
    rawSecretFeatures = secretFeatures as unknown as Record<string, number>
    const secretResult = scoreSecretFeatures(secretFeatures, derivedInputType, scoringConfig)
    secretZScores = secretResult.zScores
    score = score * publicWeight + secretResult.score * secretWeight
  }

  // 10c. Probe performance bonus (Phase 3)
  if (cachedProbeResult) {
    const probeScore = scoreProbePerformance(cachedProbeResult)
    score = Math.min(1, score + probeScore * PROBE_BONUS_MAX)
  }

  // 10d. Reputation bonus (Phase 3)
  const publicKeyHash = await sha256Hex(request.public_key)

  if (repData) {
    const bonus = computeConsistencyBonus(features, repData)
    score = Math.min(1, score + bonus)
  }

  // Merge public + secret z-scores for observability
  const allZScores: Record<string, number> = { ...publicResult.zScores, ...secretZScores }

  if (score < threshold) {
    await emit({
      error_code: ErrorCode.BEHAVIORAL_REJECTED,
      features,
      secret_features: rawSecretFeatures,
      secret_feature_scores: secretZScores,
      feature_z_scores: allZScores,
      input_type: derivedInputType,
    })
    return {
      success: false,
      error_code: ErrorCode.BEHAVIORAL_REJECTED,
    }
  }

  // 11. All checks passed — generate token

  // Update reputation for successful session (Phase 3)
  const repTtl = config.reputationTtlMs ?? DEFAULTS.reputationTtlMs
  if (repKey && config.enableReputation !== false) {
    await updateReputation(store, repKey, score, features, repTtl)
  }

  const tokenTtl = config.tokenTtlMs ?? DEFAULTS.tokenTtlMs

  // Always sign with config.secret so existing verifiers work.
  // Look up kid from secrets[] if the primary secret appears there.
  const signingKid = config.secrets?.find((s) => s.value === config.secret)?.kid

  const token = await generateToken(
    {
      type: 'captcha',
      site_key: request.site_key,
      session_id: request.session_id,
      public_key_hash: publicKeyHash,
      challenge_id: request.challenge_id,
    },
    config.secret,
    tokenTtl,
    signingKid,
  )

  await emit({
    success: true,
    score,
    features,
    secret_features: rawSecretFeatures,
    secret_feature_scores: secretZScores,
    feature_z_scores: allZScores,
    input_type: derivedInputType,
    probe_results: probeResults.length > 0 ? probeResults : undefined,
  })

  return {
    success: true,
    token,
    score,
    input_type: derivedInputType,
  }
}
