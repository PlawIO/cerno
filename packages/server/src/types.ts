import type { Challenge } from '@cernosh/core'

export interface CaptchaStore {
  setChallenge(id: string, data: Challenge, ttlMs: number): Promise<void>
  getChallenge(id: string): Promise<Challenge | null>
  deleteChallenge(id: string): Promise<void>
  markTokenConsumed(tokenId: string, ttlMs: number): Promise<void>
  isTokenConsumed(tokenId: string): Promise<boolean>
  incrementRate(key: string, windowMs: number): Promise<number>
}

export interface ServerConfig {
  /** HMAC signing secret for JWTs */
  secret: string
  store: CaptchaStore
  mazeDifficulty?: number
  mazeWidth?: number
  mazeHeight?: number
  /** Leading zero bits required for PoW */
  powDifficulty?: number
  /** Challenge TTL in ms (default 120000) */
  challengeTtlMs?: number
  /** Token TTL in ms (default 60000) */
  tokenTtlMs?: number
  /** Behavioral score threshold (default 0.5, 0.3 in calibration mode) */
  scoreThreshold?: number
  /** Lower threshold for calibration/testing */
  calibrationMode?: boolean
  /** Max attempts per session within rate limit window (default 5) */
  maxAttempts?: number
  /** Rate limit window in ms (default 300000) */
  rateLimitWindowMs?: number
}

export interface TokenPayload {
  site_key: string
  session_id: string
  public_key_hash: string
  score: number
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
