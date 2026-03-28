import { generateMaze, validatePath } from '@cerno/core'
import type { Maze, Point, RawEvent } from '@cerno/core'

export interface MazeValidationResult {
  valid: boolean
  maze: Maze
}

/**
 * Server-side maze validation.
 * Regenerates the maze from the seed and checks the submitted path.
 */
export function validateMazePath(
  mazeSeed: number,
  events: RawEvent[],
  mazeWidth: number,
  mazeHeight: number,
  mazeDifficulty: number,
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

  const valid = validatePath(maze, pathPoints)

  return { valid, maze }
}
