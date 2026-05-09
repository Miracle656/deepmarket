import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';
import { Sun, Moon, BarChart3, TrendingUp, Info, Wallet } from 'lucide-react';
import { CONFIG, type Market } from './lib/config';
import { ToastProvider } from './lib/toast';
import { useMarkets } from './lib/useMarkets';
import CreateMarketModal from './components/CreateMarketModal';
import ResolveMarketModal from './components/ResolveMarketModal';
import MarketDetailPage from './components/MarketDetailPage';
import LandingPage from './components/LandingPage';
import PortfolioPage from './components/PortfolioPage';
import PredictPage from './components/PredictPage';
import PredictDetailPage from './components/PredictDetailPage';
import { rippleThemeToggle } from './lib/themeToggle';

type Filter = 'All' | 'Active' | 'Resolved';

import deepMarketLogo from './assets/deepmarket.png';

export function formatVol(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v}`;
}

function formatDate(ms: number) {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function AppInner() {
  const navigate = useNavigate();
  const acct = useCurrentAccount();
  const { markets, isLoading, addMarket, resolveMarket } = useMarkets();

  const [filter, setFilter] = useState<Filter>('All');
  const [showCreate, setShowCreate] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Market | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('dm-theme') as 'dark' | 'light') ?? 'dark'
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('dm-theme', theme);
  }, [theme]);

  const toggleTheme = (e: React.MouseEvent<HTMLButtonElement>) =>
    rippleThemeToggle(e, theme, setTheme);

  const filtered = markets.filter(m => {
    if (filter === 'Active') return m.status === 'Active';
    if (filter === 'Resolved') return m.status === 'Resolved';
    return true;
  });

  const totalVol = markets.reduce((s, m) => s + m.volume, 0);
  const activeCount = markets.filter(m => m.status === 'Active').length;

  return (
    <div className="app">
      {/* ─── Navbar ─── */}
      <nav className="navbar">
        <button
          className="nav-brand"
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
          onClick={() => navigate('/')}
        >
          <div style={{
            width: 36, height: 36,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <img src={deepMarketLogo} alt="DeepMarket" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
          DeepMarket
        </button>

        <div className="nav-tabs">
          {(['markets', 'predict', 'portfolio', 'about'] as const).map(t => (
            <NavLink
              key={t}
              to={`/${t}`}
              className={({ isActive }) => `nav-tab ${isActive ? 'active' : ''}`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </NavLink>
          ))}
        </div>

        <div className="nav-right">
          <button
            onClick={toggleTheme}
            className="filter-btn"
            style={{ width: 34, height: 34, padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <div className="chain-badge">
            <div className="chain-dot" />
            Testnet
          </div>
          <ConnectButton />
        </div>
      </nav>

      {/* ─── Ticker bar ─── */}
      <div className="ticker-bar">
        {markets.filter(m => m.status === 'Active').slice(0, 5).map(m => (
          <div
            key={m.id}
            className="ticker-item"
            onClick={() => navigate(`/markets/${m.objectId}`)}
          >
            <span className="ticker-question">{m.question}</span>
            <span className="ticker-prob">{m.yesPrice}%</span>
          </div>
        ))}
        <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              if (!acct) { alert('Connect wallet first'); return; }
              setShowCreate(true);
            }}
          >
            + New Market
          </button>
        </div>
      </div>

      {/* ─── Main split layout ─── */}
      <div className="main-layout">
        {/* LEFT: content */}
        <div className="content-area">

          <Routes>
            <Route path="/markets" element={
              <>
                {/* Stats strip */}
                <div className="stat-strip">
                  <div className="stat-cell">
                    <div className="stat-cell-label">Total Markets</div>
                    <div className="stat-cell-value">{markets.length}</div>
                  </div>
                  <div className="stat-cell">
                    <div className="stat-cell-label">Active</div>
                    <div className="stat-cell-value" style={{ color: 'var(--yes)' }}>{activeCount}</div>
                  </div>
                  <div className="stat-cell">
                    <div className="stat-cell-label">Total Volume</div>
                    <div className="stat-cell-value">{formatVol(totalVol)}</div>
                  </div>
                  <div className="stat-cell">
                    <div className="stat-cell-label">Network</div>
                    <div className="stat-cell-value" style={{ color: 'var(--blue)' }}>Sui Testnet</div>
                  </div>
                </div>

                {/* Market list only — no selected detail here */}
                <div>
                  <div className="markets-header">
                    <span className="markets-title">All Markets</span>
                    <div className="markets-filters">
                      {(['All', 'Active', 'Resolved'] as Filter[]).map(f => (
                        <button key={f} className={`filter-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
                      ))}
                    </div>
                  </div>

                  <div className="market-grid">
                    {filtered.length === 0 && !isLoading && (
                      <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                        <div className="empty-icon"><BarChart3 size={48} strokeWidth={1} style={{ opacity: 0.8 }} /></div>
                        <div className="empty-title">No markets</div>
                      </div>
                    )}
                    {isLoading && (
                      <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                        <div className="empty-icon" style={{ opacity: 0.4 }}><BarChart3 size={48} strokeWidth={1} /></div>
                        <div className="empty-title">Loading markets…</div>
                      </div>
                    )}
                    {filtered.map(m => {
                      // Very basic pseudo-category inference from question
                      let tag = 'CRYPTO';
                      const q = m.question.toLowerCase();
                      if (q.includes('trump') || q.includes('election') || q.includes('vote') || q.includes('impeach')) tag = 'POLITICS';
                      else if (q.includes('football') || q.includes('premier league') || q.includes('messi') || q.includes('ronaldo')) tag = 'SPORTS';
                      else if (q.includes('interest rate') || q.includes('fed') || q.includes('stocks')) tag = 'FINANCE';

                      return (
                        <div
                          key={m.id}
                          className="market-card"
                          onClick={() => navigate(`/markets/${m.objectId}`)}
                        >
                          <div className="market-card-tag">{tag}</div>
                          <div className="market-card-question">{m.question}</div>

                          <div className="market-card-prices">
                            <div className="market-card-btn yes">
                              <span>YES</span>
                              <span className="price">{m.yesPrice}¢</span>
                            </div>
                            <div className="market-card-btn no">
                              <span>NO</span>
                              <span className="price">{m.noPrice}¢</span>
                            </div>
                          </div>

                          <div className="market-card-bar-bg">
                            <div className="market-card-bar-fill" style={{ width: `${m.yesPrice}%` }} />
                          </div>

                          <div className="market-card-footer">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span>Vol. {formatVol(m.volume)}</span>
                            </div>
                            <div>
                              {m.status === 'Resolved' ? (
                                <span style={{ color: m.outcome ? 'var(--yes)' : 'var(--no)' }}>
                                  {m.outcome ? 'YES Won' : 'NO Won'}
                                </span>
                              ) : (
                                <span>Closes {formatDate(m.resolutionTime)}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            } />

            <Route path="/markets/:marketId" element={
              <MarketDetailPage
                markets={markets}
                theme={theme}
                onResolve={(m) => setResolveTarget(m)}
              />
            } />

            <Route path="/predict" element={<PredictPage />} />
            <Route path="/predict/:oracleId" element={<PredictDetailPage />} />
            <Route path="/portfolio" element={<PortfolioPage markets={markets} />} />

            <Route path="/about" element={
              <div style={{ maxWidth: 680, padding: '20px 0' }}>
                <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: 16 }}>About DeepMarket</h2>
                <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: 16 }}>
                  DeepMarket is a decentralized prediction market protocol built on Sui, using DeepBook V3 as the matching engine.
                  Each market has YES and NO outcome tokens that trade against each other — price discovery reflects implied probability.
                </p>
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-base)', borderRadius: 12, padding: '20px', marginBottom: 16 }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Deployed Contracts</div>
                  {[
                    ['Package', CONFIG.PACKAGE_ID],
                    ['YES TreasuryCap', CONFIG.YES_TREASURY_CAP],
                    ['NO TreasuryCap', CONFIG.NO_TREASURY_CAP],
                    ['Upgrade Cap', CONFIG.UPGRADE_CAP],
                  ].map(([k, v]) => (
                    <div className="info-row" key={k}>
                      <span className="info-row-key">{k}</span>
                      <span className="info-row-val mono" style={{ fontSize: '0.72rem' }}>{v?.slice(0, 12)}…{v?.slice(-6)}</span>
                    </div>
                  ))}
                  <div style={{ marginTop: 12 }}>
                    <a
                      href={`https://suiscan.xyz/testnet/object/${CONFIG.PACKAGE_ID}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-primary btn-sm"
                    >
                      View on SuiScan ↗
                    </a>
                  </div>
                </div>
              </div>
            } />
            <Route path="*" element={<Navigate to="/markets" replace />} />
          </Routes>
        </div>
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateMarketModal
          onCreated={(q, rt, o) => {
            addMarket(q, rt, o);
            setShowCreate(false);
          }}
          onClose={() => setShowCreate(false)}
        />
      )}
      {/* Mobile bottom navigation */}
      <nav className="bottom-nav">
        {([
          { to: '/markets',   Icon: TrendingUp, label: 'Markets'   },
          { to: '/portfolio', Icon: Wallet,     label: 'Portfolio' },
          { to: '/about',     Icon: Info,       label: 'About'     },
        ] as const).map(({ to, Icon, label }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `bottom-nav-item ${isActive ? 'active' : ''}`}>
            <Icon size={18} strokeWidth={1.8} />
            {label}
          </NavLink>
        ))}
      </nav>

      {resolveTarget && (
        <ResolveMarketModal
          market={resolveTarget}
          onClose={() => setResolveTarget(null)}
          onResolved={(id, outcome) => resolveMarket(id, outcome)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/*" element={<AppInner />} />
      </Routes>
    </ToastProvider>
  );
}
