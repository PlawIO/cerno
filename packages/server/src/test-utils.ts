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

// ── Synthetic Human Trace ──

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

  const onsetMean = (onsetMin + onsetMax) / 2
  const onsetStd = (onsetMax - onsetMin) / 4
  let onsetMs = normalRandom(rand, onsetMean, onsetStd)
  onsetMs = Math.max(onsetMin, Math.min(onsetMax, onsetMs))

  let t = 0

  const startNorm = cellToNorm(path[0], maze)
  const microX = (rand() - 0.5) * 0.02 * cellW
  const microY = (rand() - 0.5) * 0.02 * cellH

  events.push({
    t,
    x: Math.max(0, Math.min(1, startNorm.x + microX)),
    y: Math.max(0, Math.min(1, startNorm.y + microY)),
    type: 'down',
  })

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

  let noiseX = 0
  let noiseY = 0
  const NOISE_DRIFT = 0.003
  const NOISE_RESTORE = 0.15

  for (let i = 1; i < path.length; i++) {
    const fromNorm = cellToNorm(path[i - 1], maze)
    const toNorm = cellToNorm(path[i], maze)

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

    const dx = toNorm.x - fromNorm.x
    const dy = toNorm.y - fromNorm.y
    const numSteps = Math.max(8, Math.round(10 / speedMul))
    const globalStart = (i - 1) / (path.length - 1)
    const globalEnd = i / (path.length - 1)

    for (let s = 1; s <= numSteps; s++) {
      const localProgress = s / numSteps
      const globalProgress = globalStart + (globalEnd - globalStart) * localProgress

      let envelope: number
      if (globalProgress < 0.3) {
        envelope = 0.4 + 0.6 * (globalProgress / 0.3)
      } else if (globalProgress < 0.55) {
        envelope = 1.0
      } else {
        envelope = 0.3 + 0.7 * ((1.0 - globalProgress) / 0.45)
      }

      const sinVariation = 1.0 + 0.1 * Math.sin(globalProgress * Math.PI * 6 + rand() * 0.5)
      const speedFactor = envelope * sinVariation

      noiseX = noiseX * (1 - NOISE_RESTORE) + (rand() - 0.5) * NOISE_DRIFT * cellW
      noiseY = noiseY * (1 - NOISE_RESTORE) + (rand() - 0.5) * NOISE_DRIFT * cellH

      const x = fromNorm.x + dx * localProgress + noiseX
      const y = fromNorm.y + dy * localProgress + noiseY

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
