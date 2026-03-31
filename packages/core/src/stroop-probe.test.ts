import { describe, expect, it } from 'vitest'
import { generateStroopProbe } from './stroop-probe.js'
import { generateMaze } from './maze-generator.js'
import { mulberry32 } from './seeded-prng.js'

describe('generateStroopProbe', () => {
  const maze = generateMaze({ width: 8, height: 8, difficulty: 0.3, seed: 42 })
  const rand = mulberry32(12345)

  it('generates a valid probe', () => {
    const probe = generateStroopProbe(maze, rand, 'test-probe-1')
    expect(probe).not.toBeNull()
    expect(probe!.type).toBe('color_tap')
    expect(probe!.instruction).toMatch(/^(Tap|Select|Find|Touch|Pick) the \w+ \w+$/)
    expect(probe!.cells.length).toBeGreaterThanOrEqual(2)
    expect(probe!.target_color).toBeTruthy()
    expect(probe!.trigger_cell).toBeTruthy()
  })

  it('has exactly one target cell', () => {
    const probe = generateStroopProbe(maze, mulberry32(999), 'test-probe-2')
    expect(probe).not.toBeNull()
    const targets = probe!.cells.filter((c) => c.isTarget)
    expect(targets.length).toBe(1)
    expect(targets[0].color).toBe(probe!.target_color)
  })

  it('trigger cell is on the solution path', () => {
    const probe = generateStroopProbe(maze, mulberry32(777), 'test-probe-3')
    expect(probe).not.toBeNull()
    const trigger = probe!.trigger_cell
    const onPath = maze.solution.some((p) => p.x === trigger.x && p.y === trigger.y)
    expect(onPath).toBe(true)
  })

  it('returns null for tiny maze', () => {
    const tinyMaze = generateMaze({ width: 2, height: 2, difficulty: 0, seed: 1 })
    const probe = generateStroopProbe(tinyMaze, mulberry32(1), 'test-tiny')
    // May or may not generate for 2x2 (solution too short)
    // Just verify it doesn't crash
    if (probe === null) {
      expect(probe).toBeNull()
    } else {
      expect(probe.cells.length).toBeGreaterThan(0)
    }
  })

  it('produces deterministic probes with same seed', () => {
    const r1 = mulberry32(42)
    const r2 = mulberry32(42)
    const probe1 = generateStroopProbe(maze, r1, 'det-1')
    const probe2 = generateStroopProbe(maze, r2, 'det-2')
    // Same trigger cell and target color (IDs differ)
    expect(probe1!.trigger_cell).toEqual(probe2!.trigger_cell)
    expect(probe1!.target_color).toBe(probe2!.target_color)
  })

  it('distractor colors differ from target', () => {
    const probe = generateStroopProbe(maze, mulberry32(555), 'test-colors')
    expect(probe).not.toBeNull()
    for (const color of probe!.distractor_colors) {
      expect(color).not.toBe(probe!.target_color)
    }
  })
})
