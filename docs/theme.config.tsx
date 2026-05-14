import React from 'react'
import { DocsThemeConfig, useConfig } from 'nextra-theme-docs'

const Logo = () => (
  <span
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      fontWeight: 800,
      fontSize: '1.05rem',
      letterSpacing: '-0.02em',
    }}
  >
    <img
      src="/deepmarket.png"
      alt="DeepMarket"
      width={28}
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
  // Brand blue #1c6fff ≈ hue 217, full saturation
  color: {
    hue: 217,
    saturation: 100,
  },
  banner: {
    key: 'sui-overflow-2026',
    dismissible: true,
    content: (
      <span>
        DeepMarket is live on Sui testnet — built for Sui Overflow 2026.
      </span>
    ),
  },
  head: () => {
    const { title } = useConfig()
    const pageTitle = title ? `${title} – DeepMarket` : 'DeepMarket Docs'
    return (
      <>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0"
        />
        <title>{pageTitle}</title>
        <meta
          name="description"
          content="DeepMarket — social, agent-augmented prediction trading on Sui. Spot YES/NO markets, DeepBook Predict, encrypted market chat, and an autonomous LLM trading agent."
        />
        <meta property="og:title" content={pageTitle} />
        <meta
          property="og:description"
          content="Social, agent-augmented prediction trading on Sui."
        />
        <link rel="icon" href="/deepmarket.png" />
      </>
    )
  },
  sidebar: {
    defaultMenuCollapseLevel: 1,
    toggleButton: true,
  },
  toc: {
    backToTop: true,
  },
  footer: {
    content: (
      <span>
        DeepMarket · Built on Sui + DeepBook V3 ·{' '}
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
