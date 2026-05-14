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
    key: 'deepmarket-live',
    dismissible: true,
    content: (
      <span>
        DeepMarket is live on Sui testnet.{' '}
        <a
          href="https://deepmarket-psi.vercel.app"
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'underline' }}
        >
          Open the app ↗
        </a>
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
        {/* Brand fonts — mirror the main app's typography */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Space+Mono:wght@400;700&family=Doto:wght@400..900&display=swap"
        />
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
