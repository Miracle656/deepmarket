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
// raw / 1e12 (FLOAT_SCALAR 1e9 * quoteScalar 1e9 / baseScalar 1e6). For a
// YES/SUI pool that human price IS the implied probability of YES (0..1).

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { testnetPackageIds } from '@mysten/deepbook-v3';
import type { useSuiClient } from '@mysten/dapp-kit';

type SuiClient = ReturnType<typeof useSuiClient>;

const DEEPBOOK = testnetPackageIds.DEEPBOOK_PACKAGE_ID;
const PRICE_SCALE = 1e12; // raw -> human (SUI per share)
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
