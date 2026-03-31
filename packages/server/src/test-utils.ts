/**
 * Test utilities for Cerno server tests.
 *
 * Generates synthetic human traces for testing the validation pipeline.
 * Not exported from the package — only used by test files.
 */
import type { Maze, Point, RawEvent } from '@cernosh/core'
import { Wall } from '@cernosh/core'

// ── Types ──

export interface HumanTraceOptions {
  speedMultiplier?: number
  pauseProbability?: number
  onsetRange?: [number, number]
  seed?: number
}

// ── Seeded PRNG (mulberry32) ──

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normalRandom(rand: () => number, mean: number, std: number): number {
  const u1 = rand()
  const u2 = rand()
  const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2)
  return mean + z * std
}

function logNormalRandom(rand: () => number, mu: number, sigma: number): number {
  return Math.exp(normalRandom(rand, mu, sigma))
}

// ── BFS Maze Solver ──

const DX: Record<number, number> = { [Wall.N]: 0, [Wall.S]: 0, [Wall.E]: 1, [Wall.W]: -1 }
const DY: Record<number, number> = { [Wall.N]: -1, [Wall.S]: 1, [Wall.E]: 0, [Wall.W]: 0 }
const DIRECTIONS = [Wall.N, Wall.S, Wall.E, Wall.W]

