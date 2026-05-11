# DeepMarket Telegram Bot

A lightweight notifier service that watches a user's positions on both:

- **Spot YES/NO markets** (via the DeepMarket indexer at `localhost:3000`)
- **DeepBook Predict oracles** (via `predict-server.testnet.mystenlabs.com`)

and DMs alerts to Telegram with deep-link buttons back into the DeepMarket
web app.

## Alerts

| Event | When |
|---|---|
| Strike crossed | BTC spot transitions across a strike where the user holds a position |
| Oracle near expiry | A user position's oracle is within 5 min of expiry |
| Oracle settled | Settlement freezes; user has redeemable winnings |
| Spot resolved | A market is resolved; user holds the winning side |
| Spot price move | A market the user holds moves ≥ 5¢ |

Each alert ends with a `→ Open in DeepMarket` button that deep-links to the
matching market/oracle page so the user can sign trades in the web flow.
(Autonomous on-chain trading is a future addition — would require a Move
session-key policy capping per-epoch spend.)

## Commands

- `/start <sui-address>` — register / re-register the chat's tracked address
- `/positions` — current snapshot of Spot + Predict positions
- `/mute` / `/unmute` — pause / resume alerts
- `/stop` — delete the subscription entirely

## Run

```bash
cp .env.example .env
# fill in BOT_TOKEN from @BotFather (https://t.me/BotFather → /newbot)
npm install
npm run dev
```

`subs.json` is created on first run and persists subscriptions across
restarts.

## Architecture

```
src/
  config.ts      env loader
  store.ts      JSON-file subscription store + alert-state cache
  predict.ts    Predict server client
  spot.ts       indexer client
  alerts.ts     message + inline-keyboard builders
  watchers.ts   30s poll loop (Predict + Spot in parallel)
  index.ts      Telegraf bot + command handlers
```
