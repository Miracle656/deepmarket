// AgentCap — bot-side integration with the on-chain policy object.
//
// Flow:
//   1. User creates an AgentCap on the frontend, naming the bot's custodial
//      wallet as the `agent`. The cap is a shared object.
//   2. The bot auto-discovers the cap by querying AgentCapCreated events and
//      matching `agent` to the user's custodial wallet address.
//   3. Before trading each tick, the bot checks the cap isn't revoked/expired.
//   4. After every successful mint, the bot calls record_decision — which
//      emits an on-chain AgentDecisionMade event AND aborts if the cap was
//      revoked, so the audit log is binding.
//
// Type-identity note: agent_cap was added in the v2 upgrade, but Move struct
// types are always tagged with the package's ORIGINAL id (v1). So event-type
// filters use AGENT_CAP_TYPE_ORIGIN (v1) while moveCall targets use the
// latest package id (v3, AGENT_CAP_PACKAGE_ID).

import { createHash } from 'crypto';
import { Transaction, Inputs } from '@mysten/sui/transactions';
import { CONFIG } from './config.js';
import { getSuiClient } from './sui.js';
import { getUserKeypair } from './user-wallet.js';

const PKG = CONFIG.AGENT_CAP_PACKAGE_ID;
// Type origin — where the agent_cap module's struct types are rooted. A
// struct's type id uses the package version where its MODULE was first
// published, NOT the package's original v1 id. agent_cap was added in the
// v1→v2 upgrade, so its types live at v2 (0xf2189af2…). Verified against
// on-chain AgentCapCreated events.
const TYPE_ORIGIN =
    process.env.AGENT_CAP_TYPE_ORIGIN ??
    '0xf2189af211ace44b5365d3c0cb8a8b96137897957fa53b7f83570db0f1f10068';

const CREATED_EVENT = `${TYPE_ORIGIN}::agent_cap::AgentCapCreated`;

export interface AgentCapInfo {
    capId: string;
    owner: string;
    agent: string;
    dailySpendCapUsd: number; // whole USD
    expiresAtMs: number;
    revoked: boolean;
}

/**
 * Find the AgentCap that authorizes `botWalletAddr` as its agent. Queries
 * AgentCapCreated events (rare — one per cap) and matches client-side.
 * Returns the most recent match, or null if the user hasn't authorized yet.
 */
export async function findAgentCapForBot(
    botWalletAddr: string
): Promise<AgentCapInfo | null> {
    const sui = getSuiClient();
    try {
        const res = await sui.queryEvents({
            query: { MoveEventType: CREATED_EVENT },
            limit: 200,
            order: 'descending',
        });
        for (const ev of res.data) {
            const fields = ev.parsedJson as
                | {
                      cap_id?: string;
                      owner?: string;
                      agent?: string;
                      daily_spend_cap_usd?: string;
                      expires_at_ms?: string;
                  }
                | undefined;
            if (!fields?.agent || !fields.cap_id) continue;
            if (fields.agent.toLowerCase() !== botWalletAddr.toLowerCase()) {
                continue;
            }
            // Fetch live state to pick up any later revoke/update.
            const state = await getAgentCapState(fields.cap_id);
            if (state) return state;
        }
        return null;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[agent-cap] event query failed:', msg);
        return null;
    }
}

