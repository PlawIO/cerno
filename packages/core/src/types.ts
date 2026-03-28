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
  sample_count: number
  total_duration_ms: number
}

// ── Challenge / Verification ──

export interface Challenge {
  id: string
  maze_seed: number
  pow_challenge: string
  pow_difficulty: number
  site_key: string
  created_at: number
  expires_at: number
}

export interface ValidationRequest {
  challenge_id: string
  site_key: string
  session_id: string
  maze_seed: number
  events: RawEvent[]
  pow_proof: { nonce: number; hash: string }
  public_key: string
  timestamp: number
}

export interface ValidationResult {
  success: boolean
  token?: string
  score: number
  error_code?: string
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
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]
