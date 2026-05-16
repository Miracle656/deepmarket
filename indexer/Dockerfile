# DeepMarket indexer — Render-deployable container.
#
# Two-stage: rust:slim-bookworm compiles the binary, debian:bookworm-slim
# carries it. The sui-sdk git dependency is pinned to a tag, so the build
# is deterministic; first build is ~5-10 min, Render's Docker layer cache
# speeds subsequent ones up considerably.

# ──────────────────────────── Builder ─────────────────────────────────
# Minimum Rust: 1.88. Two reasons stack:
#   1. sui-sdk at testnet-v1.67.2 declares edition = "2024" (stabilized in 1.85)
#   2. The lockfile pins recent transitive deps (home 0.5.12, time 0.3.47,
#      time-core 0.1.8) that hard-require rustc 1.88
# Picking 1.90 to give headroom against future patch-version transitive bumps.
FROM rust:1.90-slim-bookworm AS builder

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
