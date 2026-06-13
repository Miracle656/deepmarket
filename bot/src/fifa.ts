// FIFA / multi-outcome market client for the bot — readers + tx builders for
// the `outcome_market` module and its per-outcome DeepBook pools. Ported from
// the frontend lib/outcome.ts + lib/outcomeTrade.ts; builders RETURN a
// Transaction that fifa-strategy.ts signs with the user's custodial keypair.

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { getSuiClient } from './sui.js';
import { CONFIG } from './config.js';

const DEEPBOOK = CONFIG.DEEPBOOK_PACKAGE_ID;
const PKG = CONFIG.OUTCOME_PACKAGE_ID;
const CLOCK = CONFIG.CLOCK;
const SUI = CONFIG.SUI_TYPE;
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Order/price scaling (outcome tokens + SUI are both 9-decimal).
const LOT = 1_000_000n;
const FLOAT_SCALAR = 1e9;
const MAX_TS = 1844674407370955161n;
const DEEP_FEE = 1_000_000n; // 1 DEEP buffer per order

export interface FifaMarket {
    objectId: string;
    question: string;
    outcomeNames: string[];
    n: number;
    status: number;        // 0 active, 1 resolved
    winner: number | null;
    vault: bigint;
    totalStaked: bigint[];
    pools: string[];
    tokenPackageId: string;
}

export const outcomeCoinType = (pkg: string, idx: number) =>
    `${pkg}::outcome_${idx}::OUTCOME_${idx}`;

export const isZeroPool = (p?: string) => !p || /^0x0+$/.test(p);

function asBig(v: unknown): bigint {
    if (typeof v === 'string' || typeof v === 'number') return BigInt(v);
    return 0n;
}

/** Read & parse the shared OutcomeMarket object. */
export async function readFifaMarket(marketId = CONFIG.FIFA_MARKET_ID): Promise<FifaMarket | null> {
    const c = getSuiClient();
    const res = await c.getObject({ id: marketId, options: { showContent: true } });
    const content: any = res.data?.content;
    if (!content || content.dataType !== 'moveObject') return null;
    const f = content.fields as Record<string, any>;
    const winnerVec = f.winner?.fields?.vec ?? f.winner?.vec ?? (Array.isArray(f.winner) ? f.winner : []);
    const vaultRaw = f.vault?.fields?.value ?? f.vault?.value ?? f.vault;
    return {
        objectId: marketId,
        question: f.question ?? '',
        outcomeNames: (f.outcome_names ?? []).map((s: any) => String(s)),
        n: Number(f.n ?? 0),
        status: Number(f.status ?? 0),
        winner: winnerVec.length > 0 ? Number(winnerVec[0]) : null,
        vault: asBig(vaultRaw),
        totalStaked: (f.total_staked ?? []).map((v: any) => asBig(v)),
        pools: (f.pools ?? []).map((p: any) => String(p)),
        tokenPackageId: f.token_package_id ?? ZERO,
    };
}

async function poolTypes(poolId: string): Promise<{ base: string; quote: string } | null> {
    const c = getSuiClient();
    const o = await c.getObject({ id: poolId, options: { showType: true } });
    const m = o.data?.type?.match(/<(.+),\s*(.+)>/);
    if (!m) return null;
    return { base: m[1]!.trim(), quote: m[2]!.trim() };
}

/** Live order-book mid for a pool as a 0–100 probability, or null. */
export async function poolMidPct(poolId: string): Promise<number | null> {
    if (isZeroPool(poolId)) return null;
    const types = await poolTypes(poolId);
    if (!types) return null;
    const c = getSuiClient();
    const toPct = (raw: number) => Math.min(99, Math.max(1, Math.round((raw / 1e9) * 100)));
    try {
        const tx = new Transaction();
        tx.moveCall({ target: `${DEEPBOOK}::pool::mid_price`, typeArguments: [types.base, types.quote], arguments: [tx.object(poolId), tx.object(CLOCK)] });
        const r = await c.devInspectTransactionBlock({ sender: ZERO, transactionBlock: tx });
        const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
        if (r.effects?.status?.status === 'success' && bytes) {
            const mid = Number(bcs.u64().parse(new Uint8Array(bytes)));
            if (mid > 0) return toPct(mid);
        }
    } catch { /* fall through */ }
    // one-sided book → best bid/ask
    try {
        const tx = new Transaction();
        tx.moveCall({ target: `${DEEPBOOK}::pool::get_level2_ticks_from_mid`, typeArguments: [types.base, types.quote], arguments: [tx.object(poolId), tx.pure.u64(1), tx.object(CLOCK)] });
        const r = await c.devInspectTransactionBlock({ sender: ZERO, transactionBlock: tx });
        const rv = r.results?.[0]?.returnValues;
        if (!rv || rv.length < 4) return null;
        const v = bcs.vector(bcs.u64());
        const bid = (v.parse(new Uint8Array(rv[0]![0])) as string[]).map(Number)[0] ?? 0;
        const ask = (v.parse(new Uint8Array(rv[2]![0])) as string[]).map(Number)[0] ?? 0;
        if (bid > 0 && ask > 0) return toPct((bid + ask) / 2);
        if (bid > 0) return toPct(bid);
        if (ask > 0) return toPct(ask);
    } catch { /* ignore */ }
    return null;
}

