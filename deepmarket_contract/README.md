# DeepMarket Contract (Move)

The on-chain protocol for [DeepMarket](../README.md). Sui Move, edition
`2024.beta`, deployed on **Sui testnet**.

## Modules (`sources/`)

| Module | Responsibility |
|---|---|
| `market_factory` | Core protocol. Registry init, custom market registration, minting outcome tokens, resolution, and YES/NO redemption. |
| `yes_token` / `no_token` | The `YES` / `NO` outcome coin types (6 decimals) and their treasury wiring. |
| `agent_cap` | On-chain authorization + audit object. A user creates an `AgentCap` delegating Predict trading to the bot's agent address, with a daily USD spend cap and optional expiry. Every bot decision lands an audit event via `record_decision`; the owner can `revoke`/`update` at any time. |
| `deepmarket_contract` | Package entry module. |

### Key entry points

`market_factory`:
- `init_registry<Q>` — create the shared `MarketRegistry`
- `register_custom_market<Q, Y, N>` — register a market (takes YES/NO pool **addresses**, converted to IDs internally)
- `mint_outcome_tokens<Q, Y, N>` — deposit quote, receive equal YES + NO
- `resolve_market<Q, Y, N>` — admin-only, requires `&AdminCap`
- `redeem_yes<Q, Y, N>` / `redeem_no<Q, Y, N>` — redeem the winning side 1:1

All three type args are `[Q, Y, N]` (quote, YES type, NO type). Functions
use Move 2024 `ctx.sender()` method syntax.

`agent_cap`:
- `create` — share a new `AgentCap` (shared so the agent address can
  reference it in `record_decision`; `revoke`/`update` still assert
  `ctx.sender() == owner`)
- `record_decision` — append an `AgentDecisionMade` audit event
- `revoke` / `update` — owner-only policy control
- view fns: `owner`, `agent`, `daily_spend_cap_usd`, `expires_at_ms`,
  `is_revoked`, `is_active`

## Build & test

Requires the **Sui CLI**.

```bash
sui move build
sui move test
```

Dependencies (`Move.toml`) are pinned to `rev = "testnet-v1.60.0"` for
both `Sui` and `DeepBook`. CI installs the matching Sui CLI version.

## Deployed (testnet)

| Object | ID |
|---|---|
| Package (v3 — current, holds `agent_cap`) | `0x50a58add3954967d6c6480469b9fa78f3f7bb21fed9cda88323cdf7a87771c29` |
| `MarketRegistry` (shared) | `0x7e1eee1313ff5f27da5230372eb4560bad4e946bda06878134995203d489eb1d` |
| `AdminCap` | `0x7ee52b8cf3402349b6f65a8d98f9231cf1d3e0366f333c7408bfe3a3cda1450c` |
| `UpgradeCap` | `0xbe6b8bcd0ae60eb084427a4095aef779cc0ec1697bf924565fc13328046c541c` |

The package has been upgraded v1 → v2 → v3. Use **v3** for all calls
(`agent_cap` only exists there; `market_factory` is compatible across
versions). Before any future upgrade, bump `published-at` in `Move.toml`
to the latest package ID or publish fails with `PackageIDDoesNotMatch`.

> Markets also deploy a **per-market token package** (its own `yes_token`
> / `no_token`) at creation time — generated and built by the indexer's
> `builder.rs`, then published by the user's wallet. The IDs above are the
> shared protocol, not per-market packages.

See the [docs site](https://sui-stack-messaging.onrender.com) for the full
deployed-IDs table, DeepBook V3 / Predict IDs, and the market-creation flow.
