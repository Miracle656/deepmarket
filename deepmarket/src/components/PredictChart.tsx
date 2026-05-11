// PredictChart — BTC spot price + selected-strike marker for a Predict oracle.
//
// Fetches /oracles/:id/prices from the public Predict server, plots spot as a
// blue line, overlays horizontal price-lines for the user's currently-selected
// strike and (post-expiry) the settlement price. Auto-refreshes every 30s.

import { useEffect, useRef } from 'react';
import {
    createChart,
    ColorType,
    LineStyle,
    LineSeries,
    AreaSeries,
    type IChartApi,
    type ISeriesApi,
    type IPriceLine,
    type UTCTimestamp,
} from 'lightweight-charts';
import { CONFIG } from '../lib/config';

interface PriceUpdateRow {
    spot: number;
    forward: number;
    onchain_timestamp: number;
}

interface Props {
    oracleId: string;
    theme: 'dark' | 'light';
    /** Binary mode: 1e9-scaled strike to render as a horizontal marker. */
    selectedStrike: bigint | null;
    isUp: boolean;
    /** Range mode: lower strike marker (1e9-scaled). */
    lowerStrike?: bigint | null;
    /** Range mode: upper strike marker (1e9-scaled). */
    higherStrike?: bigint | null;
    /** Render mode — drives which markers appear. */
    mode?: 'binary' | 'range';
    /** 1e9-scaled settlement price once oracle is settled (else null). */
    settlementPrice: number | null;
    /** Oracle expiry in ms — drawn as a vertical reference line. */
    expiry: number;
}

const RAW_TO_USD = 1_000_000_000;
const REFRESH_MS = 30_000;

