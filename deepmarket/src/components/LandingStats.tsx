// "By the numbers" — a dedicated WHITE section (DeepBook's dark/light band
// rhythm) hosting crop-mark stat cards. Every figure is REAL: read from the
// Predict server, the on-chain vault, and the spot-market indexer.
//
// GSAP: the section + cards reveal on scroll (so the dark→white switch eases
// in rather than snapping), and each number counts up from 0 when in view.

import { useEffect, useRef, useState } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { getVaultStats, listAllOracles } from '../lib/predict';
import { useMarkets } from '../lib/useMarkets';
import { formatVol } from '../App';
import { CONFIG } from '../lib/config';

gsap.registerPlugin(ScrollTrigger);

function compact(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return Math.round(n).toLocaleString();
}

interface Stat {
    target: number;
    fmt: (n: number) => string;
    label: string;
    tag: string;
    accent: 'blue' | 'dark' | 'gray';
}

export default function LandingStats() {
    const client = useSuiClient();
    const { markets } = useMarkets();
    const [predict, setPredict] = useState<{
        tvl: number;
        oracles: number;
        active: number;
        managers: number;
    } | null>(null);

    const sectionRef = useRef<HTMLElement | null>(null);
    const valueRefs = useRef<(HTMLDivElement | null)[]>([]);
    const animatedRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const [vault, oracles, managers] = await Promise.all([
                getVaultStats(client).catch(() => null),
                listAllOracles().catch(() => []),
                fetch(`${CONFIG.PREDICT_SERVER_URL}/managers`)
                    .then((r) => r.json())
                    .catch(() => []),
            ]);
            if (cancelled) return;
            setPredict({
                tvl: vault?.tvl ?? 0,
                oracles: oracles.length,
                active: oracles.filter((o) => o.status === 'active').length,
                managers: Array.isArray(managers) ? managers.length : 0,
            });
        })();
        return () => {
            cancelled = true;
        };
    }, [client]);

    const totalVol = markets.reduce((s, m) => s + m.volume, 0);
    const usd = (n: number) => `$${compact(n)}`;
    const intFmt = (n: number) => String(Math.round(n));

    const stats: Stat[] = [
        { target: predict?.tvl ?? 0, fmt: usd, label: 'Vault TVL · dUSDC', tag: 'PLP vault', accent: 'blue' },
        { target: predict?.oracles ?? 0, fmt: compact, label: 'BTC oracles tracked', tag: 'DeepBook Predict', accent: 'dark' },
        { target: predict?.active ?? 0, fmt: intFmt, label: 'Live oracles now', tag: 'Tradeable', accent: 'gray' },
        { target: predict?.managers ?? 0, fmt: compact, label: 'Trading accounts', tag: 'Managers', accent: 'blue' },
        { target: markets.length, fmt: intFmt, label: 'Spot YES/NO markets', tag: 'CLOB', accent: 'dark' },
        { target: totalVol, fmt: formatVol, label: 'Spot order-book volume', tag: 'CLOB', accent: 'gray' },
    ];

    // Reveal + count-up, wired once data has loaded so numbers tween to real
    // targets (not 0). ScrollTrigger fires when the section enters view — or
    // immediately if it's already past, so a scrolled-down load still animates.
    useEffect(() => {
        if (!predict || animatedRef.current || !sectionRef.current) return;
        animatedRef.current = true;
        const targets = stats.map((s) => s.target);
        const fmts = stats.map((s) => s.fmt);
        const ctx = gsap.context(() => {
            gsap.from('.db-card', {
                scrollTrigger: { trigger: sectionRef.current, start: 'top 82%', once: true },
                y: 34,
                opacity: 0,
                stagger: 0.07,
                duration: 0.6,
                ease: 'power3.out',
            });
            valueRefs.current.forEach((el, i) => {
                if (!el) return;
                const obj = { v: 0 };
                gsap.to(obj, {
                    v: targets[i] ?? 0,
                    duration: 1.4,
                    ease: 'power2.out',
                    scrollTrigger: { trigger: sectionRef.current, start: 'top 82%', once: true },
                    onUpdate: () => {
                        if (el) el.textContent = fmts[i]!(obj.v);
                    },
                });
            });
        }, sectionRef);
        return () => ctx.revert();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [predict, markets.length]);

    return (
        <section className="db-stats-section" ref={sectionRef}>
            <div className="db-stats-head">
                <div className="db-eyebrow">Live on-chain</div>
                <h2 className="db-stats-title">The numbers, verifiable.</h2>
                <p className="db-stats-sub">
                    Read straight from Sui and the Predict server — no dashboards,
                    no estimates. Spot CLOB and DeepBook Predict, side by side.
                </p>
            </div>
            <div className="db-stats-grid">
                {stats.map((s, i) => (
                    <div key={i} className={`db-card db-accent-${s.accent}`}>
                        <span className="db-card-bar" />
                        <span className="db-crop db-crop-tr" />
                        <span className="db-crop db-crop-br" />
                        <div
                            className="db-card-value"
                            ref={(el) => {
                                valueRefs.current[i] = el;
                            }}
                        >
                            {predict ? s.fmt(s.target) : '—'}
                        </div>
                        <div className="db-card-foot">
                            <span className="db-card-label">{s.label}</span>
                            <span className="db-card-tag">{s.tag}</span>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
