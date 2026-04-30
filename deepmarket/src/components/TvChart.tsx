import { useEffect, useRef } from 'react';
import {
    createChart,
    ColorType,
    LineStyle,
    AreaSeries,
} from 'lightweight-charts';

interface PricePoint {
    time: number;
    value: number;
}

interface Props {
    priceHistory: PricePoint[];
    theme: 'dark' | 'light';
}

export default function TvChart({ priceHistory, theme }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);

    const isDark = theme === 'dark';
    const bg = isDark ? '#0a1628' : '#ffffff';
    const textColor = isDark ? '#7b8ea8' : '#4a5d75';
    const gridColor = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)';
    const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const lineColorYes = isDark ? '#00e5a0' : '#009966';
    const areaTopYes = isDark ? 'rgba(0,229,160,0.22)' : 'rgba(0,153,102,0.14)';
    const lineColorNo = isDark ? '#ff4d6a' : '#d92643';
    const areaTopNo = isDark ? 'rgba(255,77,106,0.22)' : 'rgba(217,38,67,0.14)';
    const areaBottom = 'rgba(0,0,0,0)';

    useEffect(() => {
        if (!containerRef.current) return;
        containerRef.current.innerHTML = '';

        if (priceHistory.length === 0) {
            containerRef.current.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#7b8ea8;font-size:0.85rem;">No price data yet</div>';
            return;
        }

        const chart = createChart(containerRef.current, {
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight || 280,
            layout: {
                background: { type: ColorType.Solid, color: bg },
                textColor,
                fontFamily: "'Inter', sans-serif",
                fontSize: 11,
            },
            grid: {
                vertLines: { color: gridColor, style: LineStyle.Dotted },
                horzLines: { color: gridColor, style: LineStyle.Dotted },
            },
            rightPriceScale: {
                borderColor,
                scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            leftPriceScale: {
                visible: true,
                borderColor,
                scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            timeScale: {
                borderColor,
                fixLeftEdge: true,
                fixRightEdge: true,
            },
            crosshair: {
                vertLine: {
                    color: gridColor,
                    width: 1,
                    style: LineStyle.Dashed,
                    labelBackgroundColor: textColor,
                },
                horzLine: {
                    color: gridColor,
                    width: 1,
                    style: LineStyle.Dashed,
                    labelBackgroundColor: textColor,
                },
            },
            handleScale: false,
            handleScroll: false,
        });

        const seriesYes = chart.addSeries(AreaSeries, {
            lineColor: lineColorYes,
            topColor: areaTopYes,
            bottomColor: areaBottom,
            lineWidth: 2,
            priceFormat: {
                type: 'custom',
                formatter: (p: number) => `YES: ${p.toFixed(0)}%`,
                minMove: 0.01,
            },
        });

        const seriesNo = chart.addSeries(AreaSeries, {
            lineColor: lineColorNo,
            topColor: areaTopNo,
            bottomColor: areaBottom,
            lineWidth: 2,
            priceScaleId: 'left',
            priceFormat: {
                type: 'custom',
                formatter: (p: number) => `NO: ${p.toFixed(0)}%`,
                minMove: 0.01,
            },
        });

        const yesData = priceHistory.map(p => ({
            time: p.time as import('lightweight-charts').UTCTimestamp,
            value: p.value,
        }));
        const noData = priceHistory.map(p => ({
            time: p.time as import('lightweight-charts').UTCTimestamp,
            value: 100 - p.value,
        }));

        seriesYes.setData(yesData);
        seriesNo.setData(noData);
        chart.timeScale().fitContent();

        const ro = new ResizeObserver(() => {
            if (containerRef.current) {
                chart.applyOptions({
                    width: containerRef.current.clientWidth,
                    height: containerRef.current.clientHeight,
                });
            }
        });
        ro.observe(containerRef.current);

        return () => {
            ro.disconnect();
            chart.remove();
        };
    }, [priceHistory, theme]);

    return (
        <div
            ref={containerRef}
            style={{ width: '100%', height: '100%', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}
        />
    );
}
