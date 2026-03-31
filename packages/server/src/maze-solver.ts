import { generateMaze, validatePath } from '@cernosh/core'
import type { Maze, Point, RawEvent } from '@cernosh/core'

export interface MazeValidationResult {
  valid: boolean
  maze: Maze
}

/**
 * Server-side maze validation.
 * Regenerates the maze from the seed and checks the submitted path.
 *
 * @param mode - 'strict' uses cell-by-cell wall checking (grid-snapped paths).
 *               'corridor' uses tolerance-based validation (free-draw on PNG).
 */
export function validateMazePath(
  mazeSeed: number,
  events: RawEvent[],
  mazeWidth: number,
  mazeHeight: number,
  mazeDifficulty: number,
  mode: 'strict' | 'corridor' = 'strict',
): MazeValidationResult {
  const maze = generateMaze({
    width: mazeWidth,
    height: mazeHeight,
    difficulty: mazeDifficulty,
    seed: mazeSeed,
  })

  // Extract path points from movement events
  const pathPoints: Point[] = events
    .filter((e) => e.type === 'move' || e.type === 'down')
    .map((e) => ({ x: e.x, y: e.y }))

  if (mode === 'corridor') {
    const valid = validatePathCorridor(maze, pathPoints)
    return { valid, maze }
  }

  const valid = validatePath(maze, pathPoints)
  return { valid, maze }
}

/**
 * Distance from point (px, py) to the closest point on line segment A→B.
 */
function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2)

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2)
}

/**
 * Corridor-based path validation for free-draw mode (image-rendered mazes).
 *
 * Instead of strict cell-by-cell wall checking, validates that:
 * 1. The trace stays within 60% of cell width from the BFS solution path
 * 2. The trace starts near the maze start and ends near the maze exit
 * 3. The trace covers at least 70% of solution path segments (prevents
 *    shortcutting by only touching start and exit)
 *
 * Coordinates are in maze-grid-normalized space (0-1), converted to
 * cell-unit space for distance calculations (1 unit = 1 cell width).
 */
function validatePathCorridor(maze: Maze, pathPoints: Point[]): boolean {
  if (pathPoints.length < 2) return false

  const solution = maze.solution
  if (!solution || solution.length < 2) return false

  // Tolerance in cell units: 60% of cell width
  const CORRIDOR_TOLERANCE = 0.6
  // Start/exit get extra tolerance (user may click slightly outside)
  const ENDPOINT_TOLERANCE = CORRIDOR_TOLERANCE * 1.5
  // Require 70% of solution segments to be visited
  const COVERAGE_THRESHOLD = 0.7

  // Solution path as cell-center coordinates (cell units)
  const solutionCenters = solution.map(p => ({
    x: p.x + 0.5,
    y: p.y + 0.5,
  }))

  // Convert first/last trace points to cell-unit space
  const first = { x: pathPoints[0].x * maze.width, y: pathPoints[0].y * maze.height }
  const last = {
    x: pathPoints[pathPoints.length - 1].x * maze.width,
    y: pathPoints[pathPoints.length - 1].y * maze.height,
  }

  const startCenter = solutionCenters[0]
  const exitCenter = solutionCenters[solutionCenters.length - 1]

  // Check endpoints are near start/exit
  const startDist = Math.sqrt((first.x - startCenter.x) ** 2 + (first.y - startCenter.y) ** 2)
  const exitDist = Math.sqrt((last.x - exitCenter.x) ** 2 + (last.y - exitCenter.y) ** 2)

  if (startDist > ENDPOINT_TOLERANCE) return false
  if (exitDist > ENDPOINT_TOLERANCE) return false

  // Check all trace points are within the corridor AND track segment coverage
  const segmentVisited = new Array(solutionCenters.length - 1).fill(false)

  for (const point of pathPoints) {
    const px = point.x * maze.width
    const py = point.y * maze.height

    let minDist = Infinity
    for (let i = 0; i < solutionCenters.length - 1; i++) {
      const dist = pointToSegmentDistance(
        px, py,
        solutionCenters[i].x, solutionCenters[i].y,
        solutionCenters[i + 1].x, solutionCenters[i + 1].y,
      )
      if (dist < minDist) minDist = dist
      // Mark segment as visited if within corridor
      if (dist <= CORRIDOR_TOLERANCE) segmentVisited[i] = true
    }

    if (minDist > CORRIDOR_TOLERANCE) return false
  }

  // Coverage check: trace must visit enough of the solution path
  const visitedCount = segmentVisited.filter(Boolean).length
  if (visitedCount < segmentVisited.length * COVERAGE_THRESHOLD) return false

  return true
}
