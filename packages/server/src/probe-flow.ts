import { generateMaze, renormalizeEvents, type Challenge, type Point, type RawEvent, RENDERING } from '@cernosh/core'
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose'
import { sha256Hex } from './crypto-utils.js'
import { MAX_EVENTS } from './scoring-constants.js'
import type {
  ProbeArmRequest,
  ProbeArmResult,
  ProbeCompleteRequest,
  ProbeCompleteResult,
  ServerConfig,
  SigningKey,
} from './types.js'

interface ProbeTicketClaims {
  kind: 'probe-ticket'
  arm_id: string
  challenge_id: string
  probe_id: string
  session_id: string
  site_key: string
  armed_at: number
  deadline_at: number
  jti: string
}

interface ProbeCompletionClaims {
  kind: 'probe-completion'
  challenge_id: string
  probe_id: string
  session_id: string
  site_key: string
  correct: boolean
  reaction_time_ms: number
  /** Server-derived probe anchor: last event timestamp (collector-relative)
   *  from the arm request trace. Used for K-H1 motor continuity. */
  probe_anchor_t: number
  jti: string
}

async function deriveKid(secret: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  )
  const bytes = new Uint8Array(hash)
  let hex = ''
  for (let i = 0; i < 4; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

async function signClaims(
  claims: Omit<ProbeTicketClaims, 'jti'> | Omit<ProbeCompletionClaims, 'jti'>,
  secret: string,
  ttlMs: number,
  kid?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + Math.max(1, Math.floor(ttlMs / 1000))
  const jti = globalThis.crypto.randomUUID()
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', kid: kid ?? await deriveKid(secret) })
    .setIssuedAt(now)
    .setJti(jti)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret))
}

async function verifyJwt<T extends { jti?: string }>(
  token: string,
  secret: string,
  secrets?: SigningKey[],
): Promise<T | null> {
  const keysToTry: string[] = []
  if (secrets?.length) {
    try {
      const header = decodeProtectedHeader(token)
      if (header.kid) {
        const matched = secrets.find((item) => item.kid === header.kid)
        if (matched) keysToTry.push(matched.value)
      }
    } catch {
      // Ignore malformed header; jwtVerify below will fail.
    }
    for (const item of secrets) {
      if (!keysToTry.includes(item.value)) keysToTry.push(item.value)
    }
  }
  if (!keysToTry.includes(secret)) keysToTry.push(secret)

  for (const value of keysToTry) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(value), {
        algorithms: ['HS256'],
      })
      return payload as T
    } catch {
      // Try next key.
    }
  }

  return null
}

function extractUniqueCells(maze: Challenge, events: RawEvent[]): Point[] {
  const corrected = renormalizeEvents(
    events,
    maze.maze_width,
    maze.maze_height,
    maze.cell_size ?? RENDERING.CELL_SIZE,
  )
  const points = corrected
    .filter((event) => event.type === 'move' || event.type === 'down' || event.type === 'keydown')
    .map((event) => ({
      x: Math.min(Math.floor(event.x * maze.maze_width), maze.maze_width - 1),
      y: Math.min(Math.floor(event.y * maze.maze_height), maze.maze_height - 1),
    }))

  if (points.length === 0) return []

  const unique = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const prev = unique[unique.length - 1]
    const next = points[i]
    if (prev.x !== next.x || prev.y !== next.y) unique.push(next)
  }
  return unique
}

function validatePrefixToTrigger(challenge: Challenge, trigger: Point, events: RawEvent[]): boolean {
  const maze = generateMaze({
    width: challenge.maze_width,
    height: challenge.maze_height,
    difficulty: challenge.maze_difficulty,
    seed: challenge.maze_seed,
  })
  const cells = extractUniqueCells(challenge, events)
  if (cells.length < 2) return false

  const first = cells[0]
  const last = cells[cells.length - 1]
  if (first.x !== maze.start.x || first.y !== maze.start.y) return false
  if (last.x !== trigger.x || last.y !== trigger.y) return false

  for (let i = 0; i < cells.length - 1; i++) {
    const current = cells[i]
    const next = cells[i + 1]
    const dx = next.x - current.x
    const dy = next.y - current.y
    if (Math.abs(dx) + Math.abs(dy) !== 1) return false

    const cell = maze.grid[current.y][current.x]
    if (dx === 1 && (cell.walls & 4)) return false
    if (dx === -1 && (cell.walls & 8)) return false
    if (dy === 1 && (cell.walls & 2)) return false
    if (dy === -1 && (cell.walls & 1)) return false
  }

  return true
}

