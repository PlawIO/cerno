/**
 * Calibration pipeline for Cerno behavioral scoring.
 *
 * Generates synthetic human and bot traces, computes ROC curves,
 * and suggests baselines from empirical data. Used by adversarial
 * evaluation tests to measure accuracy of the scoring pipeline.
 */
import type { Maze, Point, RawEvent, BehavioralFeatures, MazeProfile } from '@cernosh/core'
import { extractFeatures, Wall, computeMazeProfile } from '@cernosh/core'
import { scoreBehavior } from './behavioral-scoring.js'

// ── Types ──

export interface HumanTraceOptions {
  /** Speed multiplier relative to base (0.5 = slow, 2.0 = fast). Default 1.0. */
  speedMultiplier?: number
  /** Probability of pausing at a junction (0-1). Default 0.5. */
  pauseProbability?: number
  /** Movement onset range [min, max] in ms. Default [200, 800]. */
  onsetRange?: [number, number]
  /** Seed for deterministic generation. */
  seed?: number
}

export type BotStrategy = 'S1' | 'S2' | 'S3' | 'S4' | 'S5_score_search'

export interface ROCPoint {
  threshold: number
  tpr: number
  fpr: number
}

export interface ROCResult {
  points: ROCPoint[]
  auc: number
}

// ── Seeded PRNG (local, matching mulberry32 from core) ──

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller transform: returns a normally distributed value with given mean and std. */
function normalRandom(rand: () => number, mean: number, std: number): number {
  const u1 = rand()
  const u2 = rand()
  const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2)
  return mean + z * std
}

/** Log-normal random with given underlying normal mean and std. */
function logNormalRandom(rand: () => number, mu: number, sigma: number): number {
  return Math.exp(normalRandom(rand, mu, sigma))
}

// ── BFS Maze Solver ──

const DX: Record<number, number> = { [Wall.N]: 0, [Wall.S]: 0, [Wall.E]: 1, [Wall.W]: -1 }
const DY: Record<number, number> = { [Wall.N]: -1, [Wall.S]: 1, [Wall.E]: 0, [Wall.W]: 0 }
const DIRECTIONS = [Wall.N, Wall.S, Wall.E, Wall.W]

function solveBFS(maze: Maze): Point[] {
  // Use the maze's precomputed solution if available
  if (maze.solution && maze.solution.length > 1) return maze.solution

  const { grid, start, exit, width, height } = maze
  const visited = Array.from({ length: height }, () => new Array(width).fill(false))
  const parent = new Map<string, Point | null>()
  const key = (p: Point) => `${p.x},${p.y}`

  const queue: Point[] = [start]
  let head = 0
  visited[start.y][start.x] = true
  parent.set(key(start), null)

  while (head < queue.length) {
    const curr = queue[head++]
    if (curr.x === exit.x && curr.y === exit.y) {
      const path: Point[] = []
      let node: Point | null = curr
      while (node !== null) {
        path.push({ x: node.x, y: node.y })
        node = parent.get(key(node)) ?? null
      }
      path.reverse()
      return path
    }

    const cell = grid[curr.y][curr.x]
    for (const dir of DIRECTIONS) {
      if (cell.walls & dir) continue
      const nx = curr.x + DX[dir]
      const ny = curr.y + DY[dir]
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && !visited[ny][nx]) {
        visited[ny][nx] = true
        parent.set(key({ x: nx, y: ny }), curr)
        queue.push({ x: nx, y: ny })
      }
    }
  }

  return [start, exit]
}

/** Count open passages for a cell (used to detect junctions). */
function openPassages(maze: Maze, cell: Point): number {
  const walls = maze.grid[cell.y][cell.x].walls
  let count = 0
  if (!(walls & Wall.N)) count++
  if (!(walls & Wall.S)) count++
  if (!(walls & Wall.E)) count++
  if (!(walls & Wall.W)) count++
  return count
}

/** Convert grid cell to normalized [0,1] coordinate (center of cell). */
function cellToNorm(cell: Point, maze: Maze): { x: number; y: number } {
  return {
    x: (cell.x + 0.5) / maze.width,
    y: (cell.y + 0.5) / maze.height,
  }
}

// ── Synthetic Human Trace ──

/**
 * Generate a realistic human mouse trace through a maze.
 *
 * Key kinematic properties modelled:
 *  - Movement onset delay (200-800ms, normally distributed)
 *  - Variable speed with sinusoidal modulation (~0.0004 velocity_std after 60Hz resampling)
 *  - Tiny micro-corrections (1-2% of cell size) to avoid inflating curvature
 *  - Pauses at junctions (100-500ms, log-normal)
 *  - Asymmetric acceleration profile (deceleration phase ~1.4x acceleration)
 *  - Timing jitter via log-normal inter-event intervals (~16ms mean)
 */
