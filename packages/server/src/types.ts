import type {
  BehavioralFeatures,
  Challenge,
  ClientCapabilities,
  InputMode,
  MazeProfile,
  Point,
  RawEvent,
  ValidationRequest,
  WebAuthnAuthenticationResponseJSON,
  WebAuthnMode,
  WebAuthnRegistrationOptionsJSON,
  WebAuthnRegistrationResponseJSON,
  WebAuthnRequestOptionsJSON,
} from '@cernosh/core'

// ── Scoring config (Phase G) ──

export interface FeatureBaseline {
  mean: number
  std: number
  weight: number
}

export interface ScoringConfig {
  /** Motor control baselines per input type (overrides dev defaults) */
  motorBaselines?: {
    mouse?: Partial<Record<string, FeatureBaseline>>
    touch?: Partial<Record<string, FeatureBaseline>>
    keyboard?: Partial<Record<string, FeatureBaseline>>
  }
  /** Secret feature baselines per input type */
  secretBaselines?: {
    mouse?: Partial<Record<string, FeatureBaseline>>
    touch?: Partial<Record<string, FeatureBaseline>>
    keyboard?: Partial<Record<string, FeatureBaseline>>
  }
  /** Maze-relative baseline multipliers */
  mazeRelative?: {
    pathEfficiencyMeanRatio?: number
    pathEfficiencyStdRatio?: number
    pausePerDecisionPoint?: number
    angularEntropyBase?: number
    angularEntropyPerTurn?: number
  }
  /** Scoring algorithm parameters */
  gaussianK?: number
  extremeOutlierZ?: number
  anomalyPenaltyPer?: number
  publicScoreWeight?: number
  secretScoreWeight?: number
}

export interface ScoringContext {
  events: RawEvent[]
  inputType?: InputMode
  mazeProfile?: MazeProfile
  publicFeatures?: BehavioralFeatures
  publicZScores?: Record<string, number>
  challengeId?: string
  siteKey?: string
  reputationData?: ReputationData | null
  /** K-H1: Probe timing data for motor-stream correlation analysis */
  probeTimings?: Array<{ probe_shown_at: number; reaction_time_ms: number }>
}

export interface SecretFeaturesProvider {
  score(ctx: ScoringContext): { score: number; zScores?: Record<string, number> }
    | Promise<{ score: number; zScores?: Record<string, number> }>
}

export interface StoreCapabilities {
  atomicChallengeConsume: boolean
  atomicTokenConsume: boolean
  strongConsistency: boolean
  productionReady: boolean
}

export interface CaptchaStore {
  capabilities: StoreCapabilities
  setChallenge(id: string, data: Challenge, ttlMs: number): Promise<void>
  getChallenge(id: string): Promise<Challenge | null>
  deleteChallenge(id: string): Promise<void>
  /** Atomically retrieve and delete a challenge (GETDEL semantics). */
  consumeChallenge(id: string): Promise<Challenge | null>
  /**
   * Atomically consume a token JTI.
   * Returns true on first consume, false when the token was already spent.
   */
  consumeToken(tokenId: string, ttlMs: number): Promise<boolean>
  incrementRate(key: string, windowMs: number): Promise<number>

  setProbeArmSession?(id: string, data: ProbeArmSessionData, ttlMs: number): Promise<void>
  consumeProbeArmSession?(id: string): Promise<ProbeArmSessionData | null>

  setWebAuthnRegistrationSession?(id: string, data: WebAuthnRegistrationSessionData, ttlMs: number): Promise<void>
  consumeWebAuthnRegistrationSession?(id: string): Promise<WebAuthnRegistrationSessionData | null>
  listWebAuthnCredentials?(stableId: string, siteKey: string): Promise<WebAuthnCredentialRecord[]>
  saveWebAuthnCredential?(credential: WebAuthnCredentialRecord): Promise<void>
  updateWebAuthnCredentialCounter?(
    stableId: string,
    siteKey: string,
    credentialId: string,
    nextCounter: number,
  ): Promise<void>

