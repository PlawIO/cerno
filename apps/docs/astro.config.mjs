import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import path from 'node:path'
import { reactGrabClaudeCodeHead, reactGrabClaudeCodePlugin } from '../../scripts/react-grab-claude-code.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const isDevelopment = process.env.NODE_ENV === 'development'

export default defineConfig({
  site: 'https://cerno.sh',
  base: '/docs',
  vite: {
    plugins: isDevelopment ? [reactGrabClaudeCodePlugin(repoRoot)] : [],
  },
  integrations: [
    starlight({
      title: 'Cerno SDK',
      description: 'Reference docs for the Cerno human-verification stack.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: false,
      },
      components: {
        Header: './src/components/Header.astro',
        Footer: './src/components/Footer.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
      social: {
        github: 'https://github.com/PlawIO/cerno',
      },
      head: [
        {
          tag: 'script',
          content: `(function(){var s=localStorage.getItem('starlight-theme');var d=s==='dark'||(!s&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')})()`,
        },
        ...(isDevelopment ? reactGrabClaudeCodeHead : []),
      ],
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Overview',
          items: [
            { label: 'Introduction', slug: 'getting-started' },
            { label: 'Quick Start', slug: 'quick-start' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'React Component', slug: 'guides/react' },
            { label: 'Server SDK', slug: 'guides/server' },
            { label: 'Cloudflare Workers', slug: 'guides/cloudflare-workers' },
            { label: 'Stroop Probes', slug: 'guides/stroop-probes' },
            { label: 'WebAuthn Attestation', slug: 'guides/webauthn' },
            { label: 'Adaptive Proof-of-Work', slug: 'guides/adaptive-pow' },
            { label: 'Reputation System', slug: 'guides/reputation' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Behavioral Scoring', slug: 'concepts/behavioral-scoring' },
            { label: 'Secret Features', slug: 'concepts/secret-features' },
            { label: 'Threat Model', slug: 'concepts/threat-model' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Challenge API', slug: 'reference/api' },
            { label: 'siteverify', slug: 'reference/siteverify' },
            { label: 'Error Codes', slug: 'reference/errors' },
          ],
        },
      ],
    }),
  ],
})
