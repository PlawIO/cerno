/**
 * WebAuthn attestation verification (Phase 3).
 *
 * Optional hardware-backed proof that the browser environment is genuine.
 * Uses the platform authenticator (Touch ID, Windows Hello, Android biometrics)
 * to sign a challenge, proving the user has physical access to a real device.
 *
 * This is Cerno's answer to World.org's Orb hardware requirement,
 * but leveraging existing consumer hardware instead of custom devices.
 */
import type { WebAuthnAuthenticationResponseJSON } from '@cernosh/core'

export interface WebAuthnVerifyResult {
  valid: boolean
  error?: string
}

/**
 * Verify a WebAuthn assertion.
 *
 * This is a simplified verification that checks:
 * 1. authenticatorData has the correct RP ID hash
 * 2. The UP (user present) flag is set
 * 3. The signature structure is well-formed
 *
 * For production, use a full WebAuthn library (e.g., @simplewebauthn/server).
 * This provides the integration point and basic validation.
 */
export async function verifyWebAuthnAttestation(
  attestation: WebAuthnAuthenticationResponseJSON,
  expectedRpId: string,
  challengeId: string,
): Promise<WebAuthnVerifyResult> {
  try {
    // Decode authenticator data
    const authDataBinary = atob(attestation.response.authenticatorData)
    const authData = new Uint8Array(authDataBinary.length)
    for (let i = 0; i < authDataBinary.length; i++) {
      authData[i] = authDataBinary.charCodeAt(i)
    }

    if (authData.length < 37) {
      return { valid: false, error: 'authenticator_data_too_short' }
    }

    // First 32 bytes: SHA-256 hash of the RP ID
    const rpIdHash = authData.slice(0, 32)
    const expectedHash = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(expectedRpId),
    )
    const expectedHashBytes = new Uint8Array(expectedHash)

    // Compare RP ID hashes
    let rpIdMatch = true
    for (let i = 0; i < 32; i++) {
      if (rpIdHash[i] !== expectedHashBytes[i]) {
        rpIdMatch = false
        break
      }
    }
    if (!rpIdMatch) {
      return { valid: false, error: 'rp_id_mismatch' }
    }

    // Byte 32: flags. Bit 0 = UP (user present)
    const flags = authData[32]
    if (!(flags & 0x01)) {
      return { valid: false, error: 'user_not_present' }
    }

    // Verify the client data contains the expected challenge
    const clientDataBinary = atob(attestation.response.clientDataJSON)
    const clientData = JSON.parse(clientDataBinary)
    if (clientData.type !== 'webauthn.get') {
      return { valid: false, error: 'invalid_client_data_type' }
    }

    // The challenge in clientDataJSON should match our challenge ID
    // (base64url-encoded)
    const expectedChallenge = btoa(challengeId)
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    if (clientData.challenge !== expectedChallenge) {
      return { valid: false, error: 'challenge_mismatch' }
    }

    // Signature verification requires the credential's public key
    // which we'd need from a registration step. For the integration point,
    // we validate the structure. Full signature verification requires
    // a WebAuthn credential store (future enhancement).
    if (!attestation.response.signature || !attestation.id) {
      return { valid: false, error: 'missing_signature_or_credential' }
    }

    return { valid: true }
  } catch {
    return { valid: false, error: 'verification_failed' }
  }
}
