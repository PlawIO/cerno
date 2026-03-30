import type { Env } from './index.js'
import type { RegistrationRecord } from './register.js'

type Session = { github_id: string; login: string }

type KeyInfo = {
  site_key: string
  usage: number
  limit: number
  created_at: number
  revoked?: boolean
}

const FREE_LIMIT = 10_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentMonth(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncateKey(key: string): string {
  if (key.length <= 16) return key
  return key.slice(0, 14) + '...'
}

async function gatherKeys(
  env: Env,
  githubId: string,
): Promise<KeyInfo[]> {
  const raw = await env.CERNO_KV.get(`account:keys:${githubId}`)
  const siteKeys: string[] = raw ? JSON.parse(raw) : []
  const month = currentMonth()

  const keys: KeyInfo[] = []
  for (const sk of siteKeys) {
    const regRaw = await env.CERNO_KV.get(`reg:${sk}`)
    if (!regRaw) continue
    const reg: RegistrationRecord = JSON.parse(regRaw)
    const usage = reg.month === month ? reg.count : 0
    keys.push({
      site_key: sk,
      usage,
      limit: FREE_LIMIT,
      created_at: reg.created_at,
      revoked: reg.revoked,
    })
  }
  return keys
}

// ---------------------------------------------------------------------------
// JSON endpoint
// ---------------------------------------------------------------------------

export async function handleGetAccount(
  _request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const keys = await gatherKeys(env, session.github_id)
  return new Response(
    JSON.stringify({
      login: session.login,
      keys: keys.map((k) => ({
        site_key: k.site_key,
        usage: k.usage,
        limit: k.limit,
        created_at: k.created_at,
      })),
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

// ---------------------------------------------------------------------------
// HTML dashboard
// ---------------------------------------------------------------------------

export async function handleDashboard(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const url = new URL(request.url)
  const success = url.searchParams.get('success')
  const error = url.searchParams.get('error')
  const newSiteKey = url.searchParams.get('new_site_key')
  const newApiSecret = url.searchParams.get('new_api_secret')

  const keys = await gatherKeys(env, session.github_id)

  const html = renderPage(session, keys, { success, error, newSiteKey, newApiSecret })

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBanner(
  success: string | null,
  error: string | null,
): string {
  if (!success && !error) return ''
  const isError = !!error
  const msg = escapeHtml(isError ? error! : success!)
  return `<div class="banner ${isError ? 'banner-error' : 'banner-success'}" role="alert">${msg}</div>`
}

function renderSecretBox(
  newSiteKey: string | null,
  newApiSecret: string | null,
): string {
  if (!newSiteKey || !newApiSecret) return ''
  return `
    <div class="secret-box" role="alert">
      <strong>New key created.</strong> Copy the API secret now — it will not be shown again.
      <div class="secret-fields">
        <label>Site Key</label>
        <div class="secret-row">
          <code id="new-sk">${escapeHtml(newSiteKey)}</code>
          <button type="button" class="copy-btn" onclick="copyText('new-sk')">Copy</button>
        </div>
        <label>API Secret</label>
        <div class="secret-row">
          <code id="new-secret">${escapeHtml(newApiSecret)}</code>
          <button type="button" class="copy-btn" onclick="copyText('new-secret')">Copy</button>
        </div>
      </div>
    </div>`
}

function renderKeyRow(k: KeyInfo): string {
  const display = escapeHtml(truncateKey(k.site_key))
  const full = escapeHtml(k.site_key)
  const usage = formatNumber(k.usage)
  const limit = formatNumber(k.limit)
  const created = formatDate(k.created_at)
  const revoked = k.revoked

  return `
    <tr${revoked ? ' class="revoked"' : ''}>
      <td class="key-cell" title="${full}"><code>${display}</code></td>
      <td>${revoked ? '<span class="tag-revoked">Revoked</span>' : `${usage} / ${limit}`}</td>
      <td>${created}</td>
      <td>
        ${revoked ? '' : `
        <form method="POST" action="/api/account/keys/revoke" onsubmit="return confirm('Revoke this key? This cannot be undone.')">
          <input type="hidden" name="site_key" value="${full}">
          <button type="submit" class="btn-danger">Revoke</button>
        </form>`}
      </td>
    </tr>`
}

function renderPage(
  session: Session,
  keys: KeyInfo[],
  opts: {
    success: string | null
    error: string | null
    newSiteKey: string | null
    newApiSecret: string | null
  },
): string {
  const { success, error, newSiteKey, newApiSecret } = opts
  const login = escapeHtml(session.login)

  const keyRows = keys.length > 0
    ? keys.map(renderKeyRow).join('')
    : `<tr><td colspan="4" class="empty">No API keys yet. Create one to get started.</td></tr>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard — Cerno</title>
  <meta name="robots" content="noindex">
  <link rel="icon" type="image/svg+xml" href="https://cerno.sh/favicon.svg">
  <style>
    @font-face {
      font-family: 'Geist';
      src: url('https://cdn.jsdelivr.net/npm/geist@1.7.0/dist/fonts/geist-sans/Geist-Variable.woff2') format('woff2');
      font-weight: 100 900;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'Geist Mono';
      src: url('https://cdn.jsdelivr.net/npm/geist@1.7.0/dist/fonts/geist-mono/GeistMono-Variable.woff2') format('woff2');
      font-weight: 100 900;
      font-style: normal;
      font-display: swap;
    }

    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #ffffff;
      --fg: #282828;
      --secondary: #504944;
      --muted: #6b6866;
      --border: rgba(0,0,0,0.06);
      --border-strong: rgba(0,0,0,0.12);
      --surface: #f3f3f2;
      --accent: #2596be;
      --accent-deep: #1d7898;
      --accent-text: #042f2e;
      --nav-bg: rgba(255, 255, 255, 0.9);
      --danger: #d94444;
      --danger-bg: rgba(217,68,68,0.08);
      --success-bg: rgba(34,170,90,0.08);
      --success-border: rgba(34,170,90,0.3);
      --error-bg: rgba(217,68,68,0.08);
      --error-border: rgba(217,68,68,0.3);
      --mono: 'Geist Mono', ui-monospace, monospace;
      --sans: 'Geist', ui-sans-serif, system-ui, sans-serif;
      color-scheme: light;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d0a09;
        --fg: #f3ece4;
        --secondary: #c5beb5;
        --muted: #978f87;
        --border: rgba(255, 245, 230, 0.08);
        --border-strong: rgba(255, 245, 230, 0.14);
        --surface: #1a1614;
        --accent: #38a9d2;
        --accent-deep: #5bbde0;
        --accent-text: #b2e7fb;
        --nav-bg: rgba(13, 10, 9, 0.9);
        --danger: #e86060;
        --danger-bg: rgba(232,96,96,0.1);
        --success-bg: rgba(56,200,110,0.1);
        --success-border: rgba(56,200,110,0.3);
        --error-bg: rgba(232,96,96,0.1);
        --error-border: rgba(232,96,96,0.3);
        color-scheme: dark;
      }
    }

    html { -webkit-font-smoothing: antialiased; }

    body {
      font-family: var(--sans);
      background: var(--bg);
      color: var(--fg);
      line-height: 1.5;
      font-size: 15px;
      letter-spacing: -0.011em;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Nav */
    nav {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--nav-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
    }
    .nav-inner {
      max-width: 720px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 32px;
      height: 56px;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 16px;
      color: var(--fg);
      text-decoration: none;
    }
    .logo-mark { width: 22px; height: 22px; }

    .nav-r {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 14px;
      color: var(--muted);
    }
    .nav-r span { color: var(--secondary); }
    .nav-r a, .nav-r form button {
      color: var(--muted);
      text-decoration: none;
      background: none;
      border: none;
      font: inherit;
      cursor: pointer;
      font-size: 14px;
    }
    .nav-r a:hover, .nav-r form button:hover { color: var(--fg); text-decoration: none; }

    /* Main */
    main {
      max-width: 720px;
      margin: 0 auto;
      padding: 40px 32px 80px;
      width: 100%;
      flex: 1;
    }

    h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 24px;
    }

    /* Banners */
    .banner {
      padding: 10px 16px;
      border-radius: 6px;
      font-size: 14px;
      margin-bottom: 24px;
    }
    .banner-success {
      background: var(--success-bg);
      border: 1px solid var(--success-border);
    }
    .banner-error {
      background: var(--error-bg);
      border: 1px solid var(--error-border);
      color: var(--danger);
    }

    /* Secret box (shown after key creation) */
    .secret-box {
      background: var(--surface);
      border: 1px solid var(--accent);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
      font-size: 14px;
    }
    .secret-box strong { display: block; margin-bottom: 12px; }
    .secret-fields { display: flex; flex-direction: column; gap: 8px; }
    .secret-fields label { font-size: 12px; color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
    .secret-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .secret-row code {
      flex: 1;
      font-family: var(--mono);
      font-size: 13px;
      background: var(--bg);
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      padding: 6px 10px;
      overflow-x: auto;
      white-space: nowrap;
      user-select: all;
    }

    /* Table */
    .table-wrap { overflow-x: auto; margin-bottom: 24px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th {
      text-align: left;
      padding: 8px 12px;
      font-weight: 500;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      border-bottom: 1px solid var(--border-strong);
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .key-cell code {
      font-family: var(--mono);
      font-size: 13px;
    }
    .empty {
      color: var(--muted);
      text-align: center;
      padding: 32px 12px;
    }
    .revoked { opacity: 0.5; }
    .tag-revoked {
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--danger);
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 16px;
      border-radius: 6px;
      font: inherit;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.15s, border-color 0.15s;
    }
    .btn-primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .btn-primary:hover { background: var(--accent-deep); border-color: var(--accent-deep); }
    .btn-outline {
      background: transparent;
      color: var(--fg);
      border-color: var(--border-strong);
    }
    .btn-outline:hover { border-color: var(--muted); }
    .btn-danger {
      background: none;
      border: 1px solid var(--border-strong);
      color: var(--danger);
      padding: 4px 10px;
      border-radius: 4px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .btn-danger:hover { background: var(--danger-bg); border-color: var(--danger); }
    .copy-btn {
      background: var(--surface);
      border: 1px solid var(--border-strong);
      padding: 6px 10px;
      border-radius: 4px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      color: var(--fg);
      white-space: nowrap;
    }
    .copy-btn:hover { border-color: var(--muted); }

    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 40px;
    }

    /* Claim form */
    .claim-section { margin-bottom: 40px; }
    .claim-section summary {
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      color: var(--secondary);
      user-select: none;
      list-style: none;
    }
    .claim-section summary::-webkit-details-marker { display: none; }
    .claim-section summary::before { content: '+ '; }
    .claim-section[open] summary::before { content: '- '; }
    .claim-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 12px;
      max-width: 420px;
    }
    .claim-form label { font-size: 13px; color: var(--muted); font-weight: 500; }
    .claim-form input {
      font-family: var(--mono);
      font-size: 13px;
      padding: 8px 10px;
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      background: var(--bg);
      color: var(--fg);
      width: 100%;
    }
    .claim-form input:focus { outline: none; border-color: var(--accent); }
    .claim-form .btn { align-self: flex-start; }

    /* Separator */
    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 0 0 24px;
    }

    /* Footer */
    footer {
      border-top: 1px solid var(--border);
      padding: 20px 32px;
      font-size: 13px;
      color: var(--muted);
    }
    .footer-inner {
      max-width: 720px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .footer-inner a { color: var(--muted); }
    .footer-inner a:hover { color: var(--fg); }
    .footer-links { display: flex; gap: 16px; }

    @media (max-width: 520px) {
      main { padding: 24px 16px 60px; }
      .nav-inner { padding: 0 16px; }
      th, td { padding: 8px 8px; }
      .actions { flex-direction: column; }
      .actions .btn { width: 100%; }
    }
  </style>
</head>
<body>
  <nav>
    <div class="nav-inner">
      <a href="https://cerno.sh" class="logo">
        <svg class="logo-mark" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <g stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="13" y1="3" x2="33" y2="3"/>
            <line x1="33" y1="3" x2="33" y2="33"/>
            <line x1="3" y1="33" x2="23" y2="33"/>
            <line x1="3" y1="3" x2="3" y2="33"/>
            <line x1="13" y1="13" x2="13" y2="23"/>
            <line x1="23" y1="3" x2="23" y2="13"/>
            <line x1="23" y1="23" x2="23" y2="33"/>
            <line x1="13" y1="23" x2="23" y2="23"/>
          </g>
          <path d="M8 3 L8 8 L18 8 L18 18 L28 18 L28 28 L28 33" stroke="#2596be" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Cerno
      </a>
      <div class="nav-r">
        <span>@${login}</span>
        <form method="POST" action="/auth/logout" style="display:inline">
          <button type="submit">Logout</button>
        </form>
      </div>
    </div>
  </nav>

  <main>
    ${renderBanner(success, error)}
    ${renderSecretBox(newSiteKey, newApiSecret)}

    <h1>Your API Keys</h1>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Site Key</th>
            <th>Usage This Month</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${keyRows}
        </tbody>
      </table>
    </div>

    <div class="actions">
      <form method="POST" action="/api/account/keys">
        <button type="submit" class="btn btn-primary">+ Create New Key</button>
      </form>
    </div>

    <details class="claim-section">
      <summary>Claim Existing Key</summary>
      <form method="POST" action="/api/account/keys/claim" class="claim-form">
        <label for="claim-sk">Site Key</label>
        <input type="text" id="claim-sk" name="site_key" placeholder="ck_..." required>
        <label for="claim-secret">API Secret</label>
        <input type="text" id="claim-secret" name="api_secret" placeholder="sk_live_..." required>
        <button type="submit" class="btn btn-outline">Claim Key</button>
      </form>
    </details>

    <hr>

    <footer>
      <div class="footer-inner">
        <div class="footer-links">
          <a href="https://cerno.sh/docs/">Docs</a>
          <a href="https://cerno.sh/docs/self-hosting/">Self-hosting guide</a>
          <a href="https://github.com/PlawIO/cerno" target="_blank" rel="noopener">GitHub</a>
        </div>
      </div>
    </footer>
  </main>

  <script>
    function copyText(id) {
      var el = document.getElementById(id);
      if (!el) return;
      var text = el.textContent || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          var btn = el.parentElement.querySelector('.copy-btn');
          if (btn) { var orig = btn.textContent; btn.textContent = 'Copied'; setTimeout(function() { btn.textContent = orig; }, 1500); }
        });
      } else {
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('copy');
        sel.removeAllRanges();
      }
    }
  </script>
</body>
</html>`
}
