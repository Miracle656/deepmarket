// OracleHealthPanel — live oracle-feed freshness monitor. Idea #5 in the
// DeepBook Predict track ("oracle-feed health monitor"). For every active
// oracle we poll `getOracleState` and classify the age of its latest price +
// SVI update. No mocks: every number rendered is the actual on-chain
// timestamp delta from now. Feeds the agent-alerts surface (Phase 13).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Activity, RefreshCw, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import {
    listTradeableOracles,
    getOracleState,
    formatStrikeUsd,
    type OracleSummary,
    type OracleState,
} from '../lib/predict';

const POLL_MS = 30_000;
const FRESH_MS = 2 * 60 * 1000;   // < 2 min  → fresh
const STALE_MS = 10 * 60 * 1000;  // 2-10 min → stale; > 10 min → dead

type Health = 'fresh' | 'stale' | 'dead';

interface Row {
    oracle: OracleSummary;
    state: OracleState | null;
    priceAgeMs: number | null;   // null = no latest_price at all
    sviAgeMs: number | null;
    worst: Health;               // worst of (price, svi) ages
}

function ageOf(ts: number | undefined | null): number | null {
    if (!ts || ts <= 0) return null;
    return Math.max(0, Date.now() - ts);
}

function classify(ageMs: number | null): Health {
    if (ageMs === null) return 'dead';
    if (ageMs < FRESH_MS) return 'fresh';
    if (ageMs < STALE_MS) return 'stale';
    return 'dead';
}

function worstOf(a: Health, b: Health): Health {
    const rank: Record<Health, number> = { fresh: 0, stale: 1, dead: 2 };
    return rank[a] >= rank[b] ? a : b;
}

function formatAge(ms: number | null): string {
    if (ms === null) return 'no data';
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatExpiryShort(expiryMs: number): string {
    const diff = expiryMs - Date.now();
    if (diff < 0) return 'expired';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
    return `${Math.floor(diff / 86_400_000)}d`;
}

function StatusPill({ h }: { h: Health }) {
    const cfg = {
        fresh: { color: 'var(--yes)', label: 'FRESH', Icon: CheckCircle2 },
        stale: { color: '#f5a623', label: 'STALE', Icon: Clock },
        dead: { color: 'var(--no)', label: 'DEAD', Icon: AlertTriangle },
    }[h];
    const Icon = cfg.Icon;
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                color: cfg.color,
                fontSize: '0.72rem',
                fontWeight: 700,
                letterSpacing: 0.4,
            }}
        >
            <Icon size={12} />
            {cfg.label}
        </span>
    );
}

