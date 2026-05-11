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

    // Move package constants — must match the deployed Predict instance
    PREDICT_PACKAGE_ID:
        '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138',
    PREDICT_DUSDC_TYPE:
        '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
    DUSDC_DECIMALS: 6,
    CLOCK: '0x6',
};
