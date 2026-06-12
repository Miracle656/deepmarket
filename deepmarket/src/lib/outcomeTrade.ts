// DeepBook order-book helpers for multi-outcome markets.
//
// Each outcome of an OutcomeMarket can have its own DeepBook pool
// (base = that outcome's 9-decimal token, quote = SUI). The token price on
// that book — SUI per token, 0..1 — IS the implied probability of the
// outcome. These helpers build the one-time "enable trading" tx and the
// limit-order tx, reusing the exact scaling/fee conventions proven out in
// the binary-market TradeSidebar.
import { Transaction } from '@mysten/sui/transactions';
import { testnetPackageIds } from '@mysten/deepbook-v3';
import type { SuiJsonRpcClient as SuiClient } from '@mysten/sui/jsonRpc';
import { CONFIG } from './config';

const DEEPBOOK = testnetPackageIds.DEEPBOOK_PACKAGE_ID;
const CLOCK = '0x6';
const ZERO_RE = /^0x0+$/;

// DeepBook emits OrderFilled from its *implementation* package's order_info
// module (distinct from the call-package id used for moveCall targets).
const DEEPBOOK_EVENT_PKG = '0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982';

export interface PoolFill {
    poolId: string;
    price: number;     // SUI per token, 0–1 (== implied probability)
    baseQty: number;   // tokens traded
    quoteQty: number;  // SUI traded
    digest: string;
    ts: number;        // ms
}

/**
 * Recent DeepBook fills for the given pools.
 *
 * There's no server-side pool filter on `queryEvents`, and this testnet
 * fullnode doesn't index `queryTransactionBlocks` by InputObject/ChangedObject
 * for shared pools — so we page the global order_info stream (newest first)
 * and keep fills whose pool_id is one of ours. We stop early once a page yields
 * none of ours *after* we've already found some (a cheap "we've passed our
 * window" heuristic), else scan up to `maxPages`.
 *
 * NOTE: this can still miss old fills if an unrelated market floods the stream.
 * The durable fix is to index the outcome pools server-side (the Rust indexer
 * already ingests OrderFilled for binary pools) — tracked as a follow-up.
 */
export async function fetchPoolFills(
    client: SuiClient,
    poolIds: string[],
    maxPages = 12,
): Promise<PoolFill[]> {
    const wanted = new Set(poolIds.filter(p => !isZeroPool(p)));
    if (wanted.size === 0) return [];
    const out: PoolFill[] = [];
    let cursor: any = null;
    for (let page = 0; page < maxPages; page++) {
        const res: any = await client.queryEvents({
            query: { MoveEventType: `${DEEPBOOK_EVENT_PKG}::order_info::OrderFilled` },
            order: 'descending',
            limit: 50,
            cursor,
        });
        let hitThisPage = 0;
        for (const ev of res.data) {
            const j = ev.parsedJson as any;
            if (j?.pool_id && wanted.has(j.pool_id)) {
                hitThisPage++;
                out.push({
                    poolId: j.pool_id,
                    price: Number(j.price ?? 0) / 1e9,
                    baseQty: Number(j.base_quantity ?? 0) / 1e9,
                    quoteQty: Number(j.quote_quantity ?? 0) / 1e9,
                    digest: ev.id?.txDigest ?? '',
                    ts: Number(ev.timestampMs ?? 0),
                });
            }
        }
        // Once we've collected some fills and a whole page has none of ours,
        // we've scrolled past our market's activity — stop paging.
        if (out.length > 0 && hitThisPage === 0) break;
        if (!res.hasNextPage || !res.nextCursor) break;
        cursor = res.nextCursor;
    }
    return out;
}

// Pool params — identical to the binary markets so the books behave the same.
export const TICK_SIZE = 1_000n;
export const LOT_SIZE = 1_000_000n;
export const MIN_SIZE = 1_000_000n;

