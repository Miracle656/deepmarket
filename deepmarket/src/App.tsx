import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { ConnectButton, useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { Menu, X, BarChart3, TrendingUp, Info, Wallet } from 'lucide-react';
import { CONFIG, type Market } from './lib/config';
import { fetchRecentOutcomeMarkets, fetchOutcomeMarket } from './lib/outcome';
import { ToastProvider } from './lib/toast';
import { useMarkets } from './lib/useMarkets';
import CreateMarketModal from './components/CreateMarketModal';
import CreateOutcomeMarketModal from './components/CreateOutcomeMarketModal';
import OutcomeMarketDetailPage from './components/OutcomeMarketDetailPage';
import OutcomeMarketCard from './components/OutcomeMarketCard';
import ResolveMarketModal from './components/ResolveMarketModal';
import MarketDetailPage from './components/MarketDetailPage';
import LandingPage from './components/LandingPage';
import PortfolioPage from './components/PortfolioPage';
import PredictPage from './components/PredictPage';
import PredictDetailPage from './components/PredictDetailPage';
import AgentAuthorizePage from './components/AgentAuthorizePage';
import VaultView from './components/VaultView';
import LeaderboardPage from './components/LeaderboardPage';
import SurfaceStudio from './components/SurfaceStudio';
import OracleHealthPanel from './components/OracleHealthPanel';
import GlobalAgentFeed from './components/GlobalAgentFeed';
import AboutPage from './components/AboutPage';
import Sparkline from './components/Sparkline';
// rippleThemeToggle import removed — light mode is disabled in production.
// Re-add when the toggle button is uncommented in the nav.

type Filter = 'All' | 'Active' | 'Resolved';

// Header / drawer nav. Note "Agent" points to the live feed (/agents, plural),
// NOT the authorize page (/agent, singular) — the feed is the public showcase;
// authorizing an agent is reachable from a link on the feed itself.
const NAV_TABS = [
  { to: '/markets',     label: 'Markets'     },
  { to: '/predict',     label: 'Predict'     },
  { to: '/vault',       label: 'Vault'       },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/portfolio',   label: 'Portfolio'   },
  { to: '/agents',      label: 'Agent'       },
  { to: '/about',       label: 'About'       },
] as const;

import deepMarketLogo from './assets/deepmarket.png';

// Volume is cumulative QUOTE traded via DeepBook fills, in raw 1e9 SUI
// units (set by the indexer's OrderFilled handler). Render as SUI.
export function formatVol(rawQuote: number) {
  const sui = (rawQuote || 0) / 1e9;
  if (sui >= 1_000_000) return `${(sui / 1e6).toFixed(2)}M SUI`;
  if (sui >= 1_000) return `${(sui / 1e3).toFixed(1)}K SUI`;
  if (sui >= 1) return `${sui.toFixed(2)} SUI`;
  if (sui > 0) return `${sui.toFixed(4)} SUI`;
  return `0 SUI`;
}

function formatDate(ms: number) {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function AppInner() {
  const navigate = useNavigate();
  const acct = useCurrentAccount();
  const suiClient = useSuiClient();
  const { markets, isLoading, addMarket, resolveMarket } = useMarkets();

  // Multi-outcome markets are standalone shared objects (not in the indexer),
  // so we discover them client-side from their creation events.
  const [outcomeMarkets, setOutcomeMarkets] = useState<
    { objectId: string; question: string; n: number; status: number; vault: bigint }[]
  >([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await fetchRecentOutcomeMarkets(suiClient).catch(() => []);
      // Enrich each with status + vault so they count toward the stat strip.
      const enriched = await Promise.all(
        list.map(async (mm) => {
          const m = await fetchOutcomeMarket(suiClient, mm.objectId).catch(() => null);
          return { ...mm, status: m?.status ?? 0, vault: m?.vault ?? 0n };
        })
      );
      if (!cancelled) setOutcomeMarkets(enriched);
    })();
    return () => { cancelled = true; };
  }, [suiClient]);

  const [filter, setFilter] = useState<Filter>('All');
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateOutcome, setShowCreateOutcome] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Market | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Light mode is disabled in production — theme is hard-pinned to 'dark'.
  // We keep this as state so the prop signature for child components
  // (MarketDetailPage, PredictDetailPage) is unchanged, but no setter is
  // exposed.
  const [theme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const filtered = markets.filter(m => {
    if (filter === 'Active') return m.status === 'Active';
    if (filter === 'Resolved') return m.status === 'Resolved';
    return true;
  });

  // Totals fold in multi-outcome markets: their vault (raw 1e9 SUI) adds to
  // volume, and active (status 0) markets add to the counts.
  const outcomeVaultRaw = outcomeMarkets.reduce((s, o) => s + Number(o.vault), 0);
  const totalVol = markets.reduce((s, m) => s + m.volume, 0) + outcomeVaultRaw;
  const totalMarketCount = markets.length + outcomeMarkets.length;
  const activeCount =
    markets.filter(m => m.status === 'Active').length +
    outcomeMarkets.filter(o => o.status === 0).length;

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
          {(NAV_TABS).map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-tab ${isActive ? 'active' : ''}`}
            >
              {label}
            </NavLink>
          ))}
        </div>

        <div className="nav-right">
          {/*
            Light-mode toggle is hidden for now — the app is dark-mode-only
            in production. toggleTheme + theme state remain in case we
            re-enable later.
          <button
            onClick={toggleTheme}
            className="filter-btn"
            style={{ width: 34, height: 34, padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          */}
          <a
            href={CONFIG.DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="nav-tab"
            style={{ textDecoration: 'none' }}
            title="Open documentation"
          >
            Docs ↗
          </a>
          <div className="chain-badge">
            <div className="chain-dot" />
            Testnet
          </div>
          <span className="nav-connect-desktop">
            <ConnectButton className="dm-connect" />
          </span>
          <button
            className="nav-hamburger"
            aria-label="Open menu"
            onClick={() => setMobileMenuOpen(true)}
          >
            <Menu size={20} />
          </button>
        </div>
      </nav>

      {/* ─── Mobile drawer ─── */}
      {mobileMenuOpen && (
        <div
          className="mobile-drawer-overlay"
          onClick={() => setMobileMenuOpen(false)}
        >
          <aside
            className="mobile-drawer-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mobile-drawer-header">
              <span style={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
                DeepMarket
              </span>
              <button
                className="mobile-drawer-close"
                aria-label="Close menu"
                onClick={() => setMobileMenuOpen(false)}
              >
                <X size={20} />
              </button>
            </div>
            <nav className="mobile-drawer-nav">
              {(NAV_TABS).map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `mobile-drawer-link ${isActive ? 'active' : ''}`
                  }
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {label}
                </NavLink>
              ))}
              <a
                href={CONFIG.DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mobile-drawer-link"
                onClick={() => setMobileMenuOpen(false)}
              >
                Docs ↗
              </a>
            </nav>
            <div className="mobile-drawer-connect">
              <ConnectButton className="dm-connect" />
            </div>
          </aside>
        </div>
      )}

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
        <div style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', gap: 6 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              if (!acct) { alert('Connect wallet first'); return; }
              setShowCreateOutcome(true);
            }}
            title="Create a market with any number of outcomes (e.g. World Cup winner)"
          >
            + Multi-Outcome
          </button>
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
                    <div className="stat-cell-value">{totalMarketCount}</div>
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

                {/* Multi-outcome markets (standalone shared objects) */}
                {outcomeMarkets.length > 0 && (
                  <div style={{ marginBottom: 28 }}>
                    <div className="markets-header">
                      <span className="markets-title">Multi-Outcome Markets</span>
                    </div>
                    <div className="market-grid">
                      {outcomeMarkets.map(om => (
                        <OutcomeMarketCard
                          key={om.objectId}
                          objectId={om.objectId}
                          question={om.question}
                          n={om.n}
                        />
                      ))}
                    </div>
                  </div>
                )}

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
                      // Keyword-based category inference. Falls back to GENERAL
                      // when nothing matches so unclassified markets don't lie
                      // (the old default was CRYPTO — produced "CRYPTO" tags
                      // on sports / politics questions).
                      let tag = 'GENERAL';
                      const q = m.question.toLowerCase();
                      const has = (...keys: string[]) => keys.some(k => q.includes(k));
                      if (has('trump','biden','election','vote','impeach','president','senate','congress','parliament','tinubu','obama','prime minister')) tag = 'POLITICS';
                      else if (has('arsenal','chelsea','liverpool','manchester','barcelona','real madrid','uefa','champions league','world cup','premier league','football','soccer','fifa','nba','nfl','mlb','olympic','super bowl','formula 1',' f1 ','tennis','messi','ronaldo','haaland')) tag = 'SPORTS';
                      else if (has('bitcoin',' btc',' eth','ethereum',' sui ','solana',' sol ','doge','crypto','defi','halving',' etf','altcoin','stablecoin')) tag = 'CRYPTO';
                      else if (has('interest rate','fed ','fomc','stocks','s&p','sp500','nasdaq','recession','inflation',' gdp','unemployment','naira','currency')) tag = 'FINANCE';

                      // Pool status — markets registered with real DeepBook pools
                      // expose a non-zero yesPoolId. Skip-pools markets carry 0x0…0
                      // and can only be minted/redeemed (no order-book trading).
                      const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';
                      const hasPools = m.yesPoolId && m.yesPoolId !== ZERO;

                      return (
                        <div
                          key={m.id}
                          className="market-card"
                          onClick={() => navigate(`/markets/${m.objectId}`)}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <div className="market-card-tag">{tag}</div>
                            <div
                              className="market-card-tag"
                              title={hasPools
                                ? 'DeepBook YES/NO pools exist — limit orders, real CLOB matching.'
                                : 'No DeepBook pools — mint & redeem only (no order book on this market).'}
                              style={{
                                borderColor: hasPools ? 'var(--yes-border)' : 'var(--border-base)',
                                color: hasPools ? 'var(--yes)' : 'var(--text-muted)',
                                background: hasPools ? 'var(--yes-dim)' : 'transparent',
                              }}
                            >
                              {hasPools ? 'ORDER BOOK' : 'MINT ONLY'}
                            </div>
                          </div>
                          <div className="market-card-question">{m.question}</div>

                          <div className="market-card-spark">
                            <Sparkline marketId={m.id} current={m.yesPrice} />
                          </div>

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

            <Route path="/outcome/:marketId" element={<OutcomeMarketDetailPage />} />
            <Route path="/predict" element={<PredictPage />} />
            <Route path="/predict/:oracleId" element={<PredictDetailPage theme={theme} />} />
            <Route path="/vault" element={<VaultView />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/surface" element={<SurfaceStudio />} />
            <Route path="/health" element={<OracleHealthPanel />} />
            <Route path="/agents" element={<GlobalAgentFeed />} />
            <Route path="/portfolio" element={<PortfolioPage markets={markets} />} />
            <Route path="/agent" element={<AgentAuthorizePage />} />

            <Route path="/about" element={<AboutPage />} />
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
      {showCreateOutcome && (
        <CreateOutcomeMarketModal
          onCreated={(objectId) => {
            setShowCreateOutcome(false);
            if (objectId) navigate(`/outcome/${objectId}`);
          }}
          onClose={() => setShowCreateOutcome(false)}
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
