# DeepMarket Documentation

Documentation site for [DeepMarket](https://github.com/Miracle656/deepmarket) —
social, agent-augmented prediction trading on Sui.

Built with [Nextra 3](https://nextra.site) (Pages Router) on Next.js 14.

## Local development

```bash
npm install
npm run dev
```

Site at http://localhost:3000.

## Build

```bash
npm run build
npm run start
```

## Deploy on Vercel

The site is plain Next.js. Import the repo, set the root directory to
`docs/`, and Vercel builds it automatically. No env vars needed for the
docs site itself.

## Structure

- `pages/` — `.mdx` content files (one route per file)
- `pages/_meta.ts` files — sidebar navigation
- `theme.config.tsx` — branding (logo, colors, footer, banner)
- `public/` — static assets (logo)
