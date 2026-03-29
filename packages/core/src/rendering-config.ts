import type { RawEvent } from './types.js'

export const RENDERING = {
  CELL_SIZE: 40,
  WALL_THICKNESS: 2,
  MARGIN: 20,
  START_COLOR: '#22c55e',
  EXIT_COLOR: '#ef4444',
  PATH_COLOR: '#3b82f6',
  WALL_COLOR: '#1e293b',
  BG_COLOR: '#f8fafc',
  DARK_BG_COLOR: '#0f172a',
  DARK_WALL_COLOR: '#cbd5e1',
  MARKER_RADIUS: 12,
  PATH_WIDTH: 3,
  CURSOR_COLOR: '#8b5cf6',
} as const

/**
 * Height of the instruction text area below the maze grid in the canvas.
 * MazeCanvas adds this to the logical canvas height.
 */
const INSTRUCTION_TEXT_HEIGHT = 24

/**
 * Convert canvas-normalized coordinates (0-1 of full canvas including margins
 * and instruction text) to maze-grid-normalized coordinates (0-1 of maze area).
 *
 * The mouse collector normalizes to the full canvas rect, but validatePath and
 * extractFeatures expect coordinates normalized to just the maze grid.
 */
export function renormalizeEvents(
  events: RawEvent[],
  mazeWidth: number,
  mazeHeight: number,
  cellSize: number = RENDERING.CELL_SIZE,
): RawEvent[] {
  const margin = RENDERING.MARGIN
  const mazePixelW = mazeWidth * cellSize
  const mazePixelH = mazeHeight * cellSize
  const canvasW = mazePixelW + margin * 2
  const canvasH = mazePixelH + margin * 2 + INSTRUCTION_TEXT_HEIGHT

  return events.map((e) => ({
    ...e,
    x: Math.max(0, Math.min(1, (e.x * canvasW - margin) / mazePixelW)),
    y: Math.max(0, Math.min(1, (e.y * canvasH - margin) / mazePixelH)),
  }))
}
