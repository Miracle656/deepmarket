// DeepBook Predict — server fetch helpers + types.
//
// Reads from the public Predict server at predict-server.testnet.mystenlabs.com.
// Server provides indexed market state, oracle list, manager portfolios, vault summaries.
// Use Sui RPC for confirmation-critical reads around wallet flows.

import { CONFIG } from './config';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

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
    checkpoint_timestamp_ms?: number;
}

export interface SviUpdate {
    a: number;
    b: number;
    rho: number;
    rho_negative: boolean;
    m: number;
    m_negative: boolean;
    sigma: number;
    onchain_timestamp: number;
}

export interface OracleState {
    oracle: OracleSummary;
    latest_price: PriceUpdate | null;
    latest_svi: SviUpdate | null;
    ask_bounds: unknown;
}

export interface ManagerSummary {
    manager_id: string;
    owner: string;
    quote_balance: number;
    [key: string]: unknown;
}

// ──────────────────────────────────────────────────────────────────────────
// Server fetch
// ──────────────────────────────────────────────────────────────────────────

const SERVER = CONFIG.PREDICT_SERVER_URL;

async function fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${SERVER}${path}`);
    if (!res.ok) {
        throw new Error(`Predict server ${res.status}: ${path}`);
    }
    return (await res.json()) as T;
}

/** All oracles for the configured Predict object (1800+, mostly historical). */
export async function listAllOracles(): Promise<OracleSummary[]> {
    return fetchJson<OracleSummary[]>(
        `/predicts/${CONFIG.PREDICT_OBJECT_ID}/oracles`
    );
}

/**
 * Active + recently expired oracles, newest first.
 * Filters out long-settled oracles to keep the UI focused on tradeable + just-settled markets.
 */
export async function listTradeableOracles(): Promise<OracleSummary[]> {
    const all = await listAllOracles();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h
    return all
        .filter((o) => o.status === 'active' || o.status === 'pending' || o.expiry >= cutoff)
        .sort((a, b) => b.expiry - a.expiry);
}

export async function getOracleState(oracleId: string): Promise<OracleState> {
    return fetchJson<OracleState>(`/oracles/${oracleId}/state`);
}

export async function getOracleAskBounds(oracleId: string): Promise<unknown> {
    return fetchJson(`/oracles/${oracleId}/ask-bounds`);
}

export async function getManagerSummary(managerId: string): Promise<ManagerSummary> {
    return fetchJson<ManagerSummary>(`/managers/${managerId}/summary`);
}

export async function getManagerPositions(managerId: string): Promise<unknown> {
    return fetchJson(`/managers/${managerId}/positions/summary`);
}

export async function getVaultSummary(): Promise<unknown> {
    return fetchJson(`/predicts/${CONFIG.PREDICT_OBJECT_ID}/vault/summary`);
}

// ──────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Format a strike value to a human USD price.
 * Strikes are stored in some scaled u64 unit — observed `min_strike: 50_000_000_000_000`
 * for a $50K BTC strike, which means the scaling factor is 1e9 (so $50K = 5e13 / 1e9).
 */
export function formatStrikeUsd(rawStrike: number): string {
    const usd = rawStrike / 1_000_000_000;
    return `$${usd.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    })}`;
}

export function formatExpiry(expiryMs: number): string {
    const d = new Date(expiryMs);
    const now = Date.now();
    const diff = expiryMs - now;
    if (diff < 0) {
        const ago = Math.abs(diff);
        if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
        if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
        return `${d.toLocaleDateString()} (settled)`;
    }
    if (diff < 3_600_000) return `in ${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h`;
    return d.toLocaleDateString();
}

export function statusColor(status: OracleStatus): string {
    switch (status) {
        case 'active':
            return 'var(--yes)';
        case 'pending':
            return '#f5a623';
        case 'settled':
            return 'var(--text-muted)';
        default:
            return 'var(--text-secondary)';
    }
}
