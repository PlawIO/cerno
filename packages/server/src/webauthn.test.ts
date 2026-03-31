import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  RawEvent,
  WebAuthnAuthenticationResponseJSON,
  WebAuthnRegistrationResponseJSON,
} from '@cernosh/core'
import { generateMaze, RENDERING } from '@cernosh/core'
import { createChallenge, validateSubmission } from './validate.js'
import { completeWebAuthnRegistration, verifyWebAuthnAuthentication } from './webauthn.js'
import { MemoryStore } from './store.js'
import { generateSyntheticHumanTrace } from './test-utils.js'
import type { ServerConfig } from './types.js'

const INSTRUCTION_TEXT_HEIGHT = 24

interface WebAuthnFixture {
  rpId: string
  origin: string
  stableId: string
  siteKey: string
  registrationChallenge: string
  authenticationChallenge: string
  registrationResponse: WebAuthnRegistrationResponseJSON
  authenticationResponse: WebAuthnAuthenticationResponseJSON
}

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/webauthn.json', import.meta.url), 'utf8'),
) as WebAuthnFixture

type VerifiedAuthenticationResponse = Parameters<typeof verifyWebAuthnAuthentication>[4]

function fixtureAuthenticationResponse(): VerifiedAuthenticationResponse {
  return {
    ...fixture.authenticationResponse,
    authenticatorAttachment:
      fixture.authenticationResponse.authenticatorAttachment ?? undefined,
    clientExtensionResults: fixture.authenticationResponse.clientExtensionResults ?? {},
    response: {
      ...fixture.authenticationResponse.response,
      userHandle: fixture.authenticationResponse.response.userHandle ?? undefined,
    },
  }
}

async function generateTestKeyPair(): Promise<{
  publicKeyBase64: string
  privateKey: CryptoKey
}> {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const publicKeyBase64 = btoa(JSON.stringify(jwk))
  return { publicKeyBase64, privateKey: keyPair.privateKey }
}

async function signChallengeId(
  bindingPayload: string,
  privateKey: CryptoKey,
): Promise<string> {
  const data = new TextEncoder().encode(bindingPayload)
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    data,
  )
  const bytes = new Uint8Array(signature)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

async function computeEventsDigest(
  events: Array<{ t: number; x: number; y: number; type: string; pointer_type?: string | null; coalesced_count?: number | null }>,
): Promise<string> {
  const canonical = JSON.stringify(events.map(e => [e.t, e.x, e.y, e.type, e.pointer_type ?? null, e.coalesced_count ?? null]))
  const bytes = new TextEncoder().encode(canonical)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const arr = new Uint8Array(digest)
  let hex = ''
  for (const b of arr) hex += b.toString(16).padStart(2, '0')
  return hex
}

async function signWithEvents(
  challenge: { id: string; site_key: string; expires_at: number },
  events: Array<{ t: number; x: number; y: number; type: string }>,
  privateKey: CryptoKey,
): Promise<string> {
  const digest = await computeEventsDigest(events)
  return signChallengeId(
    `${challenge.id}:${challenge.site_key}:${challenge.expires_at}:${digest}`,
    privateKey,
  )
}

function toCanvasCoords(
  x: number,
  y: number,
  mazeWidth: number,
  mazeHeight: number,
): { x: number; y: number } {
  const cellSize = RENDERING.CELL_SIZE
  const margin = RENDERING.MARGIN
  const mazePixelW = mazeWidth * cellSize
  const mazePixelH = mazeHeight * cellSize
  const canvasW = mazePixelW + margin * 2
  const canvasH = mazePixelH + margin * 2 + INSTRUCTION_TEXT_HEIGHT
  return {
    x: (x * mazePixelW + margin) / canvasW,
    y: (y * mazePixelH + margin) / canvasH,
  }
}

async function solvePoW(challenge: string, difficulty: number): Promise<{ nonce: number; hash: string }> {
  let nonce = 0
  while (true) {
    const input = challenge + nonce.toString()
    const encoded = new TextEncoder().encode(input)
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded)
    const hashArray = new Uint8Array(hashBuffer)
    let zeroBits = 0
    for (const byte of hashArray) {
      if (byte === 0) {
        zeroBits += 8
      } else {
        zeroBits += Math.clz32(byte) - 24
        break
      }
    }
    if (zeroBits >= difficulty) {
      let hex = ''
      for (const b of hashArray) hex += b.toString(16).padStart(2, '0')
      return { nonce, hash: hex }
    }
    nonce++
  }
}

