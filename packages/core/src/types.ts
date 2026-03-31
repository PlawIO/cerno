// ── Raw event from collectors ──

export interface RawEvent {
  /** Timestamp in ms, relative to interaction start */
  t: number
  /** X position normalized 0-1 relative to canvas */
  x: number
  /** Y position normalized 0-1 relative to canvas */
  y: number
  type: 'move' | 'down' | 'up' | 'keydown' | 'keyup'
  key?: string
  pointer_type?: PointerType
  /** Number of coalesced pointer events in this frame (K-H2: event coalescing forensics) */
  coalesced_count?: number
}

// ── Maze types ──

export interface MazeConfig {
  width: number
  height: number
  difficulty: number // 0-1
  seed: number
}

/** Bitmask: N=1, S=2, E=4, W=8 */
export type WallMask = number

export const Wall = {
  N: 1,
  S: 2,
  E: 4,
  W: 8,
} as const

export interface Point {
  x: number
  y: number
}

export interface Cell {
  x: number
  y: number
  walls: WallMask
}

export interface Maze {
  grid: Cell[][]
  start: Point
  exit: Point
  width: number
  height: number
  seed: number
  solution: Point[]
}

// ── Behavioral features (6 MVP) ──

export interface BehavioralFeatures {
  velocity_std: number
  path_efficiency: number
  pause_count: number
  movement_onset_ms: number
  jerk_std: number
  angular_velocity_entropy: number
  /** Coefficient of variation of inter-event time intervals */
  timing_cv: number
  sample_count: number
  total_duration_ms: number
}

// ── Maze profile (for maze-relative behavioral baselines) ──

export interface MazeProfile {
  /** Number of cells in BFS solution */
  solutionLength: number
  /** Cells in solution with >2 open passages (fork points) */
  decisionPointCount: number
  /** Direction changes along the solution path */
  turnCount: number
  /** Euclidean start-to-exit / optimal path distance (normalized coords) */
  optimalEfficiency: number
}

// ── Challenge / Verification ──

export interface Challenge {
  id: string
  challenge_type: ChallengeType
  maze_seed: number
  maze_width: number
  maze_height: number
  maze_difficulty: number
  pow_challenge: string
  pow_difficulty: number
  site_key: string
  created_at: number
  expires_at: number
  /** SHA-256 hash of the public key bound at issuance */
  public_key_hash?: string
  /** Server-controlled cell size for coordinate renormalization */
  cell_size?: number
  /** Hash of the server-derived rate-limit binding used at issuance */
  rate_limit_binding_hash?: string
  /** Server-authored requirements the client must satisfy at verify time */
  requirements?: ChallengeRequirements
  /** Server-authored WebAuthn request options for this challenge. */
  webauthn_request_options?: WebAuthnRequestOptionsJSON
  /** Stroop probes injected into the maze (Phase 3) */
  probes?: StroopProbe[]
  /** Scoring config version pinned at issuance (for safe rotation) */
  scoring_version?: string
  /** Session ID bound at issuance, used to tie multiple challenges together (Phase K battery) */
  session_id?: string
  /** Maze rendering mode: 'grid' = seed-based client rendering, 'image' = server-rendered PNG.
   *  When 'image', server uses corridor-based path validation (tolerance for free-draw). */
  maze_render_mode?: 'grid' | 'image'

  // ── Server-rendered maze (Phase 2 hardening) ──
  /** Base64-encoded PNG of the server-rendered maze (replaces seed-based client rendering) */
  maze_image?: string
  /** Pixel width of the maze image */
  maze_image_width?: number
  /** Pixel height of the maze image */
  maze_image_height?: number
  /** Start position in normalized coordinates (0-1) relative to maze image */
  start_position?: Point
  /** Exit position in normalized coordinates (0-1) relative to maze image */
  exit_position?: Point
}

export interface ValidationRequest {
  challenge_id: string
  site_key: string
  session_id: string
  events: RawEvent[]
  pow_proof: { nonce: number; hash: string }
  public_key: string
  /** ECDSA P-256 signature of the challenge_id, base64-encoded */
  signature?: string
  timestamp: number
  /** Deployer-provided stable user identifier for cross-session reputation.
   *  MUST be a server-authenticated identity (e.g., hashed session cookie, user ID).
   *  If provided directly from the browser without server validation, an attacker
   *  can generate arbitrary stable_ids to defeat the reputation system. */
  stable_id?: string
  /** Server-derived rate-limit binding; must not come directly from the browser. */
  rate_limit_binding?: string
  /** Signed server-issued completion tokens for armed probes. */
  probe_completion_tokens?: string[]
  /** Client-reported probe responses with timing data (K-H1: probe-motor correlation) */
  probe_responses?: ProbeResponse[]
  /** Optional WebAuthn assertion for this challenge. */
  webauthn?: WebAuthnAuthenticationResponseJSON
}

