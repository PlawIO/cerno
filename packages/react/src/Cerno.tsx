import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Challenge,
  Maze,
  ProbeResponse,
  RawEvent,
  StroopProbe,
  ValidationRequest,
  ValidationResult,
} from '@cernosh/core'
import { extractFeatures, generateMaze, RENDERING } from '@cernosh/core'
import { MazeCanvas } from './MazeCanvas.js'
import { StroopOverlay } from './StroopOverlay.js'
import { generateEphemeralKeyPair, signChallenge, computeEventsDigest } from './crypto-binding.js'
import { isWebAuthnAvailable, requestWebAuthnAuthentication } from './webauthn.js'

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

// ── Design tokens ──

function getCernoTokenCSS(theme: 'light' | 'dark'): string {
  const lightTokens = `
[data-cerno-theme="light"] {
  --cerno-font: 'Geist', system-ui, -apple-system, sans-serif;
  --cerno-accent: #2dd4bf;
  --cerno-accent-deep: #14b8a6;
  --cerno-fg: #1a1a17;
  --cerno-secondary: #44403b;
  --cerno-muted: #78716c;
  --cerno-border: #e7e5e4;
  --cerno-surface: #fafaf9;
  --cerno-bg: #ffffff;
  --cerno-radius: 2px;
  --cerno-success: #22c55e;
  --cerno-error: #ef4444;
  --cerno-warning: #f59e0b;
}`

  const darkTokens = `
[data-cerno-theme="dark"] {
  --cerno-font: 'Geist', system-ui, -apple-system, sans-serif;
  --cerno-accent: #2dd4bf;
  --cerno-accent-deep: #14b8a6;
  --cerno-fg: #e7e5e4;
  --cerno-secondary: #a8a29e;
  --cerno-muted: #78716c;
  --cerno-border: #44403b;
  --cerno-surface: #1c1917;
  --cerno-bg: #0c0a09;
  --cerno-radius: 2px;
  --cerno-success: #22c55e;
  --cerno-error: #ef4444;
  --cerno-warning: #f59e0b;
}`

  if (theme === 'dark') return `${lightTokens}\n${darkTokens}`
  return `${lightTokens}\n${darkTokens}`
}

// ── Error messages (E6) ──

const ERROR_MESSAGES: Record<string, string> = {
  CHALLENGE_NOT_FOUND: 'This challenge has expired. Loading a new one...',
  CHALLENGE_EXPIRED: 'This challenge has expired. Loading a new one...',
  RATE_LIMITED: 'Too many attempts. Please wait a moment.',
  INVALID_POW: 'Verification error. Please try again.',
  PROBE_FAILED: "Quick check wasn't quite right. Try again?",
  SCORE_TOO_LOW: 'Almost! Please try once more.',
  INVALID_SIGNATURE: 'Verification error. Please try again.',
  SITE_KEY_MISMATCH: 'Configuration error. Please contact site admin.',
  PUBLIC_KEY_MISMATCH: 'Session error. Please try again.',
  // lowercase variants from ErrorCode const
  challenge_expired: 'This challenge has expired. Loading a new one...',
  challenge_not_found: 'This challenge has expired. Loading a new one...',
  rate_limited: 'Too many attempts. Please wait a moment.',
  invalid_pow: 'Verification error. Please try again.',
  probe_failed: "Quick check wasn't quite right. Try again?",
  invalid_signature: 'Verification error. Please try again.',
  public_key_mismatch: 'Session error. Please try again.',
  behavioral_rejected: 'Almost! Please try once more.',
  invalid_path: 'Path was not quite right. Please try again.',
  invalid_request: 'Something went wrong. Please try again.',
}

function friendlyError(code?: string, fallback?: string): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code]
  if (fallback?.includes('fetch') || fallback?.includes('network') || fallback?.includes('Network'))
    return 'Connection issue. Check your connection and try again.'
  return fallback ?? 'Something went wrong. Please try again.'
}

// ── Types ──

export interface VerifyResult {
  token: string
  challengeId: string
  score?: number
  inputType?: string
}

