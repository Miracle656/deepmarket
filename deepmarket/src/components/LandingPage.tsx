import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ConnectButton } from '@mysten/dapp-kit';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ArrowRight, ExternalLink, Sun, Moon } from 'lucide-react';
import { useMarkets } from '../lib/useMarkets';
import { formatVol } from '../App';
import { rippleThemeToggle } from '../lib/themeToggle';
import deepMarketLogo from '../assets/deepmarket.png';

// DeepBook brand assets
import assetInfinity  from '../assets/deepbookdes/Frame 2147260714.png';
import assetCross     from '../assets/deepbookdes/Frame 2147260716.png';
import assetDB        from '../assets/deepbookdes/Frame 2147260717.png';
import assetCoin      from '../assets/deepbookdes/Frame 2147260718.png';
import assetCube      from '../assets/deepbookdes/Frame 2147260719.png';
import assetStack     from '../assets/deepbookdes/Frame 2147260729.png';
import assetSignal    from '../assets/deepbookdes/Frame 2147260730.png';

gsap.registerPlugin(ScrollTrigger);

// ── fade-up variant for Framer Motion sections ──
const fadeUp = {
    hidden: { opacity: 0, y: 28 },
    show:   { opacity: 1, y: 0,  transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

const stagger = {
    hidden: {},
    show:   { transition: { staggerChildren: 0.12 } },
};

// ── Features data ──
const FEATURES = [
    {
        img: assetStack,
        title: 'DeepBook V3 Order Books',
        desc: "Real limit & market orders matched on-chain. Native CLOB DEX — no AMM curves, no slippage games.",
    },
    {
        img: assetCoin,
        title: 'YES / NO Outcome Tokens',
        desc: 'Every market mints two tradeable tokens backed 1:1 by SUI collateral locked in an on-chain vault.',
    },
    {
        img: assetCube,
        title: 'On-Chain Resolution',
        desc: 'Outcomes are written immutably to Sui. No backend, no middleman — oracle or admin resolves on-chain.',
    },
    {
        img: assetCross,
        title: 'Permissionless Creation',
        desc: 'Anyone can deploy a prediction market. Token contracts are compiled and published per market.',
    },
];

// ── Steps data ──
const STEPS = [
    { n: '01', img: assetSignal, label: 'Create', desc: 'Deploy a market question. Token contracts are compiled & published to Sui in 3 transactions.' },
    { n: '02', img: assetCross,  label: 'Trade',  desc: "Buy YES or NO tokens on the DeepBook order book. Price discovers the market's probability." },
    { n: '03', img: assetCoin,   label: 'Resolve', desc: 'When the event settles, an oracle or admin resolves the outcome on-chain.' },
    { n: '04', img: assetStack,  label: 'Redeem',  desc: 'Winners burn tokens and claim proportional SUI from the vault.' },
];

export default function LandingPage() {
    const navigate = useNavigate();
    const { markets } = useMarkets();

    const heroRef     = useRef<HTMLDivElement>(null);
    const visualRef   = useRef<HTMLImageElement>(null);
    const statsRef    = useRef<HTMLDivElement>(null);

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
                        width: 36, height: 36, borderRadius: 8,
                        background: '#ffffff',
                        padding: 3,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                        boxShadow: '0 0 0 1px rgba(28,111,255,0.2), 0 2px 8px rgba(28,111,255,0.15)',
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
                            width: 56, height: 56, borderRadius: 14,
                            background: '#ffffff',
                            padding: 5,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: '0 0 0 1px rgba(28,111,255,0.25), 0 4px 20px rgba(28,111,255,0.2)',
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

                {/* Right column — hero visual */}
                <motion.div
                    className="lp-hero-visual-wrap"
                    initial={{ opacity: 0, scale: 0.82 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.9, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
                >
                    {/* Glow behind asset */}
                    <div style={{
                        position: 'absolute', inset: -60,
                        background: 'radial-gradient(ellipse at center, rgba(28,111,255,0.22) 0%, transparent 68%)',
                        pointerEvents: 'none',
                    }} />
                    <img
                        ref={visualRef}
                        src={assetDB}
                        alt="DeepBook"
                        style={{
                            width: 380, height: 380,
                            objectFit: 'contain',
                            mixBlendMode: 'screen',
                            position: 'relative',
                            filter: 'brightness(1.1)',
                        }}
                    />
                    {/* Floating mini-assets */}
                    <motion.img
                        src={assetSignal}
                        style={{ position: 'absolute', top: 20, right: -24, width: 72, mixBlendMode: 'screen', opacity: 0.75 }}
                        animate={{ y: [0, -10, 0], rotate: [0, 4, 0] }}
                        transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
                    />
                    <motion.img
                        src={assetStack}
                        style={{ position: 'absolute', bottom: 16, left: -28, width: 64, mixBlendMode: 'screen', opacity: 0.65 }}
                        animate={{ y: [0, 10, 0], rotate: [0, -5, 0] }}
                        transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut', delay: 0.8 }}
                    />
                </motion.div>
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

            {/* ══════════════════════ HOW IT WORKS ══════════════════════ */}
            <section id="how-it-works" className="lp-section">
                <motion.div
                    style={{ textAlign: 'center', marginBottom: 64 }}
                    initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.5 }}
                    variants={fadeUp}
                >
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--yes)', marginBottom: 14 }}>
                        Protocol
                    </div>
                    <h2 style={{ fontSize: 'clamp(1.7rem, 3.5vw, 2.4rem)', fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--text-primary)' }}>
                        How It Works
                    </h2>
                </motion.div>

                <motion.div
                    style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 16 }}
                    initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.2 }}
                    variants={stagger}
                >
                    {STEPS.map((s, i) => (
                        <motion.div
                            key={i}
                            variants={fadeUp}
                            whileHover={{ y: -4, borderColor: 'var(--yes-border)' }}
                            style={{
                                background: 'var(--bg-panel)',
                                border: '1px solid var(--border-base)',
                                borderRadius: 'var(--radius)',
                                padding: '28px 24px',
                                position: 'relative',
                                overflow: 'hidden',
                                transition: 'border-color 0.15s',
                            }}
                        >
                            {/* Step number watermark */}
                            <div style={{
                                fontFamily: "'Doto', monospace",
                                fontSize: '5rem', fontWeight: 900,
                                color: 'rgba(28,111,255,0.06)',
                                position: 'absolute', top: -8, right: 12,
                                lineHeight: 1, userSelect: 'none', pointerEvents: 'none',
                            }}>
                                {s.n}
                            </div>

                            {/* Brand asset icon */}
                            <div style={{ width: 52, height: 52, marginBottom: 18, position: 'relative' }}>
                                <img src={s.img} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', mixBlendMode: 'screen' }} />
                            </div>

                            <div style={{ fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--yes)', marginBottom: 10 }}>
                                {s.label}
                            </div>
                            <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: 1.72 }}>
                                {s.desc}
                            </p>
                        </motion.div>
                    ))}
                </motion.div>
            </section>

            {/* ══════════════════════ FEATURES ══════════════════════ */}
            <section id="features" className="lp-section" style={{ paddingTop: 0 }}>
                <motion.div
                    style={{ textAlign: 'center', marginBottom: 64 }}
                    initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.5 }}
                    variants={fadeUp}
                >
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--no)', marginBottom: 14 }}>
                        Infrastructure
                    </div>
                    <h2 style={{ fontSize: 'clamp(1.7rem, 3.5vw, 2.4rem)', fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--text-primary)' }}>
                        Built Different
                    </h2>
                </motion.div>

                <motion.div
                    style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}
                    initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.15 }}
                    variants={stagger}
                >
                    {FEATURES.map((f, i) => (
                        <motion.div
                            key={i}
                            variants={fadeUp}
                            whileHover={{ y: -5 }}
                            style={{
                                background: 'var(--bg-panel)',
                                border: '1px solid var(--border-base)',
                                borderRadius: 'var(--radius)',
                                padding: '32px 28px',
                                position: 'relative',
                                overflow: 'hidden',
                            }}
                        >
                            {/* Subtle glow on hover area */}
                            <div style={{
                                position: 'absolute', top: -40, right: -40,
                                width: 160, height: 160,
                                background: 'radial-gradient(ellipse, rgba(28,111,255,0.06) 0%, transparent 70%)',
                                pointerEvents: 'none',
                            }} />

                            <div style={{ width: 60, height: 60, marginBottom: 20 }}>
                                <img src={f.img} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', mixBlendMode: 'screen' }} />
                            </div>
                            <div style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--text-primary)', marginBottom: 10, letterSpacing: '-0.01em' }}>
                                {f.title}
                            </div>
                            <p style={{ fontSize: '0.83rem', color: 'var(--text-secondary)', lineHeight: 1.72 }}>
                                {f.desc}
                            </p>
                        </motion.div>
                    ))}
                </motion.div>
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
                        <div style={{ width: 64, height: 64, borderRadius: 16, background: '#fff', padding: 6 }}>
                            <img src={deepMarketLogo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                        </div>
                        <img src={assetInfinity} alt="" style={{ width: 80, mixBlendMode: 'screen' }} />
                    </div>

                    <h2 style={{
                        fontSize: 'clamp(1.5rem, 3vw, 2rem)',
                        fontWeight: 800, letterSpacing: '-0.025em',
                        color: 'var(--text-primary)', marginBottom: 16,
                        position: 'relative',
                    }}>
                        Ready to make your first prediction?
                    </h2>
                    <p style={{ fontSize: '0.92rem', color: 'var(--text-secondary)', marginBottom: 36, position: 'relative' }}>
                        Connect your Sui wallet and start trading outcome tokens on live markets.
                    </p>
                    <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', position: 'relative' }}>
                        <motion.button
                            className="btn btn-primary"
                            style={{ fontSize: '0.95rem', padding: '11px 32px', display: 'flex', alignItems: 'center', gap: 8 }}
                            onClick={() => navigate('/markets')}
                            whileHover={{ scale: 1.05, boxShadow: '0 0 32px rgba(28,111,255,0.5)' }}
                            whileTap={{ scale: 0.97 }}
                        >
                            Open Markets
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
                        width: 28, height: 28, borderRadius: 6, background: '#fff',
                        padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        boxShadow: '0 0 0 1px rgba(28,111,255,0.15)',
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