function solveBFS(maze: Maze): Point[] {
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

function openPassages(maze: Maze, cell: Point): number {
  const walls = maze.grid[cell.y][cell.x].walls
  let count = 0
  if (!(walls & Wall.N)) count++
  if (!(walls & Wall.S)) count++
  if (!(walls & Wall.E)) count++
  if (!(walls & Wall.W)) count++
  return count
}

function cellToNorm(cell: Point, maze: Maze): { x: number; y: number } {
  return {
    x: (cell.x + 0.5) / maze.width,
    y: (cell.y + 0.5) / maze.height,
  }
}

// ── Chrome 60Hz timing model ──
//
// Chrome fires pointermove at display vsync (~16.67ms). OS scheduling adds
// Gaussian jitter (sigma ~0.8ms). Occasionally a frame is skipped (~3%),
// producing a ~33ms gap. During pauses, the mouse nearly stops but micro-tremor
// keeps generating events at the same vsync rate with tiny spatial offsets.
//
// This model produces:
//   raw_timing_entropy ~1.5-3.0  (most mass in 2-3 bins at 1ms resolution)
//   timing_kurtosis    ~30-200   (peaked distribution with rare frame-skip tails)
//   timing_cv          ~0.03-0.08 per-segment, ~0.3-0.7 with pause slow-downs

const VSYNC_MS = 16.67
const VSYNC_JITTER_STD = 0.8
const FRAME_SKIP_PROB = 0.03

function chromeInterval(rand: () => number): number {
  let dt = normalRandom(rand, VSYNC_MS, VSYNC_JITTER_STD)
  if (rand() < FRAME_SKIP_PROB) dt += VSYNC_MS
  return Math.max(4, dt)
}

// ── Synthetic Human Trace ──
//
// Models a human solving a maze in Chrome at 60Hz. Key design choices:
//
// 1. TIMING: All events at constant vsync rate (16.67ms + Gaussian jitter,
//    sigma 0.8ms). Chrome fires pointermove at display refresh regardless
//    of mouse speed. Occasional frame skips (~3%) produce ~33ms gaps.
//    This yields RTE ~2.0, timing_kurtosis ~30-200.
//
// 2. SPATIAL: Linear interpolation between cell centers with variable
//    speed via frames-per-cell count (global envelope: slow at start/end,
//    fast in middle). Constant velocity within cells avoids pathological
//    near-zero-velocity points that inflate Menger curvature.
//
// 3. NOISE: Ornstein-Uhlenbeck position perturbation (slow RESTORE=0.03,
//    scale 0.003 * cellW). High temporal correlation preserves velocity
//    autocorrelation (VKA ~0.88). Small amplitude keeps curvature_mean
//    in the production range (~3-20).
//
// 4. PAUSES: Time gaps at junctions (no events emitted). Chrome fires no
//    pointermove when the mouse is stationary. The 60Hz resampler
//    interpolates through the gap, producing low curvature.

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

  // ── Onset period ──
  // User sees the maze, takes time to plan. Mouse is stationary during
  // this period so Chrome fires no pointermove. The delay appears as
  // movement_onset_ms in feature extraction.
  const onsetMean = (onsetMin + onsetMax) / 2
  const onsetStd = (onsetMax - onsetMin) / 4
  let onsetMs = normalRandom(rand, onsetMean, onsetStd)
  onsetMs = Math.max(onsetMin, Math.min(onsetMax, onsetMs))

  const startNorm = cellToNorm(path[0], maze)

  // Onset: mouse-down after planning delay. During onset the mouse is
  // stationary (user is looking at the maze), so no pointermove fires.
  // The onset shows up as movement_onset_ms in feature extraction.
  let t = onsetMs
  events.push({
    t,
    x: Math.max(0, Math.min(1, startNorm.x + (rand() - 0.5) * 0.01 * cellW)),
    y: Math.max(0, Math.min(1, startNorm.y + (rand() - 0.5) * 0.01 * cellH)),
    type: 'down',
  })

  // ── Spatial noise state (Ornstein-Uhlenbeck) ──
  // Small RESTORE (0.03) = high temporal correlation = smooth wobble.
  // NOISE_SCALE controls curvature: larger scale = more lateral deviation = higher
  // Menger curvature. Production mean is 57 (std 50). Scale of 0.003 produces
  // curvature ~15-60 across maze sizes (6x6 through 10x10), keeping CM within
  // 1 std of the production baseline.
  let noiseX = 0
  let noiseY = 0
  const NOISE_SCALE = 0.003
  const NOISE_RESTORE = 0.03

  // ── Generate movement events ──
  for (let i = 1; i < path.length; i++) {
    const fromNorm = cellToNorm(path[i - 1], maze)
    const toNorm = cellToNorm(path[i], maze)

    // ── Pause at junctions ──
    // Modeled as a time gap: mouse is stationary, Chrome fires no pointermove.
    // The 60Hz resampler interpolates through the gap with a straight line
    // from the last pre-pause position to the first post-pause position,
    // producing near-zero curvature (correct for stationary mouse).
    const isJunction = openPassages(maze, path[i]) > 2
    if (isJunction && rand() < pauseProb) {
      const pauseMs = Math.max(80, Math.min(400, logNormalRandom(rand, Math.log(180), 0.4)))
      t += pauseMs
    }

    // ── Cell-to-cell movement ──
    // Linear interpolation with speed controlled by frames-per-cell count.
    // Global envelope: slower at path start/end, faster in the middle.
    const globalProgress = i / (path.length - 1)
    let speedEnvelope: number
    if (globalProgress < 0.25) {
      speedEnvelope = 0.5 + 0.5 * (globalProgress / 0.25)
    } else if (globalProgress < 0.6) {
      speedEnvelope = 1.0
    } else {
      speedEnvelope = 0.5 + 0.5 * ((1.0 - globalProgress) / 0.4)
    }
    // Micro-variation in speed (simulates natural rhythm)
    speedEnvelope *= 1.0 + 0.08 * Math.sin(globalProgress * Math.PI * 5 + rand() * 1.0)

    // Frames per cell: more frames = slower through this cell
    const baseFramesPerCell = 10
    const framesPerCell = Math.max(6, Math.round(baseFramesPerCell / (speedEnvelope * speedMul)))

    const dx = toNorm.x - fromNorm.x
    const dy = toNorm.y - fromNorm.y

    for (let s = 1; s <= framesPerCell; s++) {
      // Linear interpolation within cells. Humans maintain roughly constant
      // velocity through corridor cells (no deceleration at each cell boundary).
      // Global speed variation comes from the framesPerCell count.
      const localProgress = s / framesPerCell

      // OU noise: each step is correlated with previous (RESTORE is small)
      noiseX = noiseX * (1 - NOISE_RESTORE) + normalRandom(rand, 0, NOISE_SCALE * cellW)
      noiseY = noiseY * (1 - NOISE_RESTORE) + normalRandom(rand, 0, NOISE_SCALE * cellH)

      const x = fromNorm.x + dx * localProgress + noiseX
      const y = fromNorm.y + dy * localProgress + noiseY

      t += chromeInterval(rand)

      events.push({
        t,
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        type: 'move',
      })
    }
  }

  // ── Final release ──
  const exitNorm = cellToNorm(path[path.length - 1], maze)
  t += chromeInterval(rand)
  events.push({
    t,
    x: Math.max(0, Math.min(1, exitNorm.x + (rand() - 0.5) * 0.005 * cellW)),
    y: Math.max(0, Math.min(1, exitNorm.y + (rand() - 0.5) * 0.005 * cellH)),
    type: 'up',
  })

  return events
}