export default function PredictChart({
    oracleId,
    theme,
    selectedStrike,
    isUp,
    lowerStrike = null,
    higherStrike = null,
    mode = 'binary',
    settlementPrice,
    expiry,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
    const forwardRef = useRef<ISeriesApi<'Line'> | null>(null);
    const strikeLineRef = useRef<IPriceLine | null>(null);
    const lowerLineRef = useRef<IPriceLine | null>(null);
    const upperLineRef = useRef<IPriceLine | null>(null);
    const settleLineRef = useRef<IPriceLine | null>(null);
    const expiryLineRef = useRef<IPriceLine | null>(null);

    const isDark = theme === 'dark';
    const bg = isDark ? '#0a1628' : '#ffffff';
    const textColor = isDark ? '#7b8ea8' : '#4a5d75';
    const gridColor = isDark
        ? 'rgba(255,255,255,0.04)'
        : 'rgba(0,0,0,0.05)';
    const borderColor = isDark
        ? 'rgba(255,255,255,0.08)'
        : 'rgba(0,0,0,0.08)';
    const lineColor = isDark ? '#1c6fff' : '#0048cc';
    const areaTop = isDark
        ? 'rgba(28,111,255,0.22)'
        : 'rgba(28,111,255,0.14)';
    const forwardColor = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';

    // ── Build chart once ─────────────────────────────────────────────────
    useEffect(() => {
        if (!containerRef.current) return;
        const el = containerRef.current;
        el.innerHTML = '';

        const chart = createChart(el, {
            width: el.clientWidth,
            height: el.clientHeight || 280,
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
                scaleMargins: { top: 0.12, bottom: 0.12 },
            },
            timeScale: {
                borderColor,
                fixLeftEdge: false,
                fixRightEdge: false,
                timeVisible: true,
                secondsVisible: false,
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
            handleScale: { axisPressedMouseMove: true, mouseWheel: true },
            handleScroll: true,
        });

        const spotSeries = chart.addSeries(AreaSeries, {
            lineColor,
            topColor: areaTop,
            bottomColor: 'rgba(0,0,0,0)',
            lineWidth: 2,
            priceFormat: {
                type: 'custom',
                formatter: (v: number) =>
                    `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
                minMove: 1,
            },
        });

        const fwdSeries = chart.addSeries(LineSeries, {
            color: forwardColor,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: false,
        });

        chartRef.current = chart;
        seriesRef.current = spotSeries;
        forwardRef.current = fwdSeries;

        const ro = new ResizeObserver(() => {
            chart.applyOptions({
                width: el.clientWidth,
                height: el.clientHeight || 280,
            });
        });
        ro.observe(el);

        return () => {
            ro.disconnect();
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
            forwardRef.current = null;
            strikeLineRef.current = null;
            settleLineRef.current = null;
            expiryLineRef.current = null;
        };
    }, [theme, bg, textColor, gridColor, borderColor, lineColor, areaTop, forwardColor]);

    // ── Fetch + update price data ────────────────────────────────────────
    useEffect(() => {
        if (!oracleId) return;
        let cancelled = false;
        const fetchAndPlot = async () => {
            try {
                const res = await fetch(
                    `${CONFIG.PREDICT_SERVER_URL}/oracles/${oracleId}/prices`
                );
                if (!res.ok) return;
                const rows: PriceUpdateRow[] = await res.json();
                if (cancelled || !seriesRef.current || !forwardRef.current)
                    return;

                // Server returns newest-first; chart wants ascending time.
                // Dedupe identical consecutive timestamps (chart rejects dupes).
                const sorted = [...rows].sort(
                    (a, b) => a.onchain_timestamp - b.onchain_timestamp
                );
                const seen = new Set<number>();
                const spotData = [];
                const fwdData = [];
                for (const r of sorted) {
                    const t = Math.floor(r.onchain_timestamp / 1000) as UTCTimestamp;
                    if (seen.has(t)) continue;
                    seen.add(t);
                    spotData.push({ time: t, value: r.spot / RAW_TO_USD });
                    fwdData.push({ time: t, value: r.forward / RAW_TO_USD });
                }
                seriesRef.current.setData(spotData);
                forwardRef.current.setData(fwdData);
                chartRef.current?.timeScale().fitContent();
            } catch {
                /* ignore — server hiccup, retry on next tick */
            }
        };
        fetchAndPlot();
        const id = window.setInterval(fetchAndPlot, REFRESH_MS);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [oracleId]);

    // ── Update strike markers (binary OR range) ──────────────────────────
    useEffect(() => {
        const series = seriesRef.current;
        if (!series) return;
        // Clear all marker lines on each update — cheap and correct.
        if (strikeLineRef.current) {
            series.removePriceLine(strikeLineRef.current);
            strikeLineRef.current = null;
        }
        if (lowerLineRef.current) {
            series.removePriceLine(lowerLineRef.current);
            lowerLineRef.current = null;
        }
        if (upperLineRef.current) {
            series.removePriceLine(upperLineRef.current);
            upperLineRef.current = null;
        }

        if (mode === 'binary' && selectedStrike !== null) {
            strikeLineRef.current = series.createPriceLine({
                price: Number(selectedStrike) / RAW_TO_USD,
                color: isUp ? '#22d3a4' : '#ff4d6a',
                lineWidth: 2,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: `${isUp ? 'UP' : 'DN'} strike`,
            });
        }
        if (mode === 'range') {
            const bandColor = '#1c6fff';
            if (lowerStrike !== null) {
                lowerLineRef.current = series.createPriceLine({
                    price: Number(lowerStrike) / RAW_TO_USD,
                    color: bandColor,
                    lineWidth: 2,
                    lineStyle: LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: 'Lower',
                });
            }
            if (higherStrike !== null) {
                upperLineRef.current = series.createPriceLine({
                    price: Number(higherStrike) / RAW_TO_USD,
                    color: bandColor,
                    lineWidth: 2,
                    lineStyle: LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: 'Upper',
                });
            }
        }
    }, [mode, selectedStrike, isUp, lowerStrike, higherStrike]);

    // ── Update settlement marker ─────────────────────────────────────────
    useEffect(() => {
        const series = seriesRef.current;
        if (!series) return;
        if (settleLineRef.current) {
            series.removePriceLine(settleLineRef.current);
            settleLineRef.current = null;
        }
        if (settlementPrice !== null && settlementPrice > 0) {
            settleLineRef.current = series.createPriceLine({
                price: settlementPrice / RAW_TO_USD,
                color: '#f5a623',
                lineWidth: 2,
                lineStyle: LineStyle.Solid,
                axisLabelVisible: true,
                title: 'Settled',
            });
        }
    }, [settlementPrice]);

    // ── Expiry vertical reference (rendered as price-line at last x via title)
    // lightweight-charts has no native vertical line; we just use a marker on
    // the time axis indirectly via fitContent. Skipping vertical line to avoid
    // visual clutter — the `Settled` horizontal label tells the story.
    useEffect(() => {
        // intentionally empty — placeholder for future vertical-line plugin
        void expiry;
        void expiryLineRef;
    }, [expiry]);

    return (
        <div
            ref={containerRef}
            style={{
                width: '100%',
                height: 300,
                borderRadius: 10,
                overflow: 'hidden',
                background: bg,
                border: '1px solid var(--border-base)',
            }}
        />
    );
}
