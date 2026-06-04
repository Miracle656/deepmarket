// "Why DeepMarket" — DeepBook trader-hub-style numbered 01-04 feature cards
// (dark dotted-grid cards, blue number tags). Cards stagger-reveal on scroll.

import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const FEATURES = [
    {
        n: '01',
        title: 'Order-book pricing',
        body: 'Real CLOB matching on Sui — no AMM curves, no slippage tricks. Price options off a live SVI vol surface on DeepBook Predict.',
    },
    {
        n: '02',
        title: 'On-chain AI audit',
        body: 'An autonomous agent trades within an AgentCap policy — daily caps, revocable. Every decision is recorded on-chain and SuiScan-verifiable.',
    },
    {
        n: '03',
        title: 'Be the house',
        body: 'Supply the PLP vault and earn the premium takers pay. Live NAV mark-to-market, share price, and a real LP risk dashboard.',
    },
    {
        n: '04',
        title: 'Trade from Telegram',
        body: 'A full trade panel plus a conversational assistant in your DMs — list oracles, mint, redeem. No desktop required.',
    },
];

export default function LandingFeatures() {
    const ref = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const ctx = gsap.context(() => {
            gsap.from('.db-feat-card', {
                scrollTrigger: { trigger: ref.current, start: 'top 80%', once: true },
                y: 36,
                opacity: 0,
                stagger: 0.08,
                duration: 0.6,
                ease: 'power3.out',
            });
        }, ref);
        return () => ctx.revert();
    }, []);

    return (
        <section className="db-feat-section" ref={ref}>
            <div className="db-feat-head">
                <div className="db-feat-eyebrow">Why DeepMarket</div>
                <h2 className="db-feat-title">
                    Not just a market. <span>A Predict OS.</span>
                </h2>
            </div>
            <div className="db-feat-grid">
                {FEATURES.map((f) => (
                    <div className="db-feat-card" key={f.n}>
                        <div className="db-feat-top">
                            <span className="db-feat-num">{f.n}</span>
                            <h3 className="db-feat-name">{f.title}</h3>
                        </div>
                        <p className="db-feat-body">{f.body}</p>
                        <div className="db-feat-art">
                            <span className="db-feat-art-shape" />
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
