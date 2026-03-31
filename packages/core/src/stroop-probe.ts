/**
 * Stroop cognitive interference probes (Phase 3).
 *
 * The Stroop effect: naming the color of a word is slower when the word
 * itself names a different color. This tests cognitive presence, not
 * physical capability. An AI agent must actually "think" to solve it,
 * and doing so at human-like reaction times is extremely hard.
 *
 * World.org asks "do you have an iris?" (hardware presence).
 * Cerno asks "are you thinking right now?" (cognitive presence).
 * That's the unfair advantage.
 */
import type { Maze, Point, StroopProbe } from './types.js'
import { Wall } from './types.js'

const PROBE_COLORS = [
  { name: 'blue', hex: '#3b82f6', shape: 'circle' },
  { name: 'red', hex: '#ef4444', shape: 'square' },
  { name: 'green', hex: '#22c55e', shape: 'triangle' },
  { name: 'yellow', hex: '#eab308', shape: 'diamond' },
  { name: 'purple', hex: '#a855f7', shape: 'star' },
  { name: 'orange', hex: '#f97316', shape: 'hexagon' },
] as const

/**
 * Generate a Stroop probe for a given maze.
 * Places colored cells near a decision point in the solution path.
 * The user must tap the cell matching the instruction color.
 *
 * @param maze - The maze to probe
 * @param rand - Seeded random function for deterministic generation
 * @param probeId - Unique probe ID
 */
export function generateStroopProbe(
  maze: Maze,
  rand: () => number,
  probeId: string,
): StroopProbe | null {
  const solution = maze.solution
  if (solution.length < 6) return null // maze too small for probes

  // Pick a trigger cell ~40-60% through the solution path
  const triggerIdx = Math.floor(solution.length * (0.4 + rand() * 0.2))
  const triggerCell = solution[triggerIdx]

  // Pick target color
  const targetIdx = Math.floor(rand() * PROBE_COLORS.length)
  const targetColor = PROBE_COLORS[targetIdx]

  // Pick 2-3 distractor colors (different from target)
  const distractorCount = 2 + Math.floor(rand() * 2) // 2 or 3
  const available = PROBE_COLORS.filter((_, i) => i !== targetIdx)
  const distractors: Array<typeof PROBE_COLORS[number]> = []
  for (let i = 0; i < distractorCount && available.length > 0; i++) {
    const idx = Math.floor(rand() * available.length)
    distractors.push(available.splice(idx, 1)[0])
  }

  // Place colored cells in a grid near the trigger point
  // Find cells adjacent to the trigger that are IN the maze (open passages)
  const candidates = findAdjacentOpenCells(maze, triggerCell, 3 + distractorCount)
  if (candidates.length < 1 + distractorCount) {
    // Not enough space for probes, skip
    return null
  }

  // Assign colors: one target, rest distractors
  const shuffled = shuffleArray(candidates, rand)
  const cells: StroopProbe['cells'] = []

  // Target cell
  cells.push({
    x: shuffled[0].x,
    y: shuffled[0].y,
    color: targetColor.hex,
    isTarget: true,
  })

  // Distractor cells
  for (let i = 0; i < distractors.length && i + 1 < shuffled.length; i++) {
    cells.push({
      x: shuffled[i + 1].x,
      y: shuffled[i + 1].y,
      color: distractors[i].hex,
      isTarget: false,
    })
  }

  // Shuffle cells so target isn't always at index 0
  const shuffledCells = shuffleArray(cells, rand)

  // Vary instruction phrasing so regex matching isn't trivial
  const verbs = ['Tap', 'Select', 'Find', 'Touch', 'Pick']
  const verb = verbs[Math.floor(rand() * verbs.length)]

  return {
    id: probeId,
    type: 'color_tap',
    instruction: `${verb} the ${targetColor.name} button`,
    target_color: targetColor.hex,
    distractor_colors: distractors.map((d) => d.hex),
    cells: shuffledCells,
    trigger_cell: triggerCell,
  }
}

function findAdjacentOpenCells(maze: Maze, center: Point, count: number): Point[] {
  const result: Point[] = []
  const visited = new Set<string>()
  const queue: Point[] = [center]
  visited.add(`${center.x},${center.y}`)

  const directions = [
    { dx: 0, dy: -1, wall: Wall.N }, // N
    { dx: 0, dy: 1, wall: Wall.S },  // S
    { dx: 1, dy: 0, wall: Wall.E },  // E
    { dx: -1, dy: 0, wall: Wall.W }, // W
  ]

  // BFS from center, only traversing open passages (no walls between cells)
  while (queue.length > 0 && result.length < count) {
    const current = queue.shift()!
    // Exclude the trigger cell (center) from candidates
    if (current.x !== center.x || current.y !== center.y) {
      result.push(current)
    }

    const cell = maze.grid[current.y][current.x]

    for (const { dx, dy, wall } of directions) {
      const nx = current.x + dx
      const ny = current.y + dy
      const key = `${nx},${ny}`
      if (
        nx >= 0 && nx < maze.width &&
        ny >= 0 && ny < maze.height &&
        !visited.has(key) &&
        !(cell.walls & wall) // No wall in this direction
      ) {
        visited.add(key)
        queue.push({ x: nx, y: ny })
      }
    }
  }

  return result
}

function shuffleArray<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
