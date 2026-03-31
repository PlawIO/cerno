import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export function reactGrabClaudeCodePlugin(repoRoot) {
  let child

  return {
    name: 'react-grab-claude-code',
    configureServer(server) {
      const binPath = path.resolve(repoRoot, 'node_modules', '.bin', 'react-grab-claude-code')
      if (!fs.existsSync(binPath) || child) return

      child = spawn(binPath, [], {
        cwd: repoRoot,
        env: {
          ...process.env,
          REACT_GRAB_CWD: process.env.REACT_GRAB_CWD ?? repoRoot,
        },
        stdio: 'ignore',
      })

      const stop = () => {
        if (child && !child.killed) {
          child.kill('SIGTERM')
        }
      }

      server.httpServer?.once('close', stop)
      process.once('exit', stop)
    },
  }
}

export const reactGrabClaudeCodeHead = [
  {
    tag: 'script',
    attrs: {
      src: '//unpkg.com/react-grab/dist/index.global.js',
      crossorigin: 'anonymous',
    },
  },
  {
    tag: 'script',
    attrs: {
      src: '//unpkg.com/@react-grab/claude-code/dist/client.global.js',
      crossorigin: 'anonymous',
    },
  },
]
