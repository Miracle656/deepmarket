// AgentCap — frontend read helpers.
//
// The cap is a shared object; we discover a user's cap(s) by querying
// AgentCapCreated events filtered (client-side) by owner. The audit log
// is the AgentDecisionMade event stream for a given cap_id.
//
// Type-identity note: agent_cap was added in the v2 package upgrade, but
// Move struct types carry the package's ORIGINAL id (v1). So event-type
// filters use TYPE_ORIGIN (v1) while tx builders target the latest id.

import type { SuiJsonRpcClient as SuiClient } from '@mysten/sui/jsonRpc';

// Type origin — a struct's type id uses the package version where its MODULE
// was first published, not the package's original v1 id. agent_cap was added
// in the v1→v2 upgrade, so its types are rooted at v2 (0xf2189af2…). Verified
// against on-chain AgentCapCreated events.
const TYPE_ORIGIN =
    '0xf2189af211ace44b5365d3c0cb8a8b96137897957fa53b7f83570db0f1f10068';

const CREATED_EVENT = `${TYPE_ORIGIN}::agent_cap::AgentCapCreated`;
const DECISION_EVENT = `${TYPE_ORIGIN}::agent_cap::AgentDecisionMade`;

const DUSDC_SCALE = 1_000_000;
const STRIKE_SCALE = 1_000_000_000;

export interface AgentCapInfo {
    capId: string;
    owner: string;
    agent: string;
    /** Daily spend cap in whole USD. */
    dailySpendCapUsd: number;
    expiresAtMs: number;
    revoked: boolean;
    createdAtMs: number;
}

export interface AgentDecision {
    capId: string;
    oracleId: string;
    isMint: boolean;
    directionUp: boolean;
    /** Strike in USD. */
    strikeUsd: number;
    /** Cover in USD. */
    coverUsd: number;
    tsMs: number;
    /** The tx digest that emitted this decision. */
    digest: string;
    /** Owner (the user who authorized the agent). */
    owner?: string;
    /** Agent address (the bot's custodial wallet that signed the tx). */
    agent?: string;
    /** sha256(rationale) committed on-chain, lowercase hex (for verification). */
    rationaleHash?: string;
}

/**
 * Find the AgentCap(s) created by `owner`. Returns live state for each
 * (re-fetched from the object so revoke/update edits are reflected).
 * Most recent first.
 */
export async function findAgentCapsByOwner(
    client: SuiClient,
    owner: string,
): Promise<AgentCapInfo[]> {
    try {
        const res = await client.queryEvents({
            query: { MoveEventType: CREATED_EVENT },
            limit: 200,
            order: 'descending',
        });
        const lower = owner.toLowerCase();
        const out: AgentCapInfo[] = [];
        for (const ev of res.data) {
            const f = ev.parsedJson as { cap_id?: string; owner?: string } | undefined;
            if (!f?.cap_id || f.owner?.toLowerCase() !== lower) continue;
            const state = await getAgentCapState(client, f.cap_id);
            if (state) out.push(state);
        }
        return out;
    } catch (e) {
        console.warn('[agent-cap] findAgentCapsByOwner failed:', e);
        return [];
    }
}

/** Fetch live state of a single AgentCap shared object. */
export async function getAgentCapState(
    client: SuiClient,
    capId: string,
): Promise<AgentCapInfo | null> {
    try {
        const obj = await client.getObject({
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
            dailySpendCapUsd: Number(f.daily_spend_cap_usd ?? 0) / DUSDC_SCALE,
            expiresAtMs: Number(f.expires_at_ms ?? 0),
            revoked: Boolean(f.revoked),
            createdAtMs: Number(f.created_at_ms ?? 0),
        };
    } catch (e) {
        console.warn(`[agent-cap] getAgentCapState ${capId} failed:`, e);
        return null;
    }
}

/**
 * The on-chain audit log for a cap — every AgentDecisionMade event,
 * most recent first.
 */
export async function getDecisionLog(
    client: SuiClient,
    capId: string,
    limit = 50,
): Promise<AgentDecision[]> {
    try {
        const res = await client.queryEvents({
            query: { MoveEventType: DECISION_EVENT },
            limit: 500,
            order: 'descending',
        });
        const out: AgentDecision[] = [];
        for (const ev of res.data) {
            const f = ev.parsedJson as
                | {
                      cap_id?: string;
                      oracle_id?: string;
                      is_mint?: boolean;
                      direction_up?: boolean;
                      strike?: string;
                      cover_usd?: string;
                      ts_ms?: string;
                  }
                | undefined;
            if (!f?.cap_id || f.cap_id !== capId) continue;
            out.push({
                capId,
                oracleId: String(f.oracle_id ?? ''),
                isMint: Boolean(f.is_mint),
                directionUp: Boolean(f.direction_up),
                strikeUsd: Number(f.strike ?? 0) / STRIKE_SCALE,
                coverUsd: Number(f.cover_usd ?? 0) / DUSDC_SCALE,
                tsMs: Number(f.ts_ms ?? 0),
                digest: ev.id.txDigest,
            });
            if (out.length >= limit) break;
        }
        return out;
    } catch (e) {
        console.warn('[agent-cap] getDecisionLog failed:', e);
        return [];
    }
}

/**
 * Global live feed — every AgentDecisionMade across all caps, most recent
 * first. The events table is small (one event per agent tick), so a single
 * paginated query is enough for a dashboard.
 */
export async function getAllRecentDecisions(
    client: SuiClient,
    limit = 100,
): Promise<AgentDecision[]> {
    try {
        const res = await client.queryEvents({
            query: { MoveEventType: DECISION_EVENT },
            limit: Math.min(limit, 500),
            order: 'descending',
        });
        const out: AgentDecision[] = [];
        for (const ev of res.data) {
            const f = ev.parsedJson as
                | {
                      cap_id?: string;
                      owner?: string;
                      agent?: string;
                      oracle_id?: string;
                      is_mint?: boolean;
                      direction_up?: boolean;
                      strike?: string;
                      cover_usd?: string;
                      ts_ms?: string;
                      rationale_hash?: number[];
                  }
                | undefined;
            if (!f?.cap_id) continue;
            const hashHex = Array.isArray(f.rationale_hash)
                ? f.rationale_hash.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('')
                : undefined;
            out.push({
                capId: String(f.cap_id),
                owner: f.owner ? String(f.owner) : undefined,
                agent: f.agent ? String(f.agent) : undefined,
                oracleId: String(f.oracle_id ?? ''),
                isMint: Boolean(f.is_mint),
                directionUp: Boolean(f.direction_up),
                strikeUsd: Number(f.strike ?? 0) / STRIKE_SCALE,
                coverUsd: Number(f.cover_usd ?? 0) / DUSDC_SCALE,
                tsMs: Number(f.ts_ms ?? 0),
                digest: ev.id.txDigest,
                ...(hashHex ? { rationaleHash: hashHex } : {}),
            });
            if (out.length >= limit) break;
        }
        return out;
    } catch (e) {
        console.warn('[agent-cap] getAllRecentDecisions failed:', e);
        return [];
    }
}

/** True iff the cap is usable right now (exists, not revoked, not expired). */
export function isCapActive(cap: AgentCapInfo | null): boolean {
    if (!cap) return false;
    if (cap.revoked) return false;
    if (cap.expiresAtMs > 0 && Date.now() > cap.expiresAtMs) return false;
    return true;
}