  // ── Reputation store (Phase 3) ──
  /** Store a behavioral fingerprint for cross-session reputation */
  setReputation?(key: string, data: ReputationData, ttlMs: number): Promise<void>
  getReputation?(key: string): Promise<ReputationData | null>
}

export interface SigningKey {
  kid: string
  value: string
}

// ── Client signals for adaptive PoW (Phase 2) ──

export interface ClientSignals {
  ip?: string
  userAgent?: string
  /** Number of recent failed attempts from this session/IP */
  failedAttempts?: number
  /** Reputation score from prior sessions (0-1, higher = more trusted) */
  trustScore?: number
}

// ── Observability (Phase 2) ──

export interface ValidationEvent {
  timestamp: number
  site_key: string
  session_id: string
  challenge_id: string
  success: boolean
  score: number
  error_code?: string
  features?: BehavioralFeatures
  /** Raw secret feature values (for baseline calibration) */
  secret_features?: Record<string, number>
  secret_feature_scores?: Record<string, number>
  input_type?: InputMode
  duration_ms: number
  /** Individual feature z-scores for anomaly detection */
  feature_z_scores?: Record<string, number>
  probe_results?: Array<{ probe_id: string; correct: boolean; reaction_time_ms: number }>
}

export interface CreateChallengeRequest {
  site_key: string
  public_key?: string
  stable_id?: string
  client_capabilities?: ClientCapabilities
  client_signals?: ClientSignals
  /**
   * Server-derived binding used to tie issuance and verification to the
   * same rate-limit identity. Do not accept this directly from browsers.
   */
  rate_limit_binding?: string
  /** Per-challenge maze difficulty override (0-1). Used by CernoBattery for 5-maze assessment. */
  maze_difficulty?: number
  /** Per-challenge maze width override. */
  maze_width?: number
  /** Per-challenge maze height override. */
  maze_height?: number
  /** Session ID binding. Stored in challenge record for cross-challenge validation. */
  session_id?: string
}

// ── Reputation (Phase 3) ──

export interface ReputationData {
  /** Running trust score (0-1), weighted average of session scores */
  trust_score: number
  /** Number of completed sessions */
  session_count: number
  /** Behavioral fingerprint: mean feature values across sessions */
  feature_means: Partial<BehavioralFeatures>
  last_seen: number
}

export interface ServerConfig {
  mode?: 'development' | 'test' | 'production'
  /** HMAC signing secret for JWTs (used if secrets array not provided) */
  secret: string
  /** Versioned signing keys for rotation. First key is used for signing, all are tried for verification. */
  secrets?: SigningKey[]
  store: CaptchaStore
  mazeDifficulty?: number
  mazeWidth?: number
  mazeHeight?: number
  /** Canvas cell size in pixels (default RENDERING.CELL_SIZE) */
  cellSize?: number
  /** Leading zero bits required for PoW */
  powDifficulty?: number
  /** Challenge TTL in ms (default 120000) */
  challengeTtlMs?: number
  /** Token TTL in ms (default 60000) */
  tokenTtlMs?: number
  /** Behavioral score threshold (default 0.6, 0.3 in calibration mode) */
  scoreThreshold?: number
  /** Lower threshold for calibration/testing */
  calibrationMode?: boolean
  /** Max attempts per session within rate limit window (default 5) */
  maxAttempts?: number
  /** Rate limit window in ms (default 300000) */
  rateLimitWindowMs?: number
  /** Server-derived rate-limit identity. */
  rateLimitKey?: (request: ValidationRequest) => string | Promise<string>

  // ── Phase K ──
  /** Allow per-challenge maze overrides (width, height, difficulty) from the request.
   *  Default false. Only enable for trusted server-side callers (e.g., /prove battery).
   *  When false, request.maze_width/height/difficulty are ignored. */
  allowChallengeOverrides?: boolean

