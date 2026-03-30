import type { RawEvent } from '@cernosh/core'

export interface MouseCollector {
  start(): void
  stop(): void
  getEvents(): RawEvent[]
  reset(): void
  /** Returns the collector's start time (performance.now() at first event). -1 if no events yet. */
  getStartTime(): number
}

export function createMouseCollector(canvas: HTMLCanvasElement): MouseCollector {
  const events: Array<RawEvent & { pointer_type?: 'mouse' | 'touch' | 'pen' }> = []
  let startTime = -1
  let active = false
  let lastMoveTime = -1
  const MOVE_INTERVAL_MS = 33 // ~30Hz

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
    const pointerType = e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen'
      ? e.pointerType
      : undefined
    events.push({ t: now - startTime, x, y, type, pointer_type: pointerType })
  }

  function recordMove(e: PointerEvent, coalescedCount: number | undefined): void {
    if (!active) return
    const now = performance.now()
    if (startTime < 0) startTime = now
    const { x, y } = normalize(e)
    const pointerType = e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen'
      ? e.pointerType
      : undefined
    const event: import('@cernosh/core').RawEvent = { t: now - startTime, x, y, type: 'move', pointer_type: pointerType }
    if (coalescedCount != null) event.coalesced_count = coalescedCount
    events.push(event)
  }

  function onPointerMove(e: PointerEvent): void {
    const now = e.timeStamp || performance.now()
    if (now - lastMoveTime < MOVE_INTERVAL_MS) return
    lastMoveTime = now
    // K-H2: capture coalesced event count for event coalescing forensics.
    // Only set when the API exists. Omitting lets the server score the feature as NaN
    // (excluded) instead of penalizing unsupported browsers as CDP-like.
    const coalescedApi = (e as any).getCoalescedEvents
    const coalescedCount = typeof coalescedApi === 'function'
      ? Math.max(coalescedApi.call(e)?.length ?? 0, 1)
      : undefined // API unavailable — omit field entirely
    recordMove(e, coalescedCount)
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
      lastMoveTime = -1
    },

    getStartTime() {
      return startTime
    },
  }
}
