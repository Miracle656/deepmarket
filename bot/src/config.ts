// Env config — loaded once at startup.

import 'dotenv/config';

function required(name: string): string {
    const v = process.env[name];
    if (!v) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return v;
}

/**
 * Env var with default — treats empty string AND whitespace-only AS missing.
 * Plain `??` only catches null/undefined, so Render env vars typo'd as
 * `SUI_RPC_URL=` (empty value) would pass through as "" and fail fetch URL
 * parsing downstream. This guards against that class of failure.
 */
function envOr(name: string, fallback: string): string {
    const v = process.env[name]?.trim();
    return v && v.length > 0 ? v : fallback;
}

export const CONFIG = {
    BOT_TOKEN: required('BOT_TOKEN'),
    INDEXER_URL: envOr('INDEXER_URL', 'http://localhost:3000'),
    PREDICT_SERVER_URL: envOr(
        'PREDICT_SERVER_URL',
        'https://predict-server.testnet.mystenlabs.com'
    ),
    PREDICT_OBJECT_ID: envOr(
        'PREDICT_OBJECT_ID',
        '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a'
    ),
    WEB_URL: envOr('WEB_URL', 'http://localhost:5174'),
    POLL_MS: Number(process.env.POLL_MS ?? 30000),
    STORE_PATH: envOr('STORE_PATH', './subs.json'),

    // ── Bot trader ─────────────────────────────────────────────────
    // Each Telegram chat owns its own custodial keypair (stored in subs.json
    // via user-wallet.ts) — there is no global bot wallet. Strategy enabling
    // is per-chat via the inline "▶️ Start strategy" button, not an env var.
    SUI_RPC_URL: envOr('SUI_RPC_URL', 'https://fullnode.testnet.sui.io:443'),
    STRATEGY_BUFFER_TICKS: Number(process.env.STRATEGY_BUFFER_TICKS ?? 3),
    STRATEGY_QTY_USD: Number(process.env.STRATEGY_QTY_USD ?? 0.5),
    STRATEGY_TICK_MS: Number(process.env.STRATEGY_TICK_MS ?? 60000),
    /**
     * DEMO ONLY — bypass the edge bar and force a small deterministic mint
     * so the end-to-end flow is visible on demand even when the vault is
     * pricing every table at ~100% implied (no real edge). NEVER leave on for
     * real trading: the forced mints are -EV. Off unless DEMO_MODE=true.
     */
    DEMO_MODE: (process.env.DEMO_MODE ?? '').toLowerCase() === 'true',
    /**
     * Shared secret to drive a strategy tick over HTTP: GET /tick?key=<secret>.
     * Lets an external scheduler (cron-job.org / UptimeRobot) run the loop on
     * hosts that sleep idle instances (Render free), where setInterval can't be
     * trusted. Empty → the /tick endpoint is disabled (403).
     */
    TICK_SECRET: process.env.TICK_SECRET ?? '',

    // Service fee — bot charges a small dUSDC fee per mint, paid to a
    // treasury address. Covers API + RPC + Walrus costs. Leave
    // BOT_TREASURY_ADDRESS empty to disable.
    BOT_TREASURY_ADDRESS: process.env.BOT_TREASURY_ADDRESS ?? '',
    BOT_FEE_BPS: Number(process.env.BOT_FEE_BPS ?? 100), // 100 bps = 1%

    // ── LLM agent (Claude) ────────────────────────────────────────
    // When ANTHROPIC_API_KEY is set + AGENT_ENABLED=true, the strategy
    // tick consults Claude for each user's mint decision. When the key
    // is missing the loop falls back to the rule-based pickStrike path.
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
    AGENT_ENABLED: (process.env.AGENT_ENABLED ?? 'true') === 'true',
    AGENT_MODEL: process.env.AGENT_MODEL ?? 'claude-opus-4-7',
    /** Soft cap — agent stops minting after this many USD of new exposure per user per hour. */
    AGENT_MAX_USD_PER_HOUR: Number(process.env.AGENT_MAX_USD_PER_HOUR ?? 5),
    /**
     * HARD cap — total USD of cover a user's agent may mint per UTC day,
     * across EVERY path (LLM + fallback). Fallback when the on-chain
     * AgentCap has no dailySpendCapUsd set. The AgentCap value, when > 0,
     * always overrides this.
     */
    AGENT_MAX_USD_PER_DAY: Number(process.env.AGENT_MAX_USD_PER_DAY ?? 3),
    AGENT_MEMORY_PATH: process.env.AGENT_MEMORY_PATH ?? './agent-memory.json',

    // ── MemWal (Walrus-backed semantic memory) ────────────────────
    // When all three are set, every settled trade is written as a
    // natural-language memory via MemWal and the agent recalls the
    // most relevant ones at decision time. Falls back silently when
    // any field is missing.
    MEMWAL_ACCOUNT_ID: process.env.MEMWAL_ACCOUNT_ID ?? '',
    MEMWAL_DELEGATE_KEY: process.env.MEMWAL_DELEGATE_KEY ?? '',
    MEMWAL_SERVER_URL:
        process.env.MEMWAL_SERVER_URL ?? 'https://relayer.staging.memwal.ai',
    MEMWAL_NAMESPACE: process.env.MEMWAL_NAMESPACE ?? 'deepmarket-bot',
    /** How many recalled memories to inject into the agent prompt. */
    MEMWAL_RECALL_LIMIT: Number(process.env.MEMWAL_RECALL_LIMIT ?? 5),

    // ── AgentCap (on-chain policy object + audit log) ─────────────
    // deepmarket_contract v3 — the package holding the agent_cap module.
    // The bot calls agent_cap::record_decision after each mint so every
    // decision lands an AgentDecisionMade event on-chain. If a user's cap
    // is revoked on-chain, the strategy loop stops trading for them.
    AGENT_CAP_PACKAGE_ID:
        process.env.AGENT_CAP_PACKAGE_ID ??
        '0x50a58add3954967d6c6480469b9fa78f3f7bb21fed9cda88323cdf7a87771c29',

    // Move package constants — must match the deployed Predict instance
    PREDICT_PACKAGE_ID:
        '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138',
    PREDICT_DUSDC_TYPE:
        '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
    DUSDC_DECIMALS: 6,
    CLOCK: '0x6',
    SUI_TYPE: '0x2::sui::SUI',

    // ── FIFA / multi-outcome market (outcome_market module) ───────────
    // The deepmarket_contract v4 package that holds outcome_market, and the
    // shared OutcomeMarket the bots trade. FIFA_MARKET_ID is overridable so
    // the fleet can be pointed at any multi-outcome market.
    OUTCOME_PACKAGE_ID: envOr(
        'OUTCOME_PACKAGE_ID',
        '0x8c02107957d0190d6faa05e6299991b6693e11583a3361c1b8be4ae3ef4ba190'
    ),
    FIFA_MARKET_ID: envOr(
        'FIFA_MARKET_ID',
        '0x8b592604f3492b69e1b566f77d94e29bf68c316757961c1255da4c3444effdad'
    ),
    FIFA_TICK_MS: Number(process.env.FIFA_TICK_MS ?? 60000),
    /** Default SUI per stake / order the FIFA bot uses. */
    FIFA_QTY_SUI: Number(process.env.FIFA_QTY_SUI ?? 1),

    // ── DeepBook V3 (for the FIFA order-book half) ────────────────────
    DEEPBOOK_PACKAGE_ID:
        '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
    // Implementation package that *emits* events / defines on-chain types.
    DEEPBOOK_EVENT_PKG:
        '0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982',
    DEEP_TOKEN_TYPE:
        '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
    DEEP_SUI_REFERENCE_POOL_ID:
        '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f',
};
