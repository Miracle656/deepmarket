// CandleChart — real OHLC candlesticks for the oracle's underlying spot,
// pulled from GMX's public keeper. Predict's own feed is point-in-time; this
// gives a proper candle view of where BTC actually traded.

import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, CandlestickSeries, type UTCTimestamp } from 'lightweight-charts';
import { fetchCandles, gmxSymbol } from '../lib/gmx';

interface Props {
    symbol: string;
    theme: 'dark' | 'light';
}

export default function CandleChart({ symbol, theme }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [err, setErr] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const isDark = theme === 'dark';
    const token = gmxSymbol(symbol);

    useEffect(() => {
        let alive = true;
        let chart: ReturnType<typeof createChart> | null = null;

        const draw = async () => {
            try {
                const candles = await fetchCandles(token, '15m', 96);
                if (!alive || !containerRef.current) return;
                containerRef.current.innerHTML = '';
                chart = createChart(containerRef.current, {
                    width: containerRef.current.clientWidth,
                    height: containerRef.current.clientHeight || 300,
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
                    timeScale: {
                        borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
                        timeVisible: true,
                    },
                });
                const series = chart.addSeries(CandlestickSeries, {
                    upColor: '#00e5a0',
                    downColor: '#ff4d6a',
                    wickUpColor: '#00e5a0',
                    wickDownColor: '#ff4d6a',
                    borderVisible: false,
                });
                series.setData(
                    candles.map((c) => ({
                        time: c.time as UTCTimestamp,
                        open: c.open,
                        high: c.high,
                        low: c.low,
                        close: c.close,
                    }))
                );
                chart.timeScale().fitContent();
                setLoading(false);
                setErr(null);
            } catch (e) {
                if (alive) {
                    setErr(e instanceof Error ? e.message : 'Failed to load candles');
                    setLoading(false);
                }
            }
        };

        draw();
        const id = setInterval(draw, 60_000);
        const ro = new ResizeObserver(() => {
            if (chart && containerRef.current) {
                chart.applyOptions({ width: containerRef.current.clientWidth });
            }
        });
        if (containerRef.current) ro.observe(containerRef.current);

        return () => {
            alive = false;
            clearInterval(id);
            ro.disconnect();
            chart?.remove();
        };
    }, [token, isDark]);

    return (
        <div style={{ position: 'relative', height: 320, width: '100%' }}>
            <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
            {loading && !err && <div className="vs-empty" style={{ position: 'absolute', inset: 0 }}>Loading {token} candles…</div>}
            {err && <div className="vs-empty" style={{ position: 'absolute', inset: 0 }}>{err}</div>}
        </div>
    );
}
