/**
 * Canonical serialization of events for digest binding.
 * Fixed field order [t, x, y, type, pointer_type, coalesced_count].
 * Optional fields normalize to null for deterministic output.
 * Both client and server must produce identical strings.
 */
export function canonicalizeEvents(
  events: Array<{ t: number; x: number; y: number; type: string; pointer_type?: string | null; coalesced_count?: number | null }>,
): string {
  return JSON.stringify(events.map(e => [e.t, e.x, e.y, e.type, e.pointer_type ?? null, e.coalesced_count ?? null]))
}

/**
 * SHA-256 hex digest of the canonical event representation.
 * Included in the ECDSA binding payload so replacing events
 * after signing invalidates the signature.
 */
export async function computeEventsDigest(
  events: Array<{ t: number; x: number; y: number; type: string; pointer_type?: string | null; coalesced_count?: number | null }>,
): Promise<string> {
  const canonical = canonicalizeEvents(events)
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const arr = new Uint8Array(digest)
  let hex = ''
  for (const b of arr) hex += b.toString(16).padStart(2, '0')
  return hex
}

/**
 * Generate an ephemeral ECDSA key pair for challenge binding.
 * The public key is sent to the server and hashed into the JWT.
 * The private key signs the challenge_id, proving this client generated the keypair.
 */
export async function generateEphemeralKeyPair(): Promise<{
  publicKeyBase64: string
  privateKey: CryptoKey
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )

  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const publicKeyBase64 = btoa(JSON.stringify(jwk))

  return { publicKeyBase64, privateKey: keyPair.privateKey }
}

/**
 * Sign the canonical challenge binding payload with the ephemeral private key.
 * Returns the signature as a base64 string.
 */
export async function signChallenge(
  bindingPayload: string,
  privateKey: CryptoKey,
): Promise<string> {
  const data = new TextEncoder().encode(bindingPayload)
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    data,
  )
  // Convert ArrayBuffer to base64
  const bytes = new Uint8Array(signature)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}
