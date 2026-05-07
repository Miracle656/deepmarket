import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const ITEMS = [
    'BUILT ON SUI',
    'DEEPBOOK V3',
    'NATIVE CLOB',
    'YES / NO TOKENS',
    'ON-CHAIN RESOLUTION',
    'PERMISSIONLESS',
    'SUB-SECOND TRADES',
    'NO AMM CURVES',
    'COMPOSABLE WITH MARGIN',
    'ZERO CUSTODIAN',
];

export default function MarqueeRow() {
    const containerRef = useRef<HTMLDivElement>(null);
    const row1Ref = useRef<HTMLDivElement>(null);
    const row2Ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const ctx = gsap.context(() => {
            const buildLoop = (target: HTMLDivElement | null, reverse: boolean) => {
                if (!target) return null;
                const content = target.firstElementChild as HTMLElement | null;
                if (!content) return null;

                // Clone to make seamless loop
                const clone = content.cloneNode(true) as HTMLElement;
                target.appendChild(clone);

                const totalWidth = content.offsetWidth;
                gsap.set(target, { x: reverse ? -totalWidth : 0 });

                return gsap.to(target, {
                    x: reverse ? 0 : -totalWidth,
                    duration: 32,
                    ease: 'none',
                    repeat: -1,
                });
            };

            const tl1 = buildLoop(row1Ref.current, false);
            const tl2 = buildLoop(row2Ref.current, true);

            // Velocity-reactive: speed up while scrolling, ease back to baseline
            ScrollTrigger.create({
                trigger: containerRef.current,
                start: 'top bottom',
                end: 'bottom top',
                onUpdate: (self) => {
                    const v = Math.abs(self.getVelocity());
                    const ts = 1 + Math.min(6, v / 600);
                    [tl1, tl2].forEach(t => {
                        if (!t) return;
                        gsap.to(t, { timeScale: ts, duration: 0.4, overwrite: true });
                        gsap.to(t, { timeScale: 1, duration: 1.2, delay: 0.4, overwrite: 'auto' });
                    });
                },
            });
        }, containerRef);

        return () => ctx.revert();
    }, []);

    const Item = ({ text, accent }: { text: string; accent: 'yes' | 'no' }) => (
        <div
            style={{
                display: 'flex', alignItems: 'center', gap: 24,
                padding: '0 36px',
                whiteSpace: 'nowrap',
            }}
        >
            <span
                aria-hidden="true"
                style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: accent === 'yes' ? 'var(--yes)' : 'var(--no)',
                    boxShadow: accent === 'yes'
                        ? '0 0 14px rgba(28,111,255,0.7)'
                        : '0 0 14px rgba(255,77,106,0.7)',
                    flexShrink: 0,
                }}
            />
            <span style={{
                fontSize: 'clamp(1.5rem, 3.2vw, 2.6rem)',
                fontWeight: 900, letterSpacing: '-0.02em',
                color: 'var(--text-primary)',
                textTransform: 'uppercase',
                fontFamily: "'Borna', sans-serif",
            }}>
                {text}
            </span>
        </div>
    );

    return (
        <section
            ref={containerRef}
            className="lp-marquee"
            aria-label="DeepMarket protocol highlights"
            style={{
                position: 'relative',
                padding: '64px 0',
                overflow: 'hidden',
                borderTop: '1px solid var(--border-base)',
                borderBottom: '1px solid var(--border-base)',
                background: 'linear-gradient(180deg, transparent 0%, rgba(28,111,255,0.025) 50%, transparent 100%)',
            }}
        >
            <div style={{
                display: 'flex', flexDirection: 'column', gap: 28,
                transform: 'rotate(-1.2deg)',
            }}>
                {/* Row 1 — left-moving */}
                <div ref={row1Ref} style={{ display: 'flex', width: 'max-content', willChange: 'transform' }}>
                    <div style={{ display: 'flex' }}>
                        {ITEMS.map((t, i) => (
                            <Item key={i} text={t} accent={i % 2 === 0 ? 'yes' : 'no'} />
                        ))}
                    </div>
                </div>

                {/* Row 2 — right-moving (offset) */}
                <div ref={row2Ref} style={{ display: 'flex', width: 'max-content', willChange: 'transform' }}>
                    <div style={{ display: 'flex' }}>
                        {[...ITEMS].reverse().map((t, i) => (
                            <Item key={i} text={t} accent={i % 2 === 0 ? 'no' : 'yes'} />
                        ))}
                    </div>
                </div>
            </div>

            {/* Edge fade masks so items slide in/out cleanly */}
            <div style={{
                position: 'absolute', top: 0, bottom: 0, left: 0, width: 120,
                background: 'linear-gradient(90deg, var(--bg-root) 0%, transparent 100%)',
                pointerEvents: 'none', zIndex: 2,
            }} />
            <div style={{
                position: 'absolute', top: 0, bottom: 0, right: 0, width: 120,
                background: 'linear-gradient(-90deg, var(--bg-root) 0%, transparent 100%)',
                pointerEvents: 'none', zIndex: 2,
            }} />
        </section>
    );
}
