import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { Market } from '../lib/config';
import TvChart from './TvChart';
import TradeSidebar from './TradeSidebar';
import MintTokensModal from './MintTokensModal';

function formatDate(ms: number) {
    const d = new Date(ms);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

interface Props {
    markets: Market[];
    theme: 'dark' | 'light';
    onResolve: (m: Market) => void;
}

interface PricePoint {
    time: number;
    value: number;
}

export default function MarketDetailPage({ markets, theme, onResolve }: Props) {
    const { marketId } = useParams<{ marketId: string }>();
    const navigate = useNavigate();

    const market = markets.find(m => m.objectId === marketId);
    const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
    const [showMint, setShowMint] = useState(false);

    useEffect(() => {
        if (!market) return;
        fetch(`http://localhost:3000/markets/${market.id}/history`)
            .then(r => r.json())
            .then(data => {
                const history: any[] = data.history ?? [];
                setPriceHistory(
                    history.map(p => ({
                        time: Math.floor(new Date(p.timestamp).getTime() / 1000),
                        value: p.yes_price,
                    }))
                );
            })
            .catch(console.error);
    }, [market?.id]);

    if (!market) {
        return (
            <div className="empty-state" style={{ paddingTop: 100 }}>
                <div className="empty-title">Market not found</div>
                <div className="empty-desc" style={{ marginTop: 8 }}>
                    <Link to="/markets" className="btn btn-ghost btn-sm">Back to Markets</Link>
                </div>
            </div>
        );
    }

    return (
        <div className="main-layout" style={{ height: '100%', overflow: 'hidden' }}>
            {/* LEFT: market detail */}
            <div className="content-area">
                <div className="market-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                        <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => navigate('/markets')}
                            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                        >
                            <ArrowLeft size={14} /> All Markets
                        </button>
                    </div>

                    <div className="market-header-top">
                        <h1>{market.question}</h1>
                        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                            <span className={`tag ${market.status === 'Active' ? 'tag-active' : 'tag-resolved'}`}>
                                {market.status}
                            </span>
                            {market.status === 'Active' && (
                                <>
                                    <button className="btn btn-yes btn-sm" onClick={() => setShowMint(true)}>
                                        Mint Tokens
                                    </button>
                                    <button className="btn btn-ghost btn-sm" onClick={() => onResolve(market)}>
                                        Resolve
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    <div className="market-tags" style={{ marginBottom: 14 }}>
                        <span className="tag tag-category">#{market.id}</span>
                        <span className="tag tag-category">Sui Testnet</span>
                        <span className="tag tag-category">Closes {formatDate(market.resolutionTime)}</span>
                    </div>

                    {/* Prob summary */}
                    <div className="prob-summary">
                        <div>
                            <div className="prob-label">YES</div>
                            <div className="prob-yes">{market.yesPrice}%</div>
                        </div>
                        <div style={{ flex: 1 }}>
                            <div className="dual-bar">
                                <div className="dual-bar-yes" style={{ width: `${market.yesPrice}%` }} />
                                <div className="dual-bar-no" />
                            </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                            <div className="prob-label">NO</div>
                            <div className="prob-no">{market.noPrice}%</div>
                        </div>
                    </div>

                    {/* Chart */}
                    <div style={{ marginTop: 32, marginBottom: 16, height: 450, width: '100%' }}>
                        <TvChart priceHistory={priceHistory} theme={theme} />
                    </div>
                </div>
            </div>

            {/* RIGHT: Trade sidebar */}
            <TradeSidebar market={market} />

            {showMint && (
                <MintTokensModal market={market} onClose={() => setShowMint(false)} />
            )}
        </div>
    );
}
