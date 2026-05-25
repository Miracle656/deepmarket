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
 * Butterfly arbitrage-free check. A smile is butterfly arb-free iff the total
 * variance w(k) is convex in log-moneyness k (equivalently, the density implied
 * by the smile is non-negative). We sample w over the moneyness range and
 * compute the discrete second derivative numerically — any negative w''(k)
 * flags a butterfly violation.
 */
export interface ArbCheckResult {
    ok: boolean;
    /** k-values where the check failed (empty if ok). */
    violations: number[];
    /** Sample count used. */
    samples: number;
}

export function butterflyCheck(
    p: SviParams,
    samples = 81,
    kMin = -0.5,
    kMax = 0.5
): ArbCheckResult {
    const step = (kMax - kMin) / (samples - 1);
    const w: number[] = new Array(samples);
    for (let i = 0; i < samples; i++) {
        w[i] = totalVariance(kMin + step * i, p);
    }
    const violations: number[] = [];
    // Need at least 3 points for a finite-difference second derivative.
    for (let i = 1; i < samples - 1; i++) {
        const d2 = (w[i + 1] - 2 * w[i] + w[i - 1]) / (step * step);
        // Strict convexity is w'' >= 0; allow a small numerical tolerance.
        if (d2 < -1e-9) {
            violations.push(kMin + step * i);
        }
    }
    return { ok: violations.length === 0, violations, samples };
}

/**
 * Calendar arbitrage-free check between two expiries (TA < TB). The smile is
 * calendar arb-free at log-moneyness k iff total variance is non-decreasing in
 * T at that k — i.e. w(k, TB) ≥ w(k, TA). Any k where the later expiry has
 * LESS total variance is a violation.
 *
 * Note: total variance w = σ² × T (in the SVI parameterization here, `w`
 * already includes T implicitly via the params fit at each expiry).
 */
export function calendarCheck(
    pA: SviParams,
    pB: SviParams,
    samples = 81,
    kMin = -0.5,
    kMax = 0.5
): ArbCheckResult {
    const step = (kMax - kMin) / (samples - 1);
    const violations: number[] = [];
    for (let i = 0; i < samples; i++) {
        const k = kMin + step * i;
        const wA = totalVariance(k, pA);
        const wB = totalVariance(k, pB);
        if (wB + 1e-9 < wA) violations.push(k);
    }
    return { ok: violations.length === 0, violations, samples };
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