/** Find the wallet's first DeepBook BalanceManager, or null. */
export async function getBalanceManagerId(owner: string): Promise<string | null> {
    const c = getSuiClient();
    const type = `${CONFIG.DEEPBOOK_EVENT_PKG}::balance_manager::BalanceManager`;
    try {
        const res = await c.getOwnedObjects({ owner, filter: { StructType: type }, options: { showType: true } });
        return res.data?.[0]?.data?.objectId ?? null;
    } catch {
        return null;
    }
}

/** Wallet's SUI / DEEP / a given outcome-token balance (plain numbers). */
export async function walletBalances(owner: string, coinType?: string) {
    const c = getSuiClient();
    const [sui, deep, tok] = await Promise.all([
        c.getBalance({ owner, coinType: SUI }).then((b) => Number(b.totalBalance) / 1e9).catch(() => 0),
        c.getBalance({ owner, coinType: CONFIG.DEEP_TOKEN_TYPE }).then((b) => Number(b.totalBalance) / 1e6).catch(() => 0),
        coinType ? c.getBalance({ owner, coinType }).then((b) => Number(b.totalBalance) / 1e9).catch(() => 0) : Promise.resolve(0),
    ]);
    return { sui, deep, token: tok };
}

// ── Tx builders ───────────────────────────────────────────────────────

/** Stake `amountMist` SUI on outcome `idx` (parimutuel mint, no DEEP). */
export function buildStakeTx(sender: string, market: FifaMarket, idx: number, amountMist: bigint): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    const stake = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)])[0]!;
    tx.moveCall({
        target: `${PKG}::outcome_market::buy`,
        typeArguments: [SUI, outcomeCoinType(market.tokenPackageId, idx)],
        arguments: [tx.object(market.objectId), tx.pure.u8(idx), stake],
    });
    return tx;
}

/** Create a BalanceManager (returns tx); the new id is discovered after execution. */
export function buildNewBalanceManagerTx(sender: string): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    const mgr = tx.moveCall({ target: `${DEEPBOOK}::balance_manager::new`, arguments: [] });
    tx.transferObjects([mgr], sender);
    return tx;
}

/** Seed the DEEP/SUI price reference on a pool (once per pool before first order). */
export async function buildSyncDeepPriceTx(sender: string, poolId: string): Promise<Transaction | null> {
    const t = await poolTypes(poolId);
    if (!t) return null;
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
        target: `${DEEPBOOK}::pool::add_deep_price_point`,
        arguments: [tx.object(poolId), tx.object(CONFIG.DEEP_SUI_REFERENCE_POOL_ID), tx.object(CLOCK)],
        typeArguments: [t.base, t.quote, CONFIG.DEEP_TOKEN_TYPE, SUI],
    });
    return tx;
}

