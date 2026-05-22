// PnlChart — cumulative realized P&L for a PredictManager over time, from the
// server's /managers/:id/pnl series. Manager PnL attribution (track idea).

import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, AreaSeries, type UTCTimestamp } from 'lightweight-charts';
import { getManagerPnl, type PnlSeries } from '../lib/predict';

const usd = (n: number) =>
    `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function PnlChart({ managerId, theme }: { managerId: string; theme: 'dark' | 'light' }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [series, setSeries] = useState<PnlSeries | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const isDark = theme === 'dark';

    useEffect(() => {
        let alive = true;
        getManagerPnl(managerId, 'ALL')
            .then((s) => alive && setSeries(s))
            .catch((e) => alive && setErr(e instanceof Error ? e.message : 'Failed to load P&L'));
        return () => {
            alive = false;
        };
    }, [managerId]);

    useEffect(() => {
        if (!series || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        if (series.points.length < 2) return;

        const chart = createChart(containerRef.current, {
            width: containerRef.current.clientWidth,
            height: 220,
            layout: {
                background: { type: ColorType.Solid, color: isDark ? '#0a1628' : '#fff' },
                textColor: isDark ? '#7b8ea8' : '#4a5d75',
                fontFamily: "'Inter', sans-serif",
                fontSize: 11,
            },
            grid: {
                vertLines: { color: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)' },
                horzLines: { color: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)' },
            },
            rightPriceScale: { borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' },
            timeScale: { borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', timeVisible: true },
        });
        const last = series.points[series.points.length - 1].cumulativeRealizedPnl;
        const up = last >= 0;
        const series1 = chart.addSeries(AreaSeries, {
            lineColor: up ? '#00e5a0' : '#ff4d6a',
            topColor: up ? 'rgba(0,229,160,0.22)' : 'rgba(255,77,106,0.22)',
            bottomColor: 'rgba(0,0,0,0)',
            lineWidth: 2,
        });
        // strictly-ascending unique seconds
        let lastT = -Infinity;
        const data = series.points
            .map((p) => ({ t: Math.floor(p.timestampMs / 1000), v: p.cumulativeRealizedPnl }))
            .sort((a, b) => a.t - b.t)
            .map((p) => {
                const t = p.t <= lastT ? lastT + 1 : p.t;
                lastT = t;
                return { time: t as UTCTimestamp, value: p.v };
            });
        series1.setData(data);
        chart.timeScale().fitContent();

        const ro = new ResizeObserver(() => {
            if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
        });
        ro.observe(containerRef.current);
        return () => {
            ro.disconnect();
            chart.remove();
        };
    }, [series, isDark]);

    if (err) return <div className="vs-empty">{err}</div>;
    if (!series) return <div className="vs-empty">Loading P&amp;L…</div>;

    return (
        <div className="pnl">
            <div className="pnl-stats">
                <PnlStat label="Realized" value={series.points.at(-1)?.cumulativeRealizedPnl ?? 0} />
                <PnlStat label="Unrealized" value={series.currentUnrealizedPnl} />
                <PnlStat label="Total" value={series.currentTotalPnl} />
            </div>
            {series.points.length < 2 ? (
                <div className="vs-empty">No realized P&amp;L history yet — settle a position to chart it.</div>
            ) : (
                <div ref={containerRef} style={{ width: '100%', height: 220 }} />
            )}
        </div>
    );
}

function PnlStat({ label, value }: { label: string; value: number }) {
    const c = value > 0 ? 'var(--yes)' : value < 0 ? 'var(--no)' : 'var(--text-primary)';
    return (
        <div className="pnl-stat">
            <div className="pnl-stat-label">{label}</div>
            <div className="pnl-stat-value" style={{ color: c }}>{usd(value)}</div>
        </div>
    );
}
