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
