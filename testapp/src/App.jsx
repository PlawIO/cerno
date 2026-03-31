import { useState } from 'react'
import { Cerno } from '@cernosh/react'

const SITE_KEY = 'ck_49eb0559f0246ea494af46a07baab9f1'
const SESSION_ID = crypto.randomUUID()

export default function App() {
  const [form, setForm] = useState({ name: '', email: '' })
  const [token, setToken] = useState(null)
  const [status, setStatus] = useState(null) // null | 'loading' | 'success' | 'error'

  async function handleSubmit(e) {
    e.preventDefault()
    if (!token) return

    setStatus('loading')

    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, token, sessionId: SESSION_ID }),
    })

    setStatus(res.ok ? 'success' : 'error')
  }

  if (status === 'success') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-2xl font-semibold text-gray-900">Verified!</p>
          <p className="text-gray-500 mt-1 text-sm">Bot check passed. Submission accepted.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 w-full max-w-md p-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Sign up</h1>
        <p className="text-sm text-gray-500 mb-6">Cerno bot protection test</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <Cerno
            siteKey={SITE_KEY}
            sessionId={SESSION_ID}
            onVerify={setToken}
          />

          <button
            type="submit"
            disabled={!token || status === 'loading'}
            className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {status === 'loading' ? 'Submitting...' : 'Submit'}
          </button>

          {status === 'error' && (
            <p className="text-red-500 text-sm text-center">Something went wrong. Try again.</p>
          )}
        </form>
      </div>
    </div>
  )
}
