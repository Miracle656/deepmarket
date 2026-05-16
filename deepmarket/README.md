# DeepMarket — Web App & TypeScript SDK

The React front end for [DeepMarket](../README.md), plus the in-repo
TypeScript SDK (`src/sdk/`) that builds the Sui programmable transactions
the app submits.

## Stack

- **React 18 + Vite + TypeScript**
- **`@mysten/dapp-kit`** — wallet connect, signing, RPC
- **`@mysten/deepbook-v3`** — DeepBook V3 CLOB interactions
- **Sui Stack Messaging SDK** — encrypted per-market chat (via the relayer)
- **lightweight-charts**, Framer Motion / GSAP — price charts + landing visuals

## What's in the app

| Route | Purpose |
|---|---|
| `/` | Landing page |
| Markets | Create `YES`/`NO` outcome markets, mint outcome tokens, trade on DeepBook V3, resolve & redeem |
| Predict | DeepBook Predict — mint/redeem **binary (UP/DOWN)** and **range** options on the BTC oracle, with live devInspect price preview |
| Portfolio | Open/settled positions across markets + Predict managers |
| Agent | Authorize / revoke the on-chain `AgentCap` that lets the Telegram bot trade Predict on your behalf, with a daily spend cap |
| Market chat | Sui Stack Messaging group per market (delegate key auto-provisioned) |

## Develop

```bash
npm install
cp .env.example .env     # fill in / keep the testnet defaults
npm run dev              # http://localhost:5173 (strictPort)
```

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | `tsc -b && vite build` — typecheck + production bundle |
| `npm run lint` | ESLint |
| `npm run preview` | Serve the built bundle |

> Typecheck the project with `npx tsc -b` (the root `tsconfig.json` is
> references-only — `--noEmit` against it does nothing).

## Environment

All config is `VITE_*` (see `.env.example`). Highlights:

- `VITE_PACKAGE_ID` — DeepMarket Move package (v3 `0x50a58add…`)
- `VITE_MARKET_REGISTRY` — shared `MarketRegistry`
- `VITE_DEEPBOOK_PACKAGE_ID` / `VITE_DEEPBOOK_REGISTRY_ID` — DeepBook V3 (testnet)
- `VITE_NETWORK` — `testnet`
- `VITE_INDEXER_URL` — indexer REST API (`http://localhost:3000` locally, the Render URL in prod)
- `VITE_RELAYER_URL` — Sui Stack Messaging relayer (`:3001` locally)

## Layout

```
src/
  components/   pages + modals (Markets, Predict, Portfolio, Agent, MarketChat, Landing)
  lib/          config, predict + predict-tx, agent-cap, messaging, useMarkets, api
  sdk/          PredictionMarketClient — account / execution / strategy / resolution
  assets/       brand art
```

The SDK (`src/sdk/`) is the place to start for the create → mint → trade →
resolve → redeem flow; see the protocol [README](../deepmarket_contract/README.md)
for the matching on-chain functions.
