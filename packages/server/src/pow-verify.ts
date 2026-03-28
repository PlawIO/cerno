/**
 * Verify SHA-256 proof-of-work using Web Crypto API.
 * Cross-runtime: works in Node, Bun, Deno, Cloudflare Workers.
 */
export async function verifyPow(
  challenge: string,
  proof: { nonce: number; hash: string },
  difficulty: number,
): Promise<boolean> {
  const input = challenge + proof.nonce.toString()
  const encoded = new TextEncoder().encode(input)
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded)
  const hashArray = new Uint8Array(hashBuffer)
  const computedHex = bytesToHex(hashArray)

  // Submitted hash must match computed hash
  if (computedHex !== proof.hash) {
    return false
  }

  // Check leading zero bits
  return hasLeadingZeroBits(hashArray, difficulty)
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0')
  }
  return hex
}

function hasLeadingZeroBits(hash: Uint8Array, bits: number): boolean {
  let remaining = bits
  for (const byte of hash) {
    if (remaining <= 0) return true
    if (remaining >= 8) {
      if (byte !== 0) return false
      remaining -= 8
    } else {
      // Check top `remaining` bits of this byte
      const mask = (0xff << (8 - remaining)) & 0xff
      if ((byte & mask) !== 0) return false
      return true
    }
  }
  return true
}
