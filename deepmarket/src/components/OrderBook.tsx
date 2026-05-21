import { useEffect, useState } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { getOrderBookFromPool, type OrderBookData, type BookLevel } from '../lib/poolPricing';

interface Props {
    yesPoolId: string;
}

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Live DeepBook order-book ladder for a market's YES pool. Asks (red) on top,
 * the spread in the middle, bids (green) below — each row backed by a depth
 * bar sized to its share of the visible side. Polls every 10s via devInspect.
 */
export default function OrderBook({ yesPoolId }: Props) {
    const client = useSuiClient();
    const [book, setBook] = useState<OrderBookData | null>(null);
    const [loading, setLoading] = useState(true);

    const hasPool = yesPoolId && yesPoolId !== ZERO;

    useEffect(() => {
        if (!hasPool) {
            setLoading(false);
            return;
        }
        let alive = true;
        const load = async () => {
            const data = await getOrderBookFromPool(client, yesPoolId, 12);
            if (alive) {
                setBook(data);
                setLoading(false);
            }
        };
        load();
        const id = setInterval(load, 10_000);
        return () => {
            alive = false;
            clearInterval(id);
        };
    }, [client, yesPoolId, hasPool]);

    if (!hasPool) {
        return (
            <div className="ob-empty">
                This market has no DeepBook pool — mint &amp; redeem only, no order book.
            </div>
        );
    }
    if (loading) {
        return <div className="ob-empty">Loading order book…</div>;
    }

    const bids = book?.bids ?? [];
    const asks = book?.asks ?? [];
    if (bids.length === 0 && asks.length === 0) {
        return (
            <div className="ob-empty">
                No resting orders yet. Post a limit order to seed the book.
            </div>
        );
    }

    // Depth bars scale to the largest size on each side.
    const maxBid = Math.max(1, ...bids.map(b => b.size));
    const maxAsk = Math.max(1, ...asks.map(a => a.size));
    const bestBid = bids[0]?.price;
    const bestAsk = asks[0]?.price;
    const spread =
        bestBid != null && bestAsk != null ? Math.max(0, bestAsk - bestBid) : null;
    const mid =
        bestBid != null && bestAsk != null
            ? (bestBid + bestAsk) / 2
            : bestBid ?? bestAsk ?? null;

    const Row = ({ lvl, side, max }: { lvl: BookLevel; side: 'bid' | 'ask'; max: number }) => (
        <div className={`ob-row ob-${side}`}>
            <div className="ob-depth" style={{ width: `${(lvl.size / max) * 100}%` }} />
            <span className="ob-price">{lvl.price.toFixed(1)}¢</span>
            <span className="ob-size">{lvl.size.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
        </div>
    );

    return (
        <div className="ob">
            <div className="ob-head">
                <span>Price</span>
                <span>Size (YES)</span>
            </div>

            {/* Asks: show highest price at top, best ask just above the mid. */}
            <div className="ob-side">
                {[...asks].reverse().map((lvl, i) => (
                    <Row key={`a${i}`} lvl={lvl} side="ask" max={maxAsk} />
                ))}
            </div>

            <div className="ob-mid">
                {mid != null ? `${mid.toFixed(1)}¢` : '—'}
                {spread != null && <span className="ob-spread">spread {spread.toFixed(1)}¢</span>}
            </div>

            {/* Bids: best (highest) first, descending. */}
            <div className="ob-side">
                {bids.map((lvl, i) => (
                    <Row key={`b${i}`} lvl={lvl} side="bid" max={maxBid} />
                ))}
            </div>
        </div>
    );
}
