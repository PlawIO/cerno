# Cerno

**The last line between AI agents and your users.**

Maze-trace CAPTCHA with behavioral biometrics. Invisible to humans. Impenetrable to agents.

> Latin: *cerno* — "I distinguish" / "I separate" / "I perceive."
> Built by [veto.so](https://veto.so). Veto forbids unsafe AI behavior. Cerno distinguishes AI from human.

## How it works

Three detection layers, one visible interaction:

1. **Proof of Work** — SHA-256 mining runs in the background. Makes farm attacks expensive.
2. **Maze Challenge** — A unique procedural maze that AI agents struggle to navigate visually.
3. **Behavioral Biometrics** — 6 features extracted from mouse movements: velocity variance, jerk dynamics, angular entropy, path efficiency, pause patterns, movement onset. Things AI can't fake.

The maze is a Trojan horse. The real test is invisible.

## Quick start

```bash
npm install @cerno/react @cerno/server
```

### Client

```tsx
import { Cerno } from '@cerno/react'

function ProtectedForm() {
  return (
    <Cerno
      siteKey="your-site-key"
      sessionId={session.id}
      onVerify={(token) => submitForm(token)}
    />
  )
}
```

### Server

```typescript
import { createChallenge, validateSubmission, verifyToken } from '@cerno/server'

// Create a challenge
const challenge = await createChallenge(config, siteKey)

// Validate a submission (called by the widget)
const result = await validateSubmission(config, request)

// Verify a token (called by your app)
const verified = await verifyToken(token, {
  secret: process.env.CERNO_SECRET,
  sessionId: req.session.id,
})
```

### Cloudflare Workers

Deploy the API to Cloudflare Workers with KV storage:

```bash
cd apps/worker
wrangler deploy
```

## Packages

| Package | Description | Size |
|---------|-------------|------|
| `@cerno/core` | Maze generator, feature extractor, shared types | 10.7 KB |
| `@cerno/react` | Drop-in React CAPTCHA component | 28.4 KB |
| `@cerno/server` | Validation pipeline, scoring, JWT tokens | 10.3 KB |

## Architecture

```
Client                          Server (Cloudflare Worker)
┌─────────────────┐             ┌─────────────────────────┐
│  POST /challenge │──────────���─│  Generate maze seed      │
│                  │◄───────────│  Generate PoW challenge  │
│                  │            │  Store in KV (2min TTL)  │
│  Render maze     │            └─────────────────────────┘
│  Start PoW worker│
│  Capture events  │            ┌─────────────────────────┐
│  POST /verify    │────────────│  1. Rate limit check     │
│                  │            │  2. Challenge lookup      │
│                  │            │  3. Expiry check          │
│                  │            │  4. PoW verification      │
│                  │            │  5. Maze path validation  │
│                  │            │  6. Behavioral scoring    │
│  onVerify(token) │◄───────────│  → JWT token (60s, 1-use)│
└─────────────────┘             └─────────────────────────┘
```

## Development

```bash
bun install
bun run build
bun test
```

## License

MIT
