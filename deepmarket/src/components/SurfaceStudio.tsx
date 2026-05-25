// SurfaceStudio — live multi-expiry SVI surface + arb-free checker. Idea #9 in
// the DeepBook Predict track ("live SVI surface viewer with arb-free checker").
// All math runs on REAL on-chain SVI params from active oracles — no mocks,
// no synthetic data, no simulated walks.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Activity, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
    listTradeableOracles,
    getOracleState,
    type OracleSummary,
    type OracleState,
} from '../lib/predict';
import {
    butterflyCheck,
    calendarCheck,
    sampleSmile,
    sviFromUpdate,
    yearsToExpiry,
    type SviParams,
} from '../lib/svi';

const W = 880;
const H = 360;
const PAD_X = 56;
const PAD_Y = 28;
const N_SAMPLES = 81;
const K_MIN = -0.5;
const K_MAX = 0.5;
const PRICE_SCALE = 1e9;

const projX = (k: number) => PAD_X + ((k - K_MIN) / (K_MAX - K_MIN)) * (W - PAD_X * 2);

interface OracleSlice {
    oracle: OracleSummary;
    state: OracleState;
    svi: SviParams;
    T: number;
    smile: { k: number; iv: number }[];
    butterfly: ReturnType<typeof butterflyCheck>;
    color: string;
    expiryLabel: string;
}

// Palette: cool for soonest expiry, warm for furthest.
const PALETTE = ['#1c6fff', '#28b8d4', '#22d3a4', '#f5a623', '#ff7a92', '#a78bfa'];