/** Post a resting limit order on a pool. price 0–1, qty in tokens. */
export async function buildLimitOrderTx(
    sender: string, managerId: string, poolId: string, isBid: boolean, price: number, qty: number,
): Promise<Transaction | null> {
    if (!(price > 0 && price < 1 && qty > 0)) return null;
    const t = await poolTypes(poolId);
    if (!t) return null;
    const c = getSuiClient();
    const inputPrice = BigInt(Math.round(price * FLOAT_SCALAR));
    const rawQty = BigInt(Math.round(qty * 1e9));
    const inputQty = (rawQty / LOT) * LOT;
    if (inputQty <= 0n) return null;

    const tx = new Transaction();
    tx.setSender(sender);
    if (isBid) {
        const quoteMist = BigInt(Math.round(price * qty * 1e9));
        const c2 = tx.splitCoins(tx.gas, [tx.pure.u64(quoteMist)])[0]!;
        tx.moveCall({ target: `${DEEPBOOK}::balance_manager::deposit`, arguments: [tx.object(managerId), c2], typeArguments: [t.quote] });
    } else {
        const coins = await c.getCoins({ owner: sender, coinType: t.base });
        if (coins.data.length === 0) return null;
        const refs = coins.data.map((x: any) => tx.object(x.coinObjectId));
        const primary = refs[0]!;
        if (refs.length > 1) tx.mergeCoins(primary, refs.slice(1));
        const baseIn = tx.splitCoins(primary, [tx.pure.u64(inputQty)])[0]!;
        tx.moveCall({ target: `${DEEPBOOK}::balance_manager::deposit`, arguments: [tx.object(managerId), baseIn], typeArguments: [t.base] });
    }
    // DEEP fee buffer
    const deepCoins = await c.getCoins({ owner: sender, coinType: CONFIG.DEEP_TOKEN_TYPE });
    if (deepCoins.data.length === 0) return null;
    const dRefs = deepCoins.data.map((x: any) => tx.object(x.coinObjectId));
    const dPrim = dRefs[0]!;
    if (dRefs.length > 1) tx.mergeCoins(dPrim, dRefs.slice(1));
    const deepIn = tx.splitCoins(dPrim, [tx.pure.u64(DEEP_FEE)])[0]!;
    tx.moveCall({ target: `${DEEPBOOK}::balance_manager::deposit`, arguments: [tx.object(managerId), deepIn], typeArguments: [CONFIG.DEEP_TOKEN_TYPE] });

    const proof = tx.moveCall({ target: `${DEEPBOOK}::balance_manager::generate_proof_as_owner`, arguments: [tx.object(managerId)] });
    tx.moveCall({
        target: `${DEEPBOOK}::pool::place_limit_order`,
        arguments: [
            tx.object(poolId), tx.object(managerId), proof,
            tx.pure.u64(Date.now()), tx.pure.u8(0), tx.pure.u8(0),
            tx.pure.u64(inputPrice), tx.pure.u64(inputQty),
            tx.pure.bool(isBid), tx.pure.bool(true), tx.pure.u64(MAX_TS), tx.object(CLOCK),
        ],
        typeArguments: [t.base, t.quote],
    });
    return tx;
}

/** Cancel all the wallet's resting orders on a pool. */
export async function buildCancelAllTx(sender: string, managerId: string, poolId: string): Promise<Transaction | null> {
    const t = await poolTypes(poolId);
    if (!t) return null;
    const tx = new Transaction();
    tx.setSender(sender);
    const proof = tx.moveCall({ target: `${DEEPBOOK}::balance_manager::generate_proof_as_owner`, arguments: [tx.object(managerId)] });
    tx.moveCall({ target: `${DEEPBOOK}::pool::cancel_all_orders`, arguments: [tx.object(poolId), tx.object(managerId), proof, tx.object(CLOCK)], typeArguments: [t.base, t.quote] });
    return tx;
}

/** Sweep settled balances (base + quote + DEEP) from the BalanceManager to the wallet. */
export async function buildClaimTx(sender: string, managerId: string, poolId: string): Promise<Transaction | null> {
    const t = await poolTypes(poolId);
    if (!t) return null;
    const tx = new Transaction();
    tx.setSender(sender);
    for (const ty of [t.base, t.quote, CONFIG.DEEP_TOKEN_TYPE]) {
        const out = tx.moveCall({ target: `${DEEPBOOK}::balance_manager::withdraw_all`, arguments: [tx.object(managerId)], typeArguments: [ty] });
        tx.transferObjects([out], sender);
    }
    return tx;
}

/** Redeem all of the wallet's winning-outcome tokens for the pro-rata pool share. */
export async function buildRedeemTx(sender: string, market: FifaMarket, winnerIdx: number): Promise<Transaction | null> {
    const c = getSuiClient();
    const coinType = outcomeCoinType(market.tokenPackageId, winnerIdx);
    const coins = await c.getCoins({ owner: sender, coinType });
    if (coins.data.length === 0) return null;
    const tx = new Transaction();
    tx.setSender(sender);
    const refs = coins.data.map((x: any) => tx.object(x.coinObjectId));
    const primary = refs[0]!;
    if (refs.length > 1) tx.mergeCoins(primary, refs.slice(1));
    tx.moveCall({
        target: `${PKG}::outcome_market::redeem`,
        typeArguments: [SUI, coinType],
        arguments: [tx.object(market.objectId), tx.pure.u8(winnerIdx), primary],
    });
    return tx;
}
