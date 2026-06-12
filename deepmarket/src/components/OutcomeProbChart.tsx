import { useEffect, useRef } from 'react';
import {
    createChart,
    ColorType,
    LineStyle,
    LineSeries,
    type UTCTimestamp,
} from 'lightweight-charts';

export interface ChartSeries {
    name: string;
    color: string;
    data: { time: number; value: number }[]; // time in seconds, value 0–100
}

interface Props {
    series: ChartSeries[];
}

/**
 * Multi-line probability chart — one line per outcome, value = implied
 * probability (0–100) over time, built from DeepBook fills. Polymarket-style.
 */
export default function OutcomeProbChart({ series }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        containerRef.current.innerHTML = '';

        const hasData = series.some(s => s.data.length > 0);
        if (!hasData) {
            containerRef.current.innerHTML =
                '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#7b8ea8;font-size:0.85rem;">No trades yet — the chart fills in as outcomes trade.</div>';
            return;
        }

        const chart = createChart(containerRef.current, {
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight || 360,
            layout: {
                background: { type: ColorType.Solid, color: '#0a1628' },
                textColor: '#7b8ea8',
                fontFamily: "'Inter', sans-serif",
                fontSize: 11,
            },
            grid: {
                vertLines: { color: 'rgba(255,255,255,0.04)', style: LineStyle.Dotted },
                horzLines: { color: 'rgba(255,255,255,0.04)', style: LineStyle.Dotted },
            },
            rightPriceScale: {
                borderColor: 'rgba(255,255,255,0.08)',
                scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            timeScale: { borderColor: 'rgba(255,255,255,0.08)', fixLeftEdge: true, fixRightEdge: true },
            crosshair: {
                vertLine: { color: 'rgba(255,255,255,0.12)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#7b8ea8' },
                horzLine: { color: 'rgba(255,255,255,0.12)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#7b8ea8' },
            },
            handleScale: false,
            handleScroll: false,
        });

        for (const s of series) {
            if (s.data.length === 0) continue;
            const line = chart.addSeries(LineSeries, {
                color: s.color,
                lineWidth: 2,
                priceFormat: { type: 'custom', formatter: (p: number) => `${p.toFixed(0)}%`, minMove: 0.01 },
                lastValueVisible: true,
                priceLineVisible: false,
            });
            // lightweight-charts needs strictly ascending unique seconds.
            const sorted = [...s.data].sort((a, b) => a.time - b.time);
            let lastT = -Infinity;
            const norm = sorted.map(p => {
                const t = p.time <= lastT ? lastT + 1 : p.time;
                lastT = t;
                return { time: t as UTCTimestamp, value: p.value };
            });
            line.setData(norm);
        }

        chart.timeScale().fitContent();

        const ro = new ResizeObserver(() => {
            if (containerRef.current) {
                chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
            }
        });
        ro.observe(containerRef.current);

        return () => {
            ro.disconnect();
            chart.remove();
        };
    }, [series]);

    return (
        <div style={{ width: '100%' }}>
            {/* Legend */}
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
                {series.map((s, i) => {
                    const last = s.data.length ? s.data[s.data.length - 1].value : null;
                    return (
                        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
                            <span style={{ width: 10, height: 3, borderRadius: 2, background: s.color, display: 'inline-block' }} />
                            <span style={{ color: 'var(--text-primary)' }}>{s.name}</span>
                            {last != null && <span style={{ color: s.color, fontWeight: 700 }}>{last}%</span>}
                        </span>
                    );
                })}
            </div>
            <div ref={containerRef} style={{ width: '100%', height: 340, borderRadius: 10, overflow: 'hidden' }} />
        </div>
    );
}
