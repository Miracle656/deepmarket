// Env config — loaded once at startup.

import 'dotenv/config';

function required(name: string): string {
    const v = process.env[name];
    if (!v) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return v;
}

export const CONFIG = {
    BOT_TOKEN: required('BOT_TOKEN'),
    INDEXER_URL: process.env.INDEXER_URL ?? 'http://localhost:3000',
    PREDICT_SERVER_URL:
        process.env.PREDICT_SERVER_URL ??
        'https://predict-server.testnet.mystenlabs.com',
    PREDICT_OBJECT_ID:
        process.env.PREDICT_OBJECT_ID ??
        '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a',
    WEB_URL: process.env.WEB_URL ?? 'http://localhost:5174',
    POLL_MS: Number(process.env.POLL_MS ?? 30000),
    STORE_PATH: process.env.STORE_PATH ?? './subs.json',

    // ── Bot trader ─────────────────────────────────────────────────
    BOT_SUI_PRIVATE_KEY: process.env.BOT_SUI_PRIVATE_KEY ?? '',
    BOT_STATE_PATH: process.env.BOT_STATE_PATH ?? './bot-state.json',
    SUI_RPC_URL:
        process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
    STRATEGY_ENABLED: (process.env.STRATEGY_ENABLED ?? 'false') === 'true',
    STRATEGY_BUFFER_TICKS: Number(process.env.STRATEGY_BUFFER_TICKS ?? 3),
    STRATEGY_QTY_USD: Number(process.env.STRATEGY_QTY_USD ?? 0.5),
    STRATEGY_TICK_MS: Number(process.env.STRATEGY_TICK_MS ?? 60000),

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
};
