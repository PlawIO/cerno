import { describe, expect, it } from 'vitest'
import { generateMaze, RENDERING, type RawEvent } from '@cernosh/core'
import { armProbe, completeProbe, verifyProbeCompletionTokens } from './probe-flow.js'
import { createChallenge } from './validate.js'
import { MemoryStore } from './store.js'
import type { ServerConfig } from './types.js'

const INSTRUCTION_TEXT_HEIGHT = 24

function toCanvasCoords(
  x: number,
  y: number,
  mazeWidth: number,
  mazeHeight: number,
): { x: number; y: number } {
  const cellSize = RENDERING.CELL_SIZE
  const margin = RENDERING.MARGIN
  const mazePixelW = mazeWidth * cellSize
  const mazePixelH = mazeHeight * cellSize
  const canvasW = mazePixelW + margin * 2
  const canvasH = mazePixelH + margin * 2 + INSTRUCTION_TEXT_HEIGHT
  return {
    x: (x * mazePixelW + margin) / canvasW,
    y: (y * mazePixelH + margin) / canvasH,
  }
}

function toCanvasEvents(
  cells: Array<{ x: number; y: number }>,
  mazeWidth: number,
  mazeHeight: number,
): RawEvent[] {
  return cells.map((cell, index) => {
    const coords = toCanvasCoords(
      (cell.x + 0.5) / mazeWidth,
      (cell.y + 0.5) / mazeHeight,
      mazeWidth,
      mazeHeight,
    )
    return {
      t: index * 40,
      x: coords.x,
      y: coords.y,
      type: index === 0 ? 'down' : 'move',
    }
  })
}

// Helper: read the full (unsanitized) probe from the store.
// createChallenge strips isTarget/target_color from the client response,
// so tests that need the target cell must read from the store.
async function getStoredTargetCell(store: MemoryStore, challengeId: string, probeId: string) {
  const full = await store.getChallenge(challengeId)
  const probe = full!.probes!.find(p => p.id === probeId)!
  return probe.cells.find(c => c.isTarget)!
}

async function getStoredNonTargetCell(store: MemoryStore, challengeId: string, probeId: string) {
  const full = await store.getChallenge(challengeId)
  const probe = full!.probes!.find(p => p.id === probeId)!
  return probe.cells.find(c => !c.isTarget)!
}

