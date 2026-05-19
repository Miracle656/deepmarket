// All on-chain IDs come from env vars injected by Vite.
export const CONFIG = {
    PACKAGE_ID: import.meta.env.VITE_PACKAGE_ID as string,
    YES_TREASURY_CAP: import.meta.env.VITE_YES_TREASURY_CAP as string,
    NO_TREASURY_CAP: import.meta.env.VITE_NO_TREASURY_CAP as string,
    UPGRADE_CAP: import.meta.env.VITE_UPGRADE_CAP as string,
    MARKET_REGISTRY: import.meta.env.VITE_MARKET_REGISTRY as string,
    ADMIN_CAP_OBJECT_ID: import.meta.env.VITE_ADMIN_CAP_ID as string,
    NETWORK: (import.meta.env.VITE_NETWORK ?? 'testnet') as 'testnet' | 'mainnet' | 'devnet',

    // Sui SUI coin type
    SUI_TYPE: '0x2::sui::SUI',

    // Clock object on Sui
    CLOCK: '0x6',

    // DeepBook V3 testnet constants
    DEEPBOOK_PACKAGE_ID: import.meta.env.VITE_DEEPBOOK_PACKAGE_ID as string
        ?? '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
    DEEPBOOK_REGISTRY_ID: import.meta.env.VITE_DEEPBOOK_REGISTRY_ID as string,
    DEEP_TOKEN_TYPE: import.meta.env.VITE_DEEP_TOKEN_TYPE as string,
    DEEP_SCALAR: 1_000_000n,     // 1 DEEP = 1,000,000 base units (6 decimals)
    DEEP_POOL_FEE: 500_000_000n, // 500 DEEP per pool (from POOL_CREATION_FEE_DEEP)
    // Whitelisted DEEP/SUI reference pool (testnet). Permissionless pools
    // import their DEEP price from this via pool::add_deep_price_point so
    // place_limit_order can compute fees. One-time per pool.
    DEEP_SUI_REFERENCE_POOL_ID:
        (import.meta.env.VITE_DEEP_SUI_REFERENCE_POOL_ID as string | undefined) ??
        '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f',

    // ── DeepBook Predict (testnet, predict-testnet-4-16 branch) ──
    PREDICT_PACKAGE_ID: '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138',
    PREDICT_REGISTRY_ID: '0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64',
    PREDICT_OBJECT_ID:   '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a',
    PREDICT_DUSDC_TYPE:  '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
    PREDICT_PLP_TYPE:    '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138::plp::PLP',
    PREDICT_SERVER_URL:  'https://predict-server.testnet.mystenlabs.com',
    DUSDC_DECIMALS: 6,
};

export type MarketStatus = 'Active' | 'Resolved';

export interface Market {
    objectId: string;
    id: number;
    question: string;
    resolutionTime: number;
    oracleFeed: string;
    status: MarketStatus;
    outcome: boolean | null;
    yesPrice: number; // 0–100 cents
    noPrice: number;
    volume: number;
    yesPoolId: string;
    noPoolId: string;
    tokenPackageId: string;
}
