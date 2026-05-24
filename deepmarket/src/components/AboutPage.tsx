// AboutPage — what DeepMarket is, both products, what makes it different, and
// the on-chain addresses. Replaces the old spot-only blurb.

import { Link } from 'react-router-dom';
import {
    Layers,
    LineChart,
    Bot,
    Activity,
    BookOpen,
    MessageCircle,
    ArrowUpRight,
} from 'lucide-react';
import { CONFIG } from '../lib/config';

const SUISCAN = 'https://suiscan.xyz/testnet/object';
const short = (v?: string) => (v ? `${v.slice(0, 10)}…${v.slice(-6)}` : '—');

const FEATURES = [
    {
        icon: LineChart,
        title: 'Vol-surface pricing',
        desc: 'Every strike & expiry priced off a live SVI smile, not hand-set odds — real options market structure.',
    },
    {
        icon: Layers,
        title: 'LP vault (PLP)',
        desc: 'Supply dUSDC to take the other side of every trade and earn the premiums. On-chain economics anyone can audit.',
    },
    {
        icon: Bot,
        title: 'Autonomous agents',
        desc: 'An on-chain AgentCap caps daily spend and logs every decision; owner revocation is binding on-chain.',
    },
    {
        icon: Activity,
        title: 'Live analytics',
        desc: 'SVI smile viewer, BTC candles, per-oracle trade tape, settlement leaderboard, and manager PnL attribution.',
    },
    {
        icon: BookOpen,
        title: 'On-chain order books',
        desc: 'Spot YES/NO markets match on DeepBook V3 — real maker/taker CLOB, composable across Sui DeFi.',
    },
    {
        icon: MessageCircle,
        title: 'Telegram + chat',
        desc: 'Trade from a Telegram bot; per-market chat encrypted over Walrus + Seal with session-key auto-sign.',
    },
];

function ContractCard({
    title,
    rows,
    pkg,
}: {
    title: string;
    rows: [string, string | undefined][];
    pkg?: string;
}) {
    return (
        <div className="about-contracts">
            <div className="about-contracts-h">{title}</div>
            {rows.map(([k, v]) => (
                <a
                    key={k}
                    className="info-row about-contract-row"
                    href={v ? `${SUISCAN}/${v}` : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    <span className="info-row-key">{k}</span>
                    <span className="info-row-val mono" style={{ fontSize: '0.72rem' }}>
                        {short(v)}
                    </span>
                </a>
            ))}
            {pkg && (
                <a
                    href={`${SUISCAN}/${pkg}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost btn-sm"
                    style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                    View on SuiScan <ArrowUpRight size={13} />
                </a>
            )}
        </div>
    );
}

export default function AboutPage() {
    return (
        <div className="about-page">
            <div className="about-hero">
                <h1>About DeepMarket</h1>
                <p>
                    DeepMarket is a prediction-market protocol on Sui spanning two venues: peer-to-peer
                    YES/NO markets matched on DeepBook V3, and vol-surface-priced binary &amp; range
                    options on <strong>DeepBook Predict</strong> — with an LP vault, autonomous agents,
                    and live analytics on top.
                </p>
            </div>

            {/* Two products */}
            <div className="about-products">
                <div className="about-product">
                    <div className="about-product-tag">Spot markets</div>
                    <h3>Trade outcomes on any event</h3>
                    <p>
                        Create a market on anything. YES and NO outcome tokens trade against each
                        other on a DeepBook V3 order book — the mid-price is the crowd's implied
                        probability.
                    </p>
                    <Link to="/markets" className="about-product-link">
                        Browse markets <ArrowUpRight size={13} />
                    </Link>
                </div>
                <div className="about-product">
                    <div className="about-product-tag accent">DeepBook Predict</div>
                    <h3>Price every strike on a vol surface</h3>
                    <p>
                        Binary &amp; range options on rolling sub-hour BTC oracles, priced off a live
                        SVI smile. Take a view — or supply the vault and earn the premiums as the
                        house.
                    </p>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                        <Link to="/predict" className="about-product-link">
                            Open Predict <ArrowUpRight size={13} />
                        </Link>
                        <Link to="/vault" className="about-product-link">
                            Provide liquidity <ArrowUpRight size={13} />
                        </Link>
                    </div>
                </div>
            </div>

            {/* Feature grid */}
            <div className="about-features">
                {FEATURES.map((f) => (
                    <div className="about-feature" key={f.title}>
                        <f.icon size={18} className="about-feature-icon" />
                        <div className="about-feature-title">{f.title}</div>
                        <div className="about-feature-desc">{f.desc}</div>
                    </div>
                ))}
            </div>

            {/* Deployed contracts */}
            <div className="about-contracts-grid">
                <ContractCard
                    title="DeepMarket — spot markets"
                    pkg={CONFIG.PACKAGE_ID}
                    rows={[
                        ['Package', CONFIG.PACKAGE_ID],
                        ['YES TreasuryCap', CONFIG.YES_TREASURY_CAP],
                        ['NO TreasuryCap', CONFIG.NO_TREASURY_CAP],
                        ['Upgrade Cap', CONFIG.UPGRADE_CAP],
                    ]}
                />
                <ContractCard
                    title="DeepBook Predict — integration"
                    pkg={CONFIG.PREDICT_PACKAGE_ID}
                    rows={[
                        ['Predict package', CONFIG.PREDICT_PACKAGE_ID],
                        ['Predict object', CONFIG.PREDICT_OBJECT_ID],
                        ['dUSDC', CONFIG.PREDICT_DUSDC_TYPE?.split('::')[0]],
                        ['PLP (vault share)', CONFIG.PREDICT_PLP_TYPE?.split('::')[0]],
                    ]}
                />
            </div>

            <div className="about-links">
                <a href={CONFIG.DOCS_URL} target="_blank" rel="noopener noreferrer">
                    Docs <ArrowUpRight size={12} />
                </a>
                <a href={CONFIG.PREDICT_SERVER_URL} target="_blank" rel="noopener noreferrer">
                    Predict API <ArrowUpRight size={12} />
                </a>
            </div>
        </div>
    );
}
