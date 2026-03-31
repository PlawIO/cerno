import 'dotenv/config'
import express from 'express'
import { createChallenge, validateSubmission, verifyToken, MemoryStore } from '@cernosh/server'
import { generateMaze, validatePath } from '../packages/server/node_modules/@cernosh/core/dist/index.js'

const app = express()
app.use(express.json({ limit: '2mb' }))

const store = new MemoryStore()
const config = {
  secret: process.env.CERNO_SECRET,
  store,
}

let lastVerifyResult = null
let lastChallenge = null
let lastEvents = null
let lastStoredChallenge = null


// Cerno widget hits these two
app.post('/api/captcha/challenge', async (req, res) => {
  try {
    const challenge = await createChallenge(config, { site_key: req.body.site_key })
    lastChallenge = { id: challenge.id, site_key: challenge.site_key, expires_at: challenge.expires_at, payload: `${challenge.id}:${challenge.site_key}:${challenge.expires_at}` }
    res.json(challenge)
  } catch (err) {
    console.error('challenge error:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/captcha/verify', async (req, res) => {
  try {
    const { events: _ev, ...meta } = req.body
    lastEvents = { count: _ev?.length, first5: _ev?.slice(0, 5), last3: _ev?.slice(-3), raw: _ev }
    const storedChallenge = await store.getChallenge(req.body.challenge_id)
    lastStoredChallenge = storedChallenge
    const serverPayload = storedChallenge
      ? `${storedChallenge.id}:${storedChallenge.site_key}:${storedChallenge.expires_at}`
      : null
    lastVerifyResult = { _pre: { serverPayload, stored_expires_at: storedChallenge?.expires_at, signature: meta.signature, pk: meta.public_key }, ts: new Date().toISOString() }
    const result = await validateSubmission(config, req.body)
    lastVerifyResult = { ...result, serverPayload, signature: meta.signature, public_key: meta.public_key, challenge_id: req.body.challenge_id, ts: new Date().toISOString() }
    res.json(result)
  } catch (err) {
    lastVerifyResult = { threw: err.message, stack: err.stack?.split('\n').slice(0,3).join(' | '), ts: new Date().toISOString() }
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/debug', (req, res) => res.json({ lastVerifyResult, lastChallenge, lastEvents: { count: lastEvents?.count, first5: lastEvents?.first5, last3: lastEvents?.last3 }, lastStoredChallenge }))

app.get('/api/debug/path', (req, res) => {
  if (!lastEvents?.raw || !lastStoredChallenge) {
    return res.json({ error: 'no data yet — solve the maze first' })
  }
  const ch = lastStoredChallenge
  const CELL_SIZE = ch.cell_size ?? 40
  const MARGIN = 20
  const INSTRUCTION_TEXT_HEIGHT = 24
  const mazeWidth = ch.maze_width
  const mazeHeight = ch.maze_height

  // Recreate renormalizeEvents
  const mazePixelW = mazeWidth * CELL_SIZE
  const mazePixelH = mazeHeight * CELL_SIZE
  const canvasW = mazePixelW + MARGIN * 2
  const canvasH = mazePixelH + MARGIN * 2 + INSTRUCTION_TEXT_HEIGHT
  const renormed = lastEvents.raw.map(e => ({
    ...e,
    x: Math.max(0, Math.min(1, (e.x * canvasW - MARGIN) / mazePixelW)),
    y: Math.max(0, Math.min(1, (e.y * canvasH - MARGIN) / mazePixelH)),
  }))

  const maze = generateMaze({ width: mazeWidth, height: mazeHeight, difficulty: ch.maze_difficulty, seed: ch.maze_seed })
  const pathPoints = renormed.filter(e => e.type === 'move' || e.type === 'down').map(e => ({ x: e.x, y: e.y }))
  const cells = pathPoints.map(p => ({
    x: Math.min(Math.floor(p.x * mazeWidth), mazeWidth - 1),
    y: Math.min(Math.floor(p.y * mazeHeight), mazeHeight - 1),
  }))
  const startIdx = cells.findIndex(c => c.x === maze.start.x && c.y === maze.start.y)
  const lastCell = cells[cells.length - 1]
  const valid = validatePath(maze, pathPoints)

  res.json({
    valid,
    maze: { start: maze.start, exit: maze.exit, seed: ch.maze_seed, width: mazeWidth, height: mazeHeight, cell_size: CELL_SIZE },
    eventCount: lastEvents.raw.length,
    pathPointCount: pathPoints.length,
    startIdx,
    firstCell: cells[0],
    lastCell,
    firstRenormed: renormed[0],
    lastRenormed: renormed[renormed.length - 1],
    reachedExit: lastCell?.x === maze.exit.x && lastCell?.y === maze.exit.y,
    cells_sample: cells.slice(0, 10),
  })
})

// Self-test: generate a key pair here, sign a challenge, verify it — proves the crypto path
app.get('/api/debug/crypto-test', async (req, res) => {
  const crypto = globalThis.crypto
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const publicKeyBase64 = btoa(JSON.stringify(jwk))

  const payload = 'test-id:ck_test:1234567890'
  const data = new TextEncoder().encode(payload)
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data)
  const bytes = new Uint8Array(sig)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  const signatureBase64 = btoa(binary)

  // Now verify (same path as validateSubmission)
  try {
    const jwk2 = JSON.parse(atob(publicKeyBase64))
    const pubKey = await crypto.subtle.importKey('jwk', jwk2, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const sigBinary = atob(signatureBase64)
    const sigBytes = new Uint8Array(sigBinary.length)
    for (let i = 0; i < sigBinary.length; i++) sigBytes[i] = sigBinary.charCodeAt(i)
    const data2 = new TextEncoder().encode(payload)
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sigBytes, data2)
    res.json({ valid, publicKeyBase64Length: publicKeyBase64.length, signatureBase64Length: signatureBase64.length })
  } catch (e) {
    res.json({ error: e.message })
  }
})

// Your app's form submission endpoint
app.post('/api/submit', async (req, res) => {
  const { token, sessionId, name, email } = req.body

  const result = await verifyToken(token, {
    secret: process.env.CERNO_SECRET,
    sessionId,
    store,
  })

  if (!result.valid) {
    return res.status(400).json({ error: 'bot check failed', detail: result.error })
  }

  console.log('verified submission:', { name, email, score: result.score })
  res.json({ ok: true })
})

app.listen(3001, () => console.log('server on :3001'))
