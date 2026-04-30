const API_URL = 'http://localhost:3000';

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