export function generateSyntheticHumanTrace(maze: Maze, options?: HumanTraceOptions): RawEvent[] {
  const speedMul = options?.speedMultiplier ?? 1.0
  const pauseProb = options?.pauseProbability ?? 0.5
  const onsetMin = options?.onsetRange?.[0] ?? 200
  const onsetMax = options?.onsetRange?.[1] ?? 800
  const rand = mulberry32(options?.seed ?? Date.now())

  const path = solveBFS(maze)
  if (path.length < 2) return []

  const events: RawEvent[] = []
  const cellW = 1 / maze.width
  const cellH = 1 / maze.height

  // Movement onset delay (normally distributed within range)
  const onsetMean = (onsetMin + onsetMax) / 2
  const onsetStd = (onsetMax - onsetMin) / 4
  let onsetMs = normalRandom(rand, onsetMean, onsetStd)
  onsetMs = Math.max(onsetMin, Math.min(onsetMax, onsetMs))

  let t = 0

  // Start position with tiny offset
  const startNorm = cellToNorm(path[0], maze)
  const microX = (rand() - 0.5) * 0.02 * cellW
  const microY = (rand() - 0.5) * 0.02 * cellH

  // 'down' event at start
  events.push({
    t,
    x: Math.max(0, Math.min(1, startNorm.x + microX)),
    y: Math.max(0, Math.min(1, startNorm.y + microY)),
    type: 'down',
  })

  // Onset delay: emit a few near-stationary moves to model reaction time.
  // Use fewer events than onset duration to avoid inflating sample count.
  const onsetEvents = Math.max(2, Math.floor(onsetMs / 80))
  const onsetInterval = onsetMs / onsetEvents
  for (let i = 0; i < onsetEvents; i++) {
    const interval = logNormalRandom(rand, Math.log(Math.max(8, onsetInterval)), 0.3)
    t += Math.max(8, interval)
    events.push({
      t,
      x: Math.max(0, Math.min(1, startNorm.x + microX + (rand() - 0.5) * 0.003 * cellW)),
      y: Math.max(0, Math.min(1, startNorm.y + microY + (rand() - 0.5) * 0.003 * cellH)),
      type: 'move',
    })
  }

  // Running coordinate for smooth noise (accumulated drift rather than per-sample noise)
  let noiseX = 0
  let noiseY = 0
  const NOISE_DRIFT = 0.003 // how fast noise wanders per step (fraction of cell)
  const NOISE_RESTORE = 0.15 // how fast noise pulls back to zero

  // Traverse the solution path
  for (let i = 1; i < path.length; i++) {
    const fromNorm = cellToNorm(path[i - 1], maze)
    const toNorm = cellToNorm(path[i], maze)

    // Check if this is a junction (pause candidate)
    const isJunction = openPassages(maze, path[i]) > 2
    if (isJunction && rand() < pauseProb) {
      const pauseMs = Math.max(100, Math.min(500, logNormalRandom(rand, Math.log(250), 0.4)))
      const pauseSteps = Math.max(2, Math.floor(pauseMs / 16))
      for (let p = 0; p < pauseSteps; p++) {
        const interval = logNormalRandom(rand, Math.log(16), 0.3)
        t += Math.max(8, interval)
        events.push({
          t,
          x: Math.max(0, Math.min(1, fromNorm.x + (rand() - 0.5) * 0.005 * cellW)),
          y: Math.max(0, Math.min(1, fromNorm.y + (rand() - 0.5) * 0.005 * cellH)),
          type: 'move',
        })
      }
    }

    // Move from cell i-1 to cell i with many sub-steps for smooth motion.
    // ~10 sub-steps per cell at base speed => ~160ms per cell => ~3s for 19 cells.
    const dx = toNorm.x - fromNorm.x
    const dy = toNorm.y - fromNorm.y

    // Sub-steps per cell segment — more steps creates smoother velocity profile
    const numSteps = Math.max(8, Math.round(10 / speedMul))

    // Global progress through the full path (0..1) for accel/decel envelope
    const globalStart = (i - 1) / (path.length - 1)
    const globalEnd = i / (path.length - 1)

    for (let s = 1; s <= numSteps; s++) {
      const localProgress = s / numSteps
      const globalProgress = globalStart + (globalEnd - globalStart) * localProgress

      // Bell-curve speed envelope: slow start, cruise, slow finish.
      // Asymmetric: deceleration phase is ~1.4x longer than acceleration.
      // This produces acceleration_asymmetry ~1.3-1.6.
      let envelope: number
      if (globalProgress < 0.3) {
        // Acceleration phase (quick ramp-up)
        envelope = 0.4 + 0.6 * (globalProgress / 0.3)
      } else if (globalProgress < 0.55) {
        // Cruise phase
        envelope = 1.0
      } else {
        // Deceleration phase (gradual slow-down, ~1.4x the accel phase duration)
        envelope = 0.3 + 0.7 * ((1.0 - globalProgress) / 0.45)
      }

      // Small sinusoidal speed variation on top
      const sinVariation = 1.0 + 0.1 * Math.sin(globalProgress * Math.PI * 6 + rand() * 0.5)
      const speedFactor = envelope * sinVariation

      // Evolve noise via Ornstein-Uhlenbeck-like process (smooth, mean-reverting)
      noiseX = noiseX * (1 - NOISE_RESTORE) + (rand() - 0.5) * NOISE_DRIFT * cellW
      noiseY = noiseY * (1 - NOISE_RESTORE) + (rand() - 0.5) * NOISE_DRIFT * cellH

      const x = fromNorm.x + dx * localProgress + noiseX
      const y = fromNorm.y + dy * localProgress + noiseY

      // Timing: log-normal around 16ms, scaled by inverse of speed factor
      const baseInterval = 16 / Math.max(speedFactor, 0.2)
      const interval = logNormalRandom(rand, Math.log(Math.max(8, baseInterval)), 0.35)
      t += Math.max(6, interval)

      events.push({
        t,
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        type: 'move',
      })
    }
  }

  // 'up' event at exit
  const exitNorm = cellToNorm(path[path.length - 1], maze)
  t += logNormalRandom(rand, Math.log(30), 0.3)
  events.push({
    t,
    x: Math.max(0, Math.min(1, exitNorm.x + (rand() - 0.5) * 0.01 * cellW)),
    y: Math.max(0, Math.min(1, exitNorm.y + (rand() - 0.5) * 0.01 * cellH)),
    type: 'up',
  })

  return events
}

