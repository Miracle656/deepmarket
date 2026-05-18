import React from 'react'
import { DocsThemeConfig } from 'nextra-theme-docs'

const Logo = () => (
  <span
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      fontFamily: "'Inter Tight', Inter, sans-serif",
      fontWeight: 700,
      fontSize: '1.05rem',
      letterSpacing: '-0.01em',
    }}
  >
    <img
      src="/sui-droplet.svg"
      alt="DeepMarket"
      width={22}
      height={28}
      style={{ objectFit: 'contain' }}
    />
    DeepMarket
  </span>
)

const config: DocsThemeConfig = {
  logo: <Logo />,

  project: {
    link: 'https://github.com/Miracle656/deepmarket',
  },

  docsRepositoryBase:
    'https://github.com/Miracle656/deepmarket/tree/main/docs',

  /* Static <head> — using JSX directly (not a function with useConfig)
     avoids the SSR/CSR mismatch that triggers React #418/#423 hydration
     errors. Per-page <title> is handled by Nextra from frontmatter. */
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta
        name="description"
        content="DeepMarket — social, agent-augmented prediction trading on Sui. Spot YES/NO markets, DeepBook Predict, encrypted market chat, and an autonomous LLM trading agent."
      />
      <link rel="icon" type="image/svg+xml" href="/sui-droplet.svg" />
      <meta name="theme-color" content="#298dff" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin=""
      />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Inter+Tight:wght@500;600;700;800&family=DM+Mono:wght@400;500&family=JetBrains+Mono:wght@400;500;600&display=swap"
      />
    </>
  ),

  color: {
    hue: 217,
    saturation: 100,
  },

  sidebar: {
    defaultMenuCollapseLevel: 1,
    toggleButton: true,
  },

  toc: {
    backToTop: true,
  },

  editLink: {
    content: 'Edit this page on GitHub',
  },

  feedback: {
    content: '',
  },

  footer: {
    content: (
      <span
        style={{
          fontFamily: 'Inter, sans-serif',
          fontSize: '0.78rem',
          color: '#7b8ea8',
        }}
      >
        © {new Date().getFullYear()} DeepMarket · Built on Sui + DeepBook V3 ·{' '}
        <a
          href="https://github.com/Miracle656/deepmarket"
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'underline' }}
        >
          GitHub
        </a>
      </span>
    ),
  },
}

export default config
