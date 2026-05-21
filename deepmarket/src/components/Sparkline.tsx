import { useEffect, useState } from 'react';
import { INDEXER_URL } from '../lib/api';

// Module-level cache so re-renders / filter toggles don't refetch a market's
// history. Keyed by market id; holds the YES-price series (0..100).
const cache = new Map<number, number[]>();

interface Props {
    marketId: number;
    /** Live YES price (%) from the card — appended so the line ends where the card's number says. */
    current?: number;
    width?: number;
    height?: number;
}

/**
 * Compact YES-probability sparkline for a market card. Pulls
 * `/markets/:id/history` once, draws an SVG area+line scaled to 0..100%.
 * Rising = green, falling = red, flat/insufficient data = a muted baseline.
 */
export default function Sparkline({ marketId, current, width = 132, height = 36 }: Props) {
    const [pts, setPts] = useState<number[] | null>(cache.get(marketId) ?? null);

    useEffect(() => {
        if (cache.has(marketId)) {
            setPts(cache.get(marketId)!);
            return;
        }
        let alive = true;
        fetch(`${INDEXER_URL}/markets/${marketId}/history`)
            .then(r => r.json())
            .then(d => {
                const series = (d.history ?? []).map((p: any) => Number(p.yes_price));
                cache.set(marketId, series);
                if (alive) setPts(series);
            })
            .catch(() => {
                if (alive) setPts([]);
            });
        return () => {
            alive = false;
        };
    }, [marketId]);

    // Build the series: history + the live price as the final point.
    let series = pts ? [...pts] : [];
    if (typeof current === 'number' && !Number.isNaN(current)) {
        if (series.length === 0) series = [current];
        else if (series[series.length - 1] !== current) series.push(current);
    }

    const pad = 2;
    const w = width;
    const h = height;
    const yFor = (v: number) => h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2);

    // Not enough data to show a trend → muted flat baseline at the current level.
    if (series.length < 2) {
        const y = yFor(series[0] ?? 50);
        return (
            <svg width={w} height={h} className="spark" aria-hidden viewBox={`0 0 ${w} ${h}`}>
                <line
                    x1={0}
                    y1={y}
                    x2={w}
                    y2={y}
                    stroke="var(--border-base)"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                />
            </svg>
        );
    }

    const n = series.length;
    const xFor = (i: number) => (i / (n - 1)) * w;
    const rising = series[n - 1] >= series[0];
    const color = rising ? 'var(--yes)' : 'var(--no)';
    const gid = `sparkfill-${marketId}-${rising ? 'u' : 'd'}`;

    const linePts = series.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
    const areaPts = `0,${h} ${linePts} ${w},${h}`;

    return (
        <svg width={w} height={h} className="spark" aria-hidden viewBox={`0 0 ${w} ${h}`}>
            <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.22" />
                    <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
            </defs>
            <polygon points={areaPts} fill={`url(#${gid})`} stroke="none" />
            <polyline
                points={linePts}
                fill="none"
                stroke={color}
                strokeWidth={1.6}
                strokeLinejoin="round"
                strokeLinecap="round"
            />
        </svg>
    );
}