// ── Synthetic Bot Traces ──

export function generateSyntheticBotTrace(maze: Maze, strategy: BotStrategy, seed?: number): RawEvent[] {
  const rand = mulberry32(seed ?? Date.now())

  switch (strategy) {
    case 'S1': return generateS1Naive(maze, rand)
    case 'S2': return generateS2Noisy(maze, rand)
    case 'S3': return generateS3Template(maze, rand)
    case 'S4': return generateS4FeatureTuned(maze, rand)
    case 'S5_score_search': return generateS5ScoreSearch(maze, rand)
  }
}

/** S1: BFS solve, constant speed, perfectly centered, uniform timing. */
function generateS1Naive(maze: Maze, rand: () => number): RawEvent[] {
  const path = solveBFS(maze)
  const events: RawEvent[] = []
  const INTERVAL = 10 // constant, unnaturally fast
  let t = 0

  // Zero onset delay — instant start (inhuman)
  const start = cellToNorm(path[0], maze)
  events.push({ t, x: start.x, y: start.y, type: 'down' })

  for (let i = 1; i < path.length; i++) {
    const from = cellToNorm(path[i - 1], maze)
    const to = cellToNorm(path[i], maze)

    const steps = 3 // few steps, robotic precision
    for (let s = 1; s <= steps; s++) {
      t += INTERVAL
      const progress = s / steps
      events.push({
        t,
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
        type: 'move',
      })
    }
  }

  const end = cellToNorm(path[path.length - 1], maze)
  t += INTERVAL
  events.push({ t, x: end.x, y: end.y, type: 'up' })

  return events
}

