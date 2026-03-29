import type { RawEvent } from '@cernosh/core'

export interface MouseCollector {
  start(): void
  stop(): void
  getEvents(): RawEvent[]
  reset(): void
}

export function createMouseCollector(canvas: HTMLCanvasElement): MouseCollector {
  const events: RawEvent[] = []
  let startTime = -1
  let active = false

  function normalize(e: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    }
  }

  function record(e: PointerEvent, type: RawEvent['type']): void {
    if (!active) return
    const now = performance.now()
    if (startTime < 0) startTime = now
    const { x, y } = normalize(e)
    events.push({ t: now - startTime, x, y, type })
  }

  function onPointerMove(e: PointerEvent): void {
    record(e, 'move')
  }

  function onPointerDown(e: PointerEvent): void {
    record(e, 'down')
  }

  function onPointerUp(e: PointerEvent): void {
    record(e, 'up')
  }

  return {
    start() {
      active = true
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointerup', onPointerUp)
    },

    stop() {
      active = false
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
    },

    getEvents() {
      return events.slice()
    },

    reset() {
      events.length = 0
      startTime = -1
    },
  }
}
