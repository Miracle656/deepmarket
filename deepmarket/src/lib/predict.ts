// DeepBook Predict — server fetch helpers + types.
//
// Reads from the public Predict server at predict-server.testnet.mystenlabs.com.
// Server provides indexed market state, oracle list, manager portfolios, vault summaries.
// Use Sui RPC for confirmation-critical reads around wallet flows.

import type { SuiObjectChange } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import type { useSuiClient } from '@mysten/dapp-kit';
import { CONFIG } from './config';

type SuiClient = ReturnType<typeof useSuiClient>;
const ZERO_ADDR =
    '0x0000000000000000000000000000000000000000000000000000000000000000';

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

export interface ManagerBalance {
    quote_asset: string;
    balance: number;
}

export interface ManagerSummary {
    manager_id: string;
    owner: string;
    balances: ManagerBalance[];
    trading_balance: number;
    open_exposure: number;
    redeemable_value: number;
    realized_pnl: number;
    unrealized_pnl: number;
    account_value: number;
    open_positions: number;
    awaiting_settlement_positions: number;
}

export interface ManagerListEntry {
    manager_id: string;
    owner: string;
    digest: string;
    checkpoint: number;
    checkpoint_timestamp_ms: number;
    [key: string]: unknown;
}

export type PositionStatus = 'open' | 'won' | 'lost' | 'awaiting_settlement';

