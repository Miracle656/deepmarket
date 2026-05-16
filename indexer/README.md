# Indexer Setup Guide

The DeepMarket indexer tracks Sui events for Spot YES/NO markets, persists
fills + price history to Postgres, caches hot state in Redis, and exposes
a REST API at port `3000` (or `$PORT`).

## Local development

### Prerequisites
- Docker & Docker Compose
- Rust (`cargo`)

### 1. Start infrastructure

```bash
docker-compose up -d   # Postgres + Redis
```

### 2. Configure environment

Create `.env`:

```env
DATABASE_URL=postgres://user:password@localhost:5432/deepmarket
REDIS_URL=redis://127.0.0.1:6380/
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
PACKAGE_ID=0x50a58add3954967d6c6480469b9fa78f3f7bb21fed9cda88323cdf7a87771c29
```

### 3. Run

```bash
cargo run
```

API at `http://localhost:3000`. Endpoints:
- `GET /markets` — indexed market list
- `GET /markets/:id/history` — historical price chart data

## Production deploy — Render

Render free tier hosts the whole stack: web service (the indexer) +
Postgres + Key Value (Redis). The container spins down after 15 min of
HTTP inactivity; an UptimeRobot ping every 5 min keeps it warm.

### 1. Create the data stores first

In the Render dashboard:

- **New → Postgres** → name `deepmarket-pg`, plan **Free**. Note the
  *Internal* connection string for env wiring.
- **New → Key Value** → name `deepmarket-redis`, plan **Free**. Note the
  internal `REDIS_URL`.

Free Postgres deletes after 90 days unless upgraded.

### 2. Create the web service

- **New → Web Service**
- Connect the GitHub repo, select branch `main`
- **Root directory**: `indexer`
- **Runtime**: Docker (auto-detected from the `Dockerfile`)
- **Plan**: Free

### 3. Environment variables

| Key | Value |
|---|---|
| `DATABASE_URL` | Internal connection string from `deepmarket-pg` |
| `REDIS_URL` | Internal connection string from `deepmarket-redis` |
| `SUI_RPC_URL` | `https://fullnode.testnet.sui.io:443` |
| `PACKAGE_ID` | `0x50a58add3954967d6c6480469b9fa78f3f7bb21fed9cda88323cdf7a87771c29` |
| `RUST_LOG` | `info` |

(Render automatically injects `PORT` — the binary honors it.)

### 4. Build + deploy

Render builds the Dockerfile on every push to `main`. First build takes
5–10 min (the `sui-sdk` git dependency is heavy); subsequent builds
reuse the Docker layer cache and finish in ~2 min.

When the service is live, copy its URL (e.g.
`https://deepmarket-indexer.onrender.com`) and:

1. Add it to the deployed frontend's Vercel environment as
   `VITE_INDEXER_URL` (or update `src/lib/config.ts` to read from env).
2. Point [UptimeRobot](https://uptimerobot.com) at the service URL with
   a 5-minute interval to defeat the spin-down.

### Endpoints under CORS

The indexer's CORS layer is permissive (`allow_origin: Any`) so the
deployed frontend at any Vercel domain can call it without further
config.
