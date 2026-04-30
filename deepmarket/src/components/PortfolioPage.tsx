import { useEffect, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useNavigate } from 'react-router-dom';
import { Wallet, TrendingUp, TrendingDown } from 'lucide-react';
import type { Market } from '../lib/config';
import { formatVol } from '../App';

interface Position {
    market: Market;
    yesBalance: number; // in full token units (divided by 1e9)
    noBalance: number;
}

interface Props {
    markets: Market[];
}

export default function PortfolioPage({ markets }: Props) {
    const acct = useCurrentAccount();
    const navigate = useNavigate();
    const [positions, setPositions] = useState<Position[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!acct || markets.length === 0) { setPositions([]); return; }
        setLoading(true);

        Promise.all(
            markets.map(async (m) => {
                try {
                    const res = await fetch(`http://localhost:3000/markets/${m.id}/positions/${acct.address}`);
                    const data = await res.json();
                    return {
                        market: m,
                        yesBalance: Number(data.yes_balance ?? 0) / 1e9,
                        noBalance: Number(data.no_balance ?? 0) / 1e9,
                    };
                } catch {
                    return { market: m, yesBalance: 0, noBalance: 0 };
                }
            })
        ).then(all => {
            setPositions(all.filter(p => p.yesBalance > 0.0001 || p.noBalance > 0.0001));
            setLoading(false);
        });
    }, [acct, markets]);

    if (!acct) {
        return (
            <div className="empty-state" style={{ paddingTop: 80 }}>
                <div className="empty-icon"><Wallet size={48} strokeWidth={1} style={{ opacity: 0.8 }} /></div>
                <div className="empty-title">Connect your wallet</div>
                <div className="empty-desc">Connect to see your positions</div>
            </div>
        );
    }

    // Portfolio stats
    const totalYesValue = positions.reduce((sum, p) => sum + p.yesBalance * (p.market.yesPrice / 100), 0);
    const totalNoValue = positions.reduce((sum, p) => sum + p.noBalance * (p.market.noPrice / 100), 0);
    const totalValue = totalYesValue + totalNoValue;

    return (
        <div style={{ maxWidth: 900, paddingTop: 8 }}>
            <div className="stat-strip" style={{ marginBottom: 24 }}>
                <div className="stat-cell">
                    <div className="stat-cell-label">Open Positions</div>
                    <div className="stat-cell-value">{positions.length}</div>
                </div>
                <div className="stat-cell">
                    <div className="stat-cell-label">Est. Portfolio Value</div>
                    <div className="stat-cell-value">{totalValue.toFixed(4)} SUI</div>
                </div>
                <div className="stat-cell">
                    <div className="stat-cell-label">YES Holdings</div>
                    <div className="stat-cell-value" style={{ color: 'var(--yes)' }}>{totalYesValue.toFixed(4)} SUI</div>
                </div>
                <div className="stat-cell">
                    <div className="stat-cell-label">NO Holdings</div>
                    <div className="stat-cell-value" style={{ color: 'var(--no)' }}>{totalNoValue.toFixed(4)} SUI</div>
                </div>
            </div>

            <div className="markets-header" style={{ marginBottom: 12 }}>
                <span className="markets-title">Your Positions</span>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {acct.address.slice(0, 10)}…{acct.address.slice(-6)}
                </span>
            </div>

            {loading && (
                <div className="empty-state" style={{ paddingTop: 40 }}>
                    <div className="empty-title">Loading positions…</div>
                </div>
            )}

            {!loading && positions.length === 0 && (
                <div className="empty-state" style={{ paddingTop: 40 }}>
                    <div className="empty-icon"><TrendingUp size={48} strokeWidth={1} style={{ opacity: 0.4 }} /></div>
                    <div className="empty-title">No open positions</div>
                    <div className="empty-desc">Buy YES or NO tokens on any market to get started</div>
                </div>
            )}

            {!loading && positions.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* Table header */}
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 100px 100px 100px 120px',
                        gap: 12,
                        padding: '8px 16px',
                        fontSize: '0.72rem',
                        color: 'var(--text-muted)',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        borderBottom: '1px solid var(--border-base)',
                    }}>
                        <div>Market</div>
                        <div style={{ textAlign: 'right' }}>YES Bal</div>
                        <div style={{ textAlign: 'right' }}>NO Bal</div>
                        <div style={{ textAlign: 'right' }}>Price</div>
                        <div style={{ textAlign: 'right' }}>Est. Value</div>
                    </div>

                    {positions.map(({ market: m, yesBalance, noBalance }) => {
                        const posValue = yesBalance * (m.yesPrice / 100) + noBalance * (m.noPrice / 100);
                        const isResolved = m.status === 'Resolved';

                        return (
                            <div
                                key={m.id}
                                onClick={() => navigate(`/markets/${m.objectId}`)}
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 100px 100px 100px 120px',
                                    gap: 12,
                                    padding: '12px 16px',
                                    background: 'var(--bg-card)',
                                    border: '1px solid var(--border-base)',
                                    borderRadius: 10,
                                    cursor: 'pointer',
                                    alignItems: 'center',
                                    transition: 'border-color 0.15s',
                                }}
                                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--border-strong)')}
                                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-base)')}
                            >
                                {/* Question + status */}
                                <div>
                                    <div style={{ fontSize: '0.88rem', fontWeight: 600, marginBottom: 4, lineHeight: 1.3 }}>
                                        {m.question}
                                    </div>
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                        <span className={`tag ${isResolved ? 'tag-resolved' : 'tag-active'}`} style={{ fontSize: '0.65rem' }}>
                                            {m.status}
                                        </span>
                                        {isResolved && m.outcome !== null && (
                                            <span style={{ fontSize: '0.72rem', color: m.outcome ? 'var(--yes)' : 'var(--no)', fontWeight: 600 }}>
                                                {m.outcome ? 'YES Won' : 'NO Won'}
                                            </span>
                                        )}
                                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                            Vol {formatVol(m.volume)}
                                        </span>
                                    </div>
                                </div>

                                {/* YES balance */}
                                <div style={{ textAlign: 'right' }}>
                                    {yesBalance > 0.0001 ? (
                                        <span style={{ color: 'var(--yes)', fontWeight: 600, fontSize: '0.88rem' }}>
                                            {yesBalance.toFixed(4)}
                                        </span>
                                    ) : (
                                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    )}
                                </div>

                                {/* NO balance */}
                                <div style={{ textAlign: 'right' }}>
                                    {noBalance > 0.0001 ? (
                                        <span style={{ color: 'var(--no)', fontWeight: 600, fontSize: '0.88rem' }}>
                                            {noBalance.toFixed(4)}
                                        </span>
                                    ) : (
                                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    )}
                                </div>

                                {/* Current price */}
                                <div style={{ textAlign: 'right', fontSize: '0.88rem' }}>
                                    <span style={{ color: 'var(--yes)' }}>{m.yesPrice}¢</span>
                                    <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>/</span>
                                    <span style={{ color: 'var(--no)' }}>{m.noPrice}¢</span>
                                </div>

                                {/* Estimated value */}
                                <div style={{ textAlign: 'right' }}>
                                    <div style={{ fontWeight: 700, fontSize: '0.88rem', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                                        {posValue > 0
                                            ? <TrendingUp size={13} style={{ color: 'var(--yes)' }} />
                                            : <TrendingDown size={13} style={{ color: 'var(--text-muted)' }} />
                                        }
                                        {posValue.toFixed(4)} SUI
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
