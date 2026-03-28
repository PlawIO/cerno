import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Challenge,
  Maze,
  RawEvent,
  ValidationRequest,
  ValidationResult,
} from '@cerno/core'
import { extractFeatures, generateMaze } from '@cerno/core'
import { MazeCanvas } from './MazeCanvas.js'
import { generateEphemeralKeyPair } from './crypto-binding.js'

// ── PoW helpers ──

interface PowResult {
  nonce: number
  hash: string
}

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

async function solvePowMainThread(
  challenge: string,
  difficulty: number,
  signal?: { cancelled: boolean },
): Promise<PowResult> {
  const encoder = new TextEncoder()
  let nonce = 0
  const BATCH = 500
  const MAX_NONCE = 10_000_000 // Safety bound: ~10M iterations max
  while (nonce < MAX_NONCE) {
    if (signal?.cancelled) throw new Error('PoW cancelled')
    for (let i = 0; i < BATCH && nonce < MAX_NONCE; i++) {
      const data = encoder.encode(challenge + nonce)
      const hash = await crypto.subtle.digest('SHA-256', data)
      if (hasLeadingZeroBits(hash, difficulty)) {
        return { nonce, hash: arrayBufferToHex(hash) }
      }
      nonce++
    }
    await new Promise<void>((r) => setTimeout(r, 0))
  }
  throw new Error('PoW exceeded max iterations')
}

