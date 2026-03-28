# Cerno

**The last line between AI agents and your users.**

[![npm](https://img.shields.io/npm/v/@cerno/react?color=0ea5e9&label=%40cerno%2Freact)](https://www.npmjs.com/package/@cerno/react)
[![npm](https://img.shields.io/npm/v/@cerno/server?color=0ea5e9&label=%40cerno%2Fserver)](https://www.npmjs.com/package/@cerno/server)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-63%20passing-22c55e)](./packages)

AI browser agents can solve reCAPTCHA. They pass hCaptcha. They click checkboxes, recognize traffic lights, and type text. What they cannot do is move a mouse like a human.

Cerno is a maze-trace CAPTCHA that uses **behavioral biometrics** to tell AI from human. The maze is a Trojan horse. The real test is invisible.

> *Latin: cerno — "I distinguish" / "I separate" / "I perceive."*
> Built by [PlawIO](https://plaw.io). Pairs with [veto.so](https://veto.so) — veto forbids unsafe AI behavior, cerno distinguishes AI from human.

---

## How it works

Three detection layers. One visible interaction.

```
User sees:          Server measures:

┌──────────┐        1. Proof of Work     — SHA-256 mining in background.
│  ╔══╗    │           Makes farm attacks expensive.
│  ║  ╚═╗  │
│  ╚╗   ║  │        2. Maze Challenge    — Procedural maze regenerated
│   ╚═══╝  │           server-side from seed. Path validated.
│  ·     ● │
└──────────┘        3. Behavioral Score  — 6 features extracted from
  start  exit          raw pointer events. Things AI cannot fake.
```

**The 6 features:**

| Feature | What it measures | Why AI fails |
|---------|-----------------|--------------|
| `velocity_std` | Speed variance across the trace | Bots move at constant velocity |
| `path_efficiency` | Euclidean / actual distance | Bots take straight-line paths |
| `pause_count` | Hesitations >100ms | Bots don't pause at decision points |
| `movement_onset_ms` | Reaction time before first move | Bots start instantly |
| `jerk_std` | Third derivative of position | Human muscle control is jerky |
| `angular_velocity_entropy` | Randomness in direction changes | Bot paths have low directional entropy |

All features are re-extracted server-side from raw events. The client cannot lie about them.

---

## Quick start

```bash
npm install @cerno/react @cerno/server
```

### Drop the widget in

```tsx
import { Cerno } from '@cerno/react'

function ProtectedPage() {
  return (
    <Cerno
      siteKey="your-site-key"
      sessionId={session.id}
      onVerify={(token) => submitWithToken(token)}
    />
  )
}
```

### Validate on the server

```typescript
import { createChallenge, validateSubmission, verifyToken } from '@cerno/server'
import { MemoryStore } from '@cerno/server'

const config = {
  secret: process.env.CERNO_SECRET!,
  store: new MemoryStore(), // swap for CloudflareKVStore in production
}

// Issue a challenge (called by the widget automatically)
app.post('/api/captcha/challenge', async (req, res) => {
  const challenge = await createChallenge(config, req.body.site_key)
  res.json(challenge)
})

// Validate a submission (called by the widget automatically)
app.post('/api/captcha/verify', async (req, res) => {
  const result = await validateSubmission(config, req.body)
  res.json(result)
})

// Verify a token in your own routes
app.post('/api/sensitive-action', async (req, res) => {
  const verified = await verifyToken(req.body.cerno_token, {
    secret: process.env.CERNO_SECRET!,
    sessionId: req.session.id,
    store: config.store, // enables single-use enforcement
  })

  if (!verified.valid) return res.status(403).json({ error: 'Human verification required' })

  // proceed
})
```

### Deploy to Cloudflare Workers

```bash
cd apps/worker
cp wrangler.toml.example wrangler.toml  # add your KV namespace IDs
wrangler secret put CERNO_SECRET
wrangler deploy
```

---

## Architecture

```
Client                              Server
┌──────────────────────┐            ┌──────────────────────────────┐
│                      │            │                              │
│  POST /challenge ────┼───────────►│  Generate maze seed          │
│                      │◄───────────┼─ Maze params + PoW challenge │
│                      │            │  Store in KV (2min TTL)      │
│  Render maze         │            └──────────────────────────────┘
│  Start PoW worker    │
│  Capture raw events  │            ┌──────────────────────────────┐
│                      │            │  Validation pipeline:        │
│  POST /verify ───────┼───────────►│  1. Input bounds check       │
│                      │            │  2. Rate limit (session)     │
│                      │            │  3. Challenge lookup         │
│                      │            │  4. Site key match           │
│                      │            │  5. Expiry check             │
│                      │            │  6. PoW verification         │
│                      │            │  7. Maze path validation     │
│                      │            │  8. Behavioral scoring       │
│  onVerify(token) ◄───┼────────────┼─ JWT (60s, single-use)      │
└──────────────────────┘            └──────────────────────────────┘
```

Tokens are:
- Signed with HMAC-SHA256
- Bound to session ID
- Single-use (replay-proof via consumed-token set)
- 60-second expiry

---

## Packages

| Package | Description | Size |
|---------|-------------|------|
| [`@cerno/core`](./packages/core) | Seeded PRNG, Growing Tree maze algorithm, BFS solver, maze profiling, 6-feature behavioral extractor with 60Hz resampling | 12.4 KB |
| [`@cerno/react`](./packages/react) | Drop-in React component. Canvas renderer, pointer + keyboard collectors, PoW web worker, WebCrypto key binding | 28.6 KB |
| [`@cerno/server`](./packages/server) | 8-step validation pipeline, maze-relative behavioral scoring, JWT tokens, CaptchaStore interface | 12.4 KB |

---

## Behavioral scoring

No ML on the hot path. Pure deterministic math. **Maze-relative baselines.**

For each feature, we compute a z-score against baselines, then apply a sigmoid transform:

```
featureScore = 1 / (1 + |value - baseline.mean| / baseline.std)
finalScore   = weightedAverage(featureScores) × penalties
```

**Two kinds of baselines:**

| Type | Features | Source |
|------|----------|--------|
| Motor control (maze-independent) | `velocity_std`, `jerk_std`, `movement_onset_ms` | Static. These measure how you move, not where. |
| Topology-dependent (maze-relative) | `path_efficiency`, `pause_count`, `angular_velocity_entropy` | Computed from THIS maze's BFS solution, decision points, and turn count. |

Published mouse-movement baselines assume free-form movement. A maze constrains the path. A human solving an easy 4x4 maze behaves differently than one solving a complex 12x12. Hardcoded baselines would reject real humans on easy mazes and miss bots on hard ones. Cerno computes a `MazeProfile` (solution length, decision point count, turn count, optimal efficiency) and derives expected feature ranges from the maze topology.

Penalties for:
- **Low sample count** (<20 points): not enough data is suspicious
- **Fast completion** (<2s): humans don't solve mazes instantly

Threshold: 0.5 (configurable). Calibration mode drops it to 0.3 for initial deployments while you collect real user data.

---

## Threat model

Cerno is designed specifically for **AI browser agents** (Playwright, Puppeteer, Claude Computer Use, browser-use, Operator) — not mass bots. This changes the design significantly.

An AI agent can:
- Solve visual puzzles
- Recognize and click UI elements
- Type text, check boxes, identify traffic lights
- Replay recorded human sessions

An AI agent cannot (yet):
- Produce human-like jerk dynamics from motor control
- Replicate the micro-corrections and hesitations of human hand movement
- Fake the statistical distribution of human behavioral features without access to the scoring algorithm

The behavioral layer is the real test. The maze is just the delivery mechanism.

---

## Cloudflare Worker API

Deploy to the edge in one command. KV-backed storage, no database.

**Endpoints:**

```
POST /challenge   →  { id, maze_seed, maze_width, maze_height, maze_difficulty,
                       pow_challenge, pow_difficulty, expires_at }

POST /verify      →  { success: true, token, score }
                  →  { success: false, error_code }
```

**Error codes:**

| Code | HTTP | Meaning |
|------|------|---------|
| `challenge_not_found` | 400 | Unknown or already-used challenge ID |
| `challenge_expired` | 410 | User took >2 minutes |
| `invalid_pow` | 400 | Proof of work didn't check out |
| `invalid_path` | 400 | Maze path didn't solve the maze |
| `behavioral_rejected` | 400 | Behavioral score below threshold |
| `rate_limited` | 429 | Too many attempts from this session |
| `invalid_request` | 400 | Malformed or oversized input |

---

## Development

```bash
bun install
bun run build   # all packages + landing page
bun test        # 63 tests across 7 files
```

```
Test Files  7 passed
     Tests  63 passed

packages/core:
  seeded-prng.test.ts        4 tests  (determinism, range, distribution)
  maze-generator.test.ts    19 tests  (determinism, solvability, wall integrity, maze profiles)
  feature-extractor.test.ts  9 tests  (human vs bot, 120Hz resampling, edge cases)

packages/server:
  behavioral-scoring.test.ts 13 tests  (baselines, maze-relative adaptation, NaN guard, penalties)
  pow-verify.test.ts          4 tests  (valid/invalid proofs, difficulty)
  token.test.ts               5 tests  (JWT round-trip, replay prevention, session binding)
  validate.test.ts            9 tests  (e2e round-trip, input validation, site_key binding, rate limiting, replay)
```

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).

Copyright 2026 PlawIO, Inc.
