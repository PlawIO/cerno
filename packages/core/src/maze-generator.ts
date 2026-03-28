import { mulberry32 } from './seeded-prng.js'
import type { Cell, Maze, MazeConfig, Point } from './types.js'
import { Wall } from './types.js'

const OPPOSITE: Record<number, number> = {
  [Wall.N]: Wall.S,
  [Wall.S]: Wall.N,
  [Wall.E]: Wall.W,
  [Wall.W]: Wall.E,
}

const DX: Record<number, number> = {
  [Wall.N]: 0,
  [Wall.S]: 0,
  [Wall.E]: 1,
  [Wall.W]: -1,
}

const DY: Record<number, number> = {
  [Wall.N]: -1,
  [Wall.S]: 1,
  [Wall.E]: 0,
  [Wall.W]: 0,
}

const DIRECTIONS = [Wall.N, Wall.S, Wall.E, Wall.W]

function shuffled<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Growing Tree maze generation.
 * difficulty controls cell selection bias:
 *   0 = pure DFS (long corridors)
 *   1 = pure Prim's (many dead ends, more branching)
 */
export function generateMaze(config: MazeConfig): Maze {
  const { width, height, difficulty, seed } = config
  const rand = mulberry32(seed)

  // Init grid with all walls
  const grid: Cell[][] = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => ({
      x,
      y,
      walls: Wall.N | Wall.S | Wall.E | Wall.W,
    })),
  )

  const visited = Array.from({ length: height }, () =>
    new Array(width).fill(false),
  )

  const active: Point[] = []

  // Start from random cell
  const startX = Math.floor(rand() * width)
  const startY = Math.floor(rand() * height)
  active.push({ x: startX, y: startY })
  visited[startY][startX] = true

  while (active.length > 0) {
    // difficulty blends between last (DFS) and random (Prim's)
    const idx =
      rand() < difficulty
        ? Math.floor(rand() * active.length)
        : active.length - 1

    const cell = active[idx]
    const dirs = shuffled(DIRECTIONS, rand)
    let carved = false

    for (const dir of dirs) {
      const nx = cell.x + DX[dir]
      const ny = cell.y + DY[dir]

      if (nx >= 0 && nx < width && ny >= 0 && ny < height && !visited[ny][nx]) {
        // Remove walls between current and neighbor
        grid[cell.y][cell.x].walls &= ~dir
        grid[ny][nx].walls &= ~OPPOSITE[dir]

        visited[ny][nx] = true
        active.push({ x: nx, y: ny })
        carved = true
        break
      }
    }

    if (!carved) {
      active.splice(idx, 1)
    }
  }

  // Place start at top-left area, exit at bottom-right area
  const start: Point = { x: 0, y: 0 }
  const exit: Point = { x: width - 1, y: height - 1 }

  // Find solution via BFS
  const solution = solveMaze(grid, width, height, start, exit)

  return { grid, start, exit, width, height, seed, solution }
}

/** BFS shortest path */
export function solveMaze(
  grid: Cell[][],
  width: number,
  height: number,
  start: Point,
  exit: Point,
): Point[] {
  const visited = Array.from({ length: height }, () =>
    new Array(width).fill(false),
  )
  const parent = new Map<string, Point | null>()
  const key = (p: Point) => `${p.x},${p.y}`

  const queue: Point[] = [start]
  visited[start.y][start.x] = true
  parent.set(key(start), null)

  while (queue.length > 0) {
    const curr = queue.shift()!
    if (curr.x === exit.x && curr.y === exit.y) {
      // Reconstruct path
      const path: Point[] = []
      let node: Point | null = curr
      while (node !== null) {
        path.unshift({ x: node.x, y: node.y })
        node = parent.get(key(node)) ?? null
      }
      return path
    }

    const cell = grid[curr.y][curr.x]
    for (const dir of DIRECTIONS) {
      // Can traverse if wall is removed (bit is 0)
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

  // Should never happen for a valid maze
  return [start, exit]
}

/**
 * Validate that a path of normalized (0-1) coordinates
 * traces a valid route through the maze from start to exit.
 */
export function validatePath(
  maze: Maze,
  pathPoints: Point[],
): boolean {
  if (pathPoints.length < 2) return false

  // Convert normalized coordinates to grid cells
  const cells = pathPoints.map((p) => ({
    x: Math.min(Math.floor(p.x * maze.width), maze.width - 1),
    y: Math.min(Math.floor(p.y * maze.height), maze.height - 1),
  }))

  // Deduplicate consecutive same-cell entries
  const uniqueCells: Point[] = [cells[0]]
  for (let i = 1; i < cells.length; i++) {
    const prev = uniqueCells[uniqueCells.length - 1]
    if (cells[i].x !== prev.x || cells[i].y !== prev.y) {
      uniqueCells.push(cells[i])
    }
  }

  // Must start at maze start and end at maze exit
  const first = uniqueCells[0]
  const last = uniqueCells[uniqueCells.length - 1]
  if (first.x !== maze.start.x || first.y !== maze.start.y) return false
  if (last.x !== maze.exit.x || last.y !== maze.exit.y) return false

  // Each consecutive pair must be adjacent (no wall between them)
  for (let i = 0; i < uniqueCells.length - 1; i++) {
    const curr = uniqueCells[i]
    const next = uniqueCells[i + 1]
    const dx = next.x - curr.x
    const dy = next.y - curr.y

    // Must be adjacent (no diagonal)
    if (Math.abs(dx) + Math.abs(dy) !== 1) return false

    // Determine direction
    let dir: number
    if (dx === 1) dir = Wall.E
    else if (dx === -1) dir = Wall.W
    else if (dy === 1) dir = Wall.S
    else dir = Wall.N

    // Check no wall blocks this move
    if (maze.grid[curr.y][curr.x].walls & dir) return false
  }

  return true
}
