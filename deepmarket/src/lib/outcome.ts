// Helpers for the multi-outcome (any-N) parimutuel markets created by the
// `outcome_market` Move module. These markets are standalone shared objects
// (not in a registry), so we read them directly by object id and build the
// buy / resolve / redeem transactions here.
import type { SuiJsonRpcClient as SuiClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { CONFIG } from './config';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000000000000000000000000000';

export interface OutcomeMarketData {
    objectId: string;
    question: string;
    outcomeNames: string[];
    n: number;
    resolutionTime: number;
    oracleFeed: string;
    status: number;                // 0 = active, 1 = resolved
    winner: number | null;         // winning index once resolved
    vault: bigint;                 // total pool, raw 1e9 SUI
    totalStaked: bigint[];         // per-outcome stake, raw 1e9
    pools: string[];               // DeepBook pool ids (0x0 if none)
    tokenPackageId: string;
    ready: boolean;
}

/** The coin type minted for outcome `idx` of a market whose token package is `pkgId`. */
export function outcomeCoinType(pkgId: string, idx: number): string {
    return `${pkgId}::outcome_${idx}::OUTCOME_${idx}`;
}

/** Distinct colours per outcome (cycled) — shared by the card and detail page. */
export const OUTCOME_COLORS = ['#1E6EF3', '#22C55E', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4', '#EC4899', '#84CC16'];
export const colorForOutcome = (i: number) => OUTCOME_COLORS[i % OUTCOME_COLORS.length];

function asBig(v: unknown): bigint {
    if (typeof v === 'string' || typeof v === 'number') return BigInt(v);
    return 0n;
}

/** Read & parse a shared OutcomeMarket object by id. Returns null if not found. */
export async function fetchOutcomeMarket(
    client: SuiClient,
    objectId: string,
): Promise<OutcomeMarketData | null> {
    const res = await client.getObject({ id: objectId, options: { showContent: true } });
    const content = res.data?.content;
    if (!content || content.dataType !== 'moveObject') return null;
    const f = content.fields as Record<string, any>;

    // Option<u8> serializes as { fields: { vec: [..] } } or { vec: [..] }.
    const winnerVec =
        f.winner?.fields?.vec ?? f.winner?.vec ?? (Array.isArray(f.winner) ? f.winner : []);
    const winner = winnerVec.length > 0 ? Number(winnerVec[0]) : null;

    // Balance<Q> serializes as the bare u64 value (string).
    const vaultRaw = f.vault?.fields?.value ?? f.vault?.value ?? f.vault;

    return {
        objectId,
        question: f.question ?? '',
        outcomeNames: (f.outcome_names ?? []).map((s: any) => String(s)),
        n: Number(f.n ?? 0),
        resolutionTime: Number(f.resolution_time ?? 0),
        oracleFeed: f.oracle_feed ?? ZERO_ADDR,
        status: Number(f.status ?? 0),
        winner,
        vault: asBig(vaultRaw),
        totalStaked: (f.total_staked ?? []).map((v: any) => asBig(v)),
        pools: (f.pools ?? []).map((p: any) => String(p)),
        tokenPackageId: f.token_package_id ?? ZERO_ADDR,
        ready: Boolean(f.ready),
    };
}

/** Stake `amountMist` SUI on outcome `idx`, minting that outcome's token 1:1. */
export function buildBuyTx(
    sender: string,
    market: OutcomeMarketData,
    idx: number,
    amountMist: bigint,
): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
    tx.moveCall({
        target: `${CONFIG.OUTCOME_PACKAGE_ID}::outcome_market::buy`,
        typeArguments: [CONFIG.SUI_TYPE, outcomeCoinType(market.tokenPackageId, idx)],
        arguments: [tx.object(market.objectId), tx.pure.u8(idx), stake],
    });
    return tx;
}

/** Admin-only: resolve the market to winning outcome `winnerIdx`. */
export function buildResolveTx(
    sender: string,
    market: OutcomeMarketData,
    winnerIdx: number,
): Transaction {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
        target: `${CONFIG.OUTCOME_PACKAGE_ID}::outcome_market::resolve`,
        typeArguments: [CONFIG.SUI_TYPE],
        arguments: [
            tx.object(CONFIG.ADMIN_CAP_OBJECT_ID),
            tx.object(market.objectId),
            tx.pure.u8(winnerIdx),
        ],
    });
    return tx;
}

/**
 * Redeem all of the caller's winning-outcome tokens for a pro-rata pool share.
 * Merges the wallet's coins of the winning type into one and burns it.
 */
export async function buildRedeemTx(
    client: SuiClient,
    sender: string,
    market: OutcomeMarketData,
    winnerIdx: number,
): Promise<{ tx: Transaction; tokenAmount: bigint }> {
    const coinType = outcomeCoinType(market.tokenPackageId, winnerIdx);
    const coins = await client.getCoins({ owner: sender, coinType });
    if (coins.data.length === 0) throw new Error('You hold no winning tokens to redeem');

    const tx = new Transaction();
    tx.setSender(sender);

    const [primary, ...rest] = coins.data;
    const primaryRef = tx.object(primary.coinObjectId);
    if (rest.length > 0) {
        tx.mergeCoins(primaryRef, rest.map((c: { coinObjectId: string }) => tx.object(c.coinObjectId)));
    }
    const total = coins.data.reduce((s: bigint, c: { balance: string }) => s + BigInt(c.balance), 0n);

    tx.moveCall({
        target: `${CONFIG.OUTCOME_PACKAGE_ID}::outcome_market::redeem`,
        typeArguments: [CONFIG.SUI_TYPE, coinType],
        arguments: [tx.object(market.objectId), tx.pure.u8(winnerIdx), primaryRef],
    });
    return { tx, tokenAmount: total };
}

/** Discover outcome markets created on-chain via the OutcomeMarketCreated event. */
export async function fetchRecentOutcomeMarkets(
    client: SuiClient,
    limit = 50,
): Promise<{ objectId: string; question: string; n: number }[]> {
    const res = await client.queryEvents({
        query: { MoveEventType: `${CONFIG.OUTCOME_PACKAGE_ID}::outcome_market::OutcomeMarketCreated` },
        order: 'descending',
        limit,
    });
    const out: { objectId: string; question: string; n: number }[] = [];
    for (const ev of res.data) {
        const j = ev.parsedJson as any;
        if (j?.market_id) out.push({ objectId: j.market_id, question: j.question ?? '', n: Number(j.n ?? 0) });
    }
    return out;
}
