// PredictPage — top-level Predict markets surface.
//
// Lists tradeable + recently-expired BTC oracles from the public Predict server.
// Click an oracle to drill into its strike grid + mint UI.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Activity,
    Clock,
    RefreshCw,
    TrendingUp,
    AlertCircle,
    BarChart3,
    HeartPulse,
    Bot,
    ArrowRight,
} from 'lucide-react';
import {
    listTradeableOracles,
    getCachedTradeableOracles,
    getOracleTradeCount,
    getOracleState,
    formatStrikeUsd,
    formatExpiry,
    statusColor,
    type OracleSummary,
} from '../lib/predict';
import { binaryFairPrice, sviFromUpdate, yearsToExpiry } from '../lib/svi';

export default function PredictPage() {
    const navigate = useNavigate();
    // Paint instantly from cache (even if stale) while the ~20s network
    // refresh runs in the background; null only on first-ever visit.
    const [oracles, setOracles] = useState<OracleSummary[] | null>(() => getCachedTradeableOracles());
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [sort, setSort] = useState<'soon' | 'far' | 'new' | 'traded'>('soon');
    // Per-oracle trade counts (active oracles only). Powers the "Most traded"
    // sort + the per-card activity badge — most testnet oracles have zero
    // trades, so this surfaces the live ones.
    const [tradeCounts, setTradeCounts] = useState<Record<string, number>>({});

    const load = async () => {
        setError(null);
        setRefreshing(true);
        try {
            const data = await listTradeableOracles();
            setOracles(data);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load oracles');
        } finally {
            setRefreshing(false);
        }
    };

    useEffect(() => {
        load();
        const interval = setInterval(load, 30_000);
        return () => clearInterval(interval);
    }, []);

    // Stable key for the active set (sorted by id, independent of display sort)
    // so the count fetch only refires when the active oracles actually change.
    const activeOracleIds = useMemo(
        () =>
            (oracles ?? [])
                .filter((o) => o.status === 'active')
                .map((o) => o.oracle_id)
                .sort(),
        [oracles]
    );
    const activeIdsKey = activeOracleIds.join(',');

    useEffect(() => {
        if (activeOracleIds.length === 0) return;
        let cancelled = false;
        (async () => {
            const entries = await Promise.all(
                activeOracleIds.map(
                    async (id) => [id, await getOracleTradeCount(id)] as const
                )
            );
            if (!cancelled) setTradeCounts(Object.fromEntries(entries));
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeIdsKey]);

    const sortFn = (a: OracleSummary, b: OracleSummary) => {
        if (sort === 'soon') return a.expiry - b.expiry; // expiring first
        if (sort === 'far') return b.expiry - a.expiry; // furthest first
        if (sort === 'traded')
            return (
                (tradeCounts[b.oracle_id] ?? 0) - (tradeCounts[a.oracle_id] ?? 0)
            ); // most-traded first
        return (b.activated_at ?? 0) - (a.activated_at ?? 0); // newest first
    };
    const active = (oracles?.filter((o) => o.status === 'active') ?? []).sort(sortFn);
    const pending = oracles?.filter((o) => o.status === 'pending') ?? [];
    const settled = oracles?.filter((o) => o.status === 'settled') ?? [];

    return (
        <div className="predict-page">
            <div className="predict-header">
                <div>
                    <div className="predict-eyebrow">
                        <Activity size={14} />
                        <span>DeepBook Predict · Testnet</span>
                    </div>
                    <h1 className="predict-title">Oracle-priced markets</h1>
                    <p className="predict-sub">
                        Binary positions on rolling sub-hour BTC oracles. Quote
                        asset: dUSDC. Pricing via SVI vol surface.
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="sort-seg">
                        {([
                            ['soon', 'Expiring soon'],
                            ['traded', 'Most traded'],
                            ['new', 'Newest'],
                            ['far', 'Furthest'],
                        ] as const).map(([k, label]) => (
                            <button
                                key={k}
                                className={`sort-seg-btn ${sort === k ? 'active' : ''}`}
                                onClick={() => setSort(k)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={load}
                        disabled={refreshing}
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                        <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
                        Refresh
                    </button>
                </div>
            </div>

            {/* Surface Studio + Oracle Health CTAs — standalone so they never crowd the header row */}
            <div className="surface-cta-row">
                <button
                    className="surface-cta"
                    onClick={() => navigate('/surface')}
                    title="Live multi-expiry SVI surface + arb-free checker"
                >
                    <span className="surface-cta-label">
                        <BarChart3 size={15} />
                        Surface Studio — live SVI surface &amp; arbitrage-free checker
                    </span>
                    <ArrowRight size={15} aria-hidden />
                </button>
                <button
                    className="surface-cta"
                    onClick={() => navigate('/health')}
                    title="Per-oracle feed freshness monitor"
                >
                    <span className="surface-cta-label">
                        <HeartPulse size={15} />
                        Oracle Health — live feed freshness
                    </span>
                    <ArrowRight size={15} aria-hidden />
                </button>
                <button
                    className="surface-cta"
                    onClick={() => navigate('/agents')}
                    title="Public on-chain AI agent decision feed"
                >
                    <span className="surface-cta-label">
                        <Bot size={15} />
                        Agent Feed — live AI decisions on-chain
                    </span>
                    <ArrowRight size={15} aria-hidden />
                </button>
            </div>

            {error && (
                <div className="alert alert-error" style={{ marginTop: 16 }}>
                    <AlertCircle size={14} style={{ marginRight: 8 }} />
                    {error}
                </div>
            )}

            {!oracles && !error && (
                <div className="predict-empty">
                    <RefreshCw size={28} className="spin" />
                    <div>Loading oracles…</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 6 }}>
                        First load pulls the full oracle set from Mysten's server and can take
                        ~20s. It's cached after that.
                    </div>
                </div>
            )}

            {oracles && (
                <>
                    <Section
                        title="Active"
                        count={active.length}
                        icon={<TrendingUp size={14} />}
                        oracles={active}
                        tradeCounts={tradeCounts}
                        onPick={(id) => navigate(`/predict/${id}`)}
                    />
                    <Section
                        title="Pending settlement"
                        count={pending.length}
                        icon={<Clock size={14} />}
                        oracles={pending}
                        onPick={(id) => navigate(`/predict/${id}`)}
                    />
                    {settled.length > 0 && (
                        <Section
                            title="Recently settled"
                            count={settled.length}
                            icon={<Clock size={14} />}
                            oracles={settled.slice(0, 12)}
                            onPick={(id) => navigate(`/predict/${id}`)}
                        />
                    )}
                </>
            )}
        </div>
    );
}

function Section({
    title,
    count,
    icon,
    oracles,
    onPick,
    tradeCounts,
}: {
    title: string;
    count: number;
    icon: React.ReactNode;
    oracles: OracleSummary[];
    onPick: (id: string) => void;
    tradeCounts?: Record<string, number>;
}) {
    if (oracles.length === 0) return null;
    return (
        <div className="predict-section">
            <div className="predict-section-h">
                {icon}
                <span>{title}</span>
                <span className="predict-count">{count}</span>
            </div>
            <div className="predict-grid">
                {oracles.map((o) => (
                    <OracleCard
                        key={o.oracle_id}
                        oracle={o}
                        onPick={onPick}
                        tradeCount={tradeCounts?.[o.oracle_id]}
                    />
                ))}
            </div>
        </div>
    );
}

function OracleCard({
    oracle,
    onPick,
    tradeCount,
}: {
    oracle: OracleSummary;
    onPick: (id: string) => void;
    tradeCount?: number;
}) {
    const settled = oracle.status === 'settled';
    // Live SVI-implied odds + a near-the-money strike, so each card reads like a
    // real prediction market ("Will BTC be above $X?" → Up 62% / Down 38%)
    // instead of the meaningless shared $50k min_strike.
    const [odds, setOdds] = useState<{ up: number; strikeRaw: number } | null>(null);

    useEffect(() => {
        if (settled) return;
        let cancelled = false;
        getOracleState(oracle.oracle_id)
            .then((st) => {
                if (cancelled || !st.latest_price) return;
                const fwdRaw = st.latest_price.forward || st.latest_price.spot;
                const fwdUsd = fwdRaw / 1e9;
                const strikeUsd = Math.max(500, Math.round(fwdUsd / 500) * 500);
                const strikeRaw = strikeUsd * 1e9;
                const T = yearsToExpiry(oracle.expiry);
                let up = 0.5;
                if (st.latest_svi) {
                    up = binaryFairPrice(fwdRaw, strikeRaw, T, sviFromUpdate(st.latest_svi), true);
                }
                up = Math.min(0.99, Math.max(0.01, up));
                if (!cancelled) setOdds({ up, strikeRaw });
            })
            .catch(() => {
                /* leave odds null → shows placeholder */
            });
        return () => {
            cancelled = true;
        };
    }, [oracle.oracle_id, oracle.expiry, settled]);

    const upPct = odds ? Math.round(odds.up * 100) : null;
    const downPct = upPct === null ? null : 100 - upPct;

    return (
        <div
            className="predict-card pm-card"
            role="button"
            tabIndex={0}
            onClick={() => onPick(oracle.oracle_id)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onPick(oracle.oracle_id);
                }
            }}
            data-status={oracle.status}
        >
            <div className="predict-card-h">
                <span className="pm-asset">
                    <span className="pm-asset-dot" />
                    {oracle.underlying_asset}
                </span>
                <span
                    className="predict-card-status"
                    style={{ color: statusColor(oracle.status) }}
                >
                    {oracle.status}
                </span>
            </div>

            <div className="pm-q">
                {settled
                    ? `${oracle.underlying_asset} round settled`
                    : `Will ${oracle.underlying_asset} be above ${
                          odds ? formatStrikeUsd(odds.strikeRaw) : '…'
                      }?`}
            </div>

            {settled ? (
                oracle.settlement_price !== null &&
                oracle.settlement_price !== undefined && (
                    <div className="predict-card-strike">
                        <span className="predict-card-label">Settled at</span>
                        <span className="predict-card-value">
                            {formatStrikeUsd(oracle.settlement_price)}
                        </span>
                    </div>
                )
            ) : (
                <div className="pm-sides">
                    <div className="pm-side up">
                        <span
                            className="pm-side-bar"
                            style={{ width: `${upPct ?? 0}%` }}
                        />
                        <span className="pm-side-label">Up</span>
                        <span className="pm-side-pct">
                            {upPct === null ? '··' : `${upPct}%`}
                        </span>
                    </div>
                    <div className="pm-side down">
                        <span
                            className="pm-side-bar"
                            style={{ width: `${downPct ?? 0}%` }}
                        />
                        <span className="pm-side-label">Down</span>
                        <span className="pm-side-pct">
                            {downPct === null ? '··' : `${downPct}%`}
                        </span>
                    </div>
                </div>
            )}

            <div className="pm-foot">
                <span className="pm-foot-item">
                    <Clock size={12} />
                    {formatExpiry(oracle.expiry)}
                </span>
                {tradeCount !== undefined && (
                    <span
                        className="pm-foot-item"
                        style={{
                            marginLeft: 'auto',
                            color: tradeCount > 0 ? 'var(--yes)' : 'var(--text-muted)',
                        }}
                    >
                        <Activity size={12} />
                        {tradeCount > 0
                            ? `${tradeCount}${tradeCount >= 100 ? '+' : ''} trades`
                            : 'no trades'}
                    </span>
                )}
            </div>
        </div>
    );
}
