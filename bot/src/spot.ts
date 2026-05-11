// Spot YES/NO market indexer client.

import { CONFIG } from './config.js';

export type SpotStatus = 'Active' | 'Resolved';

export interface SpotMarket {
    objectId: string;
    id: number;
    question: string;
    resolutionTime: number;
    oracleFeed: string;
    status: SpotStatus;
    outcome: boolean | null;
    yesPrice: number; // 0-100 cents
    noPrice: number;
    volume: number;
    yesPoolId: string;
    noPoolId: string;
    tokenPackageId: string;
}

export interface SpotPosition {
    yes_balance: number;
    no_balance: number;
}

async function fetchJson<T>(path: string): Promise<T | null> {
    try {
        const res = await fetch(`${CONFIG.INDEXER_URL}${path}`);
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

export async function listMarkets(): Promise<SpotMarket[]> {
    const data = await fetchJson<SpotMarket[]>(`/markets`);
    return data ?? [];
}

export async function getMarketPosition(
    marketId: number,
    address: string
): Promise<SpotPosition | null> {
    return fetchJson<SpotPosition>(`/markets/${marketId}/positions/${address}`);
}

/** Returns YES balance + NO balance as plain numbers (already divided by 1e9). */
export function decodeBalance(p: SpotPosition | null): {
    yes: number;
    no: number;
} {
    if (!p) return { yes: 0, no: 0 };
    return {
        yes: Number(p.yes_balance ?? 0) / 1e9,
        no: Number(p.no_balance ?? 0) / 1e9,
    };
}
