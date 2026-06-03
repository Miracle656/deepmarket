// WithdrawalLimiterViz — LIVE view of the vault's withdrawal token-bucket.
//
// The bucket refills continuously on-chain (`available += rate × Δt`, capped at
// capacity). A 30s poll only captures snapshots, so between polls the bar would
// be wrong. Here we tick every second and apply the EXACT on-chain accrual
// formula against the stored snapshot — i.e. the true current headroom the
// contract would compute on the next withdrawal. Not a simulation: it's the
// real token-bucket value at `now`, plus a "full in X" ETA.

import { useEffect, useState } from 'react';

export interface LimiterState {
    enabled: boolean;
    availableUsd: number; // stored snapshot at lastUpdatedMs (human)
    capacityUsd: number; // human
    refillRatePerMs: number; // raw base units / ms
    lastUpdatedMs: number;
}

const usd = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function fmtDuration(ms: number): string {
    if (!isFinite(ms) || ms <= 0) return '—';
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

export default function WithdrawalLimiterViz({ wl }: { wl: LimiterState }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!wl.enabled) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [wl.enabled]);

    if (!wl.enabled) {
        return (
            <div className="risk-block">
                <div className="risk-block-h">Withdrawal limiter</div>
                <div className="risk-row">
                    <span className="vault-muted">Status</span>
                    <span>
                        Disabled — withdrawals capped only by available headroom.
                    </span>
                </div>
            </div>
        );
    }

    // dUSDC has 6 decimals → raw base units / 1e6 = USD.
    const refillUsdPerMs = wl.refillRatePerMs / 1e6;
    const elapsedMs = Math.max(0, now - wl.lastUpdatedMs);
    const live = Math.min(
        wl.capacityUsd,
        wl.availableUsd + refillUsdPerMs * elapsedMs
    );
    const pctFull = wl.capacityUsd > 0 ? live / wl.capacityUsd : 0;
    const isFull = pctFull >= 0.9999;
    const refillPerMin = refillUsdPerMs * 60_000;
    const msToFull =
        refillUsdPerMs > 0 ? (wl.capacityUsd - live) / refillUsdPerMs : Infinity;

    return (
        <div className="risk-block">
            <div
                className="risk-block-h"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
                <span className="wl-live-dot" /> Withdrawal limiter · live
            </div>
            <div className="wl-big">
                {usd(live)}{' '}
                <span className="vault-muted">/ {usd(wl.capacityUsd)}</span>
            </div>
            <div className="risk-bar" style={{ marginTop: 8 }}>
                <div
                    className="risk-bar-fill"
                    style={{ width: `${(pctFull * 100).toFixed(3)}%` }}
                />
            </div>
            <div className="risk-bar-foot">
                <span>
                    {isFull
                        ? 'Full — maximum headroom'
                        : `refills ${usd(refillPerMin)}/min`}
                </span>
                <span className="vault-muted">
                    {isFull ? '100%' : `full in ${fmtDuration(msToFull)}`}
                </span>
            </div>
        </div>
    );
}
