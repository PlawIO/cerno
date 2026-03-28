export interface EphemeralKeyPair {
  publicKeyBase64: string
  sign(data: ArrayBuffer): Promise<ArrayBuffer>
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )

  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const publicKeyBase64 = btoa(JSON.stringify(jwk))

  return {
    publicKeyBase64,
    async sign(data: ArrayBuffer): Promise<ArrayBuffer> {
      return crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        data,
      )
    },
  }
}