export interface ValidationResult {
  success: boolean
  token?: string
  error_code?: string
  /** Final blended score (0-1), returned on success for Phase K battery */
  score?: number
  /** Detected input type */
  input_type?: InputMode
}

// ── Input mode ──

export type InputMode = 'mouse' | 'touch' | 'keyboard'

export type PointerType = 'mouse' | 'touch' | 'pen'
export type WebAuthnMode = 'off' | 'preferred' | 'required'

export interface ClientCapabilities {
  reduced_motion?: boolean
  webauthn_available?: boolean
  pointer_types?: PointerType[]
}

export interface ChallengeRequirements {
  probe: {
    mode: 'off' | 'required'
    required_completion_count: number
  }
  webauthn: {
    mode: WebAuthnMode
  }
}

// ── Stroop cognitive probes (Phase 3) ──

export interface StroopProbe {
  id: string
  type: 'color_tap'
  /** Human-readable instruction, e.g. "Tap the blue cell" */
  instruction: string
  /** SVG markup of the instruction text (text-as-path, no DOM-readable text nodes).
   *  Set by cerno-cloud post-processing. Client renders this instead of instruction text. */
  instruction_svg?: string
  /** Server-only: hex color of the target cell. Stripped from client responses. */
  target_color?: string
  /** Server-only: hex colors of distractor cells. Stripped from client responses. */
  distractor_colors?: string[]
  /** Colored cells shown to the user. isTarget is server-only (stripped from client responses). */
  cells: Array<{ x: number; y: number; color: string; isTarget?: boolean }>
  /** When the user's cursor reaches this cell, the probe fires (grid mode) */
  trigger_cell: Point
  /** Normalized trigger position (0-1) for image mode. Set by cerno-cloud. */
  trigger_position?: Point
}

export interface ProbeResponse {
  probe_id: string
  tapped_cell: Point
  reaction_time_ms: number
  /** Client-side correctness hint for analytics; server recomputes correctness and does not trust this field. */
  correct?: boolean
  /** Timestamp when probe was shown, relative to mouse-collector start time (K-H1: probe-motor correlation) */
  probe_shown_at?: number
}

// ── Challenge types (Phase 3) ──

export type ChallengeType = 'maze' | 'maze_stroop'

// ── WebAuthn attestation (Phase 3) ──

export interface WebAuthnCredentialDescriptorJSON {
  id: string
  type: 'public-key'
  transports?: string[]
}

export interface WebAuthnRequestOptionsJSON {
  challenge: string
  rpId: string
  timeout?: number
  userVerification?: 'required' | 'preferred' | 'discouraged'
  allowCredentials?: WebAuthnCredentialDescriptorJSON[]
}

export interface WebAuthnRegistrationOptionsJSON {
  challenge: string
  rp: {
    id: string
    name: string
  }
  user: {
    id: string
    name: string
    displayName: string
  }
  pubKeyCredParams: Array<{
    alg: number
    type: 'public-key'
  }>
  timeout?: number
  attestation?: 'none' | 'direct' | 'enterprise' | 'indirect'
  authenticatorSelection?: {
    residentKey?: 'required' | 'preferred' | 'discouraged'
    userVerification?: 'required' | 'preferred' | 'discouraged'
    authenticatorAttachment?: 'platform' | 'cross-platform'
  }
  excludeCredentials?: WebAuthnCredentialDescriptorJSON[]
}

export interface WebAuthnAuthenticationResponseJSON {
  id: string
  rawId: string
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle?: string | null
  }
  type: 'public-key'
  authenticatorAttachment?: 'platform' | 'cross-platform' | null
  clientExtensionResults?: Record<string, unknown>
}

export interface WebAuthnRegistrationResponseJSON {
  id: string
  rawId: string
  response: {
    clientDataJSON: string
    attestationObject: string
    transports?: string[]
  }
  type: 'public-key'
  authenticatorAttachment?: 'platform' | 'cross-platform' | null
  clientExtensionResults?: Record<string, unknown>
}

// ── Error codes ──

export const ErrorCode = {
  CHALLENGE_EXPIRED: 'challenge_expired',
  CHALLENGE_NOT_FOUND: 'challenge_not_found',
  INVALID_POW: 'invalid_pow',
  INVALID_PATH: 'invalid_path',
  BEHAVIORAL_REJECTED: 'behavioral_rejected',
  RATE_LIMITED: 'rate_limited',
  INVALID_REQUEST: 'invalid_request',
  INVALID_SIGNATURE: 'invalid_signature',
  PUBLIC_KEY_MISMATCH: 'public_key_mismatch',
  PROBE_FAILED: 'probe_failed',
  WEBAUTHN_FAILED: 'webauthn_failed',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]
