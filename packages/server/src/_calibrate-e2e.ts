/**
 * E2E calibration: human traces + bot traces through full pipeline.
 * Run with: cd packages/server && npx tsx src/_calibrate-e2e.ts
 */
import { generateMaze, computeMazeProfile, extractFeatures, validatePath } from '@cernosh/core'
import type { Maze, Point, RawEvent } from '@cernosh/core'
import { generateSyntheticHumanTrace } from './test-utils.js'
import { extractSecretFeatures, scoreSecretFeatures } from './secret-features.js'
import { scoreBehavior } from './behavioral-scoring.js'
import { PUBLIC_SCORE_WEIGHT, SECRET_SCORE_WEIGHT } from './scoring-constants.js'

const TRIALS = 200
const THRESHOLD = 0.72
const CONFIGS = [
  { width: 6, height: 6, difficulty: 0.2 },
  { width: 8, height: 8, difficulty: 0.4 },
  { width: 10, height: 10, difficulty: 0.6 },
]

function mulberry32(s: number) {
  let x = s | 0
  return () => { x = (x + 0x6d2b79f5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function cellToNorm(p: Point, maze: Maze) {
  return { x: (p.x + 0.5) / maze.width, y: (p.y + 0.5) / maze.height }
}

function generateBotTrace(maze: Maze, variant: 'naive' | 'jittered' | 'tuned', seed: number): RawEvent[] {
  const path = maze.solution
  const events: RawEvent[] = []
  const rand = mulberry32(seed)
  let t = 0
  const start = cellToNorm(path[0], maze)
  events.push({ t: 0, x: start.x, y: start.y, type: 'down' })

  if (variant === 'naive') {
    for (let i = 1; i < path.length; i++) {
      const from = cellToNorm(path[i - 1], maze)
      const to = cellToNorm(path[i], maze)
      for (let s = 1; s <= 8; s++) {
        t += 16
        events.push({ t, x: from.x + (to.x - from.x) * s / 8, y: from.y + (to.y - from.y) * s / 8, type: 'move' })
      }
    }
  } else if (variant === 'jittered') {
    for (let i = 1; i < path.length; i++) {
      const from = cellToNorm(path[i - 1], maze)
      const to = cellToNorm(path[i], maze)
      const steps = 8 + Math.floor(rand() * 4)
      for (let s = 1; s <= steps; s++) {
        t += 12 + rand() * 10
        events.push({ t, x: from.x + (to.x - from.x) * s / steps + (rand() - 0.5) * 0.002, y: from.y + (to.y - from.y) * s / steps + (rand() - 0.5) * 0.002, type: 'move' })
      }
    }
  } else {
    // Tuned bot: variable speed, pauses, larger noise
    const onset = 200 + rand() * 400
    for (let i = 0; i < 10; i++) {
      t += onset / 10
      events.push({ t, x: start.x + (rand() - 0.5) * 0.003, y: start.y + (rand() - 0.5) * 0.003, type: 'move' })
    }
    for (let i = 1; i < path.length; i++) {
      const from = cellToNorm(path[i - 1], maze)
      const to = cellToNorm(path[i], maze)
      if (rand() < 0.3) {
        const pauseSteps = Math.floor((100 + rand() * 300) / 20)
        for (let p = 0; p < pauseSteps; p++) {
          t += 15 + rand() * 10
          events.push({ t, x: from.x + (rand() - 0.5) * 0.004, y: from.y + (rand() - 0.5) * 0.004, type: 'move' })
        }
      }
      const speed = 0.6 + rand() * 0.8
      const steps = Math.max(6, Math.round(10 / speed))
      for (let s = 1; s <= steps; s++) {
        t += Math.max(8, 10 + rand() * 20 + Math.sin(s * 0.5) * 3)
        events.push({
          t,
          x: Math.max(0, Math.min(1, from.x + (to.x - from.x) * s / steps + (rand() - 0.5) * 0.005)),
          y: Math.max(0, Math.min(1, from.y + (to.y - from.y) * s / steps + (rand() - 0.5) * 0.005)),
          type: 'move',
        })
      }
    }
  }

  const exitNorm = cellToNorm(path[path.length - 1], maze)
  events.push({ t: t + 20, x: exitNorm.x, y: exitNorm.y, type: 'up' })
  return events
}

type TraceType = 'human' | 'naive' | 'jittered' | 'tuned'

function runCalibration(traceType: TraceType) {
  let passes = 0
  let pathPasses = 0
  const scores: number[] = []
  const publicScores: number[] = []
  const secretScores: number[] = []

  for (let trial = 0; trial < TRIALS; trial++) {
    const config = CONFIGS[trial % CONFIGS.length]
    const maze = generateMaze({ ...config, seed: trial })
    const profile = computeMazeProfile(maze)

    const events = traceType === 'human'
      ? generateSyntheticHumanTrace(maze, { seed: trial * 7 + 13 })
      : generateBotTrace(maze, traceType, trial * 13 + 7)

    if (events.length < 10) { continue }

    const pathPoints = events.filter(e => e.type === 'move' || e.type === 'down').map(e => ({ x: e.x, y: e.y }))
    if (validatePath(maze, pathPoints)) pathPasses++

    const features = extractFeatures(events)
    const { score: pubScore } = scoreBehavior(features, profile, 'mouse')
    const secretFeatures = extractSecretFeatures(events)
    const { score: secScore, zScores } = scoreSecretFeatures(secretFeatures, 'mouse')
    const combined = pubScore * PUBLIC_SCORE_WEIGHT + secScore * SECRET_SCORE_WEIGHT

    scores.push(combined)
    publicScores.push(pubScore)
    secretScores.push(secScore)
    if (combined >= THRESHOLD) passes++
  }

  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
  const passRate = passes / TRIALS
  console.log(`\n=== ${traceType.toUpperCase()} (${TRIALS} traces, threshold=${THRESHOLD}) ===`)
  console.log(`Path valid: ${pathPasses}/${TRIALS}  |  Score pass: ${passes}/${TRIALS} = ${(passRate * 100).toFixed(1)}%`)
  console.log(`Public:   mean=${mean(publicScores).toFixed(4)} [${Math.min(...publicScores).toFixed(4)}, ${Math.max(...publicScores).toFixed(4)}]`)
  console.log(`Secret:   mean=${mean(secretScores).toFixed(4)} [${Math.min(...secretScores).toFixed(4)}, ${Math.max(...secretScores).toFixed(4)}]`)
  console.log(`Combined: mean=${mean(scores).toFixed(4)} [${Math.min(...scores).toFixed(4)}, ${Math.max(...scores).toFixed(4)}]`)

  if (traceType === 'human') {
    console.log(`${passRate >= 0.90 ? '✅' : '❌'} Human TPR: target >90%, got ${(passRate * 100).toFixed(1)}%`)
  } else {
    console.log(`${passes === 0 ? '✅' : '❌'} Bot FPR: target 0%, got ${(passRate * 100).toFixed(1)}% (${passes} passed)`)
  }
  return { passRate, passes }
}

console.log('════════════════════════════════════════════════════════════')
console.log('  K1 CALIBRATION REPORT — Behavioral Scoring Engine')
console.log('  Weights: public=' + PUBLIC_SCORE_WEIGHT + ' secret=' + SECRET_SCORE_WEIGHT)
console.log('  Threshold: ' + THRESHOLD)
console.log('════════════════════════════════════════════════════════════')

const human = runCalibration('human')
const naive = runCalibration('naive')
const jittered = runCalibration('jittered')
const tuned = runCalibration('tuned')

console.log('\n════════════════════════════════════════════════════════════')
console.log('  SUMMARY')
console.log('════════════════════════════════════════════════════════════')
console.log(`  Human TPR:         ${(human.passRate * 100).toFixed(1)}%  ${human.passRate >= 0.90 ? '✅' : '❌'}`)
console.log(`  Naive bot reject:  ${((1 - naive.passRate) * 100).toFixed(1)}%  ${naive.passes === 0 ? '✅' : '❌'}`)
console.log(`  Jitter bot reject: ${((1 - jittered.passRate) * 100).toFixed(1)}%  ${jittered.passes === 0 ? '✅' : '❌'}`)
console.log(`  Tuned bot reject:  ${((1 - tuned.passRate) * 100).toFixed(1)}%  ${tuned.passes === 0 ? '✅' : '❌'}`)
console.log('════════════════════════════════════════════════════════════')