// Order-book scaling. Outcome tokens and SUI are both 9-decimal, so with
// FLOAT_SCALAR = 1e9:  inputPrice = price * 1e9,  inputQty = qty * 1e9.
const FLOAT_SCALAR = 1e9;
const BASE_SCALAR = 1e9;
const QUOTE_SCALAR = 1e9;
const MAX_TIMESTAMP = 1844674407370955161n;
const DEEP_FEE_DEPOSIT = 1_000_000n; // 1 DEEP (6-dec) buffer per order

export function isZeroPool(p?: string): boolean {
    return !p || ZERO_RE.test(p);
}

async function poolTypes(client: SuiClient, poolId: string): Promise<{ base: string; quote: string }> {
    const obj = await client.getObject({ id: poolId, options: { showType: true } });
    const m = obj.data?.type?.match(/<(.+),\s*(.+)>/);
    if (!m) throw new Error('Could not determine pool type from network');
    return { base: m[1].trim(), quote: m[2].trim() };
}

/**
 * One-time setup so a wallet can trade these pools: create a BalanceManager
 * (if it has none) and seed the DEEP/SUI price reference on each pool so
 * fees can be computed (permissionless pools start with no price point).
 */
export async function buildEnableOutcomeTradingTx(
    client: SuiClient,
    sender: string,
    managerId: string | null,
    poolIds: string[],
): Promise<Transaction> {
    const tx = new Transaction();
    tx.setSender(sender);

    if (!managerId) {
        const mgr = tx.moveCall({
            target: `${DEEPBOOK}::balance_manager::new`,
            arguments: [],
        });
        tx.transferObjects([mgr], sender);
    }

    for (const poolId of poolIds) {
        if (isZeroPool(poolId)) continue;
        const { base, quote } = await poolTypes(client, poolId);
        tx.moveCall({
            target: `${DEEPBOOK}::pool::add_deep_price_point`,
            arguments: [tx.object(poolId), tx.object(CONFIG.DEEP_SUI_REFERENCE_POOL_ID), tx.object(CLOCK)],
            typeArguments: [base, quote, CONFIG.DEEP_TOKEN_TYPE, CONFIG.SUI_TYPE],
        });
    }
    return tx;
}

/**
 * Post a resting limit order on an outcome's pool.
 *  - bid (buy):  deposit QUOTE (SUI) = price * qty as collateral
 *  - ask (sell): deposit BASE (qty outcome tokens) as collateral
 * Always deposits a small DEEP buffer (non-whitelisted pools require
 * pay_with_deep = true). Quantity is floored to the pool lot size.
 */