function makeHumanEvents(maze: ReturnType<typeof generateMaze>, seed = 42): RawEvent[] {
  const trace = generateSyntheticHumanTrace(maze, { seed })
  return trace.map((event) => {
    const canvas = toCanvasCoords(event.x, event.y, maze.width, maze.height)
    return { t: event.t, x: canvas.x, y: canvas.y, type: event.type }
  })
}

function makeConfig(): { config: ServerConfig; store: MemoryStore } {
  const store = new MemoryStore()
  return {
    store,
    config: {
      secret: 'test-secret-for-webauthn',
      store,
      powDifficulty: 4,
      scoreThreshold: 0.3,
      mazeWidth: 8,
      mazeHeight: 8,
      mazeDifficulty: 0.3,
      webAuthn: {
        mode: 'required',
        rpId: fixture.rpId,
        expectedOrigin: fixture.origin,
      },
    },
  }
}

async function registerFixtureCredential(
  config: ServerConfig,
  store: MemoryStore,
): Promise<void> {
  await store.setWebAuthnRegistrationSession?.(
    'registration-session',
    {
      id: 'registration-session',
      site_key: fixture.siteKey,
      stable_id: fixture.stableId,
      expected_challenge: fixture.registrationChallenge,
      created_at: Date.now(),
    },
    60_000,
  )

  const result = await completeWebAuthnRegistration(config, {
    session_id: 'registration-session',
    response: fixture.registrationResponse as unknown as WebAuthnRegistrationResponseJSON,
  })

  expect(result.success).toBe(true)
}

describe('webauthn', () => {
  it('completes registration from a browser-generated fixture', async () => {
    const { config, store } = makeConfig()

    await registerFixtureCredential(config, store)

    const credentials = await store.listWebAuthnCredentials?.(fixture.stableId, fixture.siteKey)
    expect(credentials).toHaveLength(1)
    expect(credentials?.[0]?.credential_id).toBe(fixture.registrationResponse.id)
  })

  it('verifies a browser-generated authentication fixture and advances the counter', async () => {
    const { config, store } = makeConfig()

    await registerFixtureCredential(config, store)

    const before = await store.listWebAuthnCredentials?.(fixture.stableId, fixture.siteKey)
    const beforeCounter = before?.[0]?.counter ?? 0

    const result = await verifyWebAuthnAuthentication(
      config,
      fixture.siteKey,
      fixture.stableId,
      fixture.authenticationChallenge,
      fixtureAuthenticationResponse(),
    )

    expect(result.valid).toBe(true)

    const after = await store.listWebAuthnCredentials?.(fixture.stableId, fixture.siteKey)
    expect((after?.[0]?.counter ?? 0)).toBeGreaterThan(beforeCounter)
  })

  it('accepts a real WebAuthn assertion transcript during validateSubmission', async () => {
    const { config, store } = makeConfig()

    await registerFixtureCredential(config, store)

    const challenge = await createChallenge(config, {
      site_key: fixture.siteKey,
      stable_id: fixture.stableId,
      client_capabilities: { webauthn_available: true },
    })

    expect(challenge.webauthn_request_options).toBeDefined()

    await store.setChallenge(
      challenge.id,
      {
        ...challenge,
        webauthn_request_options: {
          ...challenge.webauthn_request_options!,
          challenge: fixture.authenticationChallenge,
          rpId: fixture.rpId,
        },
      },
      challenge.expires_at - Date.now(),
    )

    const maze = generateMaze({
      width: challenge.maze_width,
      height: challenge.maze_height,
      difficulty: challenge.maze_difficulty,
      seed: challenge.maze_seed,
    })
    const events = makeHumanEvents(maze)
    const powProof = await solvePoW(challenge.pow_challenge, challenge.pow_difficulty)
    const keyPair = await generateTestKeyPair()
    const signature = await signWithEvents(challenge, events, keyPair.privateKey)

    const result = await validateSubmission(config, {
      challenge_id: challenge.id,
      site_key: fixture.siteKey,
      session_id: 'session-1',
      maze_seed: challenge.maze_seed,
      stable_id: fixture.stableId,
      events,
      pow_proof: powProof,
      public_key: keyPair.publicKeyBase64,
      signature,
      timestamp: Date.now(),
      webauthn: fixtureAuthenticationResponse() as unknown as WebAuthnAuthenticationResponseJSON,
    })

    expect(result.success).toBe(true)
    expect(result.token).toBeDefined()
  })
})
