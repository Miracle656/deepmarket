import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ArrowRight, CheckCircle2 } from 'lucide-react';

import assetSignal from '../assets/deepbookdes/Frame 2147260730.png';
import assetCross  from '../assets/deepbookdes/Frame 2147260716.png';
import assetCoin   from '../assets/deepbookdes/Frame 2147260718.png';
import assetStack  from '../assets/deepbookdes/Frame 2147260729.png';

gsap.registerPlugin(ScrollTrigger);

type Phase = {
    id: string;
    title: string;
    subtitle: string;
    description: string;
    bullets: string[];
    accent: 'yes' | 'no';
    img: string;
};

const PHASES: Phase[] = [
    {
        id: '01',
        title: 'CREATE',
        subtitle: 'Deploy a Question',
        description: 'Anyone can mint a prediction market on-chain. Token contracts compile and publish in three transactions.',
        bullets: ['Custom YES/NO tokens', 'Per-market vault', 'Permissionless'],
        accent: 'yes',
        img: assetSignal,
    },
    {
        id: '02',
        title: 'TRADE',
        subtitle: 'Real Order Books',
        description: 'YES and NO tokens trade on DeepBook V3 spot pools. Limit orders, market orders, sub-second matching.',
        bullets: ['DeepBook CLOB', 'No AMM curves', 'On-chain matching'],
        accent: 'no',
        img: assetCross,
    },
    {
        id: '03',
        title: 'RESOLVE',
        subtitle: 'On-Chain Outcome',
        description: 'When the event settles, an oracle or admin writes the outcome to Sui. Immutable, verifiable, final.',
        bullets: ['Oracle or admin', 'Immutable record', 'Sui-native'],
        accent: 'yes',
        img: assetCoin,
    },
    {
        id: '04',
        title: 'REDEEM',
        subtitle: 'Burn for Payout',
        description: 'Winners burn outcome tokens to claim proportional SUI from the vault. No custodian, no waiting.',
        bullets: ['Proportional payout', 'Self-service', 'Burn to claim'],
        accent: 'no',
        img: assetStack,
    },
];