export interface CernoProps {
  siteKey: string
  sessionId: string
  stableId?: string
  onVerify: (token: string) => void
  /** Richer verification callback with challenge ID and score (Phase K) */
  onVerifyResult?: (result: VerifyResult) => void
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
  | 'probe'
  | 'submitting'
  | 'verified'
  | 'failed'
  | 'locked'

const MAX_ATTEMPTS = 3
const CHALLENGE_TTL_MS = 2 * 60 * 1000
type ChallengeWithRequirements = Challenge & {
  requirements?: {
    probe: {
      mode: 'off' | 'required'
      required_completion_count: number
    }
    webauthn: {
      mode: 'off' | 'preferred' | 'required'
    }
  }
}

function buildChallengeBindingPayload(challenge: Challenge, eventsDigest: string): string {
  return `${challenge.id}:${challenge.site_key}:${challenge.expires_at}:${eventsDigest}`
}

function extractLatestPointerAttempt(events: RawEvent[]): RawEvent[] {
  let lastDownIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'down') {
      lastDownIdx = i
      break
    }
  }
  if (lastDownIdx === -1) return events
  return events.slice(lastDownIdx)
}

async function collectClientCapabilities(): Promise<{
  reduced_motion: boolean
  webauthn_available: boolean
  pointer_types: Array<'mouse' | 'touch' | 'pen'>
}> {
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const pointerTypes = new Set<'mouse' | 'touch' | 'pen'>()
  if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) {
    pointerTypes.add('touch')
  }
  if (typeof window !== 'undefined' && window.matchMedia('(pointer:fine)').matches) {
    pointerTypes.add('mouse')
  }
  return {
    reduced_motion: reducedMotion,
    webauthn_available: await isWebAuthnAvailable(),
    pointer_types: Array.from(pointerTypes),
  }
}

// ── Component ──

