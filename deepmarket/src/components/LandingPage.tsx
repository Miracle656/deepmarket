import { useEffect, useRef, useState, useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ConnectButton } from '@mysten/dapp-kit';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ArrowRight, ExternalLink, Sun, Moon } from 'lucide-react';
import { useMarkets } from '../lib/useMarkets';
import { formatVol } from '../App';
import { rippleThemeToggle } from '../lib/themeToggle';
import deepMarketLogo from '../assets/sui-droplet.svg';
import HeroCandles3D from './HeroCandles3D';
import MarqueeRow from './MarqueeRow';
import HowItWorksHorizontal from './HowItWorksHorizontal';
import MagneticButton from './MagneticButton';
import InfrastructureStack3D, { type LayerSpec } from './InfrastructureStack3D';

// DeepBook brand assets
import assetInfinity  from '../assets/deepbookdes/Frame 2147260714.png';

gsap.registerPlugin(ScrollTrigger);

// ── fade-up variant for Framer Motion sections ──
const fadeUp = {
    hidden: { opacity: 0, y: 28 },
    show:   { opacity: 1, y: 0,  transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

// ── Infrastructure stack — layer codes + titles (bottom→top) ──
// Blue at the foundation, fading through cyan into rose at the agent layer —
// signals "deeper = lower-level infra, higher = closer to the user".
const INFRA_LAYERS: LayerSpec[] = [
    { color: '#1c6fff', edgeColor: '#4d9fff', code: 'L01', title: 'Sui + DeepBook V3' },
    { color: '#3a85ff', edgeColor: '#7ab4ff', code: 'L02', title: 'Spot YES/NO + DeepBook Predict' },
    { color: '#28b8d4', edgeColor: '#5cc8e2', code: 'L03', title: 'Stack Messaging + Walrus + Seal' },
    { color: '#ff4d6a', edgeColor: '#ff8095', code: 'L04', title: 'DeepMarket web app' },
    { color: '#ff7a92', edgeColor: '#ffadbb', code: 'L05', title: 'Telegram agent · auto trader' },
];

// ── Candle showcase metadata (one entry per candle, indices 0..8) ──
const CANDLE_META = [
    { tag: 'YES',  title: 'Decentralized Order Book',     desc: 'Real CLOB matching on Sui — no AMM curves, no slippage tricks.' },
    { tag: 'NO',   title: 'Outcome Tokens',               desc: 'Every market mints YES + NO tokens, backed 1:1 by SUI collateral.' },
    { tag: 'YES',  title: 'Permissionless Markets',       desc: 'Anyone can deploy a question. Token contracts compiled per market.' },
    { tag: 'NO',   title: 'Trade Both Sides',             desc: 'Long the consensus or fade it. Real bid/ask on both outcomes.' },
    { tag: 'YES',  title: 'On-Chain Resolution',          desc: 'Outcomes settled on-chain by oracle or admin. Verifiable, final.' },
    { tag: 'NO',   title: 'No Custodian',                 desc: 'Vault holds SUI. Winners burn tokens to redeem proportional payout.' },
    { tag: 'YES',  title: 'DeepBook V3 Composability',    desc: 'Built on the same primitives that power Sui DEX trading.' },
    { tag: 'NO',   title: 'Auditable End-to-End',         desc: 'Every order, position, and settlement is on-chain forever.' },
    { tag: 'YES',  title: 'Live On Sui Testnet',          desc: 'Real network, real transactions. Mainnet next.' },
] as const;

export default function LandingPage() {
    const navigate = useNavigate();
    const { markets } = useMarkets();

    const heroRef     = useRef<HTMLElement>(null);
    const visualRef   = useRef<HTMLDivElement>(null);
    const statsRef    = useRef<HTMLDivElement>(null);
    const featuresRef = useRef<HTMLElement>(null);

    const [activeCandle, setActiveCandle] = useState<number | null>(null);
    const handleActiveCandle = useCallback((idx: number | null) => setActiveCandle(idx), []);

    const [activeLayer, setActiveLayer] = useState<number | null>(null);
    const handleLayerHover = useCallback((idx: number | null) => setActiveLayer(idx), []);

    const [theme, setTheme] = useState<'dark' | 'light'>(
        () => (localStorage.getItem('dm-theme') as 'dark' | 'light') ?? 'dark'
    );

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('dm-theme', theme);
    }, [theme]);

    const activeCount = markets.filter(m => m.status === 'Active').length;
    const totalVol    = markets.reduce((s, m) => s + m.volume, 0);

    // ── GSAP: hero text sequential stagger ──
    useEffect(() => {
        const ctx = gsap.context(() => {
            gsap.timeline({ defaults: { ease: 'power3.out' } })
                .fromTo('.h-badge', { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.55 })
                .fromTo('.h-l1',    { y: 48, opacity: 0 }, { y: 0, opacity: 1, duration: 0.75 }, '-=0.25')
                .fromTo('.h-l2',    { y: 48, opacity: 0 }, { y: 0, opacity: 1, duration: 0.75 }, '-=0.55')
                .fromTo('.h-sub',   { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.55 }, '-=0.40')
                .fromTo('.h-ctas',  { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.50 }, '-=0.30');
        }, heroRef);
        return () => ctx.revert();
    }, []);

    // ── GSAP: hero visual slow float ──
    useEffect(() => {
        if (!visualRef.current) return;
        const tl = gsap.timeline({ repeat: -1, yoyo: true });
        tl.to(visualRef.current, { y: -22, duration: 3.8, ease: 'sine.inOut' });
        return () => { tl.kill(); };
    }, []);

    // ── GSAP: line-mask title reveals + parallax bg blobs (sasha-style) ──
    useEffect(() => {
        const ctx = gsap.context(() => {
            // Line-mask: animate every <span> inside .lp-mask-title from y:100% → y:0%
            document.querySelectorAll<HTMLElement>('.lp-mask-title').forEach(parent => {
                const lines = parent.querySelectorAll<HTMLElement>(':scope > span, :scope > div > span');
                gsap.fromTo(lines,
                    { yPercent: 105 },
                    {
                        yPercent: 0,
                        duration: 1.0,
                        ease: 'power4.out',
                        stagger: 0.08,
                        scrollTrigger: {
                            trigger: parent,
                            start: 'top 80%',
                            toggleActions: 'play none none reverse',
                        },
                    }
                );
            });

            // Parallax bg blobs: data-parallax-y = "30" → translateY 30% across viewport
            document.querySelectorAll<HTMLElement>('[data-parallax-y]').forEach(el => {
                const yPercent = Number(el.dataset.parallaxY ?? '20');
                gsap.to(el, {
                    yPercent,
                    ease: 'none',
                    scrollTrigger: {
                        trigger: el.closest('section') ?? el,
                        start: 'top bottom',
                        end: 'bottom top',
                        scrub: true,
                    },
                });
            });
        });
        return () => ctx.revert();
    }, []);

    // ── GSAP: stat counter on scroll ──
    useEffect(() => {
        if (!statsRef.current) return;
        const ctx = gsap.context(() => {
            document.querySelectorAll<HTMLElement>('[data-count]').forEach(el => {
                const target = parseFloat(el.dataset.count ?? '0');
                const isInt  = Number.isInteger(target);
                const proxy  = { val: 0 };
                ScrollTrigger.create({
                    trigger: el,
                    start: 'top 88%',
                    once: true,
                    onEnter: () => {
                        gsap.to(proxy, {
                            val: target,
                            duration: 1.8,
                            ease: 'power2.out',
                            onUpdate: () => {
                                el.textContent = isInt
                                    ? Math.round(proxy.val).toString()
                                    : proxy.val.toFixed(1);
                            },
                        });
                    },
                });
            });
        }, statsRef);
        return () => ctx.revert();
    }, [markets]);

    return (
        <div className="landing-root">

            {/* ══════════════════════ NAVBAR ══════════════════════ */}
            <nav className="landing-nav" style={{
                position: 'sticky', top: 0, zIndex: 200,
                height: 56,
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '0 32px',
                borderBottom: '1px solid var(--border-base)',
                backdropFilter: 'blur(20px)',
            }}>
                {/* Logo — click to go home */}
                <button
                    onClick={() => navigate('/')}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 800, fontSize: '1rem', letterSpacing: '-0.02em', color: 'var(--text-primary)', marginRight: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
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

                <div className="lp-nav-links">
                    <button
                        style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'inherit', padding: '6px 8px' }}
                        onClick={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' })}
                    >
                        How It Works
                    </button>
                    <button
                        style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'inherit', padding: '6px 8px' }}
                        onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}
                    >
                        Features
                    </button>
                </div>

                {/* Theme toggle */}
                <motion.button
                    onClick={(e) => rippleThemeToggle(e, theme, setTheme)}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    style={{
                        width: 34, height: 34, borderRadius: '50%',
                        background: 'var(--bg-hover)', border: '1px solid var(--border-base)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', color: 'var(--text-secondary)',
                    }}
                    title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                >
                    {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
                </motion.button>

                <ConnectButton />
                <motion.button
                    className="btn btn-primary btn-sm"
                    onClick={() => navigate('/markets')}
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.97 }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                    Enter App
                    <ArrowRight size={13} />
                </motion.button>
            </nav>

            {/* ══════════════════════ HERO ══════════════════════ */}
            <section ref={heroRef} style={{ position: 'relative' }}>
                {/* Background ghost asset */}
                <div style={{
                    position: 'absolute', top: '10%', left: '50%', transform: 'translateX(-50%)',
                    width: 700, height: 700,
                    backgroundImage: `url(${assetInfinity})`,
                    backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center',
                    opacity: 0.04, filter: 'blur(2px)', pointerEvents: 'none', mixBlendMode: 'screen',
                }} />

                <div className="lp-hero-inner">
                {/* Left column */}
                <div className="lp-hero-text">

                    {/* Logo mark in hero */}
                    <motion.div
                        className="h-badge lp-hero-badge-row"
                        style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5 }}
                    >
                        <div style={{
                            width: 56, height: 56,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0,
                        }}>
                            <img src={deepMarketLogo} alt="DeepMarket" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                        </div>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
                            padding: '5px 14px', borderRadius: 100,
                            background: 'var(--yes-dim)', border: '1px solid var(--yes-border)',
                            fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em',
                            color: 'var(--yes)', textTransform: 'uppercase',
                        }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--yes)', display: 'inline-block', animation: 'pulse-dot 2s infinite' }} />
                            Live on Sui Testnet · DeepBook V3
                        </div>
                    </motion.div>

                    <h1 style={{
                        fontSize: 'clamp(2.6rem, 5.5vw, 4.2rem)',
                        fontWeight: 900, lineHeight: 1.06, letterSpacing: '-0.035em',
                        marginBottom: 28,
                    }}>
                        <span className="h-l1" style={{ display: 'block', color: 'var(--text-primary)' }}>
                            Decentralized
                        </span>
                        <span className="h-l2" style={{
                            display: 'block',
                            background: 'linear-gradient(90deg, #4d9fff 0%, #1c6fff 40%, #a78bfa 100%)',
                            WebkitBackgroundClip: 'text',
                            WebkitTextFillColor: 'transparent',
                            backgroundClip: 'text',
                        }}>
                            Prediction Markets.
                        </span>
                    </h1>

                    <p className="h-sub" style={{
                        fontSize: 'clamp(0.95rem, 1.8vw, 1.08rem)',
                        color: 'var(--text-secondary)',
                        lineHeight: 1.8,
                        maxWidth: 480,
                        marginBottom: 40,
                    }}>
                        Trade YES and NO outcome tokens on real order books.
                        Every position is on-chain. Every outcome is verifiable.
                        Powered by <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Sui</strong> and{' '}
                        <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>DeepBook V3</strong>.
                    </p>

                    <div className="h-ctas lp-hero-ctas" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <motion.button
                            className="btn btn-primary"
                            style={{ fontSize: '0.95rem', padding: '11px 28px', display: 'flex', alignItems: 'center', gap: 8 }}
                            onClick={() => navigate('/markets')}
                            whileHover={{ scale: 1.04, boxShadow: '0 0 28px rgba(28,111,255,0.45)' }}
                            whileTap={{ scale: 0.97 }}
                        >
                            Explore Markets
                            <ArrowRight size={15} />
                        </motion.button>
                        <motion.a
                            href={`https://suiscan.xyz/testnet/object/${import.meta.env.VITE_PACKAGE_ID}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-ghost"
                            style={{ fontSize: '0.95rem', padding: '11px 24px', display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
                            whileHover={{ scale: 1.04 }}
                            whileTap={{ scale: 0.97 }}
                        >
                            View Contract
                            <ExternalLink size={13} />
                        </motion.a>
                    </div>
                </div>

                {/* Right column — hero visual: live three.js scene */}
                <div ref={visualRef} className="lp-hero-visual-wrap">
                    <div className="lp-hero-candles" style={{ width: '100%', maxWidth: 520, aspectRatio: '1 / 1', position: 'relative', background: 'transparent' }}>
                        <HeroCandles3D triggerRef={heroRef} onActiveIndexChange={handleActiveCandle} />
                        {/* Scroll showcase HUD — appears next to the focused candle */}
                        <AnimatePresence>
                            {activeCandle !== null && CANDLE_META[activeCandle] && (
                                <motion.div
                                    key={activeCandle}
                                    initial={{ opacity: 0, y: 12, scale: 0.95 }}
                                    animate={{ opacity: 1, y: 0,  scale: 1    }}
                                    exit={{    opacity: 0, y: -8, scale: 0.96 }}
                                    transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                                    style={{
                                        position: 'absolute',
                                        left: '50%', top: '6%',
                                        transform: 'translateX(-50%)',
                                        minWidth: 280, maxWidth: 360,
                                        padding: '14px 18px',
                                        background: 'rgba(10, 18, 32, 0.78)',
                                        backdropFilter: 'blur(14px)',
                                        WebkitBackdropFilter: 'blur(14px)',
                                        border: '1px solid rgba(28,111,255,0.28)',
                                        borderRadius: 12,
                                        boxShadow: '0 10px 40px rgba(0,0,0,0.45), 0 0 24px rgba(28,111,255,0.18)',
                                        pointerEvents: 'none',
                                        zIndex: 4,
                                    }}
                                >
                                    <div style={{
                                        display: 'inline-block',
                                        fontSize: '0.62rem', fontWeight: 800,
                                        letterSpacing: '0.14em',
                                        color: CANDLE_META[activeCandle].tag === 'YES' ? '#4d9fff' : '#ff7a92',
                                        background: CANDLE_META[activeCandle].tag === 'YES' ? 'rgba(28,111,255,0.18)' : 'rgba(255,77,106,0.16)',
                                        padding: '3px 9px',
                                        borderRadius: 6,
                                        marginBottom: 8,
                                    }}>
                                        {CANDLE_META[activeCandle].tag} · {String(activeCandle + 1).padStart(2, '0')}/09
                                    </div>
                                    <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
                                        {CANDLE_META[activeCandle].title}
                                    </div>
                                    <div style={{ fontSize: '0.82rem', lineHeight: 1.45, color: 'var(--text-muted)' }}>
                                        {CANDLE_META[activeCandle].desc}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>
                </div>{/* /lp-hero-inner */}
            </section>

            {/* ══════════════════════ STATS ══════════════════════ */}
            <div ref={statsRef} className="lp-stats-wrap">
                <div className="lp-stats-grid">
                    {[
                        { label: 'Active Markets',  num: activeCount,       suffix: '',  isCount: true },
                        { label: 'Total Volume',     num: null,              suffix: '',  display: formatVol(totalVol) },
                        { label: 'Total Markets',    num: markets.length,    suffix: '',  isCount: true },
                        { label: 'Avg Probability',  num: markets.length > 0 ? Math.round(markets.reduce((s, m) => s + m.yesPrice, 0) / markets.length) : 50, suffix: '%', isCount: true },
                    ].map((s, i) => (
                        <motion.div
                            key={i}
                            style={{
                                padding: '28px 24px',
                                textAlign: 'center',
                            }}
                            initial={{ opacity: 0, y: 16 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: i * 0.08, duration: 0.5 }}
                        >
                            <div style={{
                                fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase',
                                letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: 10,
                            }}>
                                {s.label}
                            </div>
                            <div style={{
                                fontFamily: "'Doto', monospace",
                                fontSize: '2.4rem', fontWeight: 900,
                                color: 'var(--text-primary)',
                                letterSpacing: '-0.02em',
                                lineHeight: 1,
                            }}>
                                {s.isCount ? (
                                    <span data-count={s.num}>{s.num}{s.suffix}</span>
                                ) : (
                                    <span>{s.display}</span>
                                )}
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>

            {/* ══════════════════════ MARQUEE ══════════════════════ */}
            <MarqueeRow />

            {/* ══════════════════════ HOW IT WORKS — horizontal scroll ══════════════════════ */}
            <HowItWorksHorizontal />

            {/* ══════════════════════ INFRASTRUCTURE — 3D layered stack ══════════════════════ */}
            <section
                id="features"
                ref={featuresRef}
                className="lp-section lp-infra-section"
                style={{ paddingTop: 56, paddingBottom: 56, position: 'relative', overflow: 'hidden' }}
            >
                {/* Parallax bg blobs */}
                <div
                    data-parallax-y="-25"
                    aria-hidden="true"
                    style={{
                        position: 'absolute', top: '-15%', right: '-10%',
                        width: 520, height: 520, borderRadius: '50%',
                        background: 'radial-gradient(circle, rgba(255,77,106,0.10) 0%, transparent 65%)',
                        filter: 'blur(80px)', pointerEvents: 'none', zIndex: 0,
                    }}
                />
                <div
                    data-parallax-y="20"
                    aria-hidden="true"
                    style={{
                        position: 'absolute', bottom: '-10%', left: '-12%',
                        width: 460, height: 460, borderRadius: '50%',
                        background: 'radial-gradient(circle, rgba(28,111,255,0.10) 0%, transparent 65%)',
                        filter: 'blur(90px)', pointerEvents: 'none', zIndex: 0,
                    }}
                />

                <div style={{ textAlign: 'center', marginBottom: 28, position: 'relative', zIndex: 1 }}>
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--no)', marginBottom: 10 }}>
                        Infrastructure
                    </div>
                    <h2 className="lp-mask-title" style={{ fontSize: 'clamp(1.9rem, 4.6vw, 3.4rem)', fontWeight: 900, letterSpacing: '-0.035em', color: 'var(--text-primary)', margin: 0 }}>
                        <span>Built Different</span>
                    </h2>
                </div>

                <div className="lp-infra-grid lp-infra-grid--canvas-only">
                    <div className="lp-infra-canvas lp-infra-canvas--wide">
                        <span className="lp-infra-canvas-corner tl" />
                        <span className="lp-infra-canvas-corner tr" />
                        <span className="lp-infra-canvas-corner bl" />
                        <span className="lp-infra-canvas-corner br" />
                        <InfrastructureStack3D
                            triggerRef={featuresRef}
                            layers={INFRA_LAYERS}
                            activeIndex={activeLayer}
                            onLayerHover={handleLayerHover}
                        />
                    </div>
                </div>
            </section>

            {/* ══════════════════════ CTA BANNER ══════════════════════ */}
            <section className="lp-section" style={{ paddingTop: 0 }}>
                <motion.div
                    className="lp-cta-inner"
                    initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.4 }}
                    variants={fadeUp}
                    style={{
                        background: 'linear-gradient(135deg, var(--bg-panel) 0%, rgba(28,111,255,0.09) 100%)',
                        border: '1px solid var(--yes-border)',
                        borderRadius: 'var(--radius-lg)',
                        padding: '64px 48px',
                        textAlign: 'center',
                        position: 'relative',
                        overflow: 'hidden',
                    }}
                >
                    {/* Central glow */}
                    <div style={{
                        position: 'absolute', top: -80, left: '50%', transform: 'translateX(-50%)',
                        width: 600, height: 280,
                        background: 'radial-gradient(ellipse, rgba(28,111,255,0.14) 0%, transparent 70%)',
                        pointerEvents: 'none',
                    }} />
                    {/* Logo + floating brand asset */}
                    <div className="lp-cta-deco" style={{
                        position: 'absolute', right: 40, top: '50%', transform: 'translateY(-50%)',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, opacity: 0.18,
                    }}>
                        <div style={{ width: 64, height: 64 }}>
                            <img src={deepMarketLogo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                        </div>
                        <img src={assetInfinity} alt="" style={{ width: 80, mixBlendMode: 'screen' }} />
                    </div>

                    <h2 className="lp-mask-title" style={{
                        fontSize: 'clamp(2rem, 5vw, 3.5rem)',
                        fontWeight: 900, letterSpacing: '-0.035em',
                        color: 'var(--text-primary)', marginBottom: 16,
                        position: 'relative',
                        lineHeight: 1.05,
                    }}>
                        <div><span>Ready to make</span></div>
                        <div><span>your first prediction?</span></div>
                    </h2>
                    <p style={{ fontSize: '0.92rem', color: 'var(--text-secondary)', marginBottom: 36, position: 'relative' }}>
                        Connect your Sui wallet and start trading outcome tokens on live markets.
                    </p>
                    <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', position: 'relative' }}>
                        <MagneticButton strength={28}>
                            <motion.button
                                className="btn btn-primary"
                                style={{ fontSize: '0.95rem', padding: '14px 36px', display: 'flex', alignItems: 'center', gap: 8 }}
                                onClick={() => navigate('/markets')}
                                whileHover={{ boxShadow: '0 0 40px rgba(28,111,255,0.55)' }}
                                whileTap={{ scale: 0.97 }}
                            >
                                Open Markets
                                <ArrowRight size={15} />
                            </motion.button>
                        </MagneticButton>
                        <motion.a
                            href={`https://suiscan.xyz/testnet/object/${import.meta.env.VITE_PACKAGE_ID}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-ghost"
                            style={{ fontSize: '0.95rem', padding: '11px 24px', display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
                            whileHover={{ scale: 1.04 }}
                            whileTap={{ scale: 0.97 }}
                        >
                            View on SuiScan
                            <ExternalLink size={13} />
                        </motion.a>
                    </div>
                </motion.div>
            </section>

            {/* ══════════════════════ FOOTER ══════════════════════ */}
            <footer style={{
                borderTop: '1px solid var(--border-base)',
                padding: '24px 32px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                        width: 28, height: 28,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        <img src={deepMarketLogo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    </div>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 600 }}>DeepMarket</span>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>· Built on Sui Testnet</span>
                </div>
                <div style={{ display: 'flex', gap: 24, fontSize: '0.78rem' }}>
                    {[
                        { label: 'Markets',     action: () => navigate('/markets') },
                        { label: 'Portfolio',   action: () => navigate('/portfolio') },
                        { label: 'About',       action: () => navigate('/about') },
                    ].map(({ label, action }) => (
                        <button
                            key={label}
                            onClick={action}
                            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', padding: 0 }}
                        >
                            {label}
                        </button>
                    ))}
                    <a href="https://suiscan.xyz/testnet" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>
                        SuiScan ↗
                    </a>
                </div>
            </footer>
        </div>
    );
}
