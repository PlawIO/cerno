import { mulberry32 } from './seeded-prng.js'
import type { Cell, Maze, MazeConfig, MazeProfile, Point } from './types.js'
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
  let qHead = 0
  visited[start.y][start.x] = true
  parent.set(key(start), null)

  while (qHead < queue.length) {
    const curr = queue[qHead++]
    if (curr.x === exit.x && curr.y === exit.y) {
      // Reconstruct path
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
 * Compute a structural profile of the maze for maze-relative scoring.
 * Baselines computed from the actual maze topology are strictly more accurate
 * than hardcoded values from unrelated mouse-movement research.
 */
export function computeMazeProfile(maze: Maze): MazeProfile {
  const solution = maze.solution
  const solutionLength = solution.length

  // Decision points: solution cells with >2 open passages (forks where you could go wrong)
  let decisionPointCount = 0
  for (const cell of solution) {
    const walls = maze.grid[cell.y][cell.x].walls
    let open = 0
    if (!(walls & Wall.N)) open++
    if (!(walls & Wall.S)) open++
    if (!(walls & Wall.E)) open++
    if (!(walls & Wall.W)) open++
    if (open > 2) decisionPointCount++
  }

  // Turns: direction changes along the BFS solution
  let turnCount = 0
  for (let i = 2; i < solution.length; i++) {
    const prevDx = solution[i - 1].x - solution[i - 2].x
    const prevDy = solution[i - 1].y - solution[i - 2].y
    const currDx = solution[i].x - solution[i - 1].x
    const currDy = solution[i].y - solution[i - 1].y
    if (prevDx !== currDx || prevDy !== currDy) turnCount++
  }

  // Optimal path efficiency in normalized (0-1) coordinates
  const sNx = (maze.start.x + 0.5) / maze.width
  const sNy = (maze.start.y + 0.5) / maze.height
  const eNx = (maze.exit.x + 0.5) / maze.width
  const eNy = (maze.exit.y + 0.5) / maze.height
  const euclidean = Math.sqrt((eNx - sNx) ** 2 + (eNy - sNy) ** 2)

  let pathDist = 0
  for (let i = 1; i < solution.length; i++) {
    const dx = (solution[i].x + 0.5) / maze.width - (solution[i - 1].x + 0.5) / maze.width
    const dy = (solution[i].y + 0.5) / maze.height - (solution[i - 1].y + 0.5) / maze.height
    pathDist += Math.sqrt(dx * dx + dy * dy)
  }

  const optimalEfficiency = pathDist > 0 ? euclidean / pathDist : 0

  return { solutionLength, decisionPointCount, turnCount, optimalEfficiency }
}

/**
 * Determine the wall direction between two adjacent cells.
 * Returns 0 if cells are not orthogonally adjacent.
 */
function adjacentDir(fx: number, fy: number, tx: number, ty: number): number {
  const dx = tx - fx
  const dy = ty - fy
  if (Math.abs(dx) + Math.abs(dy) !== 1) return 0
  if (dx === 1) return Wall.E
  if (dx === -1) return Wall.W
  if (dy === 1) return Wall.S
  return Wall.N
}

/**
 * Validate that a path of normalized (0-1) coordinates
 * traces a valid route through the maze from start to exit.
 *
 * Raw pointer events may contain coordinates in non-adjacent cells
 * when the user moves the pointer quickly across cell boundaries.
 * These "skipped" events are filtered out as pointer noise — only
 * events that are adjacent to the last accepted cell and connected
 * through a valid passage are kept.
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

  // Build a connected path, skipping non-adjacent pointer noise.
  // Each accepted cell must be orthogonally adjacent to the previous
  // accepted cell with no wall between them.
  const connected: Point[] = [cells[0]]
  for (let i = 1; i < cells.length; i++) {
    const prev = connected[connected.length - 1]
    // Same cell — skip
    if (cells[i].x === prev.x && cells[i].y === prev.y) continue
    // Check adjacency
    const dir = adjacentDir(prev.x, prev.y, cells[i].x, cells[i].y)
    if (!dir) continue // non-adjacent: pointer noise, skip
    // Check wall
    if (maze.grid[prev.y][prev.x].walls & dir) continue // wall-blocked, skip
    connected.push(cells[i])
  }

  // Must start at maze start and end at maze exit
  if (connected.length < 2) return false
  const first = connected[0]
  const last = connected[connected.length - 1]
  if (first.x !== maze.start.x || first.y !== maze.start.y) return false
  if (last.x !== maze.exit.x || last.y !== maze.exit.y) return false

  return true
}
