# Prediction Market Protocol on Sui (DeepBook V3)

A production-grade, modular decentralized prediction market protocol on Sui using DeepBook V3 as the central limit order book (CLOB) matching engine. Users trade `YES` and `NO` outcome tokens where price discovery reflects implied probability, and winning tokens redeem 1:1 for USDC upon market resolution.

## Architecture Diagram

```mermaid
graph TD
    A[User / Frontend] -->|Place Order PTB| B(TypeScript SDK)
    A -->|Query Markets/Positions| C(Rust Indexer API)
    
    B -->|Create Market| D[Market Factory Move Contract]
    B -->|Mint Tokens & Trade| D
    
    D -->|Register Pools| E[DeepBook V3]
    D -->|Store State| F[MarketRegistry]
    
    E -.->|Emit Events| G[Rust Indexer Waterfall]
    G -->|Update Hot State| H[(Redis)]
    G -->|Persist Fills| I[(PostgreSQL)]
    
    H --> C
    I --> C
```

## Directory Structure
- `deepmarket_contract/` — Move smart contracts (`outcome_token`, `market_factory`, `balance_manager_ext`, `resolution`)
- `deepmarket/src/sdk/` — TypeScript SDK modules for Account, Execution, Strategy, and Resolution
- `indexer/` — Rust + Axum backend for capturing Sui events and caching to Redis & Postgres

## Setup Instructions

### 1. Smart Contracts (Move)
You will need Sui CLI installed to build and deploy the contracts.

```bash
cd deepmarket_contract
sui move build
sui client publish --gas-budget 100000000
```
*Note: Make sure your `Move.toml` is correctly configured for the `testnet` environment and you have sufficient Testnet SUI.*

### 2. Rust Indexer
Ensure you have Rust, PostgreSQL, and Redis installed.

```bash
cd indexer
# Set up postgres DB
export DATABASE_URL="postgres://user:password@localhost/deepmarket"
export REDIS_URL="redis://127.0.0.1/"

# Run the indexer and API server
cargo run
```

### 3. TypeScript SDK
The SDK is located within the `deepmarket` React / Vite application. 
Ensure you have Node.js installed.

```bash
cd deepmarket
npm install

# Example test script (assuming you create one in `src/test.ts`)
# npx tsx src/test.ts
```

## SDK Flow
1. **Initialize Client**: 
   ```ts
   const client = new PredictionMarketClient(suiClient, deepBookClient, DEEPBOOK_PKG_ID, MARKET_PKG_ID);
   ```
2. **Setup Account**: Generate a BalanceManager and deposit USDC.
   ```ts
   client.account.createBalanceManager(tx);
   client.account.deposit(tx, balanceManagerId, usdcCoin, USDC_TYPE);
   ```
3. **Execution**: Place orders into the YES or NO DeepBook pools.
   ```ts
   client.execution.placeLimitOrder(tx, poolId, balanceManagerId, tradeProof, 1, 475000, 1000000, true, 0, 0, YES_TYPE, USDC_TYPE);
   ```
4. **Resolution**: Redeem winning tokens.
   ```ts
   client.resolution.redeem(tx, registryId, marketId, yesTokenConfig, true, USDC_TYPE);
   ```