export default function HowItWorksHorizontal() {
    const sectionRef = useRef<HTMLElement>(null);
    const trackRef   = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const section = sectionRef.current;
        const track   = trackRef.current;
        if (!section || !track) return;

        // Skip horizontal pin on mobile/tablet; CSS falls back to vertical stack
        const mq = window.matchMedia('(max-width: 900px)');
        if (mq.matches) return;

        const ctx = gsap.context(() => {
            // Total horizontal travel = (N-1) viewport widths
            const N = PHASES.length;
            const horizontalTween = gsap.fromTo(track,
                { x: 0 },
                {
                    x: () => `-${(N - 1) * 100}vw`,
                    ease: 'none',
                    scrollTrigger: {
                        trigger: section,
                        start: 'top top',
                        end:   () => `+=${(N - 1) * window.innerHeight * 1.0}`,
                        pin: true,
                        scrub: 1,
                        snap: {
                            snapTo: 1 / (N - 1),
                            duration: { min: 0.2, max: 0.5 },
                            ease: 'power1.inOut',
                        },
                        anticipatePin: 1,
                        invalidateOnRefresh: true,
                    },
                }
            );

            // Reveal each panel's content as it enters the viewport (containerAnimation)
            PHASES.forEach((_, i) => {
                const panel = track.querySelector(`[data-panel="${i}"]`) as HTMLElement | null;
                if (!panel) return;
                gsap.fromTo(panel.querySelectorAll('[data-reveal]'),
                    { y: 50, opacity: 0 },
                    {
                        y: 0,
                        opacity: 1,
                        duration: 0.6,
                        stagger: 0.08,
                        ease: 'power3.out',
                        scrollTrigger: {
                            trigger: panel,
                            containerAnimation: horizontalTween,
                            start: 'left 80%',
                            end: 'left 30%',
                            toggleActions: 'play none none reverse',
                        },
                    }
                );
            });
        }, sectionRef);

        return () => ctx.revert();
    }, []);

    return (
        <section
            ref={sectionRef}
            id="how-it-works"
            aria-label="How DeepMarket works"
            className="lp-hiw-section"
            style={{
                position: 'relative',
                overflow: 'hidden',
            }}
        >
            <div
                ref={trackRef}
                className="lp-hiw-track"
                style={{
                    width: `${PHASES.length * 100}vw`,
                    willChange: 'transform',
                }}
            >
                {PHASES.map((p, i) => {
                    const accent  = p.accent === 'yes' ? 'var(--yes)' : 'var(--no)';
                    const accentFx = p.accent === 'yes' ? 'rgba(28,111,255,0.18)' : 'rgba(255,77,106,0.16)';
                    return (
                        <div
                            key={p.id}
                            data-panel={i}
                            className="lp-hiw-panel"
                            style={{
                                width: '100vw',
                                height: '100vh',
                                flexShrink: 0,
                                position: 'relative',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: '0 6vw',
                                background: i % 2 === 0
                                    ? 'linear-gradient(135deg, rgba(6,12,23,0.95) 0%, rgba(10,22,40,0.92) 100%)'
                                    : 'linear-gradient(135deg, rgba(10,16,28,0.95) 0%, rgba(18,8,18,0.92) 100%)',
                                borderRight: i < PHASES.length - 1 ? '1px solid var(--border-base)' : 'none',
                                overflow: 'hidden',
                            }}
                        >
                            {/* Giant background number */}
                            <div
                                aria-hidden="true"
                                style={{
                                    position: 'absolute',
                                    right: '-2vw',
                                    bottom: '-8vh',
                                    fontFamily: "'Doto', monospace",
                                    fontSize: '38vw',
                                    fontWeight: 900,
                                    color: accent,
                                    opacity: 0.07,
                                    lineHeight: 1,
                                    userSelect: 'none',
                                    pointerEvents: 'none',
                                }}
                            >
                                {p.id}
                            </div>

                            {/* Soft accent glow blob */}
                            <div
                                aria-hidden="true"
                                style={{
                                    position: 'absolute',
                                    top: '12%',
                                    left: i % 2 === 0 ? '-12%' : 'auto',
                                    right: i % 2 === 0 ? 'auto' : '-12%',
                                    width: 520, height: 520,
                                    borderRadius: '50%',
                                    background: `radial-gradient(circle, ${accentFx} 0%, transparent 70%)`,
                                    filter: 'blur(80px)',
                                    pointerEvents: 'none',
                                }}
                            />

                            {/* Content grid */}
                            <div className="lp-hiw-grid" style={{
                                position: 'relative', zIndex: 2,
                                width: '100%', maxWidth: 1200,
                                display: 'grid',
                                gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)',
                                gap: '5vw',
                                alignItems: 'center',
                            }}>
                                {/* Left: title + description */}
                                <div>
                                    <div data-reveal style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 14,
                                        marginBottom: 28,
                                    }}>
                                        <div style={{
                                            height: 1, width: 56,
                                            background: accent, opacity: 0.6,
                                        }} />
                                        <span style={{
                                            fontFamily: "'Doto', monospace",
                                            fontSize: '0.78rem', fontWeight: 700,
                                            letterSpacing: '0.18em',
                                            color: accent,
                                            textTransform: 'uppercase',
                                        }}>
                                            Phase {p.id} of 04
                                        </span>
                                    </div>

                                    <h2 data-reveal style={{
                                        fontSize: 'clamp(3.5rem, 9vw, 8rem)',
                                        fontWeight: 900,
                                        letterSpacing: '-0.04em',
                                        lineHeight: 0.92,
                                        color: 'var(--text-primary)',
                                        margin: '0 0 12px',
                                    }}>
                                        {p.title}
                                    </h2>

                                    <div data-reveal style={{
                                        fontSize: 'clamp(1.1rem, 2vw, 1.6rem)',
                                        fontWeight: 300,
                                        color: 'var(--text-secondary)',
                                        opacity: 0.7,
                                        marginBottom: 28,
                                        letterSpacing: '-0.01em',
                                    }}>
                                        {p.subtitle}
                                    </div>

                                    <p data-reveal style={{
                                        fontSize: 'clamp(0.95rem, 1.2vw, 1.05rem)',
                                        lineHeight: 1.7,
                                        color: 'var(--text-secondary)',
                                        maxWidth: 520,
                                        margin: 0,
                                    }}>
                                        {p.description}
                                    </p>
                                </div>

                                {/* Right: bullets + asset */}
                                <div className="lp-hiw-side" style={{
                                    display: 'flex', flexDirection: 'column', gap: 24,
                                    paddingLeft: 'clamp(0px, 4vw, 80px)',
                                    borderLeft: '1px solid var(--border-base)',
                                }}>
                                    <div data-reveal style={{
                                        width: 96, height: 96,
                                        marginBottom: 8,
                                    }}>
                                        <img
                                            src={p.img}
                                            alt=""
                                            style={{
                                                width: '100%', height: '100%',
                                                objectFit: 'contain',
                                                mixBlendMode: 'screen',
                                                filter: `drop-shadow(0 0 24px ${accentFx})`,
                                            }}
                                        />
                                    </div>

                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                                        {p.bullets.map((b, j) => (
                                            <div
                                                key={j}
                                                data-reveal
                                                style={{
                                                    display: 'flex', alignItems: 'center', gap: 12,
                                                    fontSize: 'clamp(1rem, 1.4vw, 1.25rem)',
                                                    fontWeight: 600,
                                                    color: 'var(--text-primary)',
                                                    letterSpacing: '-0.01em',
                                                }}
                                            >
                                                <CheckCircle2 size={20} style={{ color: accent, flexShrink: 0 }} />
                                                <span>{b}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Bottom hint */}
                            <div style={{
                                position: 'absolute',
                                bottom: 28, left: '6vw',
                                display: 'flex', alignItems: 'center', gap: 10,
                                fontFamily: "'Doto', monospace",
                                fontSize: '0.72rem',
                                letterSpacing: '0.18em',
                                textTransform: 'uppercase',
                                color: 'var(--text-muted)',
                                opacity: 0.55,
                            }}>
                                <span>{i < PHASES.length - 1 ? 'Scroll to advance' : 'Last step'}</span>
                                {i < PHASES.length - 1 && <ArrowRight size={14} />}
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