export function Cerno({
  siteKey,
  sessionId,
  stableId,
  onVerify,
  onVerifyResult,
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
  const [activeProbe, setActiveProbe] = useState<StroopProbe | null>(null)
  const [expiryWarning, setExpiryWarning] = useState(false)
  const [lockoutRemaining, setLockoutRemaining] = useState(0)
  const probeCompletionTokensRef = useRef<string[]>([])
  const completedProbeIdsRef = useRef<Set<string>>(new Set())
  const activeProbeTicketRef = useRef<string | null>(null)
  const armingProbeIdRef = useRef<string | null>(null)
  const collectorStartTimeGetterRef = useRef<(() => number) | null>(null)
  const probeResponsesRef = useRef<import('@cernosh/core').ProbeResponse[]>([])
  const onVerifyResultRef = useRef(onVerifyResult)
  onVerifyResultRef.current = onVerifyResult

  const keyPairRef = useRef<{ publicKeyBase64: string; privateKey: CryptoKey } | null>(null)
  const keyPairPromiseRef = useRef<Promise<{ publicKeyBase64: string; privateKey: CryptoKey }> | null>(null)
  const powRef = useRef<{ promise: Promise<PowResult>; cancel: () => void } | null>(null)
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lockoutTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Generate ECDSA keypair on mount so it's available at challenge time
  useEffect(() => {
    const p = generateEphemeralKeyPair()
    keyPairPromiseRef.current = p
    p.then(kp => { keyPairRef.current = kp })
  }, [])

  const clearExpiry = useCallback(() => {
    if (expiryTimerRef.current !== null) {
      clearTimeout(expiryTimerRef.current)
      expiryTimerRef.current = null
    }
    if (warningTimerRef.current !== null) {
      clearTimeout(warningTimerRef.current)
      warningTimerRef.current = null
    }
  }, [])

  const fetchChallenge = useCallback(async () => {
    clearExpiry()
    powRef.current?.cancel()

    setState('loading')
    setErrorMsg('')
    setExpiryWarning(false)

    try {
      // Ensure keypair is ready before requesting challenge (F3 race fix)
      if (keyPairPromiseRef.current) {
        const kp = await keyPairPromiseRef.current
        keyPairRef.current = kp
      }
      const clientCapabilities = await collectClientCapabilities()
      const res = await fetch(`${apiUrl}/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_key: siteKey,
          session_id: sessionId || undefined,
          stable_id: stableId,
          public_key: keyPairRef.current?.publicKeyBase64,
          client_capabilities: clientCapabilities,
        }),
      })

      if (!res.ok) {
        throw new Error(`Challenge request failed: ${res.status}`)
      }

      const ch: Challenge = await res.json()
      if (!mountedRef.current) return

      setChallenge(ch)
      setActiveProbe(null)
      activeProbeTicketRef.current = null
      armingProbeIdRef.current = null
      probeCompletionTokensRef.current = []
      probeResponsesRef.current = []
      completedProbeIdsRef.current = new Set()

      // Image mode: maze rendered server-side as PNG, no seed on client
      if (ch.maze_image) {
        setMaze(null)
      } else {
        // Grid mode: generate maze from seed (dimensions and difficulty come from server challenge)
        const m = generateMaze({
          width: ch.maze_width,
          height: ch.maze_height,
          difficulty: ch.maze_difficulty,
          seed: ch.maze_seed,
        })
        setMaze(m)
      }

      // Start PoW in background
      powRef.current = startPow(ch.pow_challenge, ch.pow_difficulty)

      setState('ready')

      // Set expiry timer
      const ttl = ch.expires_at - Date.now()
      const timeoutMs = ttl > 0 ? Math.min(ttl, CHALLENGE_TTL_MS) : CHALLENGE_TTL_MS

      // E2: warning timer at ttl - 30s
      const warningMs = Math.max(0, timeoutMs - 30000)
      if (warningMs > 0) {
        warningTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setExpiryWarning(true)
        }, warningMs)
      }

      expiryTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return
        powRef.current?.cancel()
        setExpiryWarning(false)
        setErrorMsg('Challenge expired, loading new one...')
        setState('loading')
        onExpire?.()
        // Auto-fetch new challenge
        fetchChallenge()
      }, timeoutMs)
    } catch (err) {
      if (!mountedRef.current) return
      const error = err instanceof Error ? err : new Error(String(err))
      setState('failed')
      setErrorMsg(friendlyError(undefined, error.message))
      onError?.(error)
    }
  }, [apiUrl, siteKey, sessionId, size, clearExpiry, onError, onExpire])

  // Fetch challenge on mount
  useEffect(() => {
    fetchChallenge()
    return () => {
      clearExpiry()
      powRef.current?.cancel()
      if (lockoutTimerRef.current !== null) {
        clearInterval(lockoutTimerRef.current)
        lockoutTimerRef.current = null
      }
    }
  }, [fetchChallenge, clearExpiry])

  // Submit the validation request (after maze + optional probes)
  const submitValidation = useCallback(
    async (events: RawEvent[]) => {
      if (!challenge || (!maze && !challenge.maze_image)) return
      setState('submitting')

      try {
        const pow = await powRef.current!.promise
        extractFeatures(events)

        const keyPair = keyPairRef.current
        if (!keyPair) throw new Error('Keypair not ready')
        const eventsDigest = await computeEventsDigest(events)
        const signature = await signChallenge(buildChallengeBindingPayload(challenge, eventsDigest), keyPair.privateKey)
        const webauthn =
          challenge.webauthn_request_options
            ? await requestWebAuthnAuthentication(challenge.webauthn_request_options)
            : null
        if (
          (challenge as ChallengeWithRequirements).requirements?.webauthn.mode === 'required'
          && !webauthn
        ) {
          throw new Error('WebAuthn authentication required')
        }

        const request: ValidationRequest = {
          challenge_id: challenge.id,
          site_key: siteKey,
          session_id: sessionId,
          events,
          pow_proof: pow,
          public_key: keyPair.publicKeyBase64,
          signature,
          timestamp: Date.now(),
          stable_id: stableId,
          probe_completion_tokens:
            probeCompletionTokensRef.current.length > 0
              ? [...probeCompletionTokensRef.current]
              : undefined,
          probe_responses:
            probeResponsesRef.current.length > 0
              ? [...probeResponsesRef.current]
              : undefined,
          webauthn: webauthn ?? undefined,
        }

        const res = await fetch(`${apiUrl}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })

        let result: ValidationResult
        try {
          result = await res.json()
        } catch {
          throw new Error(`Verification request failed: ${res.status}`)
        }
        if (!mountedRef.current) return

        if (result.success && result.token) {
          setState('verified')
          clearExpiry()
          onVerify(result.token)
          onVerifyResultRef.current?.({
            token: result.token,
            challengeId: challenge.id,
            score: (result as any).score,
            inputType: (result as any).input_type,
          })
        } else {
          const nextAttempts = attempts + 1
          setAttempts(nextAttempts)

          if (nextAttempts >= MAX_ATTEMPTS) {
            setState('locked')
            clearExpiry()
            setLockoutRemaining(120)
            lockoutTimerRef.current = setInterval(() => {
              setLockoutRemaining(prev => {
                if (prev <= 1) {
                  clearInterval(lockoutTimerRef.current!)
                  lockoutTimerRef.current = null
                  fetchChallenge()
                  setAttempts(0)
                  return 0
                }
                return prev - 1
              })
            }, 1000)
          } else {
            setState('failed')
            setErrorMsg(friendlyError(result.error_code))
            fetchChallenge()
          }
        }
      } catch (err) {
        if (!mountedRef.current) return
        const error = err instanceof Error ? err : new Error(String(err))
        setState('failed')
        setErrorMsg(friendlyError(undefined, error.message))
        onError?.(error)
      }
    },
    [challenge, siteKey, sessionId, stableId, apiUrl, size, attempts, clearExpiry, onVerify, onError, fetchChallenge],
  )

  // Handle probe completion
  const handleProbeComplete = useCallback(
    async (response: ProbeResponse) => {
      if (!challenge || !activeProbeTicketRef.current) return

      const res = await fetch(`${apiUrl}/probe/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: challenge.id,
          session_id: sessionId,
          probe_ticket: activeProbeTicketRef.current,
          tapped_cell: response.tapped_cell,
        }),
      })
      const result = await res.json() as { success?: boolean; completion_token?: string; error?: string }
      if (!mountedRef.current) return

      if (!result.success || !result.completion_token) {
        setState('failed')
        setErrorMsg(friendlyError('probe_failed', result.error))
        fetchChallenge()
        return
      }

      probeCompletionTokensRef.current.push(result.completion_token)
      probeResponsesRef.current.push(response)
      completedProbeIdsRef.current.add(response.probe_id)
      activeProbeTicketRef.current = null
      armingProbeIdRef.current = null
      setActiveProbe(null)
      setState('ready')
    },
    [apiUrl, challenge, fetchChallenge, sessionId],
  )

  // Image mode: position-based probe triggering (distance check against trigger_position)
  const PROBE_TRIGGER_THRESHOLD = 0.06 // 6% of canvas
  const handlePositionVisit = useCallback(
    async (position: { x: number; y: number }, events: RawEvent[]) => {
      if (!challenge || state === 'probe' || state === 'submitting') return
      const nextProbe = challenge.probes?.find((probe) => {
        if (completedProbeIdsRef.current.has(probe.id)) return false
        if (armingProbeIdRef.current === probe.id) return false
        if (!probe.trigger_position) return false
        const dx = position.x - probe.trigger_position.x
        const dy = position.y - probe.trigger_position.y
        return Math.sqrt(dx * dx + dy * dy) < PROBE_TRIGGER_THRESHOLD
      })
      if (!nextProbe) return

      armingProbeIdRef.current = nextProbe.id
      setState('probe')

      const res = await fetch(`${apiUrl}/probe/arm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: challenge.id,
          site_key: siteKey,
          session_id: sessionId,
          probe_id: nextProbe.id,
          events,
        }),
      })
      const result = await res.json() as { success?: boolean; probe_ticket?: string; error?: string }
      if (!mountedRef.current) return

      if (!result.success || !result.probe_ticket) {
        armingProbeIdRef.current = null
        setState('failed')
        setErrorMsg(friendlyError('probe_failed', result.error))
        fetchChallenge()
        return
      }

      activeProbeTicketRef.current = result.probe_ticket
      setActiveProbe(nextProbe)
    },
    [apiUrl, challenge, fetchChallenge, sessionId, siteKey, state],
  )

  const handleCellVisit = useCallback(
    async (cell: { x: number; y: number }, events: RawEvent[]) => {
      if (!challenge || state === 'probe' || state === 'submitting') return
      const nextProbe = challenge.probes?.find(
        (probe) =>
          probe.trigger_cell.x === cell.x &&
          probe.trigger_cell.y === cell.y &&
          !completedProbeIdsRef.current.has(probe.id) &&
          armingProbeIdRef.current !== probe.id,
      )
      if (!nextProbe) return

      armingProbeIdRef.current = nextProbe.id
      setState('probe')

      const res = await fetch(`${apiUrl}/probe/arm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: challenge.id,
          site_key: siteKey,
          session_id: sessionId,
          probe_id: nextProbe.id,
          events,
        }),
      })
      const result = await res.json() as { success?: boolean; probe_ticket?: string; error?: string }
      if (!mountedRef.current) return

      if (!result.success || !result.probe_ticket) {
        armingProbeIdRef.current = null
        setState('failed')
        setErrorMsg(friendlyError('probe_failed', result.error))
        fetchChallenge()
        return
      }

      activeProbeTicketRef.current = result.probe_ticket
      setActiveProbe(nextProbe)
    },
    [apiUrl, challenge, fetchChallenge, sessionId, siteKey, state],
  )

  const handlePathComplete = useCallback(
    async (events: RawEvent[]) => {
      if (!challenge) return
      const canonicalEvents = extractLatestPointerAttempt(events)
      submitValidation(canonicalEvents)
    },
    [challenge, submitValidation],
  )

  // ── Styles ──
  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: size === 'compact' ? 8 : 12,
    borderRadius: 'var(--cerno-radius)',
    border: '1px solid var(--cerno-border)',
    background: 'var(--cerno-bg)',
    fontFamily: 'var(--cerno-font)',
    color: 'var(--cerno-fg)',
    fontSize: size === 'compact' ? 12 : 14,
    maxWidth: '100%',
    position: 'relative',
  }

  const statusStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: size === 'compact' ? 11 : 13,
    color: 'var(--cerno-muted)',
  }

  const retryBtnStyle: React.CSSProperties = {
    padding: '6px 16px',
    borderRadius: 'var(--cerno-radius)',
    border: 'none',
    background: 'var(--cerno-accent)',
    color: '#ffffff',
    fontSize: size === 'compact' ? 12 : 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  }

  // ── Render ──

  if (state === 'verified') {
    return (
      <div style={containerStyle} data-cerno-theme={theme} role="group" aria-label="Cerno verification">
        <div style={{ ...statusStyle, color: 'var(--cerno-success)' }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M6 10l3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Verified
        </div>
        <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          Verified successfully
        </div>
      </div>
    )
  }

  if (state === 'locked') {
    const mins = Math.floor(lockoutRemaining / 60)
    const secs = lockoutRemaining % 60
    return (
      <div style={containerStyle} data-cerno-theme={theme} role="group" aria-label="Cerno verification">
        <div style={{ ...statusStyle, color: 'var(--cerno-muted)' }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <rect x="4" y="9" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M7 9V6a3 3 0 0 1 6 0v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Try again in {mins}:{secs.toString().padStart(2, '0')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--cerno-muted)', marginTop: 4 }}>
          This happens sometimes
        </div>
        <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          Too many attempts. Please wait.
        </div>
      </div>
    )
  }

  if (state === 'loading') {
    return (
      <div style={containerStyle} data-cerno-theme={theme} role="group" aria-label="Cerno verification">
        <div style={statusStyle}>
          <Spinner />
          {errorMsg || 'Loading challenge...'}
        </div>
        <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          Preparing verification
        </div>
      </div>
    )
  }

  if (state === 'submitting') {
    return (
      <div style={containerStyle} data-cerno-theme={theme} role="group" aria-label="Cerno verification">
        {(maze || challenge?.maze_image) && <MazeCanvas maze={maze ?? undefined} theme={theme} onPathComplete={() => {}} paused size={size} mazeImage={challenge?.maze_image} mazeImageWidth={challenge?.maze_image_width} mazeImageHeight={challenge?.maze_image_height} startPosition={challenge?.start_position} exitPosition={challenge?.exit_position} />}
        <div style={statusStyle}>
          <Spinner />
          Verifying...
        </div>
        <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          Verifying your response
        </div>
      </div>
    )
  }

  if (state === 'failed') {
    return (
      <div style={containerStyle} data-cerno-theme={theme} role="group" aria-label="Cerno verification">
        <div style={{ ...statusStyle, color: 'var(--cerno-error)' }}>{errorMsg}</div>
        {attempts < MAX_ATTEMPTS && (
          <button
            type="button"
            style={retryBtnStyle}
            onClick={() => fetchChallenge()}
          >
            Try again ({MAX_ATTEMPTS - attempts} left)
          </button>
        )}
        <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          {`Verification failed. ${MAX_ATTEMPTS - attempts} attempts remaining.`}
        </div>
      </div>
    )
  }

  // state === 'ready' | 'solving' | 'probe'
  // Probe overlays on top of the SAME MazeCanvas (paused) so the mouse collector
  // stays alive. This is critical for K-H1: motor events must continue during probes.
  const cellSz = size === 'compact' ? 28 : RENDERING.CELL_SIZE
  const isImageMode = !!challenge?.maze_image
  return (
    <div style={{ ...containerStyle, position: 'relative' }} data-cerno-theme={theme} role="group" aria-label="Cerno verification">
      {(maze || isImageMode) && (
        <MazeCanvas
          maze={maze ?? undefined}
          theme={theme}
          onPathComplete={handlePathComplete}
          onCellVisit={handleCellVisit}
          onPositionVisit={handlePositionVisit}
          paused={state === 'probe'}
          size={size}
          onCollectorStartTime={(getter) => { collectorStartTimeGetterRef.current = getter }}
          mazeImage={challenge?.maze_image}
          mazeImageWidth={challenge?.maze_image_width}
          mazeImageHeight={challenge?.maze_image_height}
          startPosition={challenge?.start_position}
          exitPosition={challenge?.exit_position}
        />
      )}
      {state === 'probe' && activeProbe && (maze || isImageMode) && (
        <StroopOverlay
          probe={activeProbe}
          mazeWidth={maze?.width ?? (challenge?.maze_image_width ? Math.round(challenge.maze_image_width / cellSz) : 8)}
          mazeHeight={maze?.height ?? (challenge?.maze_image_height ? Math.round(challenge.maze_image_height / cellSz) : 8)}
          cellSize={cellSz}
          theme={theme}
          onComplete={handleProbeComplete}
          collectorStartTime={collectorStartTimeGetterRef.current?.()}
          imageMode={isImageMode}
        />
      )}
      {expiryWarning && (state === 'ready' || state === 'solving') && (
        <div style={{
          fontSize: 11,
          color: 'var(--cerno-warning)',
          padding: '4px 0',
        }}>
          Time running low
        </div>
      )}
      <div style={statusStyle}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 8h8M8 4v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Cerno
      </div>
      <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
        {state === 'ready' && 'Verification ready. Trace the maze path.'}
      </div>
    </div>
  )
}

// Hoist keyframes + tokens so they're injected once, not per render
const SPINNER_KEYFRAMES = `@keyframes cerno-spin { to { transform: rotate(360deg); } }`
let stylesInjected = false
function injectStyles() {
  if (stylesInjected || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.textContent = [
    getCernoTokenCSS('light'),
    SPINNER_KEYFRAMES,
  ].join('\n')
  document.head.appendChild(style)
  stylesInjected = true
}

function Spinner() {
  injectStyles()
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      style={{ animation: 'cerno-spin 0.8s linear infinite' }}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28 10" strokeLinecap="round" />
    </svg>
  )
}
