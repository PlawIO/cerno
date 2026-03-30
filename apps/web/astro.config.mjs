import { defineConfig } from 'astro/config'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')

// Dev-only plugin — not committed to the public repo
let reactGrabClaudeCodePlugin = () => null
const scriptPath = path.join(repoRoot, 'scripts/react-grab-claude-code.mjs')
if (process.env.NODE_ENV === 'development' && fs.existsSync(scriptPath)) {
  const mod = await import(scriptPath)
  reactGrabClaudeCodePlugin = mod.reactGrabClaudeCodePlugin
}

const reactGrabScripts = [
  '<script src="//unpkg.com/react-grab/dist/index.global.js" crossorigin="anonymous"></script>',
  '<script src="//unpkg.com/@react-grab/claude-code/dist/client.global.js" crossorigin="anonymous"></script>',
].join('')

// Dev-only: Vite doesn't resolve index.html for static dirs in public/
function docsDirectoryIndex() {
  return {
    name: 'docs-directory-index',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/docs/') && !req.url.includes('.')) {
          const clean = req.url.endsWith('/') ? req.url : req.url + '/'
          const file = path.join(process.cwd(), 'public', clean, 'index.html')
          if (fs.existsSync(file)) {
            const html = fs.readFileSync(file, 'utf8')
            const injected = html.replace('</head>', `${reactGrabScripts}</head>`)
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(injected)
            return
          }
        }
        next()
      })
    },
  }
}

export default defineConfig({
  output: 'static',
  site: 'https://cerno.sh',
  vite: {
    plugins: process.env.NODE_ENV === 'development'
      ? [reactGrabClaudeCodePlugin(repoRoot), docsDirectoryIndex()]
      : [docsDirectoryIndex()],
  },
})
