// TradeTape — live mint/redeem feed for one Predict oracle (/trades/:id).
// Makes the oracle page feel alive: who's taking what, at what premium.

import { useEffect, useState } from 'react';
import { getOracleTrades, formatStrikeUsd, type TradeTapeEntry } from '../lib/predict';

function ago(ms: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

const cents = (p?: number) => (p == null ? '—' : `${(p * 100).toFixed(0)}¢`);

export default function TradeTape({ oracleId }: { oracleId: string }) {
    const [trades, setTrades] = useState<TradeTapeEntry[] | null>(null);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        const load = () =>
            getOracleTrades(oracleId, 50)
                .then((t) => alive && setTrades(t))
                .catch((e) => alive && setErr(e instanceof Error ? e.message : 'Failed to load trades'));
        load();
        const id = setInterval(load, 10_000);
        return () => {
            alive = false;
            clearInterval(id);
        };
    }, [oracleId]);

    if (err) return <div className="vs-empty">{err}</div>;
    if (!trades) return <div className="vs-empty">Loading trades…</div>;
    if (trades.length === 0)
        return <div className="vs-empty">No trades on this oracle yet — be the first.</div>;

    return (
        <div className="tape">
            <div className="tape-head">
                <span>Side</span>
                <span>Instrument</span>
                <span style={{ textAlign: 'right' }}>Qty</span>
                <span style={{ textAlign: 'right' }}>Price</span>
                <span style={{ textAlign: 'right' }}>Trader</span>
                <span style={{ textAlign: 'right' }}>Age</span>
            </div>
            <div className="tape-body">
                {trades.map((t, i) => {
                    const buy = t.side === 'mint';
                    const instrument =
                        t.kind === 'range'
                            ? `${formatStrikeUsd((t.lowerStrike ?? 0) * 1e9)}–${formatStrikeUsd((t.higherStrike ?? 0) * 1e9)}`
                            : `${t.isUp ? 'UP' : 'DOWN'} @ ${formatStrikeUsd((t.strike ?? 0) * 1e9)}`;
                    const price = buy ? cents(t.askPrice) : cents(t.bidPrice);
                    return (
                        <div key={`${t.txDigest}-${i}`} className="tape-row">
                            <span className={buy ? 'tape-buy' : 'tape-sell'}>
                                {buy ? 'MINT' : 'REDEEM'}
                            </span>
                            <span className="tape-inst">{instrument}</span>
                            <span style={{ textAlign: 'right' }}>
                                {t.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>
                            <span style={{ textAlign: 'right' }}>{price}</span>
                            <span className="tape-trader" style={{ textAlign: 'right' }}>
                                {t.trader ? `${t.trader.slice(0, 4)}…${t.trader.slice(-4)}` : '—'}
                            </span>
                            <span className="tape-age" style={{ textAlign: 'right' }}>{ago(t.timestampMs)}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
