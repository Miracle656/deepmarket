import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSuiClient } from '@mysten/dapp-kit';
import { fetchOutcomeMarket, colorForOutcome, type OutcomeMarketData } from '../lib/outcome';
import { getYesPercentFromPool } from '../lib/poolPricing';
import { fetchPoolFills, isZeroPool } from '../lib/outcomeTrade';

const MAX_ROWS = 4;

function fmtSui(raw: bigint): string {
    const v = Number(raw) / 1e9;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
    return v.toFixed(v === 0 ? 0 : 2);
}

interface Props {
    objectId: string;
    question: string;
    n: number;
}

/**
 * Self-fetching market card for a multi-outcome market: shows the top outcomes
 * with their chances (live book mid → last fill → parimutuel share). Clicking
 * an outcome deep-links to that outcome's trade ticket; clicking elsewhere opens
 * the market.
 */
export default function OutcomeMarketCard({ objectId, question, n }: Props) {
    const navigate = useNavigate();
    const suiClient = useSuiClient();
    const [market, setMarket] = useState<OutcomeMarketData | null>(null);
    const [pcts, setPcts] = useState<number[]>([]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const m = await fetchOutcomeMarket(suiClient, objectId);
            if (!m || cancelled) return;
            setMarket(m);

            const total = m.totalStaked.reduce((s, v) => s + v, 0n);
            const livePools = m.pools.some(p => !isZeroPool(p));
            const fills = livePools ? await fetchPoolFills(suiClient as any, m.pools, 3) : [];
            const lastByIdx: Record<number, number> = {};
            for (const f of fills) {
                const idx = m.pools.indexOf(f.poolId);
                if (idx >= 0 && lastByIdx[idx] === undefined) lastByIdx[idx] = f.price;
            }
            const mids = await Promise.all(
                m.pools.map(p => (isZeroPool(p) ? Promise.resolve(null) : getYesPercentFromPool(suiClient as any, p))),
            );
            if (cancelled) return;
            const out = m.outcomeNames.map((_, i) => {
                if (mids[i] != null) return mids[i] as number;
                if (lastByIdx[i] != null) return Math.round(lastByIdx[i] * 100);
                return total > 0n ? Number((m.totalStaked[i] * 10000n) / total) / 100 : 0;
            });
            setPcts(out);
        })();
        return () => { cancelled = true; };
    }, [objectId, suiClient]);

    // Outcomes ordered by chance (desc), capped.
    const rows = (market?.outcomeNames ?? [])
        .map((name, i) => ({ name, i, pct: pcts[i] ?? 0 }))
        .sort((a, b) => b.pct - a.pct)
        .slice(0, MAX_ROWS);
    const hasPools = market ? market.pools.some(p => !isZeroPool(p)) : false;

    return (
        <div className="market-card" onClick={() => navigate(`/outcome/${objectId}`)}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <div className="market-card-tag">MULTI-OUTCOME</div>
                <div
                    className="market-card-tag"
                    style={{
                        color: hasPools ? 'var(--yes)' : 'var(--text-muted)',
                        borderColor: hasPools ? 'var(--yes-border)' : 'var(--border-dim)',
                        background: hasPools ? 'var(--yes-dim)' : 'var(--bg-input)',
                    }}
                >
                    {hasPools ? 'ORDER BOOK' : 'MINT ONLY'}
                </div>
            </div>

            <div className="market-card-question">{question}</div>

            {/* Outcome chances */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '4px 0 12px' }}>
                {rows.length === 0 && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading chances…</div>
                )}
                {rows.map(({ name, i, pct }) => {
                    const c = colorForOutcome(i);
                    return (
                        <button
                            key={i}
                            onClick={(e) => { e.stopPropagation(); navigate(`/outcome/${objectId}?o=${i}`); }}
                            title={`Trade ${name}`}
                            style={{
                                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                fontFamily: 'inherit', textAlign: 'left',
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: c, flexShrink: 0 }} />
                                    <span style={{
                                        fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)',
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    }}>{name}</span>
                                </span>
                                <span style={{ fontSize: '0.85rem', fontWeight: 800, color: c, fontVariantNumeric: 'tabular-nums' }}>
                                    {pct.toFixed(0)}%
                                </span>
                            </div>
                            <div style={{ height: 4, borderRadius: 999, background: 'var(--bg-input)', overflow: 'hidden', marginTop: 5 }}>
                                <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: c, borderRadius: 999 }} />
                            </div>
                        </button>
                    );
                })}
                {market && market.outcomeNames.length > MAX_ROWS && (
                    <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                        +{market.outcomeNames.length - MAX_ROWS} more
                    </span>
                )}
            </div>

            <div className="market-card-footer">
                <span>{market ? `${fmtSui(market.vault)} SUI pool` : `${n} outcomes`}</span>
                <span style={{ color: 'var(--blue)' }}>Trade →</span>
            </div>
        </div>
    );
}