/** S2: BFS + Perlin-like coordinate noise + random uniform-duration pauses. */
function generateS2Noisy(maze: Maze, rand: () => number): RawEvent[] {
  const path = solveBFS(maze)
  const events: RawEvent[] = []
  const cellW = 1 / maze.width
  const cellH = 1 / maze.height
  let t = 0

  const start = cellToNorm(path[0], maze)
  events.push({ t, x: start.x, y: start.y, type: 'down' })

  // Small onset (uniform, not log-normal like humans)
  t += 30 + rand() * 50

  for (let i = 1; i < path.length; i++) {
    const from = cellToNorm(path[i - 1], maze)
    const to = cellToNorm(path[i], maze)

    // Random uniform pause (same duration, unlike human log-normal)
    if (rand() < 0.25) {
      const pauseMs = 150 // uniform, not variable
      const pauseSteps = Math.floor(pauseMs / 12)
      for (let p = 0; p < pauseSteps; p++) {
        t += 12
        events.push({
          t,
          x: from.x + (rand() - 0.5) * 0.03 * cellW,
          y: from.y + (rand() - 0.5) * 0.03 * cellH,
          type: 'move',
        })
      }
    }

    const steps = 4
    for (let s = 1; s <= steps; s++) {
      t += 12 + (rand() - 0.5) * 3 // slight timing noise but basically uniform
      const progress = s / steps
      // Perlin-like noise: smooth random offset
      const phase = (i * steps + s) * 0.3
      const noiseX = Math.sin(phase) * 0.04 * cellW + (rand() - 0.5) * 0.02 * cellW
      const noiseY = Math.cos(phase * 1.3) * 0.04 * cellH + (rand() - 0.5) * 0.02 * cellH

      events.push({
        t,
        x: Math.max(0, Math.min(1, from.x + (to.x - from.x) * progress + noiseX)),
        y: Math.max(0, Math.min(1, from.y + (to.y - from.y) * progress + noiseY)),
        type: 'move',
      })
    }
  }

  const end = cellToNorm(path[path.length - 1], maze)
  t += 12
  events.push({ t, x: end.x, y: end.y, type: 'up' })

  return events
}

/** S3: Human template with coordinate noise. Timing from the template. */
function generateS3Template(maze: Maze, rand: () => number): RawEvent[] {
  // Generate a human trace as the template
  const template = generateSyntheticHumanTrace(maze, {
    speedMultiplier: 0.8 + rand() * 0.4,
    pauseProbability: 0.4,
    seed: Math.floor(rand() * 1e9),
  })

  const cellW = 1 / maze.width
  const cellH = 1 / maze.height

  // Per-sample independent random noise (not smooth like human Ornstein-Uhlenbeck drift).
  // This destroys velocity autocorrelation, inflates jerk and curvature,
  // and increases velocity_std — hitting both public and secret features.
  // Noise amplitude is ~15% of cell size per axis, large enough to degrade
  // path_efficiency and angular_velocity_entropy too.
  return template.map((e) => ({
    ...e,
    x: Math.max(0, Math.min(1, e.x + (rand() - 0.5) * 0.3 * cellW)),
    y: Math.max(0, Math.min(1, e.y + (rand() - 0.5) * 0.3 * cellH)),
  }))
}

/**
 * S4: Match each behavioral baseline independently.
 * velocity_std, path_efficiency, etc. are each within 1 sigma of baseline.
 * But cross-feature correlations are wrong (e.g., constant-envelope speed
 * with artificial pauses, symmetric accel/decel, uncorrelated noise).
 * The secret features (velocity autocorrelation, acceleration asymmetry,
 * curvature) expose the inconsistency.
 */
function generateS4FeatureTuned(maze: Maze, rand: () => number): RawEvent[] {
  const path = solveBFS(maze)
  const events: RawEvent[] = []
  const cellW = 1 / maze.width
  const cellH = 1 / maze.height

  // Target: movement_onset_ms ~800ms (baseline mean)
  const onsetMs = 600 + rand() * 400
  let t = 0

  const start = cellToNorm(path[0], maze)
  events.push({ t, x: start.x, y: start.y, type: 'down' })

  // Onset: sit still with constant timing (uniform intervals, not log-normal)
  const onsetSteps = Math.floor(onsetMs / 16)
  for (let i = 0; i < onsetSteps; i++) {
    t += 16
    events.push({
      t,
      x: start.x + (rand() - 0.5) * 0.002 * cellW,
      y: start.y + (rand() - 0.5) * 0.002 * cellH,
      type: 'move',
    })
  }

  // Add exactly 3 pauses spread evenly (matches pause_count baseline)
  const pauseIndices = new Set<number>()
  const spacing = Math.floor(path.length / 4)
  for (let p = 1; p <= 3 && p * spacing < path.length; p++) {
    pauseIndices.add(p * spacing)
  }

  for (let i = 1; i < path.length; i++) {
    const from = cellToNorm(path[i - 1], maze)
    const to = cellToNorm(path[i], maze)

    // Insert pause at fixed intervals
    if (pauseIndices.has(i)) {
      const pauseMs = 150 + rand() * 100
      const pauseSteps = Math.max(2, Math.floor(pauseMs / 16))
      for (let p = 0; p < pauseSteps; p++) {
        t += 16
        events.push({
          t,
          x: from.x + (rand() - 0.5) * 0.005 * cellW,
          y: from.y + (rand() - 0.5) * 0.005 * cellH,
          type: 'move',
        })
      }
    }

    // Variable sub-steps per cell to create timing_cv ~0.5
    const steps = 4 + Math.floor(rand() * 3)
    for (let s = 1; s <= steps; s++) {
      // Alternate between fast and slow intervals
      const timingPhase = Math.sin(t * 0.008 + rand())
      const interval = 14 + timingPhase * 8 + rand() * 4
      t += Math.max(6, interval)

      const progress = s / steps
      // Per-sample random noise (uncorrelated, unlike human drift)
      const noiseX = (rand() - 0.5) * 0.04 * cellW
      const noiseY = (rand() - 0.5) * 0.04 * cellH

      events.push({
        t,
        x: Math.max(0, Math.min(1, from.x + (to.x - from.x) * progress + noiseX)),
        y: Math.max(0, Math.min(1, from.y + (to.y - from.y) * progress + noiseY)),
        type: 'move',
      })
    }
  }

  const end = cellToNorm(path[path.length - 1], maze)
  t += 16
  events.push({ t, x: end.x, y: end.y, type: 'up' })

  return events
}