describe('probe flow', () => {
  it('arms, completes, and verifies a probe token once', async () => {
    const store = new MemoryStore()
    const config: ServerConfig = {
      secret: 'probe-secret',
      store,
      enableProbes: true,
      probeProbability: 1,
    }

    const challenge = await createChallenge(config, { site_key: 'test-site' })
    expect(challenge.probes?.length).toBe(1)
    const probe = challenge.probes![0]
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const triggerIndex = maze.solution.findIndex(
      (cell) => cell.x === probe.trigger_cell.x && cell.y === probe.trigger_cell.y,
    )
    const prefix = maze.solution.slice(0, triggerIndex + 1)
    const prefixEvents = toCanvasEvents(prefix, maze.width, maze.height)

    const armed = await armProbe(config, {
      challenge_id: challenge.id,
      site_key: challenge.site_key,
      session_id: 'sess-1',
      probe_id: probe.id,
      events: prefixEvents,
    })
    expect(armed.success).toBe(true)
    expect(armed.probe_ticket).toBeDefined()

    const targetCell = await getStoredTargetCell(store, challenge.id, probe.id)
    await new Promise((resolve) => setTimeout(resolve, 180))
    const completed = await completeProbe(config, {
      challenge_id: challenge.id,
      session_id: 'sess-1',
      probe_ticket: armed.probe_ticket!,
      tapped_cell: { x: targetCell.x, y: targetCell.y },
    })
    expect(completed.success).toBe(true)
    expect(completed.completion_token).toBeDefined()

    const verified = await verifyProbeCompletionTokens(
      config,
      challenge,
      'sess-1',
      [completed.completion_token!],
    )
    expect(verified.valid).toBe(true)
    expect(verified.results[0]?.probe_id).toBe(probe.id)

    const replay = await verifyProbeCompletionTokens(
      config,
      challenge,
      'sess-1',
      [completed.completion_token!],
    )
    expect(replay.valid).toBe(false)
  })

  it('rejects completion past the probe deadline', async () => {
    const store = new MemoryStore()
    const config: ServerConfig = {
      secret: 'probe-secret',
      store,
      enableProbes: true,
      probeProbability: 1,
    }

    const challenge = await createChallenge(config, { site_key: 'test-site' })
    const probe = challenge.probes![0]
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const triggerIndex = maze.solution.findIndex(
      (cell) => cell.x === probe.trigger_cell.x && cell.y === probe.trigger_cell.y,
    )
    const prefix = maze.solution.slice(0, triggerIndex + 1)
    const prefixEvents = toCanvasEvents(prefix, maze.width, maze.height)

    const armed = await armProbe(config, {
      challenge_id: challenge.id,
      site_key: challenge.site_key,
      session_id: 'sess-deadline',
      probe_id: probe.id,
      events: prefixEvents,
    })
    expect(armed.success).toBe(true)

    // Manipulate the stored arm session to be 10 seconds in the past
    // Re-store it with armed_at and deadline_at well in the past
    const armIdFromTicket = armed.probe_ticket!
    // We can't easily extract arm_id from the JWT, so instead
    // wait for the deadline to pass by re-arming with a very short TTL.
    // Alternative: directly set a new session that's already expired.
    // The completeProbe checks Date.now() > claims.deadline_at from the JWT.
    // Since the JWT deadline_at was set to ~5s from now, we wait briefly then check.
    // But the test wants to show deadline enforcement -- let's do it via time manipulation.

    // The JWT itself encodes deadline_at. We need to wait for it or forge the condition.
    // Simplest: override the challenge expires_at to be in the past, then create a fresh one.
    // Actually, the cleanest approach: create a challenge with a very short TTL so
    // the deadline passes quickly, then attempt completion.
    store.clear()

    const shortConfig: ServerConfig = {
      secret: 'probe-secret',
      store,
      enableProbes: true,
      probeProbability: 1,
      challengeTtlMs: 1_000, // 1 second TTL => deadline_at ≈ now + 1s
    }
    const shortChallenge = await createChallenge(shortConfig, { site_key: 'test-site' })
    const shortProbe = shortChallenge.probes![0]
    const shortMaze = generateMaze({
      width: shortChallenge.maze_width,
      height: shortChallenge.maze_height,
      difficulty: shortChallenge.maze_difficulty,
      seed: shortChallenge.maze_seed,
    })
    const shortTriggerIdx = shortMaze.solution.findIndex(
      (cell) => cell.x === shortProbe.trigger_cell.x && cell.y === shortProbe.trigger_cell.y,
    )
    const shortPrefix = shortMaze.solution.slice(0, shortTriggerIdx + 1)
    const shortPrefixEvents = toCanvasEvents(shortPrefix, shortMaze.width, shortMaze.height)

    const shortArmed = await armProbe(shortConfig, {
      challenge_id: shortChallenge.id,
      site_key: shortChallenge.site_key,
      session_id: 'sess-deadline2',
      probe_id: shortProbe.id,
      events: shortPrefixEvents,
    })
    expect(shortArmed.success).toBe(true)

    // Read target cell before the TTL expires
    const targetCell = await getStoredTargetCell(store, shortChallenge.id, shortProbe.id)

    // Wait for the deadline to pass (deadline_at = min(expires_at, armed_at + 5s) = ~1s)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const completed = await completeProbe(shortConfig, {
      challenge_id: shortChallenge.id,
      session_id: 'sess-deadline2',
      probe_ticket: shortArmed.probe_ticket!,
      tapped_cell: { x: targetCell.x, y: targetCell.y },
    })
    expect(completed.success).toBe(false)
    expect(completed.error).toBe('probe_failed')
  })

  it('rejects wrong probe response (non-target cell)', async () => {
    const store = new MemoryStore()
    const config: ServerConfig = {
      secret: 'probe-secret',
      store,
      enableProbes: true,
      probeProbability: 1,
    }

    const challenge = await createChallenge(config, { site_key: 'test-site' })
    const probe = challenge.probes![0]
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const triggerIndex = maze.solution.findIndex(
      (cell) => cell.x === probe.trigger_cell.x && cell.y === probe.trigger_cell.y,
    )
    const prefix = maze.solution.slice(0, triggerIndex + 1)
    const prefixEvents = toCanvasEvents(prefix, maze.width, maze.height)

    const armed = await armProbe(config, {
      challenge_id: challenge.id,
      site_key: challenge.site_key,
      session_id: 'sess-wrong',
      probe_id: probe.id,
      events: prefixEvents,
    })
    expect(armed.success).toBe(true)

    // Find a non-target cell from the stored (unsanitized) challenge
    const nonTarget = await getStoredNonTargetCell(store, challenge.id, probe.id)
    await new Promise((resolve) => setTimeout(resolve, 180))
    const completed = await completeProbe(config, {
      challenge_id: challenge.id,
      session_id: 'sess-wrong',
      probe_ticket: armed.probe_ticket!,
      tapped_cell: { x: nonTarget.x, y: nonTarget.y },
    })
    expect(completed.success).toBe(false)
    expect(completed.error).toBe('probe_failed')
  })

  it('rejects superhuman reaction time (< 150ms)', async () => {
    const store = new MemoryStore()
    const config: ServerConfig = {
      secret: 'probe-secret',
      store,
      enableProbes: true,
      probeProbability: 1,
    }

    const challenge = await createChallenge(config, { site_key: 'test-site' })
    const probe = challenge.probes![0]
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const triggerIndex = maze.solution.findIndex(
      (cell) => cell.x === probe.trigger_cell.x && cell.y === probe.trigger_cell.y,
    )
    const prefix = maze.solution.slice(0, triggerIndex + 1)
    const prefixEvents = toCanvasEvents(prefix, maze.width, maze.height)

    const armed = await armProbe(config, {
      challenge_id: challenge.id,
      site_key: challenge.site_key,
      session_id: 'sess-fast',
      probe_id: probe.id,
      events: prefixEvents,
    })
    expect(armed.success).toBe(true)

    // Complete immediately -- reaction time will be < 150ms
    const targetCell = await getStoredTargetCell(store, challenge.id, probe.id)
    const completed = await completeProbe(config, {
      challenge_id: challenge.id,
      session_id: 'sess-fast',
      probe_ticket: armed.probe_ticket!,
      tapped_cell: { x: targetCell.x, y: targetCell.y },
    })
    expect(completed.success).toBe(false)
    expect(completed.error).toBe('probe_failed')
  })

  it('rejects completion with an invalid probe_ticket', async () => {
    const store = new MemoryStore()
    const config: ServerConfig = {
      secret: 'probe-secret',
      store,
      enableProbes: true,
      probeProbability: 1,
    }

    const challenge = await createChallenge(config, { site_key: 'test-site' })

    const completed = await completeProbe(config, {
      challenge_id: challenge.id,
      session_id: 'sess-no-ticket',
      probe_ticket: 'not-a-valid-jwt',
      tapped_cell: { x: 0, y: 0 },
    })
    expect(completed.success).toBe(false)
    expect(completed.error).toBe('probe_failed')
  })

  it('rejects arm request with oversized events array', async () => {
    const store = new MemoryStore()
    const config: ServerConfig = {
      secret: 'probe-secret',
      store,
      enableProbes: true,
      probeProbability: 1,
    }

    const challenge = await createChallenge(config, { site_key: 'test-site' })
    expect(challenge.probes?.length).toBe(1)
    const probe = challenge.probes![0]

    const oversizedEvents = new Array(50_001).fill({ t: 0, x: 0, y: 0, type: 'move' })
    const result = await armProbe(config, {
      challenge_id: challenge.id,
      site_key: challenge.site_key,
      session_id: 'sess-oversized',
      probe_id: probe.id,
      events: oversizedEvents,
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe('invalid_request')
  })

  it('prevents duplicate completion token verification', async () => {
    const store = new MemoryStore()
    const config: ServerConfig = {
      secret: 'probe-secret',
      store,
      enableProbes: true,
      probeProbability: 1,
    }

    const challenge = await createChallenge(config, { site_key: 'test-site' })
    const probe = challenge.probes![0]
    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const triggerIndex = maze.solution.findIndex(
      (cell) => cell.x === probe.trigger_cell.x && cell.y === probe.trigger_cell.y,
    )
    const prefix = maze.solution.slice(0, triggerIndex + 1)
    const prefixEvents = toCanvasEvents(prefix, maze.width, maze.height)

    const armed = await armProbe(config, {
      challenge_id: challenge.id,
      site_key: challenge.site_key,
      session_id: 'sess-dup',
      probe_id: probe.id,
      events: prefixEvents,
    })
    expect(armed.success).toBe(true)

    const targetCell = await getStoredTargetCell(store, challenge.id, probe.id)
    await new Promise((resolve) => setTimeout(resolve, 180))
    const completed = await completeProbe(config, {
      challenge_id: challenge.id,
      session_id: 'sess-dup',
      probe_ticket: armed.probe_ticket!,
      tapped_cell: { x: targetCell.x, y: targetCell.y },
    })
    expect(completed.success).toBe(true)
    expect(completed.completion_token).toBeDefined()

    // First verification succeeds
    const first = await verifyProbeCompletionTokens(
      config,
      challenge,
      'sess-dup',
      [completed.completion_token!],
    )
    expect(first.valid).toBe(true)

    // Second verification with same token fails (token consumed)
    const second = await verifyProbeCompletionTokens(
      config,
      challenge,
      'sess-dup',
      [completed.completion_token!],
    )
    expect(second.valid).toBe(false)
  })
})
