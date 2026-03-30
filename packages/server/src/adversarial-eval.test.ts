import { describe, it, expect } from 'vitest'
import { generateMaze, extractFeatures, computeMazeProfile } from '@cernosh/core'
import type { Maze, RawEvent } from '@cernosh/core'
import { scoreBehavior } from './behavioral-scoring.js'
import { extractSecretFeatures, scoreSecretFeatures } from './secret-features.js'
import {
  generateSyntheticHumanTrace,
  generateSyntheticBotTrace,
  computeROC,
  type BotStrategy,
} from './calibration.js'

// ── Helpers ──

function blendScore(events: RawEvent[], maze: Maze): number {
  const profile = computeMazeProfile(maze)
  const features = extractFeatures(events)
  const { score: publicScore } = scoreBehavior(features, profile)
  const secretFeatures = extractSecretFeatures(events)
  const { score: secretScore } = scoreSecretFeatures(secretFeatures)
  return publicScore * 0.7 + secretScore * 0.3
}

function publicOnlyScore(events: RawEvent[], maze: Maze): number {
  const profile = computeMazeProfile(maze)
  const features = extractFeatures(events)
  return scoreBehavior(features, profile).score
}

// ── Test Maze ──

const maze = generateMaze({ width: 7, height: 7, difficulty: 0.3, seed: 42 })

