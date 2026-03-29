// Main API
export { createChallenge, validateSubmission } from './validate.js'
export { verifyToken } from './token.js'
export { MemoryStore } from './store.js'

// Server-only types
export type {
  CaptchaStore,
  ServerConfig,
  TokenPayload,
  VerifyTokenResult,
} from './types.js'

// Re-export core types used by consumers
export type {
  Challenge,
  ValidationRequest,
  ValidationResult,
  RawEvent,
  BehavioralFeatures,
  MazeConfig,
  MazeProfile,
  Maze,
  Point,
} from '@cernosh/core'

export { ErrorCode, CaptchaError } from '@cernosh/core'
