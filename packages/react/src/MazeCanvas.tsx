import { useCallback, useEffect, useRef, useState } from 'react'
import type { Maze, RawEvent } from '@cernosh/core'
import { RENDERING, Wall } from '@cernosh/core'
import { createMouseCollector, type MouseCollector } from './mouse-collector.js'
import { createKeyboardCollector, type KeyboardCollector } from './keyboard-collector.js'

export interface MazeCanvasProps {
  maze: Maze
  theme: 'light' | 'dark'
  onPathComplete: (events: RawEvent[]) => void
  size?: 'normal' | 'compact'
}

interface DragState {
  dragging: boolean
  path: Array<{ x: number; y: number }>
  visitedCells: Set<string>
  currentCell: { x: number; y: number } | null
}

const cellKey = (x: number, y: number) => `${x},${y}`

export function MazeCanvas({ maze, theme, onPathComplete, size = 'normal' }: MazeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mouseCollectorRef = useRef<MouseCollector | null>(null)
  const kbCollectorRef = useRef<KeyboardCollector | null>(null)
  const dragRef = useRef<DragState>({
    dragging: false,
    path: [],
    visitedCells: new Set(),
    currentCell: null,
  })
  const completedRef = useRef(false)
  const [inputMode, setInputMode] = useState<'pointer' | 'keyboard'>('pointer')
  const [canvasSize, setCanvasSize] = useState(0)
  const animFrameRef = useRef(0)

  const cellSize = size === 'compact' ? 28 : RENDERING.CELL_SIZE
  const margin = RENDERING.MARGIN
  const mazePixelW = maze.width * cellSize
  const mazePixelH = maze.height * cellSize
  const logicalW = mazePixelW + margin * 2
  const logicalH = mazePixelH + margin * 2 + 24 // extra for instruction text

  // Coordinate conversions
  const pxToCell = useCallback(
    (px: number, py: number): { x: number; y: number } | null => {
      const cx = Math.floor((px - margin) / cellSize)
      const cy = Math.floor((py - margin) / cellSize)
      if (cx < 0 || cx >= maze.width || cy < 0 || cy >= maze.height) return null
      return { x: cx, y: cy }
    },
    [maze.width, maze.height, cellSize, margin],
  )

  const cellCenter = useCallback(
    (cx: number, cy: number): { px: number; py: number } => ({
      px: margin + cx * cellSize + cellSize / 2,
      py: margin + cy * cellSize + cellSize / 2,
    }),
    [cellSize, margin],
  )

  // Check if two adjacent cells have no wall between them
  const canPass = useCallback(
    (fromX: number, fromY: number, toX: number, toY: number): boolean => {
      const dx = toX - fromX
      const dy = toY - fromY
      if (Math.abs(dx) + Math.abs(dy) !== 1) return false
      let dir: number
      if (dx === 1) dir = Wall.E
      else if (dx === -1) dir = Wall.W
      else if (dy === 1) dir = Wall.S
      else dir = Wall.N
      return !(maze.grid[fromY][fromX].walls & dir)
    },
    [maze],
  )

  // Draw the maze
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const displayW = canvasSize || logicalW
    const scale = displayW / logicalW

    canvas.width = displayW * dpr
    canvas.height = (logicalH * scale) * dpr
    canvas.style.width = `${displayW}px`
    canvas.style.height = `${logicalH * scale}px`

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0)

    const isDark = theme === 'dark'
    const bgColor = isDark ? RENDERING.DARK_BG_COLOR : RENDERING.BG_COLOR
    const wallColor = isDark ? RENDERING.DARK_WALL_COLOR : RENDERING.WALL_COLOR

    // Background
    ctx.fillStyle = bgColor
    ctx.fillRect(0, 0, logicalW, logicalH)

    // Instruction text (on canvas, not DOM)
    ctx.fillStyle = isDark ? '#94a3b8' : '#64748b'
    ctx.font = `${size === 'compact' ? 11 : 13}px system-ui, -apple-system, sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText(
      inputMode === 'keyboard' ? 'Use arrow keys to navigate' : 'Trace the path from green to red',
      logicalW / 2,
      logicalH - 8,
    )

    // Walls
    ctx.strokeStyle = wallColor
    ctx.lineWidth = RENDERING.WALL_THICKNESS
    ctx.lineCap = 'round'

    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const cell = maze.grid[y][x]
        const px = margin + x * cellSize
        const py = margin + y * cellSize

        if (cell.walls & Wall.N) {
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(px + cellSize, py)
          ctx.stroke()
        }
        if (cell.walls & Wall.S) {
          ctx.beginPath()
          ctx.moveTo(px, py + cellSize)
          ctx.lineTo(px + cellSize, py + cellSize)
          ctx.stroke()
        }
        if (cell.walls & Wall.W) {
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(px, py + cellSize)
          ctx.stroke()
        }
        if (cell.walls & Wall.E) {
          ctx.beginPath()
          ctx.moveTo(px + cellSize, py)
          ctx.lineTo(px + cellSize, py + cellSize)
          ctx.stroke()
        }
      }
    }

    // Start marker
    const startCenter = cellCenter(maze.start.x, maze.start.y)
    ctx.fillStyle = RENDERING.START_COLOR
    ctx.beginPath()
    ctx.arc(startCenter.px, startCenter.py, RENDERING.MARKER_RADIUS * (cellSize / RENDERING.CELL_SIZE), 0, Math.PI * 2)
    ctx.fill()

    // Exit marker
    const exitCenter = cellCenter(maze.exit.x, maze.exit.y)
    ctx.fillStyle = RENDERING.EXIT_COLOR
    ctx.beginPath()
    ctx.arc(exitCenter.px, exitCenter.py, RENDERING.MARKER_RADIUS * (cellSize / RENDERING.CELL_SIZE), 0, Math.PI * 2)
    ctx.fill()

    // User's trace path (pointer mode)
    const drag = dragRef.current
    if (drag.path.length > 1) {
      ctx.strokeStyle = RENDERING.PATH_COLOR
      ctx.lineWidth = RENDERING.PATH_WIDTH
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      const first = cellCenter(drag.path[0].x, drag.path[0].y)
      ctx.moveTo(first.px, first.py)
      for (let i = 1; i < drag.path.length; i++) {
        const pt = cellCenter(drag.path[i].x, drag.path[i].y)
        ctx.lineTo(pt.px, pt.py)
      }
      ctx.stroke()
    }

    // Keyboard cursor
    if (inputMode === 'keyboard' && kbCollectorRef.current) {
      const cursor = kbCollectorRef.current.getCursorCell()
      const cc = cellCenter(cursor.x, cursor.y)

      // Draw keyboard path from visited cells
      const kbEvents = kbCollectorRef.current.getEvents()
      if (kbEvents.length > 0) {
        const cellPath: Array<{ x: number; y: number }> = [{ x: maze.start.x, y: maze.start.y }]
        // Rebuild path from keydown events
        let cx = maze.start.x
        let cy = maze.start.y
        for (const ev of kbEvents) {
          if (ev.type === 'keydown') {
            const nx = Math.min(Math.floor(ev.x * maze.width), maze.width - 1)
            const ny = Math.min(Math.floor(ev.y * maze.height), maze.height - 1)
            if (nx !== cx || ny !== cy) {
              cellPath.push({ x: nx, y: ny })
              cx = nx
              cy = ny
            }
          }
        }
        if (cellPath.length > 1) {
          ctx.strokeStyle = RENDERING.PATH_COLOR
          ctx.lineWidth = RENDERING.PATH_WIDTH
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          ctx.beginPath()
          const first = cellCenter(cellPath[0].x, cellPath[0].y)
          ctx.moveTo(first.px, first.py)
          for (let i = 1; i < cellPath.length; i++) {
            const pt = cellCenter(cellPath[i].x, cellPath[i].y)
            ctx.lineTo(pt.px, pt.py)
          }
          ctx.stroke()
        }
      }

      // Cursor circle
      ctx.fillStyle = RENDERING.CURSOR_COLOR
      ctx.globalAlpha = 0.7
      ctx.beginPath()
      ctx.arc(cc.px, cc.py, cellSize * 0.3, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }
  }, [maze, theme, cellSize, margin, logicalW, logicalH, canvasSize, cellCenter, inputMode, size])

  // Resize observer
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        if (w > 0) setCanvasSize(Math.min(w, logicalW))
      }
    })
    observer.observe(container)
    // Set initial size
    setCanvasSize(Math.min(container.clientWidth, logicalW))
    return () => observer.disconnect()
  }, [logicalW])

  // Redraw on any state change
  useEffect(() => {
    draw()
  }, [draw])

  // Set up mouse collector
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const mc = createMouseCollector(canvas)
    mouseCollectorRef.current = mc
    mc.start()

    return () => {
      mc.stop()
      mouseCollectorRef.current = null
    }
  }, [maze])

  // Set up keyboard collector
  useEffect(() => {
    const kb = createKeyboardCollector(maze)
    kbCollectorRef.current = kb
    kb.start()

    return () => {
      kb.stop()
      kbCollectorRef.current = null
    }
  }, [maze])

  // Pointer event handlers for drag path tracking
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (completedRef.current) return
      setInputMode('pointer')

      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const scale = logicalW / rect.width
      const px = (e.clientX - rect.left) * scale
      const py = (e.clientY - rect.top) * scale
      const cell = pxToCell(px, py)
      if (!cell) return

      // Must start on the start cell
      if (cell.x !== maze.start.x || cell.y !== maze.start.y) return

      canvas.setPointerCapture(e.pointerId)
      const drag = dragRef.current
      drag.dragging = true
      drag.path = [{ x: cell.x, y: cell.y }]
      drag.visitedCells = new Set([cellKey(cell.x, cell.y)])
      drag.currentCell = cell
      draw()
    },
    [maze, pxToCell, logicalW, draw],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current
      if (!drag.dragging || completedRef.current) return

      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const scale = logicalW / rect.width
      const px = (e.clientX - rect.left) * scale
      const py = (e.clientY - rect.top) * scale
      const cell = pxToCell(px, py)
      if (!cell || !drag.currentCell) return

      // Same cell, nothing to do
      if (cell.x === drag.currentCell.x && cell.y === drag.currentCell.y) return

      // Must be adjacent and passable
      if (!canPass(drag.currentCell.x, drag.currentCell.y, cell.x, cell.y)) return

      const key = cellKey(cell.x, cell.y)

      // Backtracking: if the new cell is the previous cell in the path, pop
      if (drag.path.length >= 2) {
        const prev = drag.path[drag.path.length - 2]
        if (prev.x === cell.x && prev.y === cell.y) {
          const removed = drag.path.pop()!
          drag.visitedCells.delete(cellKey(removed.x, removed.y))
          drag.currentCell = cell
          draw()
          return
        }
      }

      // Don't allow revisiting cells (except backtracking handled above)
      if (drag.visitedCells.has(key)) return

      drag.path.push({ x: cell.x, y: cell.y })
      drag.visitedCells.add(key)
      drag.currentCell = cell
      draw()

      // Check if reached exit
      if (cell.x === maze.exit.x && cell.y === maze.exit.y) {
        completedRef.current = true
        drag.dragging = false
        const mc = mouseCollectorRef.current
        if (mc) {
          mc.stop()
          onPathComplete(mc.getEvents())
        }
      }
    },
    [maze, pxToCell, canPass, logicalW, draw, onPathComplete],
  )

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current
    if (!drag.dragging) return
    // If they released without reaching exit, reset the path
    drag.dragging = false
    drag.path = []
    drag.visitedCells.clear()
    drag.currentCell = null
    draw()
  }, [draw])

  // Keyboard mode: watch for arrow key presses and check exit
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (completedRef.current) return
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
      setInputMode('keyboard')

      // Schedule a redraw + exit check after the keyboard collector processes
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = requestAnimationFrame(() => {
        draw()
        const kb = kbCollectorRef.current
        if (kb) {
          const cursor = kb.getCursorCell()
          if (cursor.x === maze.exit.x && cursor.y === maze.exit.y) {
            completedRef.current = true
            kb.stop()
            onPathComplete(kb.getEvents())
          }
        }
      })
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      cancelAnimationFrame(animFrameRef.current)
    }
  }, [maze, draw, onPathComplete])

  // Reset completed flag when maze changes
  useEffect(() => {
    completedRef.current = false
    const drag = dragRef.current
    drag.dragging = false
    drag.path = []
    drag.visitedCells.clear()
    drag.currentCell = null
  }, [maze])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', maxWidth: logicalW, touchAction: 'none' }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          display: 'block',
          cursor: 'crosshair',
          touchAction: 'none',
        }}
        tabIndex={0}
      />
    </div>
  )
}
