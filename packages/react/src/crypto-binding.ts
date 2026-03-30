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
