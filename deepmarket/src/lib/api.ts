// Indexer base URL — set VITE_INDEXER_URL in .env for deploys.
// Exported so other modules don't have to duplicate the fallback logic.
export const INDEXER_URL =
    (import.meta.env.VITE_INDEXER_URL as string | undefined) ??
    'http://localhost:3000';

const API_URL = INDEXER_URL;

export interface CompileResult {
    modules: string[];
    dependencies: string[];
}

export async function compileMarket(marketName: string): Promise<CompileResult> {
    const res = await fetch(`${API_URL}/api/compile-market`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market_name: marketName }),
    });

    const data = await res.json();
    if (!data.success) {
        throw new Error(data.error || 'Failed to compile market');
    }

    return {
        modules: data.modules,
        dependencies: data.dependencies,
    };
}

/**
 * Compile a per-market token package for a multi-outcome (any-N) market. The
 * indexer emits one OTW `Coin` module per outcome (`outcome_0 … outcome_{n-1}`,
 * witnesses `OUTCOME_0 …`), each 9-decimal. The caller publishes the result,
 * harvests the N `TreasuryCap`s + package id, then drives the
 * `outcome_market::create_market` + `add_outcome`×N + `share_market` PTB.
 */
export async function compileOutcomeMarket(
    marketName: string,
    outcomes: string[],
): Promise<CompileResult> {
    const res = await fetch(`${API_URL}/api/compile-outcome-market`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market_name: marketName, outcomes }),
    });

    const data = await res.json();
    if (!data.success) {
        throw new Error(data.error || 'Failed to compile outcome market');
    }

    return {
        modules: data.modules,
        dependencies: data.dependencies,
    };
}
