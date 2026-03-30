import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialDescriptorJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server'
import type {
  BeginWebAuthnRegistrationRequest,
  BeginWebAuthnRegistrationResult,
  CompleteWebAuthnRegistrationRequest,
  CompleteWebAuthnRegistrationResult,
  ServerConfig,
  WebAuthnCredentialRecord,
} from './types.js'
import type { WebAuthnRequestOptionsJSON } from '@cernosh/core'

function toUint8Array(base64url: string): Uint8Array {
  const normalized = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function textToUint8Array(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function fromUint8Array(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function ensureWebAuthnConfig(config: ServerConfig): NonNullable<ServerConfig['webAuthn']> {
  if (!config.webAuthn || config.webAuthn.mode === 'off') {
    throw new Error('webauthn_disabled')
  }
  return config.webAuthn
}

function requireCredentialStore(config: ServerConfig): void {
  if (
    !config.store.setWebAuthnRegistrationSession ||
    !config.store.consumeWebAuthnRegistrationSession ||
    !config.store.listWebAuthnCredentials ||
    !config.store.saveWebAuthnCredential ||
    !config.store.updateWebAuthnCredentialCounter
  ) {
    throw new Error('webauthn_store_unavailable')
  }
}

function toCredentialDescriptor(record: WebAuthnCredentialRecord): PublicKeyCredentialDescriptorJSON {
  return {
    id: record.credential_id,
    type: 'public-key',
    transports: record.transports as PublicKeyCredentialDescriptorJSON['transports'],
  }
}

function toWebAuthnCredential(record: WebAuthnCredentialRecord): WebAuthnCredential {
  return {
    id: record.credential_id,
    publicKey: toUint8Array(record.credential_public_key) as WebAuthnCredential['publicKey'],
    counter: record.counter,
    transports: record.transports as WebAuthnCredential['transports'],
  }
}

export async function beginWebAuthnRegistration(
  config: ServerConfig,
  request: BeginWebAuthnRegistrationRequest,
): Promise<BeginWebAuthnRegistrationResult> {
  const webauthn = ensureWebAuthnConfig(config)
  requireCredentialStore(config)

  const existing = await config.store.listWebAuthnCredentials!(request.stable_id, request.site_key)
  const options = await generateRegistrationOptions({
    rpName: webauthn.rpName ?? 'Cerno',
    rpID: webauthn.rpId,
    userID: textToUint8Array(request.stable_id) as Uint8Array<ArrayBuffer>,
    userName: request.stable_id,
    userDisplayName: request.stable_id,
    timeout: webauthn.requestTimeoutMs ?? 60_000,
    attestationType: 'none',
    excludeCredentials: existing.map(toCredentialDescriptor),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
  })

  const sessionId = globalThis.crypto.randomUUID()
  await config.store.setWebAuthnRegistrationSession!(
    sessionId,
    {
      id: sessionId,
      site_key: request.site_key,
      stable_id: request.stable_id,
      expected_challenge: options.challenge,
      created_at: Date.now(),
    },
    webauthn.registrationTtlMs ?? 5 * 60 * 1000,
  )

  return {
    session_id: sessionId,
    options: options as unknown as BeginWebAuthnRegistrationResult['options'],
  }
}

export async function completeWebAuthnRegistration(
  config: ServerConfig,
  request: CompleteWebAuthnRegistrationRequest,
): Promise<CompleteWebAuthnRegistrationResult> {
  const webauthn = ensureWebAuthnConfig(config)
  requireCredentialStore(config)

  const session = await config.store.consumeWebAuthnRegistrationSession!(request.session_id)
  if (!session) {
    return { success: false, error: 'registration_session_not_found' }
  }

  const verification = await verifyRegistrationResponse({
    response: request.response as unknown as RegistrationResponseJSON,
    expectedChallenge: session.expected_challenge,
    expectedOrigin: webauthn.expectedOrigin,
    expectedRPID: webauthn.rpId,
    requireUserVerification: true,
  })

  if (!verification.verified || !verification.registrationInfo) {
    return { success: false, error: 'registration_failed' }
  }

  const credential = verification.registrationInfo.credential
  await config.store.saveWebAuthnCredential!({
    credential_id: credential.id,
    credential_public_key: fromUint8Array(credential.publicKey),
    counter: credential.counter,
    stable_id: session.stable_id,
    site_key: session.site_key,
    transports: request.response.response.transports,
  })

  return {
    success: true,
    credential_id: credential.id,
  }
}

export async function buildWebAuthnRequestOptions(
  config: ServerConfig,
  siteKey: string,
  stableId: string | undefined,
): Promise<WebAuthnRequestOptionsJSON | undefined> {
  const webauthn = config.webAuthn
  if (!webauthn || webauthn.mode === 'off' || !stableId || !config.store.listWebAuthnCredentials) {
    return undefined
  }

  const credentials = await config.store.listWebAuthnCredentials(stableId, siteKey)
  if (credentials.length === 0) return undefined

  const options = await generateAuthenticationOptions({
    rpID: webauthn.rpId,
    allowCredentials: credentials.map(toCredentialDescriptor),
    timeout: webauthn.requestTimeoutMs ?? 60_000,
    userVerification: 'required',
  })

  return options as unknown as WebAuthnRequestOptionsJSON
}

export async function verifyWebAuthnAuthentication(
  config: ServerConfig,
  siteKey: string,
  stableId: string | undefined,
  expectedChallenge: string,
  response: AuthenticationResponseJSON,
): Promise<{ valid: boolean; error?: string }> {
  const webauthn = ensureWebAuthnConfig(config)
  requireCredentialStore(config)

  if (!stableId) {
    return { valid: false, error: 'missing_stable_id' }
  }

  const credentials = await config.store.listWebAuthnCredentials!(stableId, siteKey)
  const credential = credentials.find((item) => item.credential_id === response.id)
  if (!credential) {
    return { valid: false, error: 'credential_not_found' }
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: webauthn.expectedOrigin,
    expectedRPID: webauthn.rpId,
    credential: toWebAuthnCredential(credential),
    requireUserVerification: true,
  })

  if (!verification.verified) {
    return { valid: false, error: 'authentication_failed' }
  }

  await config.store.updateWebAuthnCredentialCounter!(
    stableId,
    siteKey,
    verification.authenticationInfo.credentialID,
    verification.authenticationInfo.newCounter,
  )

  return { valid: true }
}