export interface Position {
    predict_id: string;
    manager_id: string;
    quote_asset: string;
    oracle_id: string;
    underlying_asset: string;
    expiry: number;
    strike: number;
    is_up: boolean;
    minted_quantity: number;
    redeemed_quantity: number;
    open_quantity: number;
    total_cost: number;
    total_payout: number;
    realized_pnl: number;
    unrealized_pnl: number;
    open_cost_basis: number;
    average_entry_price: number;
    average_exit_price: number | null;
    mark_price: number;
    mark_value: number;
    status: PositionStatus;
    first_minted_at: number;
    last_activity_at: number;
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

export async function getManagerPositions(managerId: string): Promise<Position[]> {
    return fetchJson<Position[]>(`/managers/${managerId}/positions/summary`);
}

/**
 * Find an existing PredictManager owned by `address` by scanning /managers.
 * Cold-start fallback when the localStorage cache is empty. Returns only the
 * first manager; use `findAllManagersByOwner` to see every manager.
 */
export async function findManagerByOwner(address: string): Promise<string | null> {
    const all = await findAllManagersByOwner(address);
    return all[0] ?? null;
}

/**
 * Return EVERY PredictManager owned by `address`. The protocol allows a
 * single owner to hold multiple managers (e.g., one for web-app trading +
 * one for a Telegram bot wallet — same Sui address can spawn both via
 * `predict::create_manager`). Returns ids newest-first.
 */
export async function findAllManagersByOwner(address: string): Promise<string[]> {
    try {
        const all = await fetchJson<ManagerListEntry[]>(`/managers`);
        const lower = address.toLowerCase();
        const matched: ManagerListEntry[] = [];
        for (const m of all) {
            if (m.owner?.toLowerCase() === lower && m.manager_id) {
                matched.push(m);
            }
        }
        // Server returns newest-first already; preserve that order.
        return matched.map((m) => m.manager_id);
    } catch {
        return [];
    }
}

export async function getVaultSummary(): Promise<unknown> {
    return fetchJson(`/predicts/${CONFIG.PREDICT_OBJECT_ID}/vault/summary`);
}

// ──────────────────────────────────────────────────────────────────────────
// LP vault — on-chain reads (the LP/maker side of Predict)
// ──────────────────────────────────────────────────────────────────────────

export interface VaultStats {
    /** Total dUSDC held by the vault (human). */
    tvl: number;
    /** Net asset value = balance − holders' mark-to-market (human). */
    vaultValue: number;
    /** Outstanding max payout the vault is on the hook for (human). */
    totalMaxPayout: number;
    /** Total MTM (sum of mark-to-market across holders' positions, human). */
    totalMtm: number;
    /** Withdrawable headroom = balance − max payout (human). */
    available: number;
    /** Total PLP shares minted (raw). */
    totalShares: number;
    /** vaultValue in raw base units — used to value LP shares precisely. */
    vaultValueRaw: number;
    /** Configured cap on total exposure (% of vault, 0–1). 1e9-scaled on-chain. */
    maxExposurePct: number;
    /** Withdrawal token-bucket state. */
    withdrawalLimiter: {
        enabled: boolean;
        availableUsd: number; // human, base/1e6
        capacityUsd: number; // human
        refillRatePerMs: number; // raw (per ms)
        lastUpdatedMs: number;
    };
    /** Quote-asset type strings the vault accepts for new supply/mint. */
    acceptedQuotes: string[];
}

/**
 * Read the Predict vault's live state straight from the shared object +
 * PLP total supply. No server, no devInspect — just getObject/getTotalSupply.
 */
type PredictContent = {
    fields?: {
        vault?: { fields?: Record<string, string> };
        treasury_cap?: {
            fields?: { total_supply?: { fields?: { value?: string } } };
        };
        risk_config?: {
            fields?: { max_total_exposure_pct?: string };
        };
        withdrawal_limiter?: {
            fields?: {
                enabled?: boolean;
                available?: string;
                capacity?: string;
                refill_rate_per_ms?: string;
                last_updated_ms?: string;
            };
        };
        treasury_config?: {
            fields?: {
                accepted_quotes?: {
                    fields?: {
                        contents?: { fields?: { name?: string } }[];
                    };
                };
            };
        };
    };
};

export async function getVaultStats(client: SuiClient): Promise<VaultStats | null> {
    try {
        // PLP's TreasuryCap is wrapped inside the Predict object, so
        // suix_getTotalSupply can't see it — read both vault state AND total
        // shares from the one shared object.
        const obj = await client.getObject({
            id: CONFIG.PREDICT_OBJECT_ID,
            options: { showContent: true },
        });
        const content = obj.data?.content as PredictContent | undefined;
        const v = content?.fields?.vault?.fields;
        if (!v) return null;

        const balance = Number(v.balance ?? 0);
        const mtm = Number(v.total_mtm ?? 0);
        const maxPayout = Number(v.total_max_payout ?? 0);
        const totalShares = Number(
            content?.fields?.treasury_cap?.fields?.total_supply?.fields?.value ?? 0
        );
        const D = 10 ** CONFIG.DUSDC_DECIMALS;
        const vaultValueRaw = Math.max(0, balance - mtm);

        // Risk fields — all read from the same shared object, no extra RPCs.
        const maxExposureRaw = Number(
            content?.fields?.risk_config?.fields?.max_total_exposure_pct ?? 0
        );
        const wl = content?.fields?.withdrawal_limiter?.fields;
        const acceptedQuotes = (
            content?.fields?.treasury_config?.fields?.accepted_quotes?.fields?.contents ?? []
        )
            .map((q) => q?.fields?.name)
            .filter((n): n is string => typeof n === 'string')
            .map((n) => (n.startsWith('0x') ? n : `0x${n}`));

        return {
            tvl: balance / D,
            vaultValue: vaultValueRaw / D,
            totalMaxPayout: maxPayout / D,
            totalMtm: mtm / D,
            available: Math.max(0, balance - maxPayout) / D,
            totalShares,
            vaultValueRaw,
            maxExposurePct: maxExposureRaw / 1e9,
            withdrawalLimiter: {
                enabled: Boolean(wl?.enabled),
                availableUsd: Number(wl?.available ?? 0) / D,
                capacityUsd: Number(wl?.capacity ?? 0) / D,
                refillRatePerMs: Number(wl?.refill_rate_per_ms ?? 0),
                lastUpdatedMs: Number(wl?.last_updated_ms ?? 0),
            },
            acceptedQuotes,
        };
    } catch {
        return null;
    }
}

export interface LpPosition {
    /** PLP shares held (raw base units). */
    shares: number;
    /** Current redeemable value in dUSDC (human). */
    valueUsd: number;
}

/** The caller's LP position: PLP balance valued at the current share price. */
export async function getLpPosition(
    client: SuiClient,
    address: string,
    stats?: VaultStats | null
): Promise<LpPosition> {
    try {
        const bal = await client.getBalance({
            owner: address,
            coinType: CONFIG.PREDICT_PLP_TYPE,
        });
        const shares = Number(bal.totalBalance);
        if (shares === 0) return { shares: 0, valueUsd: 0 };

        const s = stats ?? (await getVaultStats(client));
        if (!s || s.totalShares === 0) return { shares, valueUsd: 0 };

        const valueUsd =
            (shares * s.vaultValueRaw) / s.totalShares / 10 ** CONFIG.DUSDC_DECIMALS;
        return { shares, valueUsd };
    } catch {
        return { shares: 0, valueUsd: 0 };
    }
}

/**
 * Oracle IDs the vault is currently exposed to and that aren't settled —
 * `supply`/`withdraw` need each one's mark-to-market refreshed first. Read via
 * devInspect of `predict::unsettled_exposed_oracles`.
 */
export async function getUnsettledExposedOracles(
    client: SuiClient
): Promise<string[]> {
    try {
        const tx = new Transaction();
        tx.moveCall({
            target: `${CONFIG.PREDICT_PACKAGE_ID}::predict::unsettled_exposed_oracles`,
            arguments: [tx.object(CONFIG.PREDICT_OBJECT_ID)],
        });
        const r = await client.devInspectTransactionBlock({
            sender: ZERO_ADDR,
            transactionBlock: tx,
        });
        const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
        if (!bytes) return [];
        return bcs.vector(bcs.Address).parse(new Uint8Array(bytes)) as string[];
    } catch {
        return [];
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Trade tape — per-oracle mint/redeem feed (/trades/:oracleId)
// ──────────────────────────────────────────────────────────────────────────

const PRICE_SCALE = 1e9;
const QTY_SCALE = 10 ** CONFIG.DUSDC_DECIMALS; // dUSDC base units (1e6)

interface RawTrade {
    type: 'mint' | 'redeem';
    digest: string;
    checkpoint_timestamp_ms: number;
    trader?: string;
    owner?: string;
    quantity: number;
    strike?: number;
    is_up?: boolean;
    lower_strike?: number;
    higher_strike?: number;
    cost?: number;
    ask_price?: number;
    payout?: number;
    bid_price?: number;
}

export interface TradeTapeEntry {
    kind: 'binary' | 'range';
    side: 'mint' | 'redeem';
    timestampMs: number;
    txDigest: string;
    trader: string;
    quantity: number;
    strike?: number;
    isUp?: boolean;
    lowerStrike?: number;
    higherStrike?: number;
    cost?: number; // mint
    askPrice?: number; // mint (0..1 = ¢)
    payout?: number; // redeem
    bidPrice?: number; // redeem
}

export async function getOracleTrades(
    oracleId: string,
    limit = 50
): Promise<TradeTapeEntry[]> {
    const raw = await fetchJson<RawTrade[]>(`/trades/${oracleId}?limit=${limit}`);
    return raw.map((r) => {
        const isRange = r.lower_strike != null;
        const base = {
            kind: (isRange ? 'range' : 'binary') as 'binary' | 'range',
            side: r.type,
            timestampMs: r.checkpoint_timestamp_ms,
            txDigest: r.digest,
            trader: r.trader ?? r.owner ?? '',
            quantity: r.quantity / QTY_SCALE,
        };
        const priceFields =
            r.type === 'mint'
                ? { cost: (r.cost ?? 0) / QTY_SCALE, askPrice: (r.ask_price ?? 0) / PRICE_SCALE }
                : { payout: (r.payout ?? 0) / QTY_SCALE, bidPrice: (r.bid_price ?? 0) / PRICE_SCALE };
        return isRange
            ? {
                  ...base,
                  lowerStrike: (r.lower_strike ?? 0) / PRICE_SCALE,
                  higherStrike: (r.higher_strike ?? 0) / PRICE_SCALE,
                  ...priceFields,
              }
            : { ...base, strike: (r.strike ?? 0) / PRICE_SCALE, isUp: r.is_up, ...priceFields };
    });
}

// ──────────────────────────────────────────────────────────────────────────
// Manager PnL time series (/managers/:id/pnl) + leaderboard (/managers)
// ──────────────────────────────────────────────────────────────────────────

interface RawPnl {
    points?: {
        timestamp_ms: number;
        realized_pnl: number;
        cumulative_realized_pnl: number;
    }[];
    current_unrealized_pnl?: number;
    current_total_pnl?: number;
}

export interface PnlPoint {
    timestampMs: number;
    realizedPnl: number;
    cumulativeRealizedPnl: number;
}

export interface PnlSeries {
    points: PnlPoint[];
    currentUnrealizedPnl: number;
    currentTotalPnl: number;
}

export type PnlRange = '1D' | '1W' | '1M' | '3M' | 'ALL';

export async function getManagerPnl(
    managerId: string,
    range: PnlRange = 'ALL'
): Promise<PnlSeries> {
    const r = await fetchJson<RawPnl>(`/managers/${managerId}/pnl?range=${range}`);
    return {
        points: (r.points ?? []).map((p) => ({
            timestampMs: p.timestamp_ms,
            realizedPnl: p.realized_pnl / QTY_SCALE,
            cumulativeRealizedPnl: p.cumulative_realized_pnl / QTY_SCALE,
        })),
        currentUnrealizedPnl: (r.current_unrealized_pnl ?? 0) / QTY_SCALE,
        currentTotalPnl: (r.current_total_pnl ?? 0) / QTY_SCALE,
    };
}

export interface LeaderboardRow {
    managerId: string;
    owner: string;
    realizedPnl: number;
    unrealizedPnl: number;
    accountValue: number;
    openPositions: number;
}

/**
 * Settlement leaderboard — managers ranked by realized PnL. The /managers list
 * has no PnL, so we fetch summaries for up to `maxManagers` (newest) and rank.
 */
export async function getLeaderboard(maxManagers = 60): Promise<LeaderboardRow[]> {
    const managers = await fetchJson<ManagerListEntry[]>(`/managers`);
    const slice = managers.slice(0, maxManagers);
    const summaries = await Promise.all(
        slice.map((m) => getManagerSummary(m.manager_id).catch(() => null))
    );
    const rows: LeaderboardRow[] = [];
    for (const s of summaries) {
        if (!s) continue;
        rows.push({
            managerId: s.manager_id,
            owner: s.owner,
            realizedPnl: s.realized_pnl / QTY_SCALE,
            unrealizedPnl: s.unrealized_pnl / QTY_SCALE,
            accountValue: s.account_value / QTY_SCALE,
            openPositions: s.open_positions,
        });
    }
    rows.sort((a, b) => b.realizedPnl - a.realizedPnl);
    return rows;
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

// ──────────────────────────────────────────────────────────────────────────
// PredictManager lookup (localStorage cache + tx-effects extraction)
// ──────────────────────────────────────────────────────────────────────────

const MANAGER_TYPE = `${CONFIG.PREDICT_PACKAGE_ID}::predict_manager::PredictManager`;
const managerStorageKey = (address: string) =>
    `predict.manager.${address.toLowerCase()}`;

/** Read the cached PredictManager id for `address`, if any. */
export function getCachedManagerId(address: string): string | null {
    try {
        return localStorage.getItem(managerStorageKey(address));
    } catch {
        return null;
    }
}

export function setCachedManagerId(address: string, managerId: string): void {
    try {
        localStorage.setItem(managerStorageKey(address), managerId);
    } catch {
        // ignore quota / disabled storage
    }
}

export function clearCachedManagerId(address: string): void {
    try {
        localStorage.removeItem(managerStorageKey(address));
    } catch {
        // ignore
    }
}

/**
 * Find a freshly-created PredictManager id in `tx.objectChanges`.
 * Returns null if no created PredictManager is present.
 */
export function extractManagerIdFromChanges(
    changes: SuiObjectChange[] | null | undefined,
): string | null {
    if (!changes) return null;
    for (const ch of changes) {
        if (ch.type === 'created' && ch.objectType === MANAGER_TYPE) {
            return ch.objectId;
        }
    }
    return null;
}

/**
 * Validate a cached manager id by hitting the server. Clears the cache and
 * returns null on 404; returns the id unchanged on any other outcome (server
 * errors fail open so users keep their cached value if the indexer is down).
 */
export async function validateManagerId(
    address: string,
    managerId: string,
): Promise<string | null> {
    try {
        const res = await fetch(`${SERVER}/managers/${managerId}/summary`);
        if (res.status === 404) {
            clearCachedManagerId(address);
            return null;
        }
        return managerId;
    } catch {
        return managerId;
    }
}
