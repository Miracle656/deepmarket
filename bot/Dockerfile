# DeepMarket Telegram bot — Render-deployable container.
#
# Two-stage Node build: TypeScript compiles in the builder, the slim
# runtime carries dist/ + production node_modules + the static .env.
# When deployed, WEBHOOK_DOMAIN is set in Render → the bot serves an
# Express server on $PORT and Telegram pushes updates to it. Locally
# the same code falls back to long-polling.

# ──────────────────────────── Builder ─────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install all deps (including dev) so tsx/tsc can run.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Compile to dist/
RUN npx tsc

# ──────────────────────────── Runtime ─────────────────────────────────
FROM node:20-bookworm-slim

WORKDIR /app

# Production deps only — smaller image, faster cold-start.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
# Render injects $PORT; the bot honors it. EXPOSE is documentary only.
EXPOSE 3002

CMD ["node", "dist/index.js"]