export async function buildOutcomeLimitOrderTx(
    client: SuiClient,
    sender: string,
    managerId: string,
    poolId: string,
    isBid: boolean,
    price: number,
    qty: number,
): Promise<Transaction> {
    if (!(price > 0) || !(qty > 0)) throw new Error('Enter a price and quantity');
    if (price >= 1) throw new Error('Price must be between 0 and 1 (SUI per token)');

    const { base, quote } = await poolTypes(client, poolId);

    const inputPrice = BigInt(Math.round(price * FLOAT_SCALAR * QUOTE_SCALAR / BASE_SCALAR));
    const rawQty = BigInt(Math.round(qty * BASE_SCALAR));
    const inputQuantity = (rawQty / LOT_SIZE) * LOT_SIZE; // floor to a whole lot
    if (inputQuantity <= 0n) throw new Error('Quantity too small for one lot (0.001 min)');

    const tx = new Transaction();
    tx.setSender(sender);

    if (isBid) {
        const quoteMist = BigInt(Math.round(price * qty * QUOTE_SCALAR));
        const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(quoteMist)]);
        tx.moveCall({
            target: `${DEEPBOOK}::balance_manager::deposit`,
            arguments: [tx.object(managerId), c],
            typeArguments: [quote],
        });
    } else {
        const coins = await client.getCoins({ owner: sender, coinType: base });
        if (coins.data.length === 0) throw new Error('You hold none of this outcome token to post an ask');
        const refs = coins.data.map((c: { coinObjectId: string }) => tx.object(c.coinObjectId));
        const primary = refs[0];
        if (refs.length > 1) tx.mergeCoins(primary, refs.slice(1));
        const [baseIn] = tx.splitCoins(primary, [tx.pure.u64(inputQuantity)]);
        tx.moveCall({
            target: `${DEEPBOOK}::balance_manager::deposit`,
            arguments: [tx.object(managerId), baseIn],
            typeArguments: [base],
        });
    }

    // DEEP fee buffer.
    const deepCoins = await client.getCoins({ owner: sender, coinType: CONFIG.DEEP_TOKEN_TYPE });
    if (deepCoins.data.length === 0) throw new Error('No DEEP in wallet — DeepBook fees are paid in DEEP');
    const deepRefs = deepCoins.data.map((c: { coinObjectId: string }) => tx.object(c.coinObjectId));
    const deepPrimary = deepRefs[0];
    if (deepRefs.length > 1) tx.mergeCoins(deepPrimary, deepRefs.slice(1));
    const [deepIn] = tx.splitCoins(deepPrimary, [tx.pure.u64(DEEP_FEE_DEPOSIT)]);
    tx.moveCall({
        target: `${DEEPBOOK}::balance_manager::deposit`,
        arguments: [tx.object(managerId), deepIn],
        typeArguments: [CONFIG.DEEP_TOKEN_TYPE],
    });

    const proof = tx.moveCall({
        target: `${DEEPBOOK}::balance_manager::generate_proof_as_owner`,
        arguments: [tx.object(managerId)],
    });

    tx.moveCall({
        target: `${DEEPBOOK}::pool::place_limit_order`,
        arguments: [
            tx.object(poolId),
            tx.object(managerId),
            proof,
            tx.pure.u64(Date.now()),       // client_order_id
            tx.pure.u8(0),                 // order_type: GTC
            tx.pure.u8(0),                 // self_matching: allowed
            tx.pure.u64(inputPrice),
            tx.pure.u64(inputQuantity),
            tx.pure.bool(isBid),
            tx.pure.bool(true),            // pay_with_deep
            tx.pure.u64(MAX_TIMESTAMP),
            tx.object(CLOCK),
        ],
        typeArguments: [base, quote],
    });

    return tx;
}

/**
 * Seed (or refresh) the DEEP/SUI price reference on a pool. Permissionless
 * pools start with NO price point, so the first `place_*_order` aborts in
 * `deep_price::calculate_order_deep_price` (abort code 2, ENoDataPoints).
 * Importing the rate once primes the pool; points also age out, so this is
 * occasionally needed again. Idempotent-ish: re-running within the min
 * interval aborts with code 1 (EDataPointRecentlyAdded), which the caller
 * treats as "already primed".
 */
export async function buildSyncDeepPriceTx(
    client: SuiClient,
    sender: string,
    poolId: string,
): Promise<Transaction> {
    const { base, quote } = await poolTypes(client, poolId);
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
        target: `${DEEPBOOK}::pool::add_deep_price_point`,
        arguments: [tx.object(poolId), tx.object(CONFIG.DEEP_SUI_REFERENCE_POOL_ID), tx.object(CLOCK)],
        typeArguments: [base, quote, CONFIG.DEEP_TOKEN_TYPE, CONFIG.SUI_TYPE],
    });
    return tx;
}

/**
 * Sweep settled balances out of the BalanceManager back into the wallet.
 * After a fill, the bought base token / sold SUI sits idle in the manager;
 * this withdraws the pool's base, quote and any leftover DEEP to the owner.
 */
export async function buildClaimBalancesTx(
    client: SuiClient,
    sender: string,
    managerId: string,
    poolId: string,
): Promise<Transaction> {
    const { base, quote } = await poolTypes(client, poolId);
    const tx = new Transaction();
    tx.setSender(sender);
    for (const t of [base, quote, CONFIG.DEEP_TOKEN_TYPE]) {
        const out = tx.moveCall({
            target: `${DEEPBOOK}::balance_manager::withdraw_all`,
            arguments: [tx.object(managerId)],
            typeArguments: [t],
        });
        tx.transferObjects([out], sender);
    }
    return tx;
}
