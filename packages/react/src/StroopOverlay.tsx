/**
 * Stroop cognitive interference probe overlay.
 *
 * Renders colored cells on top of the maze when triggered.
 * User must tap the cell matching the instruction color.
 * Records reaction time and correctness.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Point, ProbeResponse, StroopProbe } from '@cernosh/core'
import { RENDERING } from '@cernosh/core'

// ── Accessibility: hex-to-name map ──

const colorName = (hex: string): string => {
  const map: Record<string, string> = {
    '#ef4444': 'red', '#3b82f6': 'blue', '#22c55e': 'green',
    '#f59e0b': 'yellow', '#8b5cf6': 'purple', '#ec4899': 'pink',
    '#f97316': 'orange', '#06b6d4': 'cyan',
  }
  return map[hex.toLowerCase()] ?? 'colored'
}

// ── Countdown keyframes injection ──

const PROBE_COUNTDOWN_KEYFRAMES = `@keyframes cerno-probe-countdown {
  0% { width: 100%; background: #2dd4bf; }
  60% { background: #f59e0b; }
  80% { background: #ef4444; }
  100% { width: 0%; background: #ef4444; }
}`

let probeStylesInjected = false
function injectProbeStyles() {
  if (probeStylesInjected || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.textContent = PROBE_COUNTDOWN_KEYFRAMES
  document.head.appendChild(style)
  probeStylesInjected = true
}

/** Deterministic shape-color pairing for accessibility.
 *  Each color always maps to the same shape, so colorblind users
 *  can identify buttons by shape. Sighted users use color (faster). */
const SHAPE_BY_COLOR: Record<string, string> = {
  red: 'square', blue: 'circle', green: 'triangle',
  yellow: 'diamond', purple: 'star', pink: 'hexagon',
  orange: 'hexagon', cyan: 'circle',
}

type ShapeType = 'circle' | 'square' | 'triangle' | 'diamond' | 'star' | 'hexagon'

function shapeForColor(hex: string): ShapeType {
  const name = colorName(hex)
  return (SHAPE_BY_COLOR[name] as ShapeType) ?? 'circle'
}

export interface StroopOverlayProps {
  probe: StroopProbe
  mazeWidth: number
  mazeHeight: number
  cellSize: number
  theme: 'light' | 'dark'
  onComplete: (response: ProbeResponse) => void
  /** Mouse collector start time (performance.now() base) for K-H1 probe_shown_at */
  collectorStartTime?: number
  /** Image mode: PNG maze has margins baked in, skip adding them to overlay dimensions */
  imageMode?: boolean
}

export function StroopOverlay({
  probe,
  mazeWidth,
  mazeHeight,
  cellSize,
  theme,
  onComplete,
  collectorStartTime,
  imageMode = false,
}: StroopOverlayProps) {
  injectProbeStyles()

  const [startTime] = useState(() => performance.now())
  // K-H1: probe_shown_at relative to collector start for motor-stream correlation
  const probeShownAt = collectorStartTime != null && collectorStartTime >= 0
    ? startTime - collectorStartTime
    : undefined
  const completedRef = useRef(false)

  const margin = RENDERING.MARGIN
  const mazePixelW = mazeWidth * cellSize
  const mazePixelH = mazeHeight * cellSize
  const overlayW = imageMode ? mazePixelW : mazePixelW + margin * 2
  const overlayH = imageMode ? mazePixelH + 24 : mazePixelH + margin * 2 + 24

  // E5: minimum 44px touch target
  const buttonSize = Math.max(cellSize * 1.5, 44)

  const handleCellTap = useCallback(
    (cell: { x: number; y: number; color: string }) => {
      if (completedRef.current) return
      completedRef.current = true

      const reactionTime = performance.now() - startTime

      onComplete({
        probe_id: probe.id,
        tapped_cell: { x: cell.x, y: cell.y },
        reaction_time_ms: Math.round(reactionTime),
        probe_shown_at: probeShownAt != null ? Math.round(probeShownAt) : undefined,
      })
    },
    [probe, startTime, onComplete, probeShownAt],
  )

  // Auto-timeout after 5 seconds (fail)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (completedRef.current) return
      completedRef.current = true
      onComplete({
        probe_id: probe.id,
        tapped_cell: { x: -1, y: -1 },
        reaction_time_ms: 5000,
        correct: false,
        probe_shown_at: probeShownAt != null ? Math.round(probeShownAt) : undefined,
      })
    }, 5000)
    return () => clearTimeout(timer)
  }, [probe, onComplete])

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: overlayW,
        height: overlayH,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: theme === 'dark' ? 'rgba(12, 10, 9, 0.9)' : 'rgba(250, 250, 249, 0.9)',
        borderRadius: 'var(--cerno-radius)',
        zIndex: 10,
        pointerEvents: 'none',
      }}
    >
      {/* E3: countdown bar */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        borderRadius: '2px 2px 0 0',
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: '100%',
          background: 'var(--cerno-accent)',
          animation: 'cerno-probe-countdown 5s linear forwards',
        }} />
      </div>

      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          marginBottom: 16,
          color: 'var(--cerno-fg)',
          fontFamily: 'var(--cerno-font)',
        }}
        aria-label="Quick color verification"
      >
        {probe.instruction_svg ? (
          <span dangerouslySetInnerHTML={{ __html: probe.instruction_svg }} />
        ) : (
          probe.instruction
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(probe.cells.length, 3)}, 1fr)`,
          gap: 12,
        }}
      >
        {probe.cells.map((cell) => {
          const shape = shapeForColor(cell.color)
          return (
            <button
              key={`${cell.x}-${cell.y}`}
              type="button"
              aria-label={`${colorName(cell.color)} ${shape}`}
              onClick={() => handleCellTap(cell)}
              style={{
                width: buttonSize,
                height: buttonSize,
                borderRadius: 'var(--cerno-radius)',
                border: '2px solid var(--cerno-border)',
                background: cell.color,
                cursor: 'pointer',
                transition: 'transform 0.1s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'auto',
              }}
              onMouseDown={(e) => {
                (e.target as HTMLElement).style.transform = 'scale(0.95)'
              }}
              onMouseUp={(e) => {
                (e.target as HTMLElement).style.transform = 'scale(1)'
              }}
            >
              <svg width={buttonSize * 0.4} height={buttonSize * 0.4} viewBox="0 0 20 20" style={{ opacity: 0.7, pointerEvents: 'none' }}>
                {shape === 'circle' && <circle cx="10" cy="10" r="8" fill="white" />}
                {shape === 'square' && <rect x="2" y="2" width="16" height="16" fill="white" />}
                {shape === 'triangle' && <polygon points="10,2 18,18 2,18" fill="white" />}
                {shape === 'diamond' && <polygon points="10,1 19,10 10,19 1,10" fill="white" />}
                {shape === 'star' && <polygon points="10,1 12.5,7.5 19,8 14,13 15.5,19 10,15.5 4.5,19 6,13 1,8 7.5,7.5" fill="white" />}
                {shape === 'hexagon' && <polygon points="5,2 15,2 19,10 15,18 5,18 1,10" fill="white" />}
              </svg>
            </button>
          )
        })}
      </div>

      <div
        style={{
          fontSize: 12,
          marginTop: 12,
          color: 'var(--cerno-muted)',
          fontFamily: 'var(--cerno-font)',
        }}
      >
        Quick verification
      </div>
    </div>
  )
}
