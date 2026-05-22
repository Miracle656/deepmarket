// SVI (Stochastic Volatility Inspired) parameterization — the model the
// DeepBook Predict vault prices every strike off. Adapted from the santos
// reference (predict-vol-surface).
//
// Total variance: w(k) = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma^2))
// where k = log-moneyness = log(strike / forward).
// Implied vol: iv(k) = sqrt(w(k) / T).

import type { SviUpdate } from './predict';

export type SviParams = {
    a: number; // overall variance level
    b: number; // wing slope
    rho: number; // skew (negative = puts richer)
    m: number; // horizontal shift
    sigma: number; // ATM curvature
};

// On-chain SVI params are 1e9-scaled u64 with separate sign flags for rho/m.
const SVI_SCALE = 1e9;

/** Map a server `SviUpdate` (scaled + sign flags) to float SVI params. */
export function sviFromUpdate(u: SviUpdate): SviParams {
    return {
        a: u.a / SVI_SCALE,
        b: u.b / SVI_SCALE,
        rho: ((u.rho_negative ? -1 : 1) * u.rho) / SVI_SCALE,
        m: ((u.m_negative ? -1 : 1) * u.m) / SVI_SCALE,
        sigma: u.sigma / SVI_SCALE,
    };
}

export function totalVariance(k: number, p: SviParams): number {
    const dx = k - p.m;
    return p.a + p.b * (p.rho * dx + Math.sqrt(dx * dx + p.sigma * p.sigma));
}

export function impliedVol(k: number, p: SviParams, T: number): number {
    const w = Math.max(0, totalVariance(k, p));
    return Math.sqrt(w / Math.max(T, 1e-9));
}

/** Sample the smile across a log-moneyness range. */
export function sampleSmile(
    p: SviParams,
    T: number,
    n: number,
    kMin = -0.5,
    kMax = 0.5
): { k: number; iv: number }[] {
    const out: { k: number; iv: number }[] = [];
    for (let i = 0; i < n; i++) {
        const k = kMin + ((kMax - kMin) * i) / (n - 1);
        out.push({ k, iv: impliedVol(k, p, T) });
    }
    return out;
}

/** Years to expiry from an expiry timestamp in ms. */
export function yearsToExpiry(expiryMs: number, nowMs = Date.now()): number {
    const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    return Math.max((expiryMs - nowMs) / YEAR_MS, 1e-9);
}

// Standard-normal CDF (Abramowitz & Stegun, ~1e-7 accurate).
function normCdf(x: number): number {
    const a1 = 0.254829592,
        a2 = -0.284496736,
        a3 = 1.421413741,
        a4 = -1.453152027,
        a5 = 1.061405429,
        p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + p * ax);
    const y =
        1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return 0.5 * (1 + sign * y);
}

/**
 * Binary option fair price under Black-Scholes with the SVI smile. Pays $1 if
 * (isUp && S_T > K) or (!isUp && S_T < K). Picks sigma at k = ln(K/F).
 */
export function binaryFairPrice(
    forward: number,
    strike: number,
    T: number,
    svi: SviParams,
    isUp: boolean
): number {
    if (forward <= 0 || strike <= 0 || T <= 0) return 0.5;
    const k = Math.log(strike / forward);
    const sigma = impliedVol(k, svi, T);
    if (!isFinite(sigma) || sigma <= 0) return 0.5;
    const sqrtT = Math.sqrt(T);
    const d2 = (-k - 0.5 * sigma * sigma * T) / (sigma * sqrtT);
    const probUp = normCdf(d2);
    return isUp ? probUp : 1 - probUp;
}