describe('adversarial evaluation', () => {
  // Generate traces once for the suite
  const humanTraces: RawEvent[][] = []
  const botTraces: RawEvent[][] = []
  const botStrategies: BotStrategy[] = ['S1', 'S2', 'S3', 'S4', 'S5_score_search']

  // 200 human traces with varying parameters
  for (let i = 0; i < 200; i++) {
    const speedMultiplier = 0.5 + (i % 10) * 0.15 // 0.5 to 1.85
    const pauseProbability = 0.1 + (i % 7) * 0.12 // 0.1 to 0.82
    const onsetMin = 150 + (i % 5) * 50  // 150 to 350
    const onsetMax = onsetMin + 400

    humanTraces.push(
      generateSyntheticHumanTrace(maze, {
        speedMultiplier,
        pauseProbability,
        onsetRange: [onsetMin, onsetMax],
        seed: 1000 + i,
      }),
    )
  }

  // 250 bot traces: 50 each of S1-S4, S5_score_search
  for (let i = 0; i < 250; i++) {
    const strategy = botStrategies[Math.floor(i / 50)]
    botTraces.push(generateSyntheticBotTrace(maze, strategy, 5000 + i))
  }

  // Score all traces
  const humanScores = humanTraces.map((t) => blendScore(t, maze))
  const botScores = botTraces.map((t) => blendScore(t, maze))

  // S1-S4 scores only (exclude S5 which is designed to evade)
  const s1s4BotScores = botScores.slice(0, 200)

  it('achieves >90% TPR and <5% FPR at threshold 0.6 (S1-S4)', () => {
    const { points, auc } = computeROC(humanScores, s1s4BotScores)

    // Find the point closest to threshold 0.6
    const point06 = points.find((p) => Math.abs(p.threshold - 0.6) < 0.001)
    expect(point06).toBeDefined()

    console.log('\n--- ROC at threshold 0.6 (S1-S4) ---')
    console.log(`  TPR: ${(point06!.tpr * 100).toFixed(1)}%`)
    console.log(`  FPR: ${(point06!.fpr * 100).toFixed(1)}%`)
    console.log(`  AUC: ${auc.toFixed(4)}`)

    // Target: >90% TPR, <5% FPR at threshold 0.6
    expect(point06!.tpr).toBeGreaterThan(0.90)
    expect(point06!.fpr).toBeLessThan(0.05)
  })

  it('feature interaction scoring catches S4 (feature-tuned) bots', () => {
    // Extract S4 bot traces (indices 150-199)
    const s4Traces = botTraces.slice(150, 200)

    // Score with full blend (public + secret = interaction scoring)
    const blendedScores = s4Traces.map((t) => blendScore(t, maze))
    // Score with public only (no interaction scoring from secret features)
    const publicScores = s4Traces.map((t) => publicOnlyScore(t, maze))

    const threshold = 0.6
    const caughtWithBlend = blendedScores.filter((s) => s < threshold).length
    const caughtWithPublicOnly = publicScores.filter((s) => s < threshold).length

    console.log('\n--- S4 bot detection ---')
    console.log(`  Caught with blend (public+secret): ${caughtWithBlend}/50`)
    console.log(`  Caught with public only:           ${caughtWithPublicOnly}/50`)

    // Secret features should catch MORE S4 bots than public alone
    // (or at least as many, since S4 is specifically designed to match public baselines)
    expect(caughtWithBlend).toBeGreaterThanOrEqual(caughtWithPublicOnly)
  })

  it('prints ROC summary table (S1-S4)', () => {
    const keyThresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
    const { points, auc } = computeROC(humanScores, s1s4BotScores, keyThresholds)

    console.log('\n--- ROC Summary Table (S1-S4) ---')
    console.log('  Threshold |  TPR   |  FPR   ')
    console.log('  ----------|--------|--------')
    for (const p of points) {
      console.log(
        `     ${p.threshold.toFixed(1)}    | ${(p.tpr * 100).toFixed(1).padStart(5)}% | ${(p.fpr * 100).toFixed(1).padStart(5)}%`,
      )
    }
    console.log(`  AUC: ${auc.toFixed(4)}`)

    // AUC should be strong (>0.90)
    expect(auc).toBeGreaterThan(0.90)

    // TPR at low threshold should be perfect
    const low = points.find((p) => p.threshold === 0.3)
    expect(low!.tpr).toBeGreaterThan(0.95)
  })

  it('S5 score-search bots evade public scorer but secret features add resistance', () => {
    // S5 traces are indices 200-249
    const s5Traces = botTraces.slice(200, 250)

    const s5BlendedScores = s5Traces.map((t) => blendScore(t, maze))
    const s5PublicScores = s5Traces.map((t) => publicOnlyScore(t, maze))

    const threshold = 0.6
    const passPublic = s5PublicScores.filter((s) => s >= threshold).length
    const passBlended = s5BlendedScores.filter((s) => s >= threshold).length

    const publicMean = s5PublicScores.reduce((a, b) => a + b, 0) / s5PublicScores.length
    const blendedMean = s5BlendedScores.reduce((a, b) => a + b, 0) / s5BlendedScores.length

    console.log('\n--- S5 score-search attack ---')
    console.log(`  Public mean:  ${publicMean.toFixed(4)}`)
    console.log(`  Blended mean: ${blendedMean.toFixed(4)}`)
    console.log(`  Pass public (>=${threshold}):  ${passPublic}/50`)
    console.log(`  Pass blended (>=${threshold}): ${passBlended}/50`)

    // S5 should achieve high public scores (it optimizes for them)
    expect(publicMean).toBeGreaterThan(0.6)

    // Secret features should pull the blended score down relative to public
    // (or at minimum not inflate it)
    expect(blendedMean).toBeLessThanOrEqual(publicMean)
  })

  it('human score distribution is higher than bot score distribution', () => {
    const humanMean = humanScores.reduce((a, b) => a + b, 0) / humanScores.length
    const botMean = botScores.reduce((a, b) => a + b, 0) / botScores.length

    console.log('\n--- Score Distributions ---')
    console.log(`  Human mean: ${humanMean.toFixed(4)}`)
    console.log(`  Bot mean:   ${botMean.toFixed(4)}`)
    console.log(`  Separation: ${(humanMean - botMean).toFixed(4)}`)

    // Per-strategy breakdown
    for (let si = 0; si < botStrategies.length; si++) {
      const stratScores = botScores.slice(si * 50, (si + 1) * 50)
      const mean = stratScores.reduce((a, b) => a + b, 0) / stratScores.length
      console.log(`  ${botStrategies[si]} mean: ${mean.toFixed(4)}`)
    }

    expect(humanMean).toBeGreaterThan(botMean)
  })
})
