# DeepMarket × DeepBook Composability Plan

How DeepMarket evolves on top of the three DeepBook primitives: **Spot**, **Margin**, and **Predict**.

---

## Where we are today (Phase 0)

- DeepMarket already uses **DeepBook Spot** as its trading venue.
- Each market mints YES/NO outcome tokens; trading happens on YES/SUI and NO/SUI Spot pools.
- Current blocker: pool creation fee = **500 DEEP**, currently holding ~20 DEEP. This is purely a liquidity/funding blocker, not architectural.
- `skipPools=true` mode lets us mint→resolve→redeem without pools while we accumulate DEEP.

**Phase 0 must ship before any new primitive work begins.** Pools live → trades flowing → indexer & frontend battle-tested. Anything else is premature.

---

## Phase 1 — DeepBook Margin (priority, live since Q1 2026)

**What it unlocks:** leveraged YES/NO positions ("3× YES on this market"), borrow against open positions, structured-product surface area.

### Why Margin first
- **Zero contract changes.** Margin sits on top of our existing Spot pools. Our `market_factory.move` doesn't touch Margin code.
- **Composes natively** with what we already have. The user opens a leveraged position by depositing YES/NO collateral into a Margin manager; Margin handles borrow + execution against our Spot pools.
- **Shared liquidity.** Liquidations route through the same order books we already create.

### Integration points

| Layer | Work |
|-------|------|
| **SDK** (`deepmarket/src/sdk/`) | New `marginModule.ts`. Wrap @mysten/deepbook-v3 margin functions: `borrow_and_swap`, `repay`, `add_collateral`, `withdraw_collateral`, `get_position_health`. |
| **TradeSidebar** | Leverage slider (1×–5× initial), liquidation-price display, margin-call warning band. New tab: "Spot / Margin". |
| **PortfolioPage** | Margin position list with health factor, unrealized PnL, liquidation price. Currently the page is incomplete — build it Margin-aware from the start. |
| **Indexer** (`indexer/`) | Add a `margin_positions` table; subscribe to Margin events (`PositionOpened`, `Liquidated`, `Repaid`). Same polling architecture as current event loop. |
| **Risk UX** | Confirmation modal showing liquidation price, max loss. Required before submit on >2× positions. |

### Open questions to resolve before building
1. Does Margin support arbitrary token pairs, or is there a whitelist? (Verify YES/NO tokens can be margin collateral.)
2. What's the minimum borrow size? Affects whether small markets can support leverage.
3. Liquidation bot infrastructure — do we run one, or rely on DeepBook's keeper network?

### Estimated scope
- 1–2 weeks engineering once Phase 0 ships.
- ~600 LOC SDK, ~400 LOC frontend, ~300 LOC indexer.

---

## Phase 2 — DeepBook Predict (optional, testnet only)

**What it unlocks:** a parallel market type for **oracle-priced events** ("Will SUI close > $5 on June 1?", options, vertical spreads).

### Why this is different from DeepMarket
- Predict markets are priced by an oracle (Block Scholes SVI surface), not by a YES/NO order book.
- Settlement is automatic at expiry — no admin resolution.
- Quote asset is **DUSDC**, not SUI.
- Positions are **quantities inside a `PredictManager`**, not separate token objects. No per-market token deploy needed.

This isn't an upgrade to existing markets — it's a **second product line** alongside admin-resolved YES/NO markets.

### Integration points

| Layer | Work |
|-------|------|
| **Routing** | New `/predict` route. Existing `/markets` stays YES/NO-only. |
| **SDK** | New `predictModule.ts`. Functions: `createManager`, `mintBinary`, `mintRange`, `redeem`, `redeemPermissionless`, `supplyVault` (LP), `withdrawVault`. |
| **Data** | Use the public Predict server (`predict-server.testnet.mystenlabs.com`) directly for market lists, portfolio, vault summaries, history. **Do not extend our Rust indexer** — server already provides indexed surfaces. |
| **Live updates** | Subscribe to Sui events for `oracle::OraclePricesUpdated` only (sub-second tape). Everything else from the server. |
| **UI** | Oracle picker, expiry picker, strike grid (binary positions), range builder (verticals). Different mental model — design from scratch, don't fork the YES/NO components. |
| **LP page** | New surface for vault liquidity providers (supply DUSDC → receive PLP shares). |

### When to actually do this
- **Don't start until Predict hits mainnet** (planned "later this year"). Docs explicitly say testnet IDs/layouts are provisional.
- Alternatively: build a thin spike on testnet to learn the API surface, but treat it as throwaway until mainnet IDs land.

### Estimated scope
- 3–4 weeks engineering once we commit. Effectively a new app section.

---

## Phase 3 — Composed products (Margin + Predict)

The article's headline pitch — "tap to bet UP/DOWN apps", "3× leveraged BTC ETF", "structured products" — only becomes possible when both primitives are live. Two examples:

| Product | Composition |
|---------|-------------|
| **3× UP/DOWN tap** | Predict binary position + Margin borrow. One transaction. |
| **YES/NO with leverage** | Existing DeepMarket YES/NO market + Margin position on top. Already feasible after Phase 1. |
| **Spread products** | Two Predict positions netted (e.g. long $5 call + short $6 call). Native to Predict V2 ("composable calls, puts, spreads next"). |
| **Synthetic perpetual** | Roll forward expired Predict positions automatically. |

These are differentiation opportunities — not roadmap items today.

---

## Order of operations (recommended)

1. **Phase 0**: Ship Spot pools. Resolve the 500 DEEP blocker (option: ask DeepBook team for testnet faucet access, or buy DEEP off-chain if available).
2. **Phase 0.5**: End-to-end test mint → trade → resolve → redeem on a live market with real pools.
3. **Phase 1 (Margin)**: SDK + TradeSidebar leverage tab + portfolio + indexer events.
4. **Phase 1.5**: Production hardening — liquidation flow tested, indexer recovery on RPC failure, alerting.
5. **Phase 2 (Predict)**: Only if (a) Predict hits mainnet and (b) we want price-based markets as a product.
6. **Phase 3 (Composed)**: Opportunistic — pick one composed product and ship a flagship demo.

---

## What this is *not*

- Not a replacement for the custom `market_factory.move` contract. Admin-resolved arbitrary-event markets ("Will X win election?") remain DeepMarket's core differentiator. Predict cannot serve this use case.
- Not a reason to delay Phase 0. Composability talk is downstream of having working pools.
- Not free. Each primitive added = dual SDK paths, dual UI flows, dual indexing. Surface area grows with each step.

---

## Open decisions for next session

- [ ] Strategy for Phase 0 funding: keep swapping (slow), request testnet DEEP from DeepBook team, or skip pools and demo on resolve/redeem flow only?
- [ ] Confirm Margin supports arbitrary YES/NO tokens (read SDK or ping DeepBook Discord).
- [ ] Decide whether Predict gets a parallel path or never (depends on product strategy — price-based markets vs event-only).
