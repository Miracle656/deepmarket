// "By the numbers" — a dedicated WHITE section (DeepBook rhythm: alternating
// dark/light bands) hosting crop-mark stat cards. Every figure is REAL: read
// from the Predict server, the on-chain vault, and the spot-market indexer.

import { useEffect, useState } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { getVaultStats, listAllOracles } from '../lib/predict';
import { useMarkets } from '../lib/useMarkets';
import { formatVol } from '../App';
import { CONFIG } from '../lib/config';

function compact(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return Math.round(n).toLocaleString();
}

interface Stat {
    value: string;
    label: string;
    tag: string;
    /** accent for the top bar + crop marks */
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
    const dash = (v: string) => (predict ? v : '—');

    const stats: Stat[] = [
        { value: predict ? `$${compact(predict.tvl)}` : '—', label: 'Vault TVL · dUSDC', tag: 'PLP vault', accent: 'blue' },
        { value: dash(compact(predict?.oracles ?? 0)), label: 'BTC oracles tracked', tag: 'DeepBook Predict', accent: 'dark' },
        { value: dash(String(predict?.active ?? 0)), label: 'Live oracles now', tag: 'Tradeable', accent: 'gray' },
        { value: dash(compact(predict?.managers ?? 0)), label: 'Trading accounts', tag: 'Managers', accent: 'blue' },
        { value: String(markets.length), label: 'Spot YES/NO markets', tag: 'CLOB', accent: 'dark' },
        { value: formatVol(totalVol), label: 'Spot order-book volume', tag: 'CLOB', accent: 'gray' },
    ];

    return (
        <section className="db-stats-section">
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
                        <div className="db-card-value">{s.value}</div>
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
