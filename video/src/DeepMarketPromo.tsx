// DeepMarket promo — DeepBook-family look (black + electric blue), the 3D
// candle cluster as a frame-driven background, and four sequenced scenes.
// Every figure is a real on-chain/predict-server snapshot (no invented stats).

import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { DeepCandles } from "./DeepCandles";

const BLUE = "#1E6EF3";
const FONT =
  "'Inter','Segoe UI',system-ui,-apple-system,'Helvetica Neue',sans-serif";

// ── shared fade in/out (frame is relative inside each Sequence) ──
const useFade = (inEnd: number, outStart: number, outEnd: number) => {
  const f = useCurrentFrame();
  const a = interpolate(f, [0, inEnd], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const b = interpolate(f, [outStart, outEnd], [1, 0], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return Math.min(a, b);
};

const rise = (frame: number, end: number, px = 28) =>
  interpolate(frame, [0, end], [px, 0], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

// ── Scene 1 — brand ──
const BrandIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = useFade(20, 60, 75);
  const y = rise(frame, 30, 24);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ opacity, transform: `translateY(${y}px)`, textAlign: "center" }}>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 96,
            fontWeight: 900,
            letterSpacing: "-0.045em",
            color: "#fff",
          }}
        >
          Deep<span style={{ color: BLUE }}>Market</span>
        </div>
        <div
          style={{
            fontFamily: FONT,
            marginTop: 14,
            fontSize: 26,
            fontWeight: 600,
            color: "rgba(255,255,255,0.7)",
            letterSpacing: "0.01em",
          }}
        >
          Prediction markets on Sui
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── Scene 2 — headline ──
const Headline: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = useFade(22, 100, 120);
  return (
    <AbsoluteFill style={{ alignItems: "flex-start", justifyContent: "center", padding: "0 120px" }}>
      <div style={{ opacity }}>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 124,
            fontWeight: 900,
            lineHeight: 0.98,
            letterSpacing: "-0.05em",
            color: "#fff",
            transform: `translateY(${rise(frame, 30, 36)}px)`,
          }}
        >
          Trade outcomes.
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 124,
            fontWeight: 900,
            lineHeight: 0.98,
            letterSpacing: "-0.05em",
            color: BLUE,
            transform: `translateY(${rise(frame, 42, 36)}px)`,
          }}
        >
          Predict price on Sui.
        </div>
        <div
          style={{
            fontFamily: FONT,
            marginTop: 26,
            fontSize: 28,
            fontWeight: 500,
            color: "rgba(255,255,255,0.72)",
            maxWidth: 880,
            lineHeight: 1.5,
            opacity: interpolate(frame, [18, 44], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          Real order-book pricing on DeepBook Predict. On-chain positions,
          verifiable outcomes, an optional AI agent.
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── Scene 3 — stats (real snapshot) with count-up ──
type StatDef = { target: number; fmt: (n: number) => string; label: string; tag: string };
const STATS: StatDef[] = [
  { target: 1.01, fmt: (n) => `$${n.toFixed(2)}M`, label: "Vault TVL · dUSDC", tag: "PLP vault" },
  { target: 3.6, fmt: (n) => `${n.toFixed(1)}K`, label: "BTC oracles tracked", tag: "Predict" },
  { target: 261, fmt: (n) => String(Math.round(n)), label: "Trading accounts", tag: "Managers" },
];

const Stats: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = useFade(22, 100, 120);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ opacity, width: "100%", maxWidth: 1500, padding: "0 80px" }}>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 30,
            fontWeight: 800,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: BLUE,
            marginBottom: 28,
            transform: `translateY(${rise(frame, 26, 20)}px)`,
          }}
        >
          Live on-chain
        </div>
        <div style={{ display: "flex", gap: 22 }}>
          {STATS.map((s, i) => {
            const start = 14 + i * 6;
            const v = interpolate(frame, [start, start + 38], [0, s.target], {
              easing: Easing.bezier(0.16, 1, 0.3, 1),
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            const cardY = rise(frame, 28 + i * 6, 30);
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  position: "relative",
                  padding: "34px 30px",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 18,
                  background: "rgba(255,255,255,0.03)",
                  transform: `translateY(${cardY}px)`,
                }}
              >
                <span style={{ position: "absolute", top: 14, right: 14, width: 8, height: 8, background: BLUE }} />
                <span style={{ position: "absolute", bottom: 14, left: 14, width: 8, height: 8, background: BLUE }} />
                <div
                  style={{
                    fontFamily: FONT,
                    fontSize: 82,
                    fontWeight: 800,
                    letterSpacing: "-0.03em",
                    color: "#fff",
                    lineHeight: 1,
                  }}
                >
                  {s.fmt(v)}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 18 }}>
                  <span style={{ fontFamily: FONT, fontSize: 24, fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>
                    {s.label}
                  </span>
                  <span style={{ fontFamily: FONT, fontSize: 16, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: BLUE }}>
                    {s.tag}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── Scene 4 — CTA ──
const CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = useFade(22, 999, 1000);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ opacity, textAlign: "center", transform: `translateY(${rise(frame, 30, 26)}px)` }}>
        <div style={{ fontFamily: FONT, fontSize: 22, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: BLUE, marginBottom: 22 }}>
          Live on Sui testnet
        </div>
        <div style={{ fontFamily: FONT, fontSize: 84, fontWeight: 900, letterSpacing: "-0.04em", color: "#fff", lineHeight: 1 }}>
          Trade from your DM.
        </div>
        <div
          style={{
            display: "inline-block",
            marginTop: 34,
            padding: "16px 34px",
            borderRadius: 14,
            background: BLUE,
            color: "#fff",
            fontFamily: FONT,
            fontSize: 30,
            fontWeight: 800,
          }}
        >
          t.me/sui_deepMarket_bot
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const DeepMarketPromo: React.FC = () => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#04070d" }}>
      {/* 3D candle background */}
      <AbsoluteFill>
        <ThreeCanvas width={width} height={height} camera={{ position: [0, 0.4, 11], fov: 35 }}>
          <DeepCandles />
        </ThreeCanvas>
      </AbsoluteFill>

      {/* readability scrim + blue floor glow */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(120% 90% at 50% 120%, rgba(28,111,255,0.22), transparent 60%), linear-gradient(90deg, rgba(4,7,13,0.78) 0%, rgba(4,7,13,0.35) 55%, rgba(4,7,13,0.0) 100%)",
        }}
      />

      {/* scenes */}
      <Sequence durationInFrames={75} layout="none">
        <BrandIntro />
      </Sequence>
      <Sequence from={75} durationInFrames={135} layout="none">
        <Headline />
      </Sequence>
      <Sequence from={210} durationInFrames={130} layout="none">
        <Stats />
      </Sequence>
      <Sequence from={340} durationInFrames={120} layout="none">
        <CTA />
      </Sequence>
    </AbsoluteFill>
  );
};
