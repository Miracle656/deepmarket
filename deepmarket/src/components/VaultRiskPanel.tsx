// VaultRiskPanel — "is PLP safe?" snapshot. Pure reads from the Predict object
// (utilization vs cap, withdrawal-limiter token-bucket, exposed-oracle count,
// accepted quote assets, MTM vs max payout). NO simulations, NO mocks — every
// value is fetched live from chain.

import { useCallback, useEffect, useState } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import {
    getVaultStats,
    getUnsettledExposedOracles,
    type VaultStats,
} from '../lib/predict';

const usd = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number, digits = 2) => `${(n * 100).toFixed(digits)}%`;

function shortType(t: string): string {
    const last = t.split('::').pop() ?? t;
    return last;
}

export default function VaultRiskPanel() {
    const sui = useSuiClient();
    const [stats, setStats] = useState<VaultStats | null>(null);
    const [exposedOracleIds, setExposedOracleIds] = useState<string[] | null>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        const [s, exp] = await Promise.all([
            getVaultStats(sui),
            getUnsettledExposedOracles(sui),
        ]);
        setStats(s);
        setExposedOracleIds(exp);
        setLoading(false);
    }, [sui]);

    useEffect(() => {
        load();
        const id = setInterval(load, 30_000);
        return () => clearInterval(id);
    }, [load]);

    if (!stats) {
        return (
            <div className="vault-panel" style={{ marginTop: 18 }}>
                <div className="vs-empty" style={{ minHeight: 120 }}>
                    {loading ? 'Loading vault risk state…' : 'Could not read vault state.'}
                </div>
            </div>
        );
    }

    // utilizations: actual exposure / TVL  vs the configured cap.
    const exposureUtilization = stats.tvl > 0 ? stats.totalMaxPayout / stats.tvl : 0;
    const utilOfCap =
        stats.maxExposurePct > 0 ? exposureUtilization / stats.maxExposurePct : 0;

    const wl = stats.withdrawalLimiter;
    const wlPctFull = wl.enabled && wl.capacityUsd > 0 ? wl.availableUsd / wl.capacityUsd : 0;
    // refill rate in dUSDC per minute (raw is base units per ms, dUSDC = 6 dp)
    const refillPerMin = wl.refillRatePerMs > 0 ? (wl.refillRatePerMs * 60_000) / 1e6 : 0;

    return (
        <div className="vault-panel" style={{ marginTop: 18 }}>
            <div className="vault-head" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="predict-eyebrow" style={{ margin: 0 }}>
                    <ShieldCheck size={14} /> Vault risk · live
                </div>
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={load}
                    title="Refresh risk state"
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                    <RefreshCw size={13} className={loading ? 'spin' : ''} />
                </button>
            </div>

            {/* Headline numbers */}
            <div className="vault-stats" style={{ marginTop: 14 }}>
                <Stat
                    label="Exposure / TVL"
                    value={pct(exposureUtilization, 3)}
                    sub={`cap ${pct(stats.maxExposurePct, 0)}`}
                />
                <Stat label="Total max payout" value={usd(stats.totalMaxPayout)} sub="worst-case liability" />
                <Stat label="Total MTM" value={usd(stats.totalMtm)} sub="net liability vs holders" />
            </div>

            {/* Utilization vs cap — visual */}
            <div className="risk-bar-wrap" title={`Used ${pct(utilOfCap, 1)} of the ${pct(stats.maxExposurePct, 0)} cap`}>
                <div className="risk-bar">
                    <div
                        className="risk-bar-fill"
                        style={{ width: `${Math.min(100, utilOfCap * 100).toFixed(2)}%` }}
                    />
                </div>
                <div className="risk-bar-foot">
                    <span>{pct(utilOfCap, 1)} of cap used</span>
                    <span className="vault-muted">{usd(stats.totalMaxPayout)} / {usd(stats.tvl * stats.maxExposurePct)}</span>
                </div>
            </div>

            {/* Withdrawal limiter */}
            <div className="risk-block">
                <div className="risk-block-h">Withdrawal limiter</div>
                {wl.enabled ? (
                    <>
                        <div className="risk-row">
                            <span className="vault-muted">Available now</span>
                            <span>{usd(wl.availableUsd)} <span className="vault-muted">/ {usd(wl.capacityUsd)}</span></span>
                        </div>
                        <div className="risk-row">
                            <span className="vault-muted">Refill</span>
                            <span>{usd(refillPerMin)} / min</span>
                        </div>
                        <div className="risk-bar" style={{ marginTop: 8 }}>
                            <div
                                className="risk-bar-fill"
                                style={{ width: `${(wlPctFull * 100).toFixed(2)}%` }}
                            />
                        </div>
                    </>
                ) : (
                    <div className="risk-row">
                        <span className="vault-muted">Status</span>
                        <span>Disabled — unlimited withdrawals subject to available headroom.</span>
                    </div>
                )}
            </div>

            {/* Exposed oracles + accepted quotes */}
            <div className="risk-block">
                <div className="risk-block-h">Active exposure</div>
                <div className="risk-row">
                    <span className="vault-muted">Unsettled exposed oracles</span>
                    <span>{exposedOracleIds == null ? '—' : exposedOracleIds.length}</span>
                </div>
                <div className="risk-row">
                    <span className="vault-muted">Accepted quote assets</span>
                    <span>{stats.acceptedQuotes.map(shortType).join(', ') || '—'}</span>
                </div>
            </div>
        </div>
    );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="vault-stat">
            <div className="vault-stat-label">{label}</div>
            <div className="vault-stat-value">{value}</div>
            {sub && <div className="vault-muted" style={{ fontSize: '0.72rem', marginTop: 2 }}>{sub}</div>}
        </div>
    );
}
