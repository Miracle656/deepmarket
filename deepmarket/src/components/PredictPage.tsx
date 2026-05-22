// PredictPage — top-level Predict markets surface.
//
// Lists tradeable + recently-expired BTC oracles from the public Predict server.
// Click an oracle to drill into its strike grid + mint UI.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Clock, RefreshCw, TrendingUp, AlertCircle } from 'lucide-react';
import {
    listTradeableOracles,
    formatStrikeUsd,
    formatExpiry,
    statusColor,
    type OracleSummary,
} from '../lib/predict';

export default function PredictPage() {
    const navigate = useNavigate();
    const [oracles, setOracles] = useState<OracleSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

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

    const active = oracles?.filter((o) => o.status === 'active') ?? [];
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
                </div>
            )}

            {oracles && (
                <>
                    <Section
                        title="Active"
                        count={active.length}
                        icon={<TrendingUp size={14} />}
                        oracles={active}
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
}: {
    title: string;
    count: number;
    icon: React.ReactNode;
    oracles: OracleSummary[];
    onPick: (id: string) => void;
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
                    <OracleCard key={o.oracle_id} oracle={o} onPick={onPick} />
                ))}
            </div>
        </div>
    );
}

function OracleCard({
    oracle,
    onPick,
}: {
    oracle: OracleSummary;
    onPick: (id: string) => void;
}) {
    return (
        <button
            className="predict-card"
            onClick={() => onPick(oracle.oracle_id)}
            data-status={oracle.status}
        >
            <div className="predict-card-h">
                <span className="predict-card-asset">{oracle.underlying_asset}</span>
                <span
                    className="predict-card-status"
                    style={{ color: statusColor(oracle.status) }}
                >
                    {oracle.status}
                </span>
            </div>
            <div className="predict-card-expiry">
                <Clock size={12} />
                <span>{formatExpiry(oracle.expiry)}</span>
            </div>
            <div className="predict-card-strike">
                <span className="predict-card-label">Min strike</span>
                <span className="predict-card-value">
                    {formatStrikeUsd(oracle.min_strike)}
                </span>
            </div>
            {oracle.settlement_price !== null && oracle.settlement_price !== undefined && (
                <div className="predict-card-strike">
                    <span className="predict-card-label">Settled at</span>
                    <span className="predict-card-value">
                        {formatStrikeUsd(oracle.settlement_price)}
                    </span>
                </div>
            )}
        </button>
    );
}
