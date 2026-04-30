# Indexer Setup Guide

This indexer uses PostgreSQL and Redis to track prediction market events on Sui.

## Prerequisites
- Docker & Docker Compose
- Rust (cargo)

## 1. Start Infrastructure
Run the following in the `indexer` directory to start PostgreSQL and Redis:
```bash
docker-compose up -d
```

## 2. Configure Environment
A `.env` file has been created for you. Update the `PACKAGE_ID` with your deployed Move contract package ID:
```env
DATABASE_URL=postgres://user:password@localhost:5432/deepmarket
REDIS_URL=redis://127.0.0.1:6379/
PACKAGE_ID=0xYOUR_PACKAGE_ID_HERE
NETWORK=testnet
```

## 3. Run the Indexer
Install dependencies and start the indexer:
```bash
cargo run
```

The API will be available at `http://localhost:3000`.
- `/markets` - Indexed market list
- `/markets/:id/history` - Historical price chart data
