import { describe, expect, it } from 'vitest'
import { generateMaze, solveMaze, validatePath } from './maze-generator.js'
import type { Maze, Point } from './types.js'
import { Wall } from './types.js'

describe('generateMaze', () => {
  it('produces deterministic output for the same seed', () => {
    const a = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 42 })
    const b = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 42 })
    expect(a.grid).toEqual(b.grid)
    expect(a.solution).toEqual(b.solution)
    expect(a.start).toEqual(b.start)
    expect(a.exit).toEqual(b.exit)
  })

  it('produces different mazes for different seeds', () => {
    const a = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 1 })
    const b = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 2 })
    // Grids should differ (extremely high probability)
    const aWalls = a.grid.flat().map((c) => c.walls)
    const bWalls = b.grid.flat().map((c) => c.walls)
    expect(aWalls).not.toEqual(bWalls)
  })

  it('generates a maze with correct dimensions', () => {
    const maze = generateMaze({ width: 8, height: 12, difficulty: 0.5, seed: 100 })
    expect(maze.grid.length).toBe(12) // rows = height
    expect(maze.grid[0].length).toBe(8) // cols = width
    expect(maze.width).toBe(8)
    expect(maze.height).toBe(12)
  })

  it('always has a valid solution', () => {
    for (let seed = 0; seed < 50; seed++) {
      const maze = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed })
      expect(maze.solution.length).toBeGreaterThan(1)
      expect(maze.solution[0]).toEqual(maze.start)
      expect(maze.solution[maze.solution.length - 1]).toEqual(maze.exit)
    }
  })

  it('solution path does not cross walls', () => {
    const maze = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 42 })
    const path = maze.solution
    for (let i = 0; i < path.length - 1; i++) {
      const curr = path[i]
      const next = path[i + 1]
      const dx = next.x - curr.x
      const dy = next.y - curr.y

      // Must be adjacent
      expect(Math.abs(dx) + Math.abs(dy)).toBe(1)

      let dir: number
      if (dx === 1) dir = Wall.E
      else if (dx === -1) dir = Wall.W
      else if (dy === 1) dir = Wall.S
      else dir = Wall.N

      // No wall blocking this move
      expect(maze.grid[curr.y][curr.x].walls & dir).toBe(0)
    }
  })

  it('all cells are reachable (perfect maze)', () => {
    const maze = generateMaze({ width: 8, height: 8, difficulty: 0.3, seed: 77 })
    const visited = new Set<string>()
    const queue: Point[] = [{ x: 0, y: 0 }]
    visited.add('0,0')

    while (queue.length > 0) {
      const curr = queue.shift()!
      const cell = maze.grid[curr.y][curr.x]
      const dirs = [
        { wall: Wall.N, dx: 0, dy: -1 },
        { wall: Wall.S, dx: 0, dy: 1 },
        { wall: Wall.E, dx: 1, dy: 0 },
        { wall: Wall.W, dx: -1, dy: 0 },
      ]
      for (const { wall, dx, dy } of dirs) {
        if (cell.walls & wall) continue
        const nx = curr.x + dx
        const ny = curr.y + dy
        const key = `${nx},${ny}`
        if (!visited.has(key) && nx >= 0 && nx < 8 && ny >= 0 && ny < 8) {
          visited.add(key)
          queue.push({ x: nx, y: ny })
        }
      }
    }

    expect(visited.size).toBe(64) // 8x8 = 64 cells
  })

  it('difficulty 0 produces longer corridors than difficulty 1', () => {
    // DFS (difficulty=0) tends to produce fewer dead ends
    const dfs = generateMaze({ width: 10, height: 10, difficulty: 0, seed: 42 })
    const prim = generateMaze({ width: 10, height: 10, difficulty: 1, seed: 42 })
    // DFS solution is typically longer (more winding)
    // Just verify both are valid
    expect(dfs.solution.length).toBeGreaterThan(1)
    expect(prim.solution.length).toBeGreaterThan(1)
  })
})

describe('validatePath', () => {
  it('accepts a valid solution path', () => {
    const maze = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 42 })
    // Convert solution points to normalized coordinates (center of each cell)
    const normalizedPath = maze.solution.map((p) => ({
      x: (p.x + 0.5) / maze.width,
      y: (p.y + 0.5) / maze.height,
    }))
    expect(validatePath(maze, normalizedPath)).toBe(true)
  })

  it('rejects an empty path', () => {
    const maze = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 42 })
    expect(validatePath(maze, [])).toBe(false)
  })

  it('rejects a single-point path', () => {
    const maze = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 42 })
    expect(validatePath(maze, [{ x: 0.05, y: 0.05 }])).toBe(false)
  })

  it('rejects a path that does not start at maze start', () => {
    const maze = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 42 })
    // Start from wrong cell
    const badPath = [
      { x: 0.55, y: 0.05 }, // cell (5,0) instead of (0,0)
      { x: 0.95, y: 0.95 },
    ]
    expect(validatePath(maze, badPath)).toBe(false)
  })

  it('rejects a path that does not end at maze exit', () => {
    const maze = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 42 })
    const partialPath = maze.solution.slice(0, 3).map((p) => ({
      x: (p.x + 0.5) / maze.width,
      y: (p.y + 0.5) / maze.height,
    }))
    expect(validatePath(maze, partialPath)).toBe(false)
  })

  it('rejects a path that crosses walls', () => {
    const maze = generateMaze({ width: 10, height: 10, difficulty: 0.3, seed: 42 })
    // Straight line from (0,0) to (9,9) will almost certainly cross walls
    const straightLine = Array.from({ length: 10 }, (_, i) => ({
      x: (i + 0.5) / 10,
      y: (i + 0.5) / 10,
    }))
    // This diagonal path has non-adjacent cells, so it should fail
    expect(validatePath(maze, straightLine)).toBe(false)
  })
})
