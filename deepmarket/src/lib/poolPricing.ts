// Live DeepBook pool pricing.
//
// The indexer only tracks market_factory events, so a market's displayed
// odds were a static 50¢ even when there were real orders on the book.
// This reads the YES pool's price straight from DeepBook via devInspect:
//
//   - pool::mid_price(pool, clock): u64        — mid of best bid/ask
//   - pool::get_level2_ticks_from_mid(pool, n, clock)
//        : (bidPx[], bidQty[], askPx[], askQty[])  — fallback when the
//          book is one-sided (mid_price aborts without both sides)
//
// On-chain price is scaled the same as our limit orders: humanPrice =
// raw / 1e9 (FLOAT_SCALAR 1e9 * quoteScalar 1e9 / baseScalar 1e9 — the
// YES/NO tokens are 9-decimal, same as SUI). For a YES/SUI pool that
// human price IS the implied probability of YES (0..1).

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { testnetPackageIds } from '@mysten/deepbook-v3';
import type { useSuiClient } from '@mysten/dapp-kit';

type SuiClient = ReturnType<typeof useSuiClient>;

const DEEPBOOK = testnetPackageIds.DEEPBOOK_PACKAGE_ID;
const PRICE_SCALE = 1e9; // raw -> human (SUI per share); 9-dec base & quote
const ZERO_ADDR =
    '0x0000000000000000000000000000000000000000000000000000000000000000';

const poolTypeCache = new Map<string, [string, string]>();

async function poolTypeArgs(
    client: SuiClient,
    poolId: string
): Promise<[string, string] | null> {
    const cached = poolTypeCache.get(poolId);
    if (cached) return cached;
    const obj = await client.getObject({ id: poolId, options: { showType: true } });
    const m = obj.data?.type?.match(/<(.+),\s*(.+)>/);
    if (!m) return null;
    const pair: [string, string] = [m[1].trim(), m[2].trim()];
    poolTypeCache.set(poolId, pair);
    return pair;
}

function isZeroPool(poolId?: string): boolean {
    return !poolId || /^0x0+$/.test(poolId);
}

export interface BookLevel {
    /** Price as a YES probability in cents, 0–100. */
    price: number;
    /** Resting size in YES shares. */
    size: number;
}

export interface OrderBookData {
    bids: BookLevel[]; // best (highest) first
    asks: BookLevel[]; // best (lowest) first
}

/**
 * Live order book for a YES pool, read via `pool::get_level2_ticks_from_mid`.
 * `ticks` price levels each side of the mid. Prices are converted to YES
 * cents (raw/1e9*100) and sizes to shares (raw/1e9). Returns null when the
 * pool is unconfigured/unreadable; empty arrays when a side has no orders.
 */
export async function getOrderBookFromPool(
    client: SuiClient,
    yesPoolId: string,
    ticks = 12
): Promise<OrderBookData | null> {
    if (isZeroPool(yesPoolId)) return null;
    const types = await poolTypeArgs(client, yesPoolId);
    if (!types) return null;

    try {
        const tx = new Transaction();
        tx.moveCall({
            target: `${DEEPBOOK}::pool::get_level2_ticks_from_mid`,
            typeArguments: types,
            arguments: [tx.object(yesPoolId), tx.pure.u64(ticks), tx.object('0x6')],
        });
        const r = await client.devInspectTransactionBlock({
            sender: ZERO_ADDR,
            transactionBlock: tx,
        });
        if (r.effects?.status?.status !== 'success') return null;
        const rv = r.results?.[0]?.returnValues;
        if (!rv || rv.length < 4) return null;

        const vecU64 = bcs.vector(bcs.u64());
        const col = (i: number) =>
            (vecU64.parse(new Uint8Array(rv[i][0])) as string[]).map(Number);
        const bidPx = col(0);
        const bidQty = col(1);
        const askPx = col(2);
        const askQty = col(3);

        const level = (px: number, qty: number): BookLevel => ({
            price: (px / PRICE_SCALE) * 100,
            size: qty / PRICE_SCALE,
        });
        const bids = bidPx
            .map((p, i) => level(p, bidQty[i] ?? 0))
            .filter(l => l.size > 0);
        const asks = askPx
            .map((p, i) => level(p, askQty[i] ?? 0))
            .filter(l => l.size > 0);

        return { bids, asks };
    } catch {
        return null;
    }
}

/**
 * Implied YES probability (0–100) read live from the pool's order book.
 * Returns null when the pool is unconfigured, empty, or unreadable — the
 * caller should fall back to its existing default in that case.
 */
export async function getYesPercentFromPool(
    client: SuiClient,
    yesPoolId: string
): Promise<number | null> {
    if (isZeroPool(yesPoolId)) return null;
    const types = await poolTypeArgs(client, yesPoolId);
    if (!types) return null;

    const toPct = (raw: number): number => {
        const human = raw / PRICE_SCALE; // SUI per YES = P(YES)
        return Math.min(99, Math.max(1, Math.round(human * 100)));
    };

    // 1. mid_price — works when the book has both a bid and an ask.
    try {
        const tx = new Transaction();
        tx.moveCall({
            target: `${DEEPBOOK}::pool::mid_price`,
            typeArguments: types,
            arguments: [tx.object(yesPoolId), tx.object('0x6')],
        });
        const r = await client.devInspectTransactionBlock({
            sender: ZERO_ADDR,
            transactionBlock: tx,
        });
        if (r.effects?.status?.status === 'success') {
            const ret = r.results?.[0]?.returnValues;
            const bytes = ret?.[0]?.[0];
            if (bytes) {
                const mid = Number(bcs.u64().parse(new Uint8Array(bytes)));
                if (mid > 0) return toPct(mid);
            }
        }
    } catch {
        /* fall through to level2 */
    }

    // 2. One-sided book — derive from best bid / best ask.
    try {
        const tx = new Transaction();
        tx.moveCall({
            target: `${DEEPBOOK}::pool::get_level2_ticks_from_mid`,
            typeArguments: types,
            arguments: [tx.object(yesPoolId), tx.pure.u64(1), tx.object('0x6')],
        });
        const r = await client.devInspectTransactionBlock({
            sender: ZERO_ADDR,
            transactionBlock: tx,
        });
        if (r.effects?.status?.status !== 'success') return null;
        const rv = r.results?.[0]?.returnValues;
        if (!rv || rv.length < 4) return null;
        const vecU64 = bcs.vector(bcs.u64());
        const bidPx = (vecU64.parse(new Uint8Array(rv[0][0])) as string[]).map(Number);
        const askPx = (vecU64.parse(new Uint8Array(rv[2][0])) as string[]).map(Number);
        const bestBid = bidPx[0] ?? 0;
        const bestAsk = askPx[0] ?? 0;
        if (bestBid > 0 && bestAsk > 0) return toPct((bestBid + bestAsk) / 2);
        if (bestBid > 0) return toPct(bestBid);
        if (bestAsk > 0) return toPct(bestAsk);
        return null;
    } catch {
        return null;
    }
}
