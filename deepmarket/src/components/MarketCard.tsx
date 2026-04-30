import type { Market } from '../lib/config';

interface Props {
    market: Market;
    onClick: () => void;
}

export default function MarketCard({ market, onClick }: Props) {
    const formatDate = (ms: number) =>
        new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const formatVol = (v: number) =>
        v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v}`;

    return (
        <div className="market-card" onClick={onClick} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onClick()}>
            <div className="market-meta">
                <span className="market-id">Market #{market.id}</span>
                <span className={`market-status status-${market.status.toLowerCase()}`}>
                    {market.status === 'Active' ? '🟢 Active' : '🏁 Resolved'}
                </span>
            </div>

            <div className="market-question">{market.question}</div>

            <div className="market-prices">
                <div className="price-chip yes">
                    <div className="price-chip-label">YES</div>
                    <div className="price-chip-value">{market.yesPrice}¢</div>
                </div>
                <div className="price-chip no">
                    <div className="price-chip-label">NO</div>
                    <div className="price-chip-value">{market.noPrice}¢</div>
                </div>
            </div>

            <div className="probability-bar" style={{ marginBottom: 14 }}>
                <div className="probability-fill" style={{ width: `${market.yesPrice}%` }} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                <span>📅 {formatDate(market.resolutionTime)}</span>
                <span>📊 {formatVol(market.volume)}</span>
            </div>

            {market.status === 'Resolved' && market.outcome !== null && (
                <div style={{
                    marginTop: 12,
                    padding: '8px 12px',
                    borderRadius: 8,
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    background: market.outcome ? 'var(--yes-glow)' : 'var(--no-glow)',
                    color: market.outcome ? 'var(--yes-color)' : 'var(--no-color)',
                    border: `1px solid ${market.outcome ? 'rgba(34,211,238,0.3)' : 'rgba(244,63,94,0.3)'}`,
                }}>
                    {market.outcome ? '✅ YES won · Redeem YES tokens' : '❌ NO won · Redeem NO tokens'}
                </div>
            )}
        </div>
    );
}