/**
 * S5: Score-search attack. Generates many synthetic human traces with
 * random parameter variations, scores each against the public scorer,
 * and returns the trace with the highest public score.
 *
 * This simulates an attacker who has read the public scoring code and
 * optimizes their trace to maximize the public behavioral score.
 * The only defense is the secret features (30% weight in the blend).
 */
function generateS5ScoreSearch(maze: Maze, rand: () => number): RawEvent[] {
  const profile = computeMazeProfile(maze)
  let bestTrace: RawEvent[] = []
  let bestScore = -1

  for (let i = 0; i < 20; i++) {
    const speedMultiplier = 0.6 + rand() * 0.8
    const pauseProbability = 0.2 + rand() * 0.6
    const onsetMin = 150 + rand() * 200
    const onsetMax = onsetMin + 200 + rand() * 400

    const trace = generateSyntheticHumanTrace(maze, {
      speedMultiplier,
      pauseProbability,
      onsetRange: [onsetMin, onsetMax],
      seed: Math.floor(rand() * 1e9),
    })

    const features = extractFeatures(trace)
    const { score } = scoreBehavior(features, profile)

    if (score > bestScore) {
      bestScore = score
      bestTrace = trace
    }
  }

  return bestTrace
}

// ── ROC Curve ──

export function computeROC(
  humanScores: number[],
  botScores: number[],
  thresholds?: number[],
): ROCResult {
  const thresh = thresholds ?? Array.from({ length: 19 }, (_, i) => 0.1 + i * 0.05)

  const points: ROCPoint[] = thresh.map((threshold) => {
    // TPR: fraction of humans correctly classified as human (score >= threshold)
    const tp = humanScores.filter((s) => s >= threshold).length
    const tpr = humanScores.length > 0 ? tp / humanScores.length : 0

    // FPR: fraction of bots incorrectly classified as human (score >= threshold)
    const fp = botScores.filter((s) => s >= threshold).length
    const fpr = botScores.length > 0 ? fp / botScores.length : 0

    return { threshold, tpr, fpr }
  })

  // Sort by FPR ascending for AUC computation
  const sorted = [...points].sort((a, b) => a.fpr - b.fpr)

  // AUC via trapezoidal rule
  let auc = 0
  for (let i = 1; i < sorted.length; i++) {
    const dFpr = sorted[i].fpr - sorted[i - 1].fpr
    const avgTpr = (sorted[i].tpr + sorted[i - 1].tpr) / 2
    auc += dFpr * avgTpr
  }

  // Add the triangle from (0,0) to first point and from last point to (1,1)
  if (sorted.length > 0) {
    auc += sorted[0].fpr * sorted[0].tpr / 2
    auc += (1 - sorted[sorted.length - 1].fpr) * (1 + sorted[sorted.length - 1].tpr) / 2
  }

  return { points, auc }
}

// ── Baseline Suggestion ──

export function suggestBaselines(
  traces: RawEvent[][],
): Record<string, { mean: number; std: number }> {
  const allFeatures: BehavioralFeatures[] = traces.map((t) => extractFeatures(t))

  const featureKeys: (keyof BehavioralFeatures)[] = [
    'velocity_std',
    'path_efficiency',
    'pause_count',
    'movement_onset_ms',
    'jerk_std',
    'angular_velocity_entropy',
    'timing_cv',
  ]

  const result: Record<string, { mean: number; std: number }> = {}

  for (const key of featureKeys) {
    const values = allFeatures.map((f) => f[key])
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(values.length - 1, 1)
    result[key] = { mean, std: Math.sqrt(variance) }
  }

  return result
}
