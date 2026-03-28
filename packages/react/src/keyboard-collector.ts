import type { Maze, RawEvent } from '@cerno/core'
import { Wall } from '@cerno/core'

export interface KeyboardCollector {
  start(): void
  stop(): void
  getEvents(): RawEvent[]
  reset(): void
  getCursorCell(): { x: number; y: number }
}

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

const KEY_TO_WALL: Record<string, number> = {
  ArrowUp: Wall.N,
  ArrowDown: Wall.S,
  ArrowRight: Wall.E,
  ArrowLeft: Wall.W,
}

const KEY_DX: Record<string, number> = {
  ArrowUp: 0,
  ArrowDown: 0,
  ArrowRight: 1,
  ArrowLeft: -1,
}

const KEY_DY: Record<string, number> = {
  ArrowUp: -1,
  ArrowDown: 1,
  ArrowRight: 0,
  ArrowLeft: 0,
}

export function createKeyboardCollector(maze: Maze): KeyboardCollector {
  const events: RawEvent[] = []
  let startTime = -1
  let active = false
  let cursorX = maze.start.x
  let cursorY = maze.start.y

  function cellToNormalized(cx: number, cy: number): { x: number; y: number } {
    return {
      x: (cx + 0.5) / maze.width,
      y: (cy + 0.5) / maze.height,
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!active || !ARROW_KEYS.has(e.key)) return
    e.preventDefault()

    const now = performance.now()
    if (startTime < 0) startTime = now

    const wall = KEY_TO_WALL[e.key]
    const cell = maze.grid[cursorY][cursorX]

    // Only move if no wall blocks the direction
    if (!(cell.walls & wall)) {
      const nx = cursorX + KEY_DX[e.key]
      const ny = cursorY + KEY_DY[e.key]
      if (nx >= 0 && nx < maze.width && ny >= 0 && ny < maze.height) {
        cursorX = nx
        cursorY = ny
      }
    }

    const { x, y } = cellToNormalized(cursorX, cursorY)
    events.push({ t: now - startTime, x, y, type: 'keydown', key: e.key })
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (!active || !ARROW_KEYS.has(e.key)) return
    e.preventDefault()

    const now = performance.now()
    if (startTime < 0) startTime = now

    const { x, y } = cellToNormalized(cursorX, cursorY)
    events.push({ t: now - startTime, x, y, type: 'keyup', key: e.key })
  }

  return {
    start() {
      active = true
      document.addEventListener('keydown', onKeyDown)
      document.addEventListener('keyup', onKeyUp)
    },

    stop() {
      active = false
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
    },

    getEvents() {
      return events.slice()
    },

    reset() {
      events.length = 0
      startTime = -1
      cursorX = maze.start.x
      cursorY = maze.start.y
    },

    getCursorCell() {
      return { x: cursorX, y: cursorY }
    },
  }
}