export async function armProbe(
  config: ServerConfig,
  request: ProbeArmRequest,
): Promise<ProbeArmResult> {
  if (!Array.isArray(request.events) || request.events.length > MAX_EVENTS) {
    return { success: false, error: 'invalid_request' }
  }

  const challenge = await config.store.getChallenge(request.challenge_id)
  if (!challenge || challenge.site_key !== request.site_key) {
    return { success: false, error: 'challenge_not_found' }
  }
  if (Date.now() > challenge.expires_at) {
    return { success: false, error: 'challenge_expired' }
  }
  if (challenge.rate_limit_binding_hash) {
    const binding = request.rate_limit_binding ? await sha256Hex(request.rate_limit_binding) : ''
    if (binding !== challenge.rate_limit_binding_hash) {
      return { success: false, error: 'challenge_not_found' }
    }
  }

  const probe = challenge.probes?.find((item) => item.id === request.probe_id)
  if (!probe || challenge.requirements?.probe.mode !== 'required') {
    return { success: false, error: 'probe_failed' }
  }
  if (!validatePrefixToTrigger(challenge, probe.trigger_cell, request.events)) {
    return { success: false, error: 'invalid_path' }
  }
  if (!config.store.setProbeArmSession) {
    return { success: false, error: 'probe_store_unavailable' }
  }

  // K-H1: Capture the last event timestamp from the arm request trace.
  // This is the collector-relative timestamp at probe trigger, used as the
  // server-derived anchor for motor continuity analysis (replacing client's
  // probe_shown_at which an attacker can fabricate).
  const moveEvents = request.events.filter(
    e => e.type === 'move' || e.type === 'down' || e.type === 'up',
  )
  const lastEventT = moveEvents.length > 0 ? moveEvents[moveEvents.length - 1].t : 0

  const armId = globalThis.crypto.randomUUID()
  const armedAt = Date.now()
  const deadlineAt = Math.min(challenge.expires_at, armedAt + 5_000)
  await config.store.setProbeArmSession(armId, {
    id: armId,
    challenge_id: challenge.id,
    probe_id: probe.id,
    site_key: challenge.site_key,
    session_id: request.session_id,
    armed_at: armedAt,
    deadline_at: deadlineAt,
    last_event_t: lastEventT,
  }, Math.max(1_000, deadlineAt - armedAt))

  const signingKid = config.secrets?.find((item) => item.value === config.secret)?.kid
  const probeTicket = await signClaims({
    kind: 'probe-ticket',
    arm_id: armId,
    challenge_id: challenge.id,
    probe_id: probe.id,
    session_id: request.session_id,
    site_key: challenge.site_key,
    armed_at: armedAt,
    deadline_at: deadlineAt,
  }, config.secret, deadlineAt - armedAt, signingKid)

  return {
    success: true,
    probe_ticket: probeTicket,
    armed_at: armedAt,
    deadline_at: deadlineAt,
  }
}

export async function completeProbe(
  config: ServerConfig,
  request: ProbeCompleteRequest,
): Promise<ProbeCompleteResult> {
  const claims = await verifyJwt<ProbeTicketClaims>(request.probe_ticket, config.secret, config.secrets)
  if (!claims || claims.kind !== 'probe-ticket') {
    return { success: false, error: 'probe_failed' }
  }
  if (
    claims.challenge_id !== request.challenge_id ||
    claims.session_id !== request.session_id ||
    Date.now() > claims.deadline_at
  ) {
    return { success: false, error: 'probe_failed' }
  }
  if (!config.store.consumeProbeArmSession) {
    return { success: false, error: 'probe_store_unavailable' }
  }
  const armSession = await config.store.consumeProbeArmSession(claims.arm_id)
  if (!armSession) {
    return { success: false, error: 'probe_failed' }
  }
  const challenge = await config.store.getChallenge(request.challenge_id)
  if (!challenge) {
    return { success: false, error: 'challenge_not_found' }
  }
  const probe = challenge.probes?.find((item) => item.id === claims.probe_id)
  if (!probe) {
    return { success: false, error: 'probe_failed' }
  }

  const correct = probe.cells.some(
    (cell) => cell.isTarget && cell.x === request.tapped_cell.x && cell.y === request.tapped_cell.y,
  )
  const reactionTime = Math.max(0, Date.now() - armSession.armed_at)
  if (!correct || reactionTime < 150 || reactionTime > 5_000) {
    return { success: false, error: 'probe_failed' }
  }

  const signingKid = config.secrets?.find((item) => item.value === config.secret)?.kid
  const completionToken = await signClaims({
    kind: 'probe-completion',
    challenge_id: challenge.id,
    probe_id: probe.id,
    session_id: request.session_id,
    site_key: challenge.site_key,
    correct: true,
    reaction_time_ms: reactionTime,
    probe_anchor_t: armSession.last_event_t,
  }, config.secret, Math.max(1_000, challenge.expires_at - Date.now()), signingKid)

  return {
    success: true,
    completion_token: completionToken,
  }
}

export async function verifyProbeCompletionTokens(
  config: ServerConfig,
  challenge: Challenge,
  sessionId: string,
  tokens: string[],
): Promise<{
  valid: boolean
  results: Array<{ probe_id: string; correct: boolean; reaction_time_ms: number; probe_anchor_t: number }>
}> {
  const requiredCount = challenge.requirements?.probe.required_completion_count ?? 0
  if (requiredCount === 0) {
    return { valid: true, results: [] }
  }
  if (tokens.length !== requiredCount) {
    return { valid: false, results: [] }
  }

  const seen = new Set<string>()
  const results: Array<{ probe_id: string; correct: boolean; reaction_time_ms: number; probe_anchor_t: number }> = []
  for (const token of tokens) {
    const claims = await verifyJwt<ProbeCompletionClaims>(token, config.secret, config.secrets)
    if (!claims || claims.kind !== 'probe-completion') {
      return { valid: false, results: [] }
    }
    if (
      claims.challenge_id !== challenge.id ||
      claims.session_id !== sessionId ||
      claims.site_key !== challenge.site_key ||
      !claims.correct ||
      seen.has(claims.probe_id)
    ) {
      return { valid: false, results: [] }
    }
    if (config.store && claims.jti) {
      const consumed = await config.store.consumeToken(claims.jti, 60_000)
      if (!consumed) return { valid: false, results: [] }
    }
    seen.add(claims.probe_id)
    results.push({
      probe_id: claims.probe_id,
      correct: claims.correct,
      reaction_time_ms: claims.reaction_time_ms,
      probe_anchor_t: claims.probe_anchor_t ?? 0,
    })
  }

  return { valid: true, results }
}
