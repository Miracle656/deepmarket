// DeepBook-style full-bleed stat panels with corner "crop-mark" squares.
// Every number is REAL — pulled live from the Predict server + on-chain vault.

import { useEffect, useState } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { getVaultStats, listAllOracles } from '../lib/predict';
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
}

const PLACEHOLDER: Stat[] = [
    { value: '—', label: 'Vault TVL · dUSDC' },
    { value: '—', label: 'BTC oracles tracked' },
    { value: '—', label: 'Live oracles now' },
    { value: '—', label: 'Trading accounts' },
];

const VARIANTS = ['blue', 'black', 'gray', 'white'] as const;

export default function LandingStats() {
    const client = useSuiClient();
    const [stats, setStats] = useState<Stat[] | null>(null);

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
            const active = oracles.filter((o) => o.status === 'active').length;
            const managerCount = Array.isArray(managers) ? managers.length : 0;
            setStats([
                { value: vault ? `$${compact(vault.tvl)}` : '—', label: 'Vault TVL · dUSDC' },
                { value: compact(oracles.length), label: 'BTC oracles tracked' },
                { value: String(active), label: 'Live oracles now' },
                { value: compact(managerCount), label: 'Trading accounts' },
            ]);
        })();
        return () => {
            cancelled = true;
        };
    }, [client]);

    const data = stats ?? PLACEHOLDER;

    return (
        <section className="db-stats" aria-label="DeepMarket live stats">
            {data.map((s, i) => (
                <div key={i} className={`db-stat db-stat-${VARIANTS[i]}`}>
                    <span className="db-crop db-crop-tr" />
                    <span className="db-crop db-crop-bl" />
                    <span className="db-crop db-crop-br" />
                    <div className="db-stat-value">{s.value}</div>
                    <div className="db-stat-label">{s.label}</div>
                </div>
            ))}
        </section>
    );
}