function startPow(
  challenge: string,
  difficulty: number,
): { promise: Promise<PowResult>; cancel: () => void } {
  const signal = { cancelled: false }
  let worker: Worker | null = null

  const promise = new Promise<PowResult>((resolve, reject) => {
    // Try Web Worker first
    try {
      const workerCode = `
const ctx = self;
function hasLeadingZeroBits(buffer, bits) {
  const view = new Uint8Array(buffer);
  let remaining = bits;
  for (let i = 0; i < view.length && remaining > 0; i++) {
    if (remaining >= 8) { if (view[i] !== 0) return false; remaining -= 8; }
    else { const mask = 0xff << (8 - remaining); if ((view[i] & mask) !== 0) return false; remaining = 0; }
  }
  return true;
}
function arrayBufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}
const encoder = new TextEncoder();
async function solve(challenge, difficulty) {
  const BATCH = 1000;
  let nonce = 0;
  while (true) {
    for (let i = 0; i < BATCH; i++) {
      const data = encoder.encode(challenge + nonce);
      const hash = await crypto.subtle.digest('SHA-256', data);
      if (hasLeadingZeroBits(hash, difficulty)) {
        ctx.postMessage({ nonce, hash: arrayBufferToHex(hash) });
        return;
      }
      nonce++;
    }
    await new Promise(r => setTimeout(r, 0));
  }
}
ctx.addEventListener('message', (e) => { solve(e.data.challenge, e.data.difficulty); });
`
      const blob = new Blob([workerCode], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      worker = new Worker(url)

      worker.onmessage = (e: MessageEvent<PowResult>) => {
        URL.revokeObjectURL(url)
        if (!signal.cancelled) resolve(e.data)
      }

      worker.onerror = () => {
        URL.revokeObjectURL(url)
        worker?.terminate()
        worker = null
        // Fall back to main thread
        if (!signal.cancelled) solvePowMainThread(challenge, difficulty, signal).then(resolve, reject)
      }

      worker.postMessage({ challenge, difficulty })
    } catch {
      // Workers not available, fall back
      if (!signal.cancelled) solvePowMainThread(challenge, difficulty, signal).then(resolve, reject)
    }
  })

  return {
    promise,
    cancel() {
      signal.cancelled = true
      worker?.terminate()
    },
  }
}

// ── Types ──

export interface CernoProps {
  siteKey: string
  sessionId: string
  onVerify: (token: string) => void
  onError?: (error: Error) => void
  onExpire?: () => void
  theme?: 'light' | 'dark'
  size?: 'normal' | 'compact'
  apiUrl?: string
}

type CaptchaState =
  | 'loading'
  | 'ready'
  | 'solving'
  | 'submitting'
  | 'verified'
  | 'failed'
  | 'locked'

const MAX_ATTEMPTS = 3
const CHALLENGE_TTL_MS = 2 * 60 * 1000

// ── Component ──

export function Cerno({
  siteKey,
  sessionId,
  onVerify,
  onError,
  onExpire,
  theme = 'light',
  size = 'normal',
  apiUrl = '/api/captcha',
}: CernoProps) {
  const [state, setState] = useState<CaptchaState>('loading')
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [maze, setMaze] = useState<Maze | null>(null)
  const [attempts, setAttempts] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')

  const powRef = useRef<{ promise: Promise<PowResult>; cancel: () => void } | null>(null)
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const clearExpiry = useCallback(() => {
    if (expiryTimerRef.current !== null) {
      clearTimeout(expiryTimerRef.current)
      expiryTimerRef.current = null
    }
  }, [])

  const fetchChallenge = useCallback(async () => {
    clearExpiry()
    powRef.current?.cancel()

    setState('loading')
    setErrorMsg('')

    try {
      const res = await fetch(`${apiUrl}/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_key: siteKey }),
      })

      if (!res.ok) {
        throw new Error(`Challenge request failed: ${res.status}`)
      }

      const ch: Challenge = await res.json()
      if (!mountedRef.current) return

      setChallenge(ch)

      // Generate maze from seed (dimensions and difficulty come from server challenge)
      const m = generateMaze({
        width: ch.maze_width,
        height: ch.maze_height,
        difficulty: ch.maze_difficulty,
        seed: ch.maze_seed,
      })
      setMaze(m)

      // Start PoW in background
      powRef.current = startPow(ch.pow_challenge, ch.pow_difficulty)

      setState('ready')

      // Set expiry timer
      const ttl = ch.expires_at - Date.now()
      const timeoutMs = ttl > 0 ? Math.min(ttl, CHALLENGE_TTL_MS) : CHALLENGE_TTL_MS

      expiryTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return
        powRef.current?.cancel()
        setState('loading')
        onExpire?.()
        // Auto-fetch new challenge
        fetchChallenge()
      }, timeoutMs)
    } catch (err) {
      if (!mountedRef.current) return
      const error = err instanceof Error ? err : new Error(String(err))
      setState('failed')
      setErrorMsg(error.message)
      onError?.(error)
    }
  }, [apiUrl, siteKey, size, clearExpiry, onError, onExpire])

  // Fetch challenge on mount
  useEffect(() => {
    fetchChallenge()
    return () => {
      clearExpiry()
      powRef.current?.cancel()
    }
  }, [fetchChallenge, clearExpiry])

  const handlePathComplete = useCallback(
    async (events: RawEvent[]) => {
      if (!challenge || !maze) return
      setState('submitting')

      try {
        // Wait for PoW to finish
        const pow = await powRef.current!.promise

        // Extract behavioral features (for debugging/logging; server re-extracts)
        extractFeatures(events)

        // Generate ephemeral key pair
        const keyPair = await generateEphemeralKeyPair()

        const request: ValidationRequest = {
          challenge_id: challenge.id,
          site_key: siteKey,
          session_id: sessionId,
          maze_seed: challenge.maze_seed,
          events,
          pow_proof: pow,
          public_key: keyPair.publicKeyBase64,
          timestamp: Date.now(),
        }

        const res = await fetch(`${apiUrl}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })

        if (!res.ok) {
          throw new Error(`Verification request failed: ${res.status}`)
        }

        const result: ValidationResult = await res.json()
        if (!mountedRef.current) return

        if (result.success && result.token) {
          setState('verified')
          clearExpiry()
          onVerify(result.token)
        } else {
          const nextAttempts = attempts + 1
          setAttempts(nextAttempts)

          if (nextAttempts >= MAX_ATTEMPTS) {
            setState('locked')
            clearExpiry()
            setErrorMsg('Too many failed attempts. Please try again later.')
          } else {
            setState('failed')
            setErrorMsg(result.error_code ?? 'Verification failed. Try again.')
            // Auto-fetch new challenge for retry
            fetchChallenge()
          }
        }
      } catch (err) {
        if (!mountedRef.current) return
        const error = err instanceof Error ? err : new Error(String(err))
        setState('failed')
        setErrorMsg(error.message)
        onError?.(error)
      }
    },
    [challenge, maze, siteKey, sessionId, apiUrl, attempts, clearExpiry, onVerify, onError, fetchChallenge],
  )

  // ── Styles ──
  const isDark = theme === 'dark'
  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: size === 'compact' ? 8 : 12,
    borderRadius: 8,
    border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
    background: isDark ? '#0f172a' : '#ffffff',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: isDark ? '#e2e8f0' : '#1e293b',
    fontSize: size === 'compact' ? 12 : 14,
    maxWidth: '100%',
  }

  const statusStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: size === 'compact' ? 11 : 13,
    color: isDark ? '#94a3b8' : '#64748b',
  }

  const retryBtnStyle: React.CSSProperties = {
    padding: '6px 16px',
    borderRadius: 6,
    border: 'none',
    background: isDark ? '#3b82f6' : '#2563eb',
    color: '#ffffff',
    fontSize: size === 'compact' ? 12 : 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  }

  // ── Render ──

  if (state === 'verified') {
    return (
      <div style={containerStyle}>
        <div style={{ ...statusStyle, color: '#22c55e' }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M6 10l3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Verified
        </div>
      </div>
    )
  }

  if (state === 'locked') {
    return (
      <div style={containerStyle}>
        <div style={{ ...statusStyle, color: '#ef4444' }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {errorMsg}
        </div>
      </div>
    )
  }

  if (state === 'loading') {
    return (
      <div style={containerStyle}>
        <div style={statusStyle}>
          <Spinner isDark={isDark} />
          Loading challenge...
        </div>
      </div>
    )
  }

  if (state === 'submitting') {
    return (
      <div style={containerStyle}>
        {maze && <MazeCanvas maze={maze} theme={theme} onPathComplete={() => {}} size={size} />}
        <div style={statusStyle}>
          <Spinner isDark={isDark} />
          Verifying...
        </div>
      </div>
    )
  }

  if (state === 'failed') {
    return (
      <div style={containerStyle}>
        <div style={{ ...statusStyle, color: '#ef4444' }}>{errorMsg}</div>
        {attempts < MAX_ATTEMPTS && (
          <button
            type="button"
            style={retryBtnStyle}
            onClick={() => fetchChallenge()}
          >
            Try again ({MAX_ATTEMPTS - attempts} left)
          </button>
        )}
      </div>
    )
  }

  // state === 'ready' | 'solving'
  return (
    <div style={containerStyle}>
      {maze && (
        <MazeCanvas
          maze={maze}
          theme={theme}
          onPathComplete={handlePathComplete}
          size={size}
        />
      )}
      <div style={statusStyle}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 8h8M8 4v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Cerno
      </div>
    </div>
  )
}

// Simple CSS spinner as inline SVG
function Spinner({ isDark }: { isDark: boolean }) {
  const color = isDark ? '#94a3b8' : '#64748b'
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      style={{ animation: 'cerno-spin 0.8s linear infinite' }}
    >
      <style>{`@keyframes cerno-spin { to { transform: rotate(360deg); } }`}</style>
      <circle cx="8" cy="8" r="6" stroke={color} strokeWidth="2" strokeDasharray="28 10" strokeLinecap="round" />
    </svg>
  )
}
