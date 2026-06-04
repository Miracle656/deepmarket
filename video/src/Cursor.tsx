// A frame-driven fake cursor with a click ripple, for product-demo scenes.
// Position is interpolated between waypoints; "clicks" pulse a ring + dip.

import { useCurrentFrame, interpolate, Easing } from "remotion";

export type Pt = { x: number; y: number }; // composition pixels

export const Cursor: React.FC<{
  /** waypoints in composition px; cursor eases between them */
  from: Pt;
  to: Pt;
  moveStart: number;
  moveEnd: number;
  /** frame(s) where a click ripple fires */
  clicks?: number[];
}> = ({ from, to, moveStart, moveEnd, clicks = [] }) => {
  const frame = useCurrentFrame();

  const t = interpolate(frame, [moveStart, moveEnd], [0, 1], {
    easing: Easing.bezier(0.5, 0, 0.2, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const x = from.x + (to.x - from.x) * t;
  const y = from.y + (to.y - from.y) * t;

  // press dip on the nearest click
  const dip = clicks.reduce((acc, c) => {
    const d = interpolate(frame, [c - 4, c, c + 6], [0, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    return Math.max(acc, d);
  }, 0);
  const scale = 1 - dip * 0.18;

  return (
    <>
      {clicks.map((c, i) => {
        const r = interpolate(frame, [c, c + 22], [0, 64], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        });
        const o = interpolate(frame, [c, c + 22], [0.5, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        if (o <= 0) return null;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x - r,
              top: y - r,
              width: r * 2,
              height: r * 2,
              borderRadius: "50%",
              border: `3px solid rgba(30,110,243,${o})`,
              boxShadow: `0 0 24px rgba(30,110,243,${o * 0.8})`,
            }}
          />
        );
      })}
      <svg
        width="40"
        height="40"
        viewBox="0 0 24 24"
        style={{
          position: "absolute",
          left: x,
          top: y,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.6))",
        }}
      >
        <path
          d="M5 3 L5 20 L9.5 15.5 L12.5 22 L15 21 L12 14.5 L18.5 14.5 Z"
          fill="#fff"
          stroke="#0b0e14"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
};
