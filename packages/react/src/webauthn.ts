/**
 * Client-side WebAuthn integration (Phase 3).
 *
 * Requests a platform authenticator assertion (Touch ID, Windows Hello, etc.)
 * to prove the user has physical access to a genuine device.
 *
 * Falls back gracefully if the platform doesn't support it.
 */
import type {
  WebAuthnAuthenticationResponseJSON,
  WebAuthnRegistrationOptionsJSON,
  WebAuthnRegistrationResponseJSON,
  WebAuthnRequestOptionsJSON,
} from '@cernosh/core'

type PublicKeyCredentialWithJSON = PublicKeyCredential & {
  toJSON?: () => unknown
}

type PublicKeyCredentialClass = typeof PublicKeyCredential & {
  parseCreationOptionsFromJSON?: (
    options: WebAuthnRegistrationOptionsJSON,
  ) => CredentialCreationOptions['publicKey']
  parseRequestOptionsFromJSON?: (
    options: WebAuthnRequestOptionsJSON,
  ) => CredentialRequestOptions['publicKey']
}

/**
 * Check if WebAuthn platform authenticator is available.
 */
export async function isWebAuthnAvailable(): Promise<boolean> {
  if (
    typeof window === 'undefined' ||
    !window.PublicKeyCredential
  ) {
    return false
  }
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

function toUint8Array(base64url: string): Uint8Array {
  const normalized = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toBufferSource(base64url: string): BufferSource {
  return toUint8Array(base64url) as unknown as BufferSource
}

function toBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function parseCreationOptions(
  options: WebAuthnRegistrationOptionsJSON,
): CredentialCreationOptions['publicKey'] {
  const PKC = window.PublicKeyCredential as PublicKeyCredentialClass
  if (PKC.parseCreationOptionsFromJSON) {
    return PKC.parseCreationOptionsFromJSON(options)
  }

  return {
    ...options,
    challenge: toBufferSource(options.challenge),
    user: {
      ...options.user,
      id: toBufferSource(options.user.id),
    },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: toBufferSource(credential.id),
    })),
  } as CredentialCreationOptions['publicKey']
}

function parseRequestOptions(
  options: WebAuthnRequestOptionsJSON,
): CredentialRequestOptions['publicKey'] {
  const PKC = window.PublicKeyCredential as PublicKeyCredentialClass
  if (PKC.parseRequestOptionsFromJSON) {
    return PKC.parseRequestOptionsFromJSON(options)
  }

  return {
    ...options,
    rpId: options.rpId,
    challenge: toBufferSource(options.challenge),
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: toBufferSource(credential.id),
    })),
  } as CredentialRequestOptions['publicKey']
}

function serializeRegistration(credential: PublicKeyCredentialWithJSON): WebAuthnRegistrationResponseJSON {
  const json = credential.toJSON?.()
  if (json) return json as WebAuthnRegistrationResponseJSON

  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
      transports: response.getTransports?.(),
    },
    type: 'public-key',
    authenticatorAttachment: (credential.authenticatorAttachment ?? null) as 'platform' | 'cross-platform' | null,
    clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
  }
}

function serializeAuthentication(credential: PublicKeyCredentialWithJSON): WebAuthnAuthenticationResponseJSON {
  const json = credential.toJSON?.()
  if (json) return json as WebAuthnAuthenticationResponseJSON

  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      userHandle: response.userHandle ? toBase64url(response.userHandle) : undefined,
    },
    type: 'public-key',
    authenticatorAttachment: (credential.authenticatorAttachment ?? null) as 'platform' | 'cross-platform' | null,
    clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
  }
}

export async function requestWebAuthnRegistration(
  options: WebAuthnRegistrationOptionsJSON,
): Promise<WebAuthnRegistrationResponseJSON | null> {
  if (!(await isWebAuthnAvailable())) return null

  try {
    const credential = await navigator.credentials.create({
      publicKey: parseCreationOptions(options),
    }) as PublicKeyCredentialWithJSON | null

    if (!credential) return null

    return serializeRegistration(credential)
  } catch {
    return null
  }
}

export async function requestWebAuthnAuthentication(
  options: WebAuthnRequestOptionsJSON,
): Promise<WebAuthnAuthenticationResponseJSON | null> {
  if (!(await isWebAuthnAvailable())) return null

  try {
    const credential = await navigator.credentials.get({
      publicKey: parseRequestOptions(options),
    }) as PublicKeyCredentialWithJSON | null

    if (!credential) return null

    return serializeAuthentication(credential)
  } catch {
    return null
  }
}

export async function requestWebAuthnAttestation(
  challengeId: string,
  rpId: string,
): Promise<WebAuthnAuthenticationResponseJSON | null> {
  return requestWebAuthnAuthentication({
    challenge: btoa(challengeId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
    rpId,
    timeout: 30_000,
    userVerification: 'required',
  })
}
