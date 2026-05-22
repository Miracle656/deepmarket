// VolSurfaceChart — live SVI smile (log-moneyness × implied vol) for one
// Predict oracle, rendered straight from the on-chain SVI params the vault
// prices off. Idea #9 in the DeepBook Predict track ("live SVI surface viewer").

import { sampleSmile, sviFromUpdate, yearsToExpiry, type SviParams } from '../lib/svi';
import type { OracleState } from '../lib/predict';

const W = 880;
const H = 300;
const PAD_X = 52;
const PAD_Y = 26;
const N = 64;
const K_MIN = -0.5;
const K_MAX = 0.5;
const PRICE_SCALE = 1e9;

const projX = (k: number) => PAD_X + ((k - K_MIN) / (K_MAX - K_MIN)) * (W - PAD_X * 2);

export default function VolSurfaceChart({ state }: { state: OracleState | null }) {
    if (!state?.latest_svi || !state.latest_price) {
        return <div className="vs-empty">No SVI data for this oracle yet.</div>;
    }

    const svi: SviParams = sviFromUpdate(state.latest_svi);
    const spot = state.latest_price.spot / PRICE_SCALE;
    const forward = state.latest_price.forward / PRICE_SCALE;
    const expiryMs = state.oracle.expiry;
    const T = yearsToExpiry(expiryMs);

    const smile = sampleSmile(svi, T, N, K_MIN, K_MAX);
    const ivs = smile.map((p) => p.iv);
    const minIv = Math.max(0, Math.min(...ivs));
    const maxIv = Math.max(...ivs);
    const padIv = Math.max((maxIv - minIv) * 0.15, 0.01);
    const ivMin = Math.max(0, minIv - padIv);
    const ivMax = maxIv + padIv;
    const projY = (iv: number) =>
        PAD_Y + (1 - (iv - ivMin) / (ivMax - ivMin || 1)) * (H - PAD_Y * 2);

    const line = smile
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${projX(p.k).toFixed(1)},${projY(p.iv).toFixed(1)}`)
        .join(' ');
    const baseY = (H - PAD_Y).toFixed(1);
    const area = `${line} L ${projX(smile[smile.length - 1].k).toFixed(1)},${baseY} L ${projX(smile[0].k).toFixed(1)},${baseY} Z`;

    const atm = smile.reduce((best, p) => (Math.abs(p.k) < Math.abs(best.k) ? p : best));
    const yTicks = [0, 1, 2, 3].map((i) => ivMin + ((ivMax - ivMin) * i) / 3);
    const xTicks = [-0.4, -0.2, 0, 0.2, 0.4];

    const mins = Math.max(0, Math.round((expiryMs - Date.now()) / 60000));
    const tLabel = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
    const px = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

    return (
        <div className="vs">
            <div className="vs-strip">
                <Seg label={state.oracle.underlying_asset || 'BTC'} accent />
                <span className="vs-sep">▸</span>
                <Seg label="spot" value={px(spot)} />
                <span className="vs-sep">▸</span>
                <Seg label="fwd" value={px(forward)} />
                <span className="vs-sep">▸</span>
                <Seg label="atm iv" value={`${(atm.iv * 100).toFixed(1)}%`} />
                <span className="vs-sep">▸</span>
                <Seg label="skew" value={svi.rho.toFixed(2)} />
                <span className="vs-sep">▸</span>
                <Seg label="t" value={tLabel} />
            </div>

            <svg viewBox={`0 0 ${W} ${H}`} className="vs-svg" preserveAspectRatio="none">
                <defs>
                    <linearGradient id="vs-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--yes)" stopOpacity="0.18" />
                        <stop offset="100%" stopColor="var(--yes)" stopOpacity="0" />
                    </linearGradient>
                </defs>

                {yTicks.map((iv, i) => (
                    <g key={i}>
                        <line x1={PAD_X} y1={projY(iv)} x2={W - PAD_X} y2={projY(iv)}
                            stroke="var(--border-base)" strokeWidth={0.5} strokeDasharray="2 4" />
                        <text x={PAD_X - 8} y={projY(iv) + 3} textAnchor="end" fontSize="10"
                            fill="var(--text-muted)">{(iv * 100).toFixed(0)}%</text>
                    </g>
                ))}
                {xTicks.map((k) => (
                    <text key={k} x={projX(k)} y={H - PAD_Y + 16} textAnchor="middle" fontSize="10"
                        fill="var(--text-muted)">
                        {k === 0 ? 'ATM' : `${k > 0 ? '+' : ''}${(k * 100).toFixed(0)}%`}
                    </text>
                ))}
                <line x1={projX(0)} y1={PAD_Y} x2={projX(0)} y2={H - PAD_Y}
                    stroke="var(--border-base)" strokeWidth={0.5} strokeDasharray="2 4" />

                <path d={area} fill="url(#vs-fill)" />
                <path d={line} fill="none" stroke="var(--yes)" strokeWidth={1.8}
                    strokeLinecap="round" strokeLinejoin="round" />
                <circle cx={projX(atm.k)} cy={projY(atm.iv)} r={4} fill="var(--yes)" />
            </svg>

            <div className="vs-foot">
                <span>SVI smile · log-moneyness × implied vol</span>
                <span>oracle {state.oracle.oracle_id.slice(0, 8)}…{state.oracle.oracle_id.slice(-4)}</span>
            </div>
        </div>
    );
}

function Seg({ label, value, accent }: { label: string; value?: string; accent?: boolean }) {
    return (
        <span className="vs-seg">
            <span className={accent ? 'vs-seg-accent' : 'vs-seg-label'}>{label}</span>
            {value !== undefined && <span className="vs-seg-value">{value}</span>}
        </span>
    );
}
