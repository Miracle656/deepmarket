// DeepMarket promo — DeepBook-family look. Candles are a brief 2.5s intro
// (not a constant background), then a cursor walks the real app, then a CTA.
// No audio.

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
import { DemoScreen } from "./DemoScreen";

const BLUE = "#1E6EF3";
const FONT = "'Inter','Segoe UI',system-ui,-apple-system,sans-serif";

const rise = (frame: number, end: number, px = 24) =>
  interpolate(frame, [0, end], [px, 0], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

// ── Scene 1 — 3D candle intro + brand (then fades out) ──
const IntroCandles: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const inOpacity = interpolate(frame, [0, 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const outOpacity = interpolate(frame, [60, 75], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacity = Math.min(inOpacity, outOpacity);

  return (
    <AbsoluteFill style={{ background: "#04070d", opacity }}>
      <AbsoluteFill>
        <ThreeCanvas width={width} height={height} camera={{ position: [0, 0.4, 11], fov: 35 }}>
          <DeepCandles />
        </ThreeCanvas>
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(120% 90% at 50% 120%, rgba(28,111,255,0.22), transparent 60%)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ textAlign: "center", transform: `translateY(${rise(frame, 30, 22)}px)` }}>
          <div style={{ fontFamily: FONT, fontSize: 104, fontWeight: 900, letterSpacing: "-0.045em", color: "#fff" }}>
            Deep<span style={{ color: BLUE }}>Market</span>
          </div>
          <div style={{ fontFamily: FONT, marginTop: 12, fontSize: 28, fontWeight: 600, color: "rgba(255,255,255,0.72)" }}>
            Prediction markets on Sui
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── Final scene — CTA ──
const CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#04070d", alignItems: "center", justifyContent: "center", opacity }}>
      <div style={{ textAlign: "center", transform: `translateY(${rise(frame, 30, 24)}px)` }}>
        <div style={{ fontFamily: FONT, fontSize: 22, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: BLUE, marginBottom: 20 }}>
          Live on Sui testnet
        </div>
        <div style={{ fontFamily: FONT, fontSize: 92, fontWeight: 900, letterSpacing: "-0.045em", color: "#fff", lineHeight: 1 }}>
          Trade outcomes.<br />
          <span style={{ color: BLUE }}>Predict price on Sui.</span>
        </div>
        <div style={{ display: "inline-block", marginTop: 36, padding: "16px 34px", borderRadius: 14, background: BLUE, color: "#fff", fontFamily: FONT, fontSize: 30, fontWeight: 800 }}>
          t.me/sui_deepMarket_bot
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const DeepMarketPromo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: "#04070d" }}>
      <Sequence durationInFrames={75} layout="none">
        <IntroCandles />
      </Sequence>

      <Sequence from={75} durationInFrames={120} layout="none">
        <DemoScreen
          src="screens/predict.png"
          title="Oracle-priced markets"
          sub="Binary + range options on rolling BTC oracles — sorted by what's live."
          focus={{ x: 0.17, y: 0.46 }}
          from={{ x: 0.5, y: 0.12 }}
        />
      </Sequence>

      <Sequence from={195} durationInFrames={120} layout="none">
        <DemoScreen
          src="screens/oracle.png"
          title="Mint UP, DOWN or a range"
          sub="SVI-priced, with live devInspect quotes. A countdown to settlement."
          focus={{ x: 0.82, y: 0.5 }}
          from={{ x: 0.3, y: 0.2 }}
        />
      </Sequence>

      <Sequence from={315} durationInFrames={120} layout="none">
        <DemoScreen
          src="screens/vault.png"
          title="Be the house"
          sub="Supply the PLP vault, earn the premium. Live NAV + a real risk dashboard."
          focus={{ x: 0.3, y: 0.42 }}
          from={{ x: 0.7, y: 0.2 }}
        />
      </Sequence>

      <Sequence from={435} durationInFrames={120} layout="none">
        <DemoScreen
          src="screens/agents.png"
          title="Every AI decision, on-chain"
          sub="An autonomous agent trades under an AgentCap. Public, SuiScan-verifiable."
          focus={{ x: 0.5, y: 0.4 }}
          from={{ x: 0.5, y: 0.12 }}
        />
      </Sequence>

      <Sequence from={555} durationInFrames={110} layout="none">
        <CTA />
      </Sequence>
    </AbsoluteFill>
  );
};
