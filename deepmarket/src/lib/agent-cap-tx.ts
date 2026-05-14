// AgentCap — Move-call tx builders for the on-chain agent policy object.
//
// The cap is a SHARED object: the user (owner) signs `create` once to
// authorize a bot address, then the bot references the shared cap in its
// `record_decision` txs. Only the owner can `revoke` / `update` — those
// paths assert ctx.sender() == owner inside the Move module.
//
// daily_spend_cap_usd is in dUSDC base units (1e6 = $1).

import { Transaction } from '@mysten/sui/transactions';
import { CONFIG } from './config';

const PKG = CONFIG.PACKAGE_ID;
const CLOCK = CONFIG.CLOCK;
const DUSDC_SCALE = 1_000_000;

export interface CreateCapParams {
    /** The bot's Sui address that will be authorized to act. */
    agent: string;
    /** Daily spend cap in whole USD (converted to dUSDC base units here). */
    dailySpendCapUsd: number;
    /** Absolute ms timestamp the cap expires at. */
    expiresAtMs: number;
    /**
     * Optional oracle allowlist. Empty = the agent may act on any oracle.
     * Pass oracle object ids (0x…).
     */
    allowedOracles?: string[];
}

/** Mint + share a fresh AgentCap owned by the signer. */
export function buildCreateCapTx(p: CreateCapParams): Transaction {
    const tx = new Transaction();
    tx.moveCall({
        target: `${PKG}::agent_cap::create`,
        arguments: [
            tx.pure.address(p.agent),
            tx.pure.u64(BigInt(Math.floor(p.dailySpendCapUsd * DUSDC_SCALE))),
            tx.pure.u64(BigInt(Math.floor(p.expiresAtMs))),
            tx.pure.vector('id', p.allowedOracles ?? []),
            tx.object(CLOCK),
        ],
    });
    return tx;
}

/** Flip the cap's `revoked` flag — kills the agent's authorization on-chain. */
export function buildRevokeCapTx(capId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
        target: `${PKG}::agent_cap::revoke`,
        arguments: [tx.object(capId), tx.object(CLOCK)],
    });
    return tx;
}

export interface UpdateCapParams {
    capId: string;
    newDailySpendCapUsd: number;
    newExpiresAtMs: number;
}

/** Owner-only: adjust the daily cap and/or expiry of an existing cap. */
export function buildUpdateCapTx(p: UpdateCapParams): Transaction {
    const tx = new Transaction();
    tx.moveCall({
        target: `${PKG}::agent_cap::update`,
        arguments: [
            tx.object(p.capId),
            tx.pure.u64(BigInt(Math.floor(p.newDailySpendCapUsd * DUSDC_SCALE))),
            tx.pure.u64(BigInt(Math.floor(p.newExpiresAtMs))),
            tx.object(CLOCK),
        ],
    });
    return tx;
}