export default function OracleHealthPanel() {
    const navigate = useNavigate();
    const [rows, setRows] = useState<Row[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [lastRefresh, setLastRefresh] = useState<number>(0);

    const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const all = await listTradeableOracles();
            // Only oracles that should be getting fed — settled feeds going
            // stale is expected, not a health issue.
            const active = all.filter(
                (o) => o.status === 'active' || o.status === 'pending',
            );
            if (active.length === 0) {
                setRows([]);
                setLastRefresh(Date.now());
                return;
            }
            const states = await Promise.all(
                active.map((o) => getOracleState(o.oracle_id).catch(() => null)),
            );
            const built: Row[] = active.map((o, i) => {
                const state = states[i];
                const priceAgeMs = ageOf(state?.latest_price?.onchain_timestamp);
                const sviAgeMs = ageOf(state?.latest_svi?.onchain_timestamp);
                const worst = worstOf(classify(priceAgeMs), classify(sviAgeMs));
                return { oracle: o, state, priceAgeMs, sviAgeMs, worst };
            });
            // Worst feeds first, then by expiry (soonest expiring still wanted up top).
            const rank: Record<Health, number> = { dead: 0, stale: 1, fresh: 2 };
            built.sort((a, b) => {
                const r = rank[a.worst] - rank[b.worst];
                return r !== 0 ? r : a.oracle.expiry - b.oracle.expiry;
            });
            setRows(built);
            setLastRefresh(Date.now());
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load oracle states');
        } finally {
            setBusy(false);
        }
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, POLL_MS);
        return () => clearInterval(id);
    }, [load]);

    const totals = useMemo(() => {
        const t = { fresh: 0, stale: 0, dead: 0 };
        for (const r of rows ?? []) t[r.worst]++;
        return t;
    }, [rows]);

    return (
        <div className="surface-page">
            <div className="predict-header">
                <div>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => navigate('/predict')}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10 }}
                    >
                        <ArrowLeft size={13} /> Back to Predict
                    </button>
                    <div className="predict-eyebrow">
                        <Activity size={14} />
                        <span>DeepBook Predict · Oracle Health</span>
                    </div>
                    <h1 className="predict-title">Live feed health</h1>
                    <p className="predict-sub">
                        Per-oracle freshness of the on-chain price + SVI update. A stale or dead feed
                        means traders are pricing off old data — the keeper hasn't refreshed it
                        recently, which is the first thing to check when quotes look wrong. Polls every {POLL_MS / 1000}s.
                    </p>
                </div>
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={load}
                    disabled={busy}
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                    <RefreshCw size={14} className={busy ? 'spin' : ''} /> Refresh
                </button>
            </div>

            {/* Aggregate counts */}
            {rows && rows.length > 0 && (
                <div
                    style={{
                        display: 'flex',
                        gap: 16,
                        flexWrap: 'wrap',
                        marginTop: 4,
                        marginBottom: 16,
                        padding: '12px 16px',
                        border: '1px solid var(--border-base)',
                        borderRadius: 12,
                        background: 'var(--surface-1, transparent)',
                        fontSize: '0.85rem',
                    }}
                >
                    <span><StatusPill h="fresh" /> &nbsp;<strong>{totals.fresh}</strong></span>
                    <span><StatusPill h="stale" /> &nbsp;<strong>{totals.stale}</strong></span>
                    <span><StatusPill h="dead" /> &nbsp;<strong>{totals.dead}</strong></span>
                    <span className="vault-muted" style={{ marginLeft: 'auto' }}>
                        {rows.length} active/pending oracle{rows.length === 1 ? '' : 's'}
                        {lastRefresh > 0 && ` · last refreshed ${formatAge(Date.now() - lastRefresh)}`}
                    </span>
                </div>
            )}

            {error && <div className="vs-empty" style={{ marginTop: 16 }}>{error}</div>}
            {!rows && !error && <div className="vs-empty" style={{ marginTop: 16 }}>Loading feed health…</div>}
            {rows && rows.length === 0 && (
                <div className="vs-empty" style={{ marginTop: 16 }}>
                    No active or pending oracles right now.
                </div>
            )}

            {rows && rows.length > 0 && (
                <div
                    style={{
                        border: '1px solid var(--border-base)',
                        borderRadius: 12,
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'minmax(90px, 1fr) 100px 110px 120px 120px 90px',
                            padding: '10px 14px',
                            background: 'var(--surface-2, transparent)',
                            borderBottom: '1px solid var(--border-base)',
                            fontSize: '0.74rem',
                            fontWeight: 700,
                            letterSpacing: 0.4,
                            color: 'var(--text-muted)',
                            textTransform: 'uppercase',
                        }}
                    >
                        <span>Oracle</span>
                        <span>Status</span>
                        <span>Price age</span>
                        <span>SVI age</span>
                        <span>Min strike</span>
                        <span style={{ textAlign: 'right' }}>Expires</span>
                    </div>
                    {rows.map((r) => (
                        <div
                            key={r.oracle.oracle_id}
                            style={{
                                display: 'grid',
                                gridTemplateColumns: 'minmax(90px, 1fr) 100px 110px 120px 120px 90px',
                                padding: '12px 14px',
                                borderBottom: '1px solid var(--border-base)',
                                fontSize: '0.85rem',
                                alignItems: 'center',
                                cursor: 'pointer',
                            }}
                            onClick={() => navigate(`/predict/${r.oracle.oracle_id}`)}
                            title="Open oracle"
                        >
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{ fontWeight: 600 }}>{r.oracle.underlying_asset || 'BTC'}</span>
                                <span className="vault-muted" style={{ fontSize: '0.7rem' }}>
                                    {r.oracle.oracle_id.slice(0, 6)}…{r.oracle.oracle_id.slice(-4)}
                                </span>
                            </span>
                            <span><StatusPill h={r.worst} /></span>
                            <span
                                style={{
                                    color:
                                        classify(r.priceAgeMs) === 'fresh'
                                            ? 'var(--text-primary)'
                                            : classify(r.priceAgeMs) === 'stale'
                                                ? '#f5a623'
                                                : 'var(--no)',
                                }}
                            >
                                {formatAge(r.priceAgeMs)}
                            </span>
                            <span
                                style={{
                                    color:
                                        classify(r.sviAgeMs) === 'fresh'
                                            ? 'var(--text-primary)'
                                            : classify(r.sviAgeMs) === 'stale'
                                                ? '#f5a623'
                                                : 'var(--no)',
                                }}
                            >
                                {formatAge(r.sviAgeMs)}
                            </span>
                            <span className="vault-muted">{formatStrikeUsd(r.oracle.min_strike)}</span>
                            <span style={{ textAlign: 'right' }} className="vault-muted">
                                {formatExpiryShort(r.oracle.expiry)}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            <div className="vault-muted" style={{ marginTop: 14, fontSize: '0.78rem', textAlign: 'center' }}>
                FRESH &lt; {FRESH_MS / 60_000}m · STALE &lt; {STALE_MS / 60_000}m · DEAD older or missing.
            </div>
        </div>
    );
}
