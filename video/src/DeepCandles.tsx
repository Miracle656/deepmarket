// DeepMarket 3D candlestick cluster — ported from the site's HeroCandles3D,
// but every motion is driven by useCurrentFrame() (Remotion rule: no useFrame,
// no self-animating loops, or it flickers on render).

import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { MathUtils } from "three";

type CandleSpec = { x: number; yOffset: number; height: number; up: boolean };

const CANDLES: CandleSpec[] = [
  { x: -3.6, yOffset: 0.1, height: 1.6, up: true },
  { x: -2.7, yOffset: -0.4, height: 1.0, up: false },
  { x: -1.8, yOffset: 0.2, height: 1.9, up: true },
  { x: -0.9, yOffset: -0.3, height: 1.1, up: false },
  { x: 0.0, yOffset: 0.0, height: 1.4, up: true },
  { x: 0.9, yOffset: -0.35, height: 1.2, up: false },
  { x: 1.8, yOffset: 0.3, height: 1.8, up: true },
  { x: 2.7, yOffset: -0.2, height: 1.0, up: false },
  { x: 3.7, yOffset: 0.5, height: 2.6, up: true },
];

const COL = {
  upBody: "#1c6fff",
  upWick: "#4d9fff",
  downBody: "#ff4d6a",
  downWick: "#ff7a92",
};

const BODY_W = 0.42;
const WICK_R = 0.045;
const WICK_LEN = 0.55;

function Candle({ spec, index }: { spec: CandleSpec; index: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Staggered drop-in entrance (frame-driven).
  const start = index * 0.13 * fps;
  const p = interpolate(frame, [start, start + 1.1 * fps], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(frame, [start + 0.15 * fps, start + 0.7 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const y = spec.yOffset + (1 - p) * 12;
  const rotZ = MathUtils.degToRad((1 - p) * -18);
  const scale = interpolate(p, [0, 1], [0.6, 1]);

  const bodyCol = spec.up ? COL.upBody : COL.downBody;
  const wickCol = spec.up ? COL.upWick : COL.downWick;
  const wickY = spec.height / 2 + WICK_LEN / 2;

  return (
    <group position={[spec.x, y, 0]} rotation={[0, 0, rotZ]} scale={scale}>
      <mesh>
        <boxGeometry args={[BODY_W, spec.height, BODY_W]} />
        <meshStandardMaterial
          color={bodyCol}
          emissive={bodyCol}
          emissiveIntensity={0.4}
          roughness={0.35}
          metalness={0}
          transparent
          opacity={opacity}
        />
      </mesh>
      {[wickY, -wickY].map((wy, i) => (
        <mesh key={i} position={[0, wy, 0]}>
          <cylinderGeometry args={[WICK_R, WICK_R, WICK_LEN, 8]} />
          <meshStandardMaterial
            color={wickCol}
            emissive={wickCol}
            emissiveIntensity={1.6}
            roughness={0.6}
            transparent
            opacity={opacity}
          />
        </mesh>
      ))}
    </group>
  );
}

/** The candle cluster + lighting. Place inside a <ThreeCanvas>. */
export const DeepCandles: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Slow frame-driven sweep (replaces the GSAP idle yoyo).
  const sweep = Math.sin((frame / fps) * 0.5) * 0.14;

  return (
    <>
      <ambientLight intensity={0.55} color="#cfe0ff" />
      <directionalLight position={[5, 6, 4]} intensity={1.6} />
      <directionalLight position={[-4, -2, 3]} intensity={0.45} color="#ffd9e0" />
      <directionalLight position={[0, 2, -6]} intensity={1.2} />
      <pointLight position={[0, -2.2, 1.5]} intensity={30} distance={12} decay={1.4} color="#1c6fff" />

      <group
        rotation={[MathUtils.degToRad(-6), sweep, MathUtils.degToRad(8)]}
      >
        {CANDLES.map((spec, i) => (
          <Candle key={i} spec={spec} index={i} />
        ))}
      </group>
    </>
  );
};
