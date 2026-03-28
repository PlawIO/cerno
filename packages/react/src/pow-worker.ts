// Web Worker: SHA-256 proof-of-work computation
// Receives { challenge: string, difficulty: number } via postMessage
// Posts back { nonce: number, hash: string } when a valid proof is found

const ctx = self as unknown as Worker

function hasLeadingZeroBits(buffer: ArrayBuffer, bits: number): boolean {
  const view = new Uint8Array(buffer)
  let remaining = bits
  for (let i = 0; i < view.length && remaining > 0; i++) {
    if (remaining >= 8) {
      if (view[i] !== 0) return false
      remaining -= 8
    } else {
      const mask = 0xff << (8 - remaining)
      if ((view[i] & mask) !== 0) return false
      remaining = 0
    }
  }
  return true
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

const encoder = new TextEncoder()

async function solve(challenge: string, difficulty: number): Promise<void> {
  const BATCH_SIZE = 1000
  let nonce = 0

  while (true) {
    for (let i = 0; i < BATCH_SIZE; i++) {
      const data = encoder.encode(challenge + nonce)
      const hash = await crypto.subtle.digest('SHA-256', data)
      if (hasLeadingZeroBits(hash, difficulty)) {
        ctx.postMessage({ nonce, hash: arrayBufferToHex(hash) })
        return
      }
      nonce++
    }
    // Yield to event loop between batches so the worker stays responsive
    await new Promise<void>((r) => setTimeout(r, 0))
  }
}

ctx.addEventListener('message', (e: MessageEvent<{ challenge: string; difficulty: number }>) => {
  const { challenge, difficulty } = e.data
  solve(challenge, difficulty)
})
