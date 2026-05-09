// PredictDetailPage — single oracle's market detail with mint scaffolding.
//
// v0 scope: show oracle state from server, dUSDC balance, PredictManager
// status, and a placeholder Mint button. Full mint flow lands next session.

import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { ArrowLeft, RefreshCw, AlertCircle, TrendingUp, Lock, Activity } from 'lucide-react';
import {
    getOracleState,
    formatStrikeUsd,
    formatExpiry,
    statusColor,
    type OracleState,
} from '../lib/predict';
import { CONFIG } from '../lib/config';

export default function PredictDetailPage() {
    const { oracleId } = useParams<{ oracleId: string }>();
    const navigate = useNavigate();
    const account = useCurrentAccount();
    const sui = useSuiClient();

    const [state, setState] = useState<OracleState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [dusdc, setDusdc] = useState<bigint | null>(null);

    useEffect(() => {
        if (!oracleId) return;
        let cancelled = false;
        (async () => {
            try {
                const s = await getOracleState(oracleId);
                if (!cancelled) setState(s);
            } catch (e) {
                if (!cancelled)
                    setError(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [oracleId]);

    useEffect(() => {
        if (!account?.address) {
            setDusdc(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const balance = await sui.getBalance({
                    owner: account.address,
                    coinType: CONFIG.PREDICT_DUSDC_TYPE,
                });
                if (!cancelled) setDusdc(BigInt(balance.totalBalance));
            } catch {
                if (!cancelled) setDusdc(0n);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [account?.address, sui]);

    if (!oracleId) return null;

    const dusdcDisplay =
        dusdc === null
            ? '—'
            : (Number(dusdc) / 10 ** CONFIG.DUSDC_DECIMALS).toLocaleString(
                  'en-US',
                  { minimumFractionDigits: 2, maximumFractionDigits: 2 }
              );

    return (
        <div className="predict-page">
            <button
                className="btn btn-ghost btn-sm"
                onClick={() => navigate('/predict')}
                style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}
            >
                <ArrowLeft size={14} /> All oracles
            </button>

            {error && (
                <div className="alert alert-error">
                    <AlertCircle size={14} style={{ marginRight: 8 }} />
                    {error}
                </div>
            )}

            {!state && !error && (
                <div className="predict-empty">
                    <RefreshCw size={28} className="spin" />
                    <div>Loading oracle state…</div>
                </div>
            )}

            {state && (
                <div className="predict-detail-layout">
                    {/* LEFT — oracle data */}
                    <div className="predict-detail-main">
                        <div className="predict-eyebrow">
                            <TrendingUp size={14} />
                            <span>{state.oracle.underlying_asset} · DeepBook Predict</span>
                        </div>
                        <h1 className="predict-title" style={{ fontSize: 32 }}>
                            {state.oracle.underlying_asset} expiring{' '}
                            {formatExpiry(state.oracle.expiry)}
                        </h1>
                        <div
                            className="predict-card-status"
                            style={{
                                color: statusColor(state.oracle.status),
                                fontSize: 13,
                                marginTop: 4,
                            }}
                        >
                            {state.oracle.status}
                        </div>

                        <div className="predict-stats" style={{ marginTop: 24 }}>
                            <StatCard
                                label="Spot"
                                value={
                                    state.latest_price
                                        ? formatStrikeUsd(state.latest_price.spot)
                                        : '—'
                                }
                                accent="blue"
                            />
                            <StatCard
                                label="Forward"
                                value={
                                    state.latest_price
                                        ? formatStrikeUsd(state.latest_price.forward)
                                        : '—'
                                }
                            />
                            <StatCard
                                label="Settlement"
                                value={
                                    state.oracle.settlement_price
                                        ? formatStrikeUsd(state.oracle.settlement_price)
                                        : 'pending'
                                }
                            />
                            <StatCard
                                label="Min strike"
                                value={formatStrikeUsd(state.oracle.min_strike)}
                            />
                            <StatCard
                                label="Tick size"
                                value={formatStrikeUsd(state.oracle.tick_size)}
                            />
                            <StatCard
                                label="Activated"
                                value={
                                    state.oracle.activated_at
                                        ? new Date(state.oracle.activated_at).toLocaleTimeString()
                                        : '—'
                                }
                            />
                        </div>

                        {state.latest_svi && (
                            <div className="predict-svi">
                                <div className="predict-section-h" style={{ marginTop: 28 }}>
                                    <Activity size={14} />
                                    <span>Vol surface (SVI)</span>
                                </div>
                                <div className="predict-svi-grid">
                                    <SviStat label="a" value={state.latest_svi.a} />
                                    <SviStat label="b" value={state.latest_svi.b} />
                                    <SviStat
                                        label="ρ"
                                        value={state.latest_svi.rho}
                                        negative={state.latest_svi.rho_negative}
                                    />
                                    <SviStat
                                        label="m"
                                        value={state.latest_svi.m}
                                        negative={state.latest_svi.m_negative}
                                    />
                                    <SviStat label="σ" value={state.latest_svi.sigma} />
                                </div>
                            </div>
                        )}

                        <details className="predict-debug">
                            <summary>Raw oracle state (debug)</summary>
                            <pre>{JSON.stringify(state, null, 2)}</pre>
                        </details>
                    </div>

                    {/* RIGHT — mint sidebar */}
                    <aside className="predict-detail-side">
                        <div className="predict-section-h">
                            <Lock size={14} />
                            <span>Mint a binary position</span>
                        </div>
                        <div className="predict-mint-card">
                            <div className="predict-mint-row">
                                <span className="predict-mint-label">Your dUSDC</span>
                                <span className="predict-mint-value">
                                    {account ? `${dusdcDisplay} dUSDC` : '—'}
                                </span>
                            </div>
                            <div className="predict-mint-row">
                                <span className="predict-mint-label">PredictManager</span>
                                <span className="predict-mint-value">not initialized</span>
                            </div>
                            <div
                                className="alert alert-info"
                                style={{ marginTop: 14, fontSize: 12, lineHeight: 1.5 }}
                            >
                                <strong>Phase 2.1 — next session.</strong>
                                <ul style={{ marginTop: 6, paddingLeft: 16 }}>
                                    <li>Initialize PredictManager</li>
                                    <li>Deposit dUSDC</li>
                                    <li>Pick strike + direction</li>
                                    <li>
                                        Call <code>predict::mint</code>
                                    </li>
                                </ul>
                            </div>
                            <button
                                className="btn btn-primary btn-full"
                                disabled
                                style={{ marginTop: 12 }}
                            >
                                Initialize &amp; mint (soon)
                            </button>
                        </div>
                    </aside>
                </div>
            )}
        </div>
    );
}

function StatCard({
    label,
    value,
    accent,
}: {
    label: string;
    value: string;
    accent?: 'blue' | 'rose';
}) {
    return (
        <div className={`predict-stat ${accent ? `accent-${accent}` : ''}`}>
            <div className="predict-stat-label">{label}</div>
            <div className="predict-stat-value">{value}</div>
        </div>
    );
}

function SviStat({
    label,
    value,
    negative,
}: {
    label: string;
    value: number;
    negative?: boolean;
}) {
    const formatted = (negative ? '−' : '') + value.toLocaleString();
    return (
        <div className="predict-svi-cell">
            <div className="predict-svi-label">{label}</div>
            <div className="predict-svi-value">{formatted}</div>
        </div>
    );
}

// Suppress unused warning — Link kept available for future cross-links
void Link;
