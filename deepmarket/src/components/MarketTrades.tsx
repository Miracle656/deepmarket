// MarketTrades — all fills for a spot YES/NO market (not just the user's),
// from the indexer's fill history. The "Trade History" half of an order-book
// market, alongside the live OrderBook depth ladder.

import { useEffect, useState } from 'react';
import { INDEXER_URL } from '../lib/api';

interface Fill {
    price: number; // YES probability, 0-100
    qty: number; // base raw (1e9 = 1 share)
    digest: string;
}

export default function MarketTrades({ marketId }: { marketId: number }) {
    const [fills, setFills] = useState<Fill[] | null>(null);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        const load = () =>
            fetch(`${INDEXER_URL}/markets/${marketId}/orderbook`)
                .then((r) => r.json())
                .then((d) => alive && setFills(Array.isArray(d.fills) ? d.fills : []))
                .catch((e) => alive && setErr(e instanceof Error ? e.message : 'Failed to load trades'));
        load();
        const id = setInterval(load, 10_000);
        return () => {
            alive = false;
            clearInterval(id);
        };
    }, [marketId]);

    if (err) return <div className="vs-empty">{err}</div>;
    if (!fills) return <div className="vs-empty">Loading trades…</div>;
    if (fills.length === 0)
        return <div className="vs-empty">No trades on this market yet.</div>;

    return (
        <div className="tape">
            <div className="tape-head" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                <span>YES price</span>
                <span style={{ textAlign: 'right' }}>Size</span>
                <span style={{ textAlign: 'right' }}>Tx</span>
            </div>
            <div className="tape-body">
                {fills.map((f, i) => (
                    <div key={`${f.digest}-${i}`} className="tape-row" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                        <span className="tape-buy">{f.price}¢</span>
                        <span style={{ textAlign: 'right' }}>
                            {(f.qty / 1e9).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                        </span>
                        <a
                            href={`https://testnet.suivision.xyz/txblock/${f.digest}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="tape-trader"
                            style={{ textAlign: 'right', textDecoration: 'none' }}
                        >
                            {f.digest.slice(0, 6)}…
                        </a>
                    </div>
                ))}
            </div>
        </div>
    );
}
