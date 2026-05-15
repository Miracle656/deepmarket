# DeepMarket indexer — Render-deployable container.
#
# Two-stage: rust:slim-bookworm compiles the binary, debian:bookworm-slim
# carries it. The sui-sdk git dependency is pinned to a tag, so the build
# is deterministic; first build is ~5-10 min, Render's Docker layer cache
# speeds subsequent ones up considerably.

# ──────────────────────────── Builder ─────────────────────────────────
FROM rust:1.83-slim-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

# Cargo.toml's git deps are tag-pinned so resolution is deterministic
# regardless of upstream branch movement. We don't pass --locked so
# Cargo can refresh the lockfile if it doesn't match Cargo.toml's source
# pins (e.g., a branch → tag migration).
COPY Cargo.toml Cargo.lock ./
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
# Render injects $PORT; the binary honors it. EXPOSE is documentary only.
EXPOSE 3000

CMD ["indexer"]
