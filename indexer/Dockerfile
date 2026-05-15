# DeepMarket indexer — Render-deployable container.
#
# Two-stage build: rust:slim-bookworm compiles the binary, then a minimal
# debian:bookworm-slim runtime carries it. The sui-sdk git dependency
# pulls in a lot, so first build is ~5-10 min; subsequent builds reuse
# Docker layer cache as long as Cargo.toml/Cargo.lock don't change.

# ──────────────────────────── Builder ─────────────────────────────────
FROM rust:1.83-slim-bookworm AS builder

WORKDIR /app

# Build deps: pkg-config + libssl-dev for reqwest + sqlx native-tls,
# git for sui-sdk's git dependency.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

# Pre-fetch deps so source-only edits don't blow the cache.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo "fn main() { println!(\"stub\"); }" > src/main.rs \
    && cargo build --release \
    && rm -rf src target/release/deps/indexer* target/release/indexer*

# Real source
COPY src ./src
RUN cargo build --release

# ──────────────────────────── Runtime ─────────────────────────────────
FROM debian:bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/indexer /usr/local/bin/indexer

ENV RUST_LOG=info
# Render injects $PORT; we bind to it. EXPOSE is purely documentary.
EXPOSE 3000

CMD ["indexer"]
