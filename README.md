# Cerno

**The last line between AI agents and your users.**

[![npm](https://img.shields.io/npm/v/@cernosh/react?color=0ea5e9&label=%40cernosh%2Freact)](https://www.npmjs.com/package/@cernosh/react)
[![npm](https://img.shields.io/npm/v/@cernosh/server?color=0ea5e9&label=%40cernosh%2Fserver)](https://www.npmjs.com/package/@cernosh/server)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-167%20passing-22c55e)](./packages)

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

**Public features** (7 behavioral metrics extracted from raw pointer events):

| Feature | What it measures |
|---------|-----------------|
| `velocity_std` | Speed variance across the trace |
| `path_efficiency` | Euclidean vs. actual path distance |
| `pause_count` | Hesitations >100ms |
| `movement_onset_ms` | Reaction time before first move |
| `jerk_std` | Third derivative of position |
| `angular_velocity_entropy` | Randomness in direction changes |
| `timing_cv` | Coefficient of variation of inter-event timing |

All features are re-extracted server-side from raw events. The server also computes additional secret features not present in the client SDK.

---

## Quick start

```bash
npm install @cernosh/react @cernosh/server
```

### Drop the widget in

```tsx
import { Cerno } from '@cernosh/react'

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
import { createChallenge, validateSubmission, verifyToken } from '@cernosh/server'
import { MemoryStore } from '@cernosh/server'

const config = {
  secret: process.env.CERNO_SECRET!,
  store: new MemoryStore(), // development/test only
}

// Issue a challenge (called by the widget automatically)
app.post('/api/captcha/challenge', async (req, res) => {
  const challenge = await createChallenge(config, {
    site_key: req.body.site_key,
    client_capabilities: req.body.client_capabilities,
  })
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
wrangler secret put CERNO_SECRET
wrangler deploy
```

The in-repo worker supports a Durable Objects state path for production and a KV fallback for demos.
`CERNO_MODE=production` requires the Durable Objects binding or another strong-consistency store.

---

## Architecture

```
Client                              Server
┌──────────────────────┐            ┌──────────────────────────────┐
│                      │            │                              │
│  POST /challenge ────┼───────────►│  Generate maze seed          │
│                      │◄───────────┼─ Maze params + PoW challenge │
│                      │            │  Store in DO/Redis           │
│  Render maze         │            └──────────────────────────────┘
│  Start PoW worker    │
│  Capture raw events  │            ┌──────────────────────────────┐
│                      │            │  Validation pipeline:        │
│  POST /verify ───────┼───────────►│  1. Input bounds check       │
│                      │            │  2. Rate limit (server key)  │
│                      │            │  3. Challenge consume        │
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

### `stable_id` trust boundary

The optional `stableId` prop enables cross-session reputation tracking. **It must be a server-authenticated identity** (e.g., hashed session cookie, database user ID). If you pass a value sourced directly from the browser without server validation, an attacker can generate arbitrary stable IDs to game the reputation system. Set it server-side and inject it into the page, or omit it entirely.

---

## Packages

| Package | Description | Size |
|---------|-------------|------|
| [`@cernosh/core`](./packages/core) | Seeded PRNG, Growing Tree maze algorithm, BFS solver, maze profiling, 6-feature behavioral extractor with 60Hz resampling | 12.4 KB |
| [`@cernosh/react`](./packages/react) | Drop-in React component. Canvas renderer, pointer + keyboard collectors, PoW web worker, WebCrypto key binding | 28.6 KB |
| [`@cernosh/server`](./packages/server) | Challenge issuance, validation pipeline, probe/WebAuthn flows, JWT tokens, `CaptchaStore` interface | 12.4 KB |
| [`@cernosh/server-redis`](./packages/server-redis) | Strong-consistency Redis adapter for portable production deployments | 2.1 KB |

---

## Behavioral scoring

No ML on the hot path. Pure deterministic math. **Maze-relative baselines.**

Features are scored against baselines adapted to each maze's topology. An easy 4x4 maze produces different human behavior than a complex 12x12. Cerno computes a `MazeProfile` from the maze structure and derives expected feature ranges accordingly.

The scoring pipeline applies penalties for suspicious patterns (insufficient data, impossibly fast completion) and produces a final score from 0 to 1. The threshold is configurable via `ScoringConfig`.

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

Deploy to the edge in one command. The checked-in worker uses Durable Objects for authoritative
state when `CERNO_STATE` is bound, and falls back to KV only for demos or staging.

**Endpoints:**

```
POST /challenge   →  { id, maze_seed, maze_width, maze_height, maze_difficulty,
                       pow_challenge, pow_difficulty, expires_at, requirements,
                       probes?, webauthn_request_options? }

POST /probe/arm   →  { success, probe_ticket, armed_at, deadline_at }
POST /probe/complete
                  →  { success, completion_token }

POST /verify      →  { success: true, token }
                  →  { success: false, error_code }

POST /webauthn/register/options
                  →  { session_id, options }
POST /webauthn/register/verify
                  →  { success, credential_id? }

POST /siteverify  →  { success, challenge_id?, session_id?, site_key?, error? }
```

**Error codes:**

| Code | HTTP | Meaning |
|------|------|---------|
| `challenge_not_found` | 400 | Unknown or already-used challenge ID |
| `challenge_expired` | 410 | User took >2 minutes |
| `invalid_pow` | 400 | Proof of work didn't check out |
| `invalid_path` | 400 | Maze path didn't solve the maze |
| `behavioral_rejected` | 400 | Behavioral score below threshold |
| `rate_limited` | 429 | Too many attempts from this client binding |
| `invalid_request` | 400 | Malformed or oversized input |

---

## Development

```bash
bun install
bun run build   # all packages + landing page
bun test        # 167 tests across 18 files
```

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).

Copyright 2026 PlawIO, Inc.
