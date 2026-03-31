import { useState, useId } from 'react'
import { Cerno } from '@cernosh/react'

/**
 * Landing page demo: the real @cernosh/react Cerno widget
 * connected to api.cerno.sh. Visitors interact with the exact
 * same maze rendering they'd get in their own app.
 */
export function CernoDemo() {
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID())
  const [score, setScore] = useState<number | null>(null)
  const [status, setStatus] = useState<'idle' | 'verified' | 'error'>('idle')
  const id = useId()

  const theme =
    typeof document !== 'undefined'
      ? (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light'
      : 'light'

  function handleReset() {
    setSessionId(crypto.randomUUID())
    setScore(null)
    setStatus('idle')
  }

  return (
    <div className="cerno-demo-wrap">
      <div className="cerno-demo-widget">
        <Cerno
          key={sessionId}
          siteKey="ck_05a716da870416d96af00ef30d7808f0"
          sessionId={sessionId}
          apiUrl="https://api.cerno.sh"
          theme={theme}
          onVerify={() => {
            setStatus('verified')
          }}
          onVerifyResult={(result) => {
            if (result.score != null) setScore(result.score)
          }}
          onError={() => {
            setStatus('error')
          }}
        />
      </div>
      <div className="cerno-demo-info">
        {status === 'verified' && (
          <div className="cerno-demo-result">
            <span className="cerno-demo-check">Verified</span>
            {score != null && (
              <span className="cerno-demo-score">Score: {score.toFixed(2)}</span>
            )}
          </div>
        )}
        {status === 'error' && (
          <div className="cerno-demo-result">
            <span className="cerno-demo-err">Error — try again</span>
          </div>
        )}
        <button className="new-maze" onClick={handleReset} type="button">
          New maze
        </button>
      </div>
    </div>
  )
}