  // ── Phase 2 ──
  /** Enable server-only secret feature scoring (default true) */
  enableSecretFeatures?: boolean
  /** Adaptive PoW: scale difficulty based on client signals */
  adaptivePow?: {
    enabled: boolean
    /** Max PoW difficulty bits (default 24) */
    maxDifficulty?: number
    /** Min PoW difficulty bits (default 14) */
    minDifficulty?: number
  }
  /** Observability hook: called after every validation attempt */
  onValidation?: (event: ValidationEvent) => void | Promise<void>
  /** Client signals provider: called during challenge creation for adaptive PoW */
  getClientSignals?: (request: Request) => ClientSignals | Promise<ClientSignals>

  // ── Phase 3 ──
  /** Enable Stroop cognitive probes */
  enableProbes?: boolean
  /** Probability of injecting a probe (0-1, default 0.5) */
  probeProbability?: number
  webAuthn?: {
    mode: WebAuthnMode
    rpId: string
    rpName?: string
    expectedOrigin: string | string[]
    registrationTtlMs?: number
    requestTimeoutMs?: number
  }
  /** Reputation TTL in ms (default 30 days) */
  reputationTtlMs?: number
  /** Explicit reputation opt-in; disabled by default without a stable ID. */
  enableReputation?: boolean

  // ── Phase G ──
  /** Runtime scoring config (baselines, algorithm params). Falls back to dev defaults. */
  scoring?: ScoringConfig
  /** Current scoring config version identifier (stamped onto challenges). */
  scoringVersion?: string
  /** Map of scoring config versions for safe rotation. */
  scoringVersions?: Record<string, ScoringConfig>
  /** Pluggable secret features provider (managed service extensibility). */
  secretFeaturesProvider?: SecretFeaturesProvider
}

export interface ProbeArmSessionData {
  id: string
  challenge_id: string
  probe_id: string
  site_key: string
  session_id: string
  armed_at: number
  deadline_at: number
}

export interface WebAuthnCredentialRecord {
  credential_id: string
  credential_public_key: string
  counter: number
  stable_id: string
  site_key: string
  transports?: string[]
}

export interface WebAuthnRegistrationSessionData {
  id: string
  site_key: string
  stable_id: string
  expected_challenge: string
  created_at: number
}

export interface BeginWebAuthnRegistrationRequest {
  site_key: string
  stable_id: string
}

export interface BeginWebAuthnRegistrationResult {
  session_id: string
  options: WebAuthnRegistrationOptionsJSON
}

export interface CompleteWebAuthnRegistrationRequest {
  session_id: string
  response: WebAuthnRegistrationResponseJSON
}

export interface CompleteWebAuthnRegistrationResult {
  success: boolean
  credential_id?: string
  error?: string
}

export interface ProbeArmRequest {
  challenge_id: string
  site_key: string
  session_id: string
  probe_id: string
  events: ValidationRequest['events']
  rate_limit_binding?: string
}

export interface ProbeArmResult {
  success: boolean
  probe_ticket?: string
  armed_at?: number
  deadline_at?: number
  error?: string
}

export interface ProbeCompleteRequest {
  challenge_id: string
  session_id: string
  probe_ticket: string
  tapped_cell: Point
}

export interface ProbeCompleteResult {
  success: boolean
  completion_token?: string
  error?: string
}

export interface TokenPayload {
  type: 'captcha'
  site_key: string
  session_id: string
  public_key_hash: string
  challenge_id: string
  /** Unique token ID for replay prevention */
  jti: string
  iat: number
  exp: number
}

export interface VerifyTokenResult {
  valid: boolean
  score: number
  error?: string
}

export interface SiteverifyResult {
  success: boolean
  score: number
  challenge_id?: string
  session_id?: string
  site_key?: string
  error?: string
}

export interface SiteverifyRequest {
  token: string
  session_id: string
}

export interface SiteverifyOptions {
  secret: string
  secrets?: SigningKey[]
  store?: CaptchaStore
  tokenTtlMs?: number
}