function expiryLabel(expiryMs: number): string {
    const mins = Math.round((expiryMs - Date.now()) / 60000);
    if (mins < 60) return `${Math.max(0, mins)}m`;
    if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${Math.floor(mins / 60 / 24)}d`;
}

export default function SurfaceStudio() {
    const navigate = useNavigate();
    const [slices, setSlices] = useState<OracleSlice[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const all = await listTradeableOracles();
            const active = all.filter((o) => o.status === 'active').slice(0, 6);
            if (active.length === 0) {
                setSlices([]);
                return;
            }
            const states = await Promise.all(
                active.map((o) =>
                    getOracleState(o.oracle_id).catch((e) => {
                        console.error('getOracleState failed', o.oracle_id, e);
                        return null;
                    })
                )
            );
            const built: OracleSlice[] = [];
            states.forEach((state, i) => {
                if (!state?.latest_svi || !state.latest_price) return;
                const svi = sviFromUpdate(state.latest_svi);
                const T = yearsToExpiry(active[i].expiry);
                const smile = sampleSmile(svi, T, N_SAMPLES, K_MIN, K_MAX);
                built.push({
                    oracle: active[i],
                    state,
                    svi,
                    T,
                    smile,
                    butterfly: butterflyCheck(svi, N_SAMPLES, K_MIN, K_MAX),
                    color: PALETTE[built.length % PALETTE.length],
                    expiryLabel: expiryLabel(active[i].expiry),
                });
            });
            // Sort by expiry — soonest first, so the palette colors are in time order.
            built.sort((a, b) => a.oracle.expiry - b.oracle.expiry);
            built.forEach((s, i) => (s.color = PALETTE[i % PALETTE.length]));
            setSlices(built);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load oracle states');
        } finally {
            setBusy(false);
        }
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, 60_000);
        return () => clearInterval(id);
    }, [load]);

    // Calendar checks: for each adjacent pair sorted by T, check that w(k, T₂)
    // ≥ w(k, T₁) for all k. Real math, real params.
    const calendarPairs = useMemo(() => {
        if (!slices || slices.length < 2) return [];
        const out: { a: OracleSlice; b: OracleSlice; result: ReturnType<typeof calendarCheck> }[] = [];
        for (let i = 0; i < slices.length - 1; i++) {
            const a = slices[i];
            const b = slices[i + 1];
            out.push({ a, b, result: calendarCheck(a.svi, b.svi, N_SAMPLES, K_MIN, K_MAX) });
        }
        return out;
    }, [slices]);

    // Shared y-axis: span of every smile's IV range so curves are comparable.
    const yRange = useMemo(() => {
        if (!slices || slices.length === 0) return { min: 0, max: 1 };
        let lo = Infinity;
        let hi = -Infinity;
        for (const s of slices) {
            for (const p of s.smile) {
                if (p.iv < lo) lo = p.iv;
                if (p.iv > hi) hi = p.iv;
            }
        }
        const pad = Math.max((hi - lo) * 0.12, 0.005);
        return { min: Math.max(0, lo - pad), max: hi + pad };
    }, [slices]);
    const projY = (iv: number) =>
        PAD_Y + (1 - (iv - yRange.min) / Math.max(yRange.max - yRange.min, 1e-9)) * (H - PAD_Y * 2);

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
                        <span>DeepBook Predict · Surface Studio</span>
                    </div>
                    <h1 className="predict-title">Live SVI surface</h1>
                    <p className="predict-sub">
                        Every active oracle's smile, drawn from real on-chain SVI params. Below: a
                        live arbitrage-free check — butterfly (per smile) and calendar (across
                        expiries) — computed against the actual params with numerical second
                        derivatives.
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

            {error && <div className="vs-empty" style={{ marginTop: 16 }}>{error}</div>}
            {!slices && !error && <div className="vs-empty" style={{ marginTop: 16 }}>Loading surface…</div>}
            {slices && slices.length === 0 && (
                <div className="vs-empty" style={{ marginTop: 16 }}>
                    No active oracles right now. Surfaces will appear here once oracles activate.
                </div>
            )}

            {slices && slices.length > 0 && (
                <>
                    {/* Multi-expiry surface */}
                    <div className="vs">
                        <div className="vs-strip">
                            {slices.map((s) => (
                                <span key={s.oracle.oracle_id} className="vs-seg">
                                    <span style={{ width: 10, height: 3, background: s.color, borderRadius: 2 }} />
                                    <span className="vs-seg-label">{s.expiryLabel}</span>
                                    <span className="vs-seg-value">
                                        {(s.smile.find((p) => Math.abs(p.k) < 0.01)?.iv ?? 0) * 100 < 0.1
                                            ? '—'
                                            : `${((s.smile.find((p) => Math.abs(p.k) < 0.01)?.iv ?? 0) * 100).toFixed(1)}% atm`}
                                    </span>
                                </span>
                            ))}
                        </div>
                        <svg viewBox={`0 0 ${W} ${H}`} className="vs-svg" preserveAspectRatio="none">
                            {/* y grid (4 ticks across yRange) */}
                            {[0, 1, 2, 3].map((i) => {
                                const iv = yRange.min + ((yRange.max - yRange.min) * i) / 3;
                                return (
                                    <g key={i}>
                                        <line
                                            x1={PAD_X}
                                            y1={projY(iv)}
                                            x2={W - PAD_X}
                                            y2={projY(iv)}
                                            stroke="var(--border-base)"
                                            strokeWidth={0.5}
                                            strokeDasharray="2 4"
                                        />
                                        <text x={PAD_X - 8} y={projY(iv) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                                            {(iv * 100).toFixed(0)}%
                                        </text>
                                    </g>
                                );
                            })}
                            {/* x ticks */}
                            {[-0.4, -0.2, 0, 0.2, 0.4].map((k) => (
                                <text key={k} x={projX(k)} y={H - PAD_Y + 16} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                                    {k === 0 ? 'ATM' : `${k > 0 ? '+' : ''}${(k * 100).toFixed(0)}%`}
                                </text>
                            ))}
                            <line
                                x1={projX(0)}
                                y1={PAD_Y}
                                x2={projX(0)}
                                y2={H - PAD_Y}
                                stroke="var(--border-base)"
                                strokeWidth={0.5}
                                strokeDasharray="2 4"
                            />
                            {/* curves */}
                            {slices.map((s) => {
                                const d = s.smile
                                    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${projX(p.k).toFixed(1)},${projY(p.iv).toFixed(1)}`)
                                    .join(' ');
                                return (
                                    <path
                                        key={s.oracle.oracle_id}
                                        d={d}
                                        fill="none"
                                        stroke={s.color}
                                        strokeWidth={1.6}
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        opacity={s.butterfly.ok ? 1 : 0.7}
                                    />
                                );
                            })}
                        </svg>
                        <div className="vs-foot">
                            <span>SVI smiles · log-moneyness × implied vol</span>
                            <span>{slices.length} active expiries · poll 60s</span>
                        </div>
                    </div>

                    {/* Arb-free check tables */}
                    <div className="surface-grid">
                        <div className="risk-block" style={{ marginTop: 16 }}>
                            <div className="risk-block-h">Butterfly check · per smile</div>
                            {slices.map((s) => (
                                <div key={s.oracle.oracle_id} className="risk-row">
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                        <span style={{ width: 10, height: 3, background: s.color, borderRadius: 2 }} />
                                        <span className="vault-muted">{s.expiryLabel}</span>
                                    </span>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                        {s.butterfly.ok ? (
                                            <>
                                                <CheckCircle2 size={13} color="var(--yes)" />
                                                <span style={{ color: 'var(--yes)' }}>Arb-free</span>
                                            </>
                                        ) : (
                                            <>
                                                <AlertTriangle size={13} color="var(--no)" />
                                                <span style={{ color: 'var(--no)' }}>
                                                    {s.butterfly.violations.length} violation
                                                    {s.butterfly.violations.length === 1 ? '' : 's'}
                                                </span>
                                            </>
                                        )}
                                    </span>
                                </div>
                            ))}
                        </div>

                        <div className="risk-block" style={{ marginTop: 16 }}>
                            <div className="risk-block-h">Calendar check · adjacent expiries</div>
                            {calendarPairs.length === 0 ? (
                                <div className="risk-row vault-muted">Need ≥ 2 active expiries to check.</div>
                            ) : (
                                calendarPairs.map(({ a, b, result }) => (
                                    <div key={`${a.oracle.oracle_id}-${b.oracle.oracle_id}`} className="risk-row">
                                        <span className="vault-muted">
                                            {a.expiryLabel} → {b.expiryLabel}
                                        </span>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                            {result.ok ? (
                                                <>
                                                    <CheckCircle2 size={13} color="var(--yes)" />
                                                    <span style={{ color: 'var(--yes)' }}>Arb-free</span>
                                                </>
                                            ) : (
                                                <>
                                                    <AlertTriangle size={13} color="var(--no)" />
                                                    <span style={{ color: 'var(--no)' }}>
                                                        {result.violations.length} violation
                                                        {result.violations.length === 1 ? '' : 's'}
                                                    </span>
                                                </>
                                            )}
                                        </span>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    <div className="vault-muted" style={{ marginTop: 14, fontSize: '0.78rem', textAlign: 'center' }}>
                        Spot reference (oldest active): {
                            slices[0].state.latest_price
                                ? `$${(slices[0].state.latest_price.spot / PRICE_SCALE).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                                : '—'
                        }
                    </div>
                </>
            )}
        </div>
    );
}
