// DeepBook Predict server client + types.
// Mirrors the frontend's `src/lib/predict.ts` shape.

import { CONFIG } from './config.js';

export type OracleStatus = 'inactive' | 'active' | 'pending' | 'settled';

export interface OracleSummary {
    predict_id: string;
    oracle_id: string;
    oracle_cap_id: string;
    underlying_asset: string;
    expiry: number;
    min_strike: number;
    tick_size: number;
    status: OracleStatus;
    activated_at: number;
    settlement_price: number | null;
    settled_at: number | null;
    created_checkpoint: number;
}

export interface PriceUpdate {
    spot: number;
    forward: number;
    onchain_timestamp: number;
}

export interface OracleState {
    oracle: OracleSummary;
    latest_price: PriceUpdate | null;
    latest_svi: unknown;
    ask_bounds: unknown;
}

export interface ManagerSummary {
    manager_id: string;
    owner: string;
    trading_balance: number;
    open_exposure: number;
    realized_pnl: number;
    unrealized_pnl: number;
    account_value: number;
    open_positions: number;
    awaiting_settlement_positions: number;
}

export type PositionStatus =
    | 'active'
    | 'open'
    | 'won'
    | 'lost'
    | 'redeemable'
    | 'awaiting_settlement';

export interface Position {
    predict_id: string;
    manager_id: string;
    oracle_id: string;
    underlying_asset: string;
    expiry: number;
    strike: number;
    is_up: boolean;
    open_quantity: number;
    open_cost_basis: number;
    realized_pnl: number;
    unrealized_pnl: number;
    mark_value: number;
    status: PositionStatus;
}

interface ManagerListEntry {
    manager_id: string;
    owner: string;
    [k: string]: unknown;
}

async function fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${CONFIG.PREDICT_SERVER_URL}${path}`);
    if (!res.ok) {
        throw new Error(`Predict server ${res.status}: ${path}`);
    }
    return (await res.json()) as T;
}

export async function listActiveOracles(): Promise<OracleSummary[]> {
    const all = await fetchJson<OracleSummary[]>(
        `/predicts/${CONFIG.PREDICT_OBJECT_ID}/oracles`
    );
    return all.filter((o) => o.status === 'active' || o.status === 'pending');
}

export async function getOracleState(oracleId: string): Promise<OracleState> {
    return fetchJson<OracleState>(`/oracles/${oracleId}/state`);
}

export async function getOracleStateBatch(
    oracleIds: string[]
): Promise<Map<string, OracleState>> {
    const results = await Promise.allSettled(
        oracleIds.map((id) => getOracleState(id))
    );
    const map = new Map<string, OracleState>();
    for (let i = 0; i < oracleIds.length; i++) {
        const r = results[i];
        const id = oracleIds[i];
        if (r && r.status === 'fulfilled' && id) {
            map.set(id, r.value);
        }
    }
    return map;
}

export async function findManagerByOwner(address: string): Promise<string | null> {
    try {
        const all = await fetchJson<ManagerListEntry[]>(`/managers`);
        const lower = address.toLowerCase();
        for (const m of all) {
            if (m.owner?.toLowerCase() === lower && m.manager_id) {
                return m.manager_id;
            }
        }
        return null;
    } catch {
        return null;
    }
}

export async function getManagerSummary(
    managerId: string
): Promise<ManagerSummary | null> {
    try {
        return await fetchJson<ManagerSummary>(`/managers/${managerId}/summary`);
    } catch {
        return null;
    }
}

export async function getManagerPositions(
    managerId: string
): Promise<Position[]> {
    try {
        return await fetchJson<Position[]>(
            `/managers/${managerId}/positions/summary`
        );
    } catch {
        return [];
    }
}

// ── Order flow (per-oracle trade tape) ────────────────────────────────────

interface RawTrade {
    type: 'mint' | 'redeem';
    checkpoint_timestamp_ms: number;
    quantity: number;
    is_up?: boolean;
    lower_strike?: number; // present on range trades — excluded from up/down skew
    payout?: number;
}

export interface OracleFlow {
    /** Number of recent trades considered. */
    trades: number;
    /** dUSDC of UP binary mints in the window (human). */
    upMintUsd: number;
    /** dUSDC of DOWN binary mints in the window (human). */
    downMintUsd: number;
    /** dUSDC of redemptions in the window (human). */
    redeemUsd: number;
    /** (up − down) / (up + down) ∈ [-1, 1]. >0 = crowd leaning UP. */
    netSkew: number;
    /** Minutes the window spans (oldest→now). 0 if no trades. */
    windowMin: number;
}

const EMPTY_FLOW: OracleFlow = {
    trades: 0,
    upMintUsd: 0,
    downMintUsd: 0,
    redeemUsd: 0,
    netSkew: 0,
    windowMin: 0,
};

/**
 * Real order-flow snapshot for one oracle from the public trade tape
 * (`/trades/:id`). Lets the agent read what the crowd is actually doing —
 * net UP vs DOWN mint pressure + redemption flow — not just price/vol.
 * Returns an all-zero snapshot on any error or when the oracle has no trades.
 */
export async function computeOracleFlow(
    oracleId: string,
    limit = 50
): Promise<OracleFlow> {
    let raw: RawTrade[];
    try {
        raw = await fetchJson<RawTrade[]>(`/trades/${oracleId}?limit=${limit}`);
    } catch {
        return EMPTY_FLOW;
    }
    if (!Array.isArray(raw) || raw.length === 0) return EMPTY_FLOW;

    const QTY = 1_000_000;
    let up = 0;
    let down = 0;
    let redeem = 0;
    let oldest = Date.now();
    for (const t of raw) {
        if (t.checkpoint_timestamp_ms < oldest) oldest = t.checkpoint_timestamp_ms;
        const qty = (t.quantity ?? 0) / QTY;
        if (t.type === 'mint') {
            if (t.lower_strike != null) continue; // range mint — no up/down dir
            if (t.is_up) up += qty;
            else down += qty;
        } else {
            redeem += (t.payout ?? t.quantity ?? 0) / QTY;
        }
    }
    const tot = up + down;
    return {
        trades: raw.length,
        upMintUsd: up,
        downMintUsd: down,
        redeemUsd: redeem,
        netSkew: tot > 0 ? (up - down) / tot : 0,
        windowMin: Math.max(1, (Date.now() - oldest) / 60_000),
    };
}

/** Every PredictManager on the configured Predict instance (id + owner). */
export async function listAllManagers(): Promise<
    { manager_id: string; owner: string }[]
> {
    try {
        const raw = await fetchJson<ManagerListEntry[]>(`/managers`);
        return raw
            .filter((m) => typeof m.manager_id === 'string' && typeof m.owner === 'string')
            .map((m) => ({ manager_id: m.manager_id, owner: m.owner as string }));
    } catch {
        return [];
    }
}

const RAW_TO_USD = 1_000_000_000;
const DUSDC_SCALE = 1_000_000;

export function strikeToUsd(rawStrike: number): number {
    return rawStrike / RAW_TO_USD;
}

export function spotToUsd(rawSpot: number): number {
    return rawSpot / RAW_TO_USD;
}

export function dusdcToUsd(raw: number): number {
    return raw / DUSDC_SCALE;
}

export function formatExpiry(expiryMs: number): string {
    const d = new Date(expiryMs);
    const now = Date.now();
    const diff = expiryMs - now;
    if (diff < 0) {
        return `${d.toLocaleString()} (settled)`;
    }
    if (diff < 60_000) return `in ${Math.floor(diff / 1000)}s`;
    if (diff < 3_600_000) return `in ${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h`;
    return d.toLocaleString();
}
