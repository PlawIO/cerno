# TODOS

## Post-launch

### Server-side feature rotation mechanism
Secret feature weights, baselines, and active feature set should be updatable without code deploys. Score-search attacks work because the scoring function is static. Weekly baseline rotation based on production telemetry makes local attacker copies go stale. Requires production telemetry pipeline, baseline drift monitoring, and a config update mechanism. Blocked by: need real human traces from production, not synthetic.

### React component QA test suite
`packages/react/` has zero automated tests. Known issues: stale closures in useCallback deps (Cerno.tsx), unbounded event buffers (mouse-collector.ts), Web Worker URL leak on unmount. Run /qa with Playwright against the landing page demo to exercise Cerno.tsx, MazeCanvas.tsx, StroopOverlay.tsx end-to-end. Blocked by: code fixes from eng review landing first.
