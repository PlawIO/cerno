// Main API
export { cernoMiddleware, toExpressHandler } from './middleware.js'
export { createChallenge, validateSubmission } from './validate.js'
export { validateServerConfig } from './config.js'
export { verifyToken } from './token.js'
export { MemoryStore } from './store.js'
export { siteverify } from './siteverify.js'
export { computeAdaptiveDifficulty } from './adaptive-pow.js'
export { validateProbeResponses, scoreProbePerformance } from './probe-validator.js'
export { armProbe, completeProbe, verifyProbeCompletionTokens } from './probe-flow.js'
export { queryReputation, updateReputation, reputationKey, computeConsistencyBonus } from './reputation.js'

// Scoring internals (public algorithm — the moat is calibration data, not the code)
export { scoreBehavior } from './behavioral-scoring.js'
export { extractSecretFeatures, scoreSecretFeatures, type ProbeTimingData, type SecretFeatures } from './secret-features.js'
export { updateAdaptiveBaselines, welfordVariance, welfordStd } from './adaptive-baselines.js'
export {
  beginWebAuthnRegistration,
  completeWebAuthnRegistration,
  buildWebAuthnRequestOptions,
  verifyWebAuthnAuthentication,
} from './webauthn.js'

// Server-only types
export type {
  AdaptiveState,
  CaptchaStore,
  CreateChallengeRequest,
  ClientSignals,
  FeatureBaseline,
  ScoringConfig,
  ScoringContext,
  SecretFeaturesProvider,
  BeginWebAuthnRegistrationRequest,
  BeginWebAuthnRegistrationResult,
  CompleteWebAuthnRegistrationRequest,
  CompleteWebAuthnRegistrationResult,
  ProbeArmRequest,
  ProbeArmResult,
  ProbeCompleteRequest,
  ProbeCompleteResult,
  ProbeArmSessionData,
  ServerConfig,
  SiteverifyOptions,
  SiteverifyRequest,
  SigningKey,
  StoreCapabilities,
  TokenPayload,
  VerifyTokenResult,
  SiteverifyResult,
  ValidationEvent,
  ReputationData,
  WebAuthnCredentialRecord,
  WebAuthnRegistrationSessionData,
} from './types.js'

// Re-export core types used by consumers
export type {
  Challenge,
  ChallengeType,
  ValidationRequest,
  ValidationResult,
  RawEvent,
  BehavioralFeatures,
  MazeConfig,
  MazeProfile,
  Maze,
  Point,
  InputMode,
  StroopProbe,
  ProbeResponse,
  WebAuthnAuthenticationResponseJSON,
  WebAuthnCredentialDescriptorJSON,
  WebAuthnRegistrationOptionsJSON,
  WebAuthnRegistrationResponseJSON,
  WebAuthnRequestOptionsJSON,
  WebAuthnMode,
} from '@cernosh/core'

export { ErrorCode, CaptchaError } from '@cernosh/core'
