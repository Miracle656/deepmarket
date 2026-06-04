// A product-demo scene: a real app screenshot with a slow Ken-Burns zoom
// toward the focus point, an animated cursor that moves in and clicks there,
// and a caption chip. All frame-driven.

import {
  AbsoluteFill,
  Img,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";
import { Cursor } from "./Cursor";

const BLUE = "#1E6EF3";
const FONT = "'Inter','Segoe UI',system-ui,-apple-system,sans-serif";

export const DemoScreen: React.FC<{
  src: string; // file in public/, e.g. "screens/predict.png"
  title: string;
  sub: string;
  /** click/zoom focus, normalized 0..1 */
  focus: { x: number; y: number };
  /** cursor entry point, normalized 0..1 */
  from: { x: number; y: number };
}> = ({ src, title, sub, focus, from }) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();

  const appear = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Ken Burns toward the focus point.
  const scale = interpolate(frame, [0, durationInFrames], [1.0, 1.08], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateRight: "clamp",
  });

  const toPx = (p: { x: number; y: number }) => ({ x: p.x * width, y: p.y * height });
  const clickFrame = 52;

  const capOpacity = interpolate(frame, [16, 32], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: "#04070d", opacity: appear }}>
      <AbsoluteFill style={{ transformOrigin: `${focus.x * 100}% ${focus.y * 100}%`, transform: `scale(${scale})` }}>
        <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>

      <Cursor from={toPx(from)} to={toPx(focus)} moveStart={8} moveEnd={48} clicks={[clickFrame]} />

      {/* caption chip */}
      <div
        style={{
          position: "absolute",
          left: 56,
          bottom: 56,
          opacity: capOpacity,
          transform: `translateY(${interpolate(frame, [16, 36], [16, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)`,
          display: "flex",
          alignItems: "stretch",
          gap: 14,
          background: "rgba(4,7,13,0.82)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 14,
          padding: "16px 22px 16px 18px",
          backdropFilter: "blur(8px)",
          maxWidth: 720,
        }}
      >
        <div style={{ width: 4, borderRadius: 4, background: BLUE }} />
        <div>
          <div style={{ fontFamily: FONT, fontSize: 34, fontWeight: 800, letterSpacing: "-0.02em", color: "#fff" }}>
            {title}
          </div>
          <div style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500, color: "rgba(255,255,255,0.72)", marginTop: 4 }}>
            {sub}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
