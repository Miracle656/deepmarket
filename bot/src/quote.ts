// On-chain price quoting via devInspect.
//
// The single biggest lever on agent quality: before deciding, ask the chain
// what each strike ACTUALLY costs. `predict::get_trade_amounts` returns the
// per-quantity (cost, payout) for a market key — the same call the frontend
// uses for its live price preview. We run it read-only via devInspect.
//
// Two things fall out of this for free:
//   1. Implied probability = cost / payout. The agent can now compare its
//      directional view against the market's priced-in odds and only trade
//      when it has real edge (after the vault spread).
//   2. Out-of-band strikes ABORT inside get_trade_amounts. A devInspect that
//      aborts → that strike is unquotable → we never feed it to the model or
//      the chain. This eliminates EAskPriceOutOfBounds structurally instead
//      of guessing the band from a prompt heuristic.

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { CONFIG } from './config.js';
import { getSuiClient } from './sui.js';
import { strikeToUsd, type OracleSummary } from './predict.js';

const PKG = CONFIG.PREDICT_PACKAGE_ID;
const PREDICT_OBJECT = CONFIG.PREDICT_OBJECT_ID;
const DUSDC_SCALE = 1_000_000;

/** A single devInspect-verified strike quote. */
export interface StrikeQuote {
    direction: 'UP' | 'DOWN';
    /** Strike in raw 1e9 units (already snapped to the oracle grid). */
    strikeRaw: bigint;
    strikeUsd: number;
    /** Per-unit cost (premium) in USD to mint this binary. */
    costUsd: number;
    /** Per-unit max payout in USD if it settles in the money. */
    payoutUsd: number;
    /**
     * Market-implied probability this leg settles in the money.
     * cost / payout — already includes the vault spread, so the agent's
     * own estimate must beat this by the edge threshold to be +EV.
     */
    impliedProb: number;
}

function buildGetTradeAmountsTx(opts: {
    oracleId: string;
    expiry: number;
    strikeRaw: bigint;
    isUp: boolean;
    quantity: bigint;
}): Transaction {
    const tx = new Transaction();
    const key = tx.moveCall({
        target: `${PKG}::market_key::new`,
        arguments: [
            tx.pure.id(opts.oracleId),
            tx.pure.u64(opts.expiry),
            tx.pure.u64(opts.strikeRaw),
            tx.pure.bool(opts.isUp),
        ],
    });
    tx.moveCall({
        target: `${PKG}::predict::get_trade_amounts`,
        arguments: [
            tx.object(PREDICT_OBJECT),
            tx.object(opts.oracleId),
            key,
            tx.pure.u64(opts.quantity),
            tx.object(CONFIG.CLOCK),
        ],
    });
    return tx;
}

// Probe quantity — 1 dUSDC of cover. cost/payout scale linearly with
// quantity so implied prob is invariant; we just need a non-zero amount.
const PROBE_QTY = BigInt(DUSDC_SCALE);

/**
 * Quote one (strike, direction) via devInspect. Returns null when the
 * strike is out of band (the Move call aborts) or the RPC hiccups —
 * either way the strike is simply omitted from the menu.
 */
async function quoteOne(
    sender: string,
    oracle: OracleSummary,
    strikeRaw: bigint,
    isUp: boolean
): Promise<StrikeQuote | null> {
    try {
        const tx = buildGetTradeAmountsTx({
            oracleId: oracle.oracle_id,
            expiry: oracle.expiry,
            strikeRaw,
            isUp,
            quantity: PROBE_QTY,
        });
        const res = await getSuiClient().devInspectTransactionBlock({
            sender,
            transactionBlock: tx,
        });
        // An abort (out-of-band strike) surfaces as a non-success effect.
        if (res.effects?.status?.status !== 'success') return null;
        const ret = res.results?.[1]?.returnValues;
        if (!ret || ret.length < 2) return null;
        const costBytes = ret[0]?.[0];
        const payoutBytes = ret[1]?.[0];
        if (!costBytes || !payoutBytes) return null;
        const costBase = Number(bcs.u64().parse(new Uint8Array(costBytes)));
        const payoutBase = Number(bcs.u64().parse(new Uint8Array(payoutBytes)));
        if (!(payoutBase > 0) || !(costBase > 0)) return null;
        const costUsd = costBase / DUSDC_SCALE;
        const payoutUsd = payoutBase / DUSDC_SCALE;
        const impliedProb = Math.min(0.999, Math.max(0.001, costBase / payoutBase));
        return {
            direction: isUp ? 'UP' : 'DOWN',
            strikeRaw,
            strikeUsd: strikeToUsd(Number(strikeRaw)),
            costUsd,
            payoutUsd,
            impliedProb,
        };
    } catch {
        return null;
    }
}

/**
 * Probe a ladder of grid strikes around spot, both directions, and return
 * only the ones the vault will actually quote. This is empirical band
 * discovery — no heuristic, the chain tells us the truth each tick.
 *
 * Quotes are oracle-level (not user-level), so strategy.ts builds this once
 * per oracle per tick and shares it across all subscribed users.
 */
export async function quoteLadder(
    sender: string,
    oracle: OracleSummary,
    spotRaw: number,
    steps = 5
): Promise<StrikeQuote[]> {
    const minStrike = BigInt(oracle.min_strike);
    const tick = BigInt(oracle.tick_size);
    if (tick <= 0n) return [];

    const spot = BigInt(Math.floor(spotRaw));
    // Nearest grid index to spot.
    let kSpot = (spot - minStrike) / tick;
    if (kSpot < 0n) kSpot = 0n;

    const tasks: Promise<StrikeQuote | null>[] = [];
    for (let j = -steps; j <= steps; j++) {
        const k = kSpot + BigInt(j);
        if (k < 0n) continue;
        const strikeRaw = minStrike + k * tick;
        // Probe both directions for every grid strike in the window.
        tasks.push(quoteOne(sender, oracle, strikeRaw, true));
        tasks.push(quoteOne(sender, oracle, strikeRaw, false));
    }

    const settled = await Promise.allSettled(tasks);
    const quotes: StrikeQuote[] = [];
    for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) quotes.push(r.value);
    }
    // Sort by strike then direction for a readable prompt table.
    quotes.sort(
        (a, b) =>
            a.strikeUsd - b.strikeUsd ||
            (a.direction === b.direction ? 0 : a.direction === 'UP' ? -1 : 1)
    );
    return quotes;
}

/** "UP @ $76,800 · cost $0.61 · implied 61%" — one prompt line per quote. */
export function formatQuoteLine(q: StrikeQuote): string {
    return (
        `${q.direction} @ $${q.strikeUsd.toFixed(0)}  ` +
        `cost $${q.costUsd.toFixed(3)}  ` +
        `payout $${q.payoutUsd.toFixed(2)}  ` +
        `implied ${(q.impliedProb * 100).toFixed(0)}%`
    );
}