/** Fetch the live state of an AgentCap shared object. */
export async function getAgentCapState(
    capId: string
): Promise<AgentCapInfo | null> {
    const sui = getSuiClient();
    try {
        const obj = await sui.getObject({
            id: capId,
            options: { showContent: true },
        });
        const content = obj.data?.content;
        if (!content || content.dataType !== 'moveObject') return null;
        const f = content.fields as Record<string, unknown>;
        return {
            capId,
            owner: String(f.owner ?? ''),
            agent: String(f.agent ?? ''),
            dailySpendCapUsd:
                Number(f.daily_spend_cap_usd ?? 0) / 10 ** CONFIG.DUSDC_DECIMALS,
            expiresAtMs: Number(f.expires_at_ms ?? 0),
            revoked: Boolean(f.revoked),
        };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[agent-cap] getObject ${capId} failed:`, msg);
        return null;
    }
}

/** True iff the cap is usable right now (exists, not revoked, not expired). */
export function isCapUsable(cap: AgentCapInfo | null): boolean {
    if (!cap) return false;
    if (cap.revoked) return false;
    if (cap.expiresAtMs > 0 && Date.now() > cap.expiresAtMs) return false;
    return true;
}

export interface RecordDecisionParams {
    capId: string;
    oracleId: string;
    isMint: boolean;
    directionUp: boolean;
    /** Strike in raw on-chain units (1e9 = $1). */
    strike: number;
    /** Cover in dUSDC base units (1e6 = $1). */
    coverUsd: number;
    /** The agent's rationale string — hashed to 32 bytes on-chain. */
    rationale: string;
}

/**
 * Emit an on-chain AgentDecisionMade event for this trade. Signed by the
 * user's custodial wallet (which must be the cap's `agent`). Aborts on-chain
 * if the cap is revoked/expired — so a revoked agent cannot post fake entries.
 *
 * Best-effort: failures are logged, not thrown. A missed audit entry should
 * never block the actual trade from having happened.
 */
export async function recordDecision(
    chatId: number,
    p: RecordDecisionParams
): Promise<{ digest: string } | { error: string }> {
    const kp = await getUserKeypair(chatId);
    if (!kp) {
        console.warn(`[agent-cap] no custodial wallet for chat ${chatId}`);
        return { error: 'no custodial wallet' };
    }
    const sui = getSuiClient();

    // sha256(rationale) — already 32 bytes, exactly what the Move side wants.
    const rationaleHash = Array.from(
        createHash('sha256').update(p.rationale).digest()
    );

    const tx = new Transaction();

    // Pin the shared AgentCap as an IMMUTABLE shared ref at its initial shared
    // version. record_decision takes `&AgentCap` (read-only); letting
    // tx.object() auto-resolve produced "Transaction needs to be rebuilt"
    // (stale shared version / wrong mutability). Referencing by
    // initialSharedVersion is version-stable — the validator resolves current.
    let capArg = tx.object(p.capId);
    try {
        const capObj = await sui.getObject({
            id: p.capId,
            options: { showOwner: true },
        });
        const owner = capObj.data?.owner;
        if (owner && typeof owner === 'object' && 'Shared' in owner) {
            capArg = tx.object(
                Inputs.SharedObjectRef({
                    objectId: p.capId,
                    initialSharedVersion: Number(
                        (owner as { Shared: { initial_shared_version: number | string } })
                            .Shared.initial_shared_version
                    ),
                    mutable: false,
                })
            );
        }
    } catch {
        /* fall back to tx.object(capId) */
    }

    tx.moveCall({
        target: `${PKG}::agent_cap::record_decision`,
        arguments: [
            capArg,
            tx.pure.id(p.oracleId),
            tx.pure.bool(p.isMint),
            tx.pure.bool(p.directionUp),
            tx.pure.u64(BigInt(Math.floor(p.strike))),
            tx.pure.u64(BigInt(Math.floor(p.coverUsd))),
            tx.pure.vector('u8', rationaleHash),
            tx.object(CONFIG.CLOCK),
        ],
    });

    try {
        const res = await sui.signAndExecuteTransaction({
            signer: kp,
            transaction: tx,
            options: { showEffects: true },
        });
        if (res.effects?.status.status !== 'success') {
            const err = res.effects?.status.error ?? 'unknown';
            console.warn(
                `[agent-cap] record_decision failed for chat ${chatId} (cap ${p.capId}):`,
                err
            );
            return { error: err };
        }
        return { digest: res.digest };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
            `[agent-cap] record_decision tx threw for chat ${chatId} (cap ${p.capId}):`,
            msg
        );
        return { error: msg };
    }
}
