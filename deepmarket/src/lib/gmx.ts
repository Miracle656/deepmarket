// GMX oracle keeper — public, unauthenticated BTC/ETH candle feed. Used for
// the candlestick view of the Predict oracle's underlying spot (Predict's own
// price feed is point-in-time; this gives real OHLC). Adapted from santos.

const BASE = 'https://arbitrum-api.gmxinfra.io';

export type Period = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface Candle {
    time: number; // unix seconds
    open: number;
    high: number;
    low: number;
    close: number;
}

interface CandlesResponse {
    period: Period;
    candles: [number, number, number, number, number][]; // [t, o, h, l, c]
}

/** Map a Predict underlying label to a GMX token symbol. */
export function gmxSymbol(underlying: string | undefined): string {
    const u = (underlying ?? '').toUpperCase();
    if (u.includes('ETH')) return 'ETH';
    if (u.includes('SOL')) return 'SOL';
    return 'BTC';
}

export async function fetchCandles(
    tokenSymbol: string,
    period: Period,
    limit: number,
    signal?: AbortSignal
): Promise<Candle[]> {
    const url = `${BASE}/prices/candles?tokenSymbol=${encodeURIComponent(
        tokenSymbol
    )}&period=${period}&limit=${limit}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`GMX candles ${res.status}`);
    const json: CandlesResponse = await res.json();
    return json.candles
        .map(([t, o, h, l, c]) => ({ time: t, open: o, high: h, low: l, close: c }))
        .sort((a, b) => a.time - b.time);
}
