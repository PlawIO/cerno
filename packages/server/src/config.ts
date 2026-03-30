import type { ServerConfig } from './types.js'

export function validateServerConfig(config: ServerConfig): void {
  if (config.mode !== 'production') return

  if (!config.rateLimitKey) {
    throw new Error('production_mode_requires_server_rate_limit_key')
  }
  if (!config.store.capabilities.atomicChallengeConsume) {
    throw new Error('production_mode_requires_atomic_challenge_consume')
  }
  if (!config.store.capabilities.atomicTokenConsume) {
    throw new Error('production_mode_requires_atomic_token_consume')
  }
  if (!config.store.capabilities.strongConsistency) {
    throw new Error('production_mode_requires_strong_consistency_store')
  }
  if (!config.store.capabilities.productionReady) {
    throw new Error('production_mode_requires_production_ready_store')
  }
  if (config.webAuthn && config.webAuthn.mode !== 'off') {
    if (
      !config.store.consumeWebAuthnRegistrationSession ||
      !config.store.listWebAuthnCredentials ||
      !config.store.saveWebAuthnCredential ||
      !config.store.updateWebAuthnCredentialCounter
    ) {
      throw new Error('production_mode_requires_webauthn_store')
    }
  }
  if (config.enableReputation) {
    if (!config.store.getReputation || !config.store.setReputation) {
      throw new Error('production_mode_requires_reputation_store')
    }
  }
  if (config.enableProbes) {
    if (!config.store.setProbeArmSession || !config.store.consumeProbeArmSession) {
      throw new Error('production_mode_requires_probe_store')
    }
  }
}
