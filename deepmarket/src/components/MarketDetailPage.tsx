import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { ArrowLeft, LineChart, MessageCircle, BookOpen, History } from 'lucide-react';
import { CONFIG, type Market } from '../lib/config';
import { INDEXER_URL } from '../lib/api';
import TvChart from './TvChart';
import TradeSidebar from './TradeSidebar';
import MintTokensModal from './MintTokensModal';
import MarketChat from './MarketChat';
import OrderBook from './OrderBook';
import MarketTrades from './MarketTrades';

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
    const acct = useCurrentAccount();
    const suiClient = useSuiClient();

    const market = markets.find(m => m.objectId === marketId);
    const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
    const [showMint, setShowMint] = useState(false);
    const [activeTab, setActiveTab] = useState<'chart' | 'book' | 'trades' | 'chat'>('chart');
    const [isAdmin, setIsAdmin] = useState(false);

    // Resolution is gated by the protocol AdminCap (one cap resolves all
    // markets). Only show Resolve to the wallet that owns it.
    useEffect(() => {
        if (!acct) { setIsAdmin(false); return; }
        let cancelled = false;
        suiClient
            .getObject({ id: CONFIG.ADMIN_CAP_OBJECT_ID, options: { showOwner: true } })
            .then(res => {
                const owner = res.data?.owner;
                const addr = owner && typeof owner === 'object' && 'AddressOwner' in owner
                    ? (owner as { AddressOwner: string }).AddressOwner : null;
                if (!cancelled) setIsAdmin(addr === acct.address);
            })
            .catch(() => { if (!cancelled) setIsAdmin(false); });
        return () => { cancelled = true; };
    }, [acct, suiClient]);

    useEffect(() => {
        if (!market) return;
        fetch(`${INDEXER_URL}/markets/${market.id}/history`)
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
                                    {isAdmin && (
                                        <button className="btn btn-ghost btn-sm" onClick={() => onResolve(market)}>
                                            Resolve
                                        </button>
                                    )}
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

                    {/* Tab strip */}
                    <div className="market-tabs" role="tablist">
                        <button
                            className={`market-tab ${activeTab === 'chart' ? 'active' : ''}`}
                            onClick={() => setActiveTab('chart')}
                            role="tab"
                            aria-selected={activeTab === 'chart'}
                        >
                            <LineChart size={14} /> Chart
                        </button>
                        <button
                            className={`market-tab ${activeTab === 'book' ? 'active' : ''}`}
                            onClick={() => setActiveTab('book')}
                            role="tab"
                            aria-selected={activeTab === 'book'}
                        >
                            <BookOpen size={14} /> Order Book
                        </button>
                        <button
                            className={`market-tab ${activeTab === 'trades' ? 'active' : ''}`}
                            onClick={() => setActiveTab('trades')}
                            role="tab"
                            aria-selected={activeTab === 'trades'}
                        >
                            <History size={14} /> Trades
                        </button>
                        <button
                            className={`market-tab ${activeTab === 'chat' ? 'active' : ''}`}
                            onClick={() => setActiveTab('chat')}
                            role="tab"
                            aria-selected={activeTab === 'chat'}
                        >
                            <MessageCircle size={14} /> Chat
                        </button>
                    </div>

                    {/* Tab body */}
                    {activeTab === 'chart' && (
                        <div style={{ marginTop: 16, marginBottom: 16, height: 450, width: '100%' }}>
                            <TvChart priceHistory={priceHistory} theme={theme} />
                        </div>
                    )}
                    {activeTab === 'book' && (
                        <div style={{ marginTop: 16, marginBottom: 16, height: 450, width: '100%', overflowY: 'auto' }}>
                            <OrderBook yesPoolId={market.yesPoolId ?? ''} />
                        </div>
                    )}
                    {activeTab === 'trades' && (
                        <div style={{ marginTop: 16, marginBottom: 16, height: 450, width: '100%', overflowY: 'auto' }}>
                            <MarketTrades marketId={market.id} />
                        </div>
                    )}
                    {activeTab === 'chat' && (
                        <div style={{ marginTop: 16, marginBottom: 16, height: 450, width: '100%' }}>
                            <MarketChat
                                marketObjectId={market.objectId}
                                marketTitle={market.question}
                            />
                        </div>
                    )}
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
