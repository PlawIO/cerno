import { useState, useEffect } from 'react'
import { Cerno } from '@cernosh/react'

/**
 * Benchmark page: the real @cernosh/react Cerno widget in a panel.
 * Shows elapsed time, status, and score after verification.
 */
export function CernoBenchmark() {
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID())
  const [score, setScore] = useState<number | null>(null)
  const [status, setStatus] = useState('Ready')
  const [startTime, setStartTime] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState('-')

  const theme =
    typeof document !== 'undefined'
      ? (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light'
      : 'light'

  useEffect(() => {
    if (startTime == null) return
    const interval = setInterval(() => {
      setElapsed(((Date.now() - startTime) / 1000).toFixed(1) + 's')
    }, 100)
    return () => clearInterval(interval)
  }, [startTime])

  function handleReset() {
    setSessionId(crypto.randomUUID())
    setScore(null)
    setStatus('Ready')
    setStartTime(null)
    setElapsed('-')
  }

  return (
    <>
      <div className="panel-head">
        <div className="panel-title">
          Cerno
          <span className="badge badge-live">LIVE</span>
          <a href="https://github.com/PlawIO/cerno" target="_blank" rel="noopener">
            GitHub &#8599;
          </a>
        </div>
        <div className="panel-meta">
          <span>{elapsed}</span>
          <span style={{ opacity: 0.3 }}>|</span>
          <span>{status}</span>
        </div>
      </div>
      <div className="panel-body">
        <Cerno
          key={sessionId}
          siteKey="ck_05a716da870416d96af00ef30d7808f0"
          sessionId={sessionId}
          apiUrl="https://api.cerno.sh"
          theme={theme}
          onVerify={() => {
            setStatus('Verified')
            if (startTime) {
              setElapsed(((Date.now() - startTime) / 1000).toFixed(1) + 's')
            }
          }}
          onVerifyResult={(result) => {
            if (result.score != null) setScore(result.score)
          }}
          onError={() => {
            setStatus('Error')
          }}
        />
        <div className="panel-foot">
          <div className="panel-score">
            Score <span className="score-val">{score != null ? score.toFixed(2) : '-'}</span>
          </div>
          <button className="btn-reset" onClick={handleReset} type="button">
            New maze
          </button>
        </div>
        <p className="panel-note">
          SDK preview &middot; live API &middot; maze-trace + 12 behavioral features + PoW + ECDSA
          binding
        </p>
      </div>
    </>
  )
}
