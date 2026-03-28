/**
 * Generate an ephemeral ECDSA key pair for challenge binding.
 * The public key is sent to the server and hashed into the JWT.
 * The private key is discarded (sign() is not needed for MVP,
 * the public key hash alone binds the token to this client session).
 */
export async function generateEphemeralKeyPair(): Promise<{ publicKeyBase64: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )

  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const publicKeyBase64 = btoa(JSON.stringify(jwk))

  return { publicKeyBase64 }
}
