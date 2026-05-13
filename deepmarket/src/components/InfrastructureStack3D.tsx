// InfrastructureStack3D — 60FPS pure-Canvas isometric stack.
//
// Architecture (per the project brief):
//   - 2D <canvas>, no WebGL / Three.js. Manual isometric projection.
//   - Animation state held in a single mutable ref (no React re-renders).
//   - Spring physics for open/close (stiffness + damping).
//   - dt-normalized rAF loop — same speed at 60Hz and 144Hz.
//   - Mouse parallax: enter/leave drive openAmount, move drives tiltX/Y.
//   - IntersectionObserver gates the rAF loop to save CPU when offscreen.
//   - Volumetric particle field parallaxes against the tilt.
//
// Props are unchanged from the previous (Three.js) version so LandingPage
// keeps working without edits.

import {
    useEffect,
    useRef,
    type RefObject,
} from 'react';

export type LayerSpec = {
    /** Brand accent for the layer's edges + flowing line. */
    color: string;
    /** Soft tint used for the top-face gradient. */
    edgeColor: string;
    /** Short layer code, e.g. "L01". Drawn before the title. */
    code?: string;
    /** Inline label drawn next to the layer when the stack is open. */
    title?: string;
};

interface Props {
    /** Kept for compatibility with the parent; unused in canvas version. */
    triggerRef: RefObject<HTMLElement | null>;
    layers: LayerSpec[];
    activeIndex: number | null;
    onLayerHover?: (i: number | null) => void;
}

// ── Geometry / tuning ─────────────────────────────────────────────────────
const BASE_S = 105;            // half-width of each layer box
const LAYER_H = 16;            // height of each layer (thin slab)
const GAP_CLOSED = 3;          // gap between layers when collapsed
const GAP_OPEN = 32;           // gap when fully expanded
const ISO = Math.PI / 6;       // 30° isometric

// Physics
const SPRING_STIFFNESS = 0.18;
const SPRING_DAMPING = 0.74;
const TILT_LERP = 0.085;
const TILT_MAX_X = 0.22;       // radians, ~12.5°
const TILT_MAX_Y = 0.32;       // radians, ~18°

// Spotlight (driven by activeIndex)
const SPOT_LERP = 0.12;

// Particle field
const PARTICLE_COUNT = 36;
const PARTICLE_TILT_GAIN = 38;

// Inline labels (typewriter cascade)
const LABEL_LEAD_MS = 180;        // delay before first label starts revealing
const LABEL_STAGGER_MS = 220;     // delay between successive layer labels
const LABEL_TYPE_MS = 520;        // time for a single label to fully type out
const LABEL_GUTTER = 82;          // px between layer right-edge and label start
const LABEL_CODE_PX = 12;         // monospace layer-code size, e.g. "L01"
const LABEL_TITLE_PX = 19;        // sans-serif label title size

// ── Color helpers ─────────────────────────────────────────────────────────

function parseHex(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    const full =
        h.length === 3
            ? h.split('').map((c) => c + c).join('')
            : h;
    return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
    ];
}
function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}
function rgb([r, g, b]: [number, number, number], alpha = 1): string {
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [4, 8, 15];

// ── Projection ────────────────────────────────────────────────────────────

interface Point2 { px: number; py: number }

/**
 * Project a 3D point `(x, y, z)` (y is up) through tiltY then tiltX, then
 * isometric-project to 2D canvas coords centered at `(cx, cy)` with `scale`.
 */
function project(
    x: number, y: number, z: number,
    tiltX: number, tiltY: number,
    cx: number, cy: number,
    scale: number
): Point2 {
    // Rotate around Y axis (left/right tilt)
    const cyR = Math.cos(tiltY), syR = Math.sin(tiltY);
    const x1 = x * cyR + z * syR;
    const z1 = -x * syR + z * cyR;
    // Rotate around X axis (forward/back tilt)
    const cxR = Math.cos(tiltX), sxR = Math.sin(tiltX);
    const y2 = y * cxR - z1 * sxR;
    const z2 = y * sxR + z1 * cxR;
    const x2 = x1;
    // Isometric projection
    const px = cx + (x2 - z2) * Math.cos(ISO) * scale;
    const py = cy + (-y2 + (x2 + z2) * Math.sin(ISO)) * scale;
    return { px, py };
}

function pointInPolygon(x: number, y: number, poly: Point2[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i];
        const b = poly[j];
        if (!a || !b) continue;
        if (
            ((a.py > y) !== (b.py > y)) &&
            (x < ((b.px - a.px) * (y - a.py)) / (b.py - a.py) + a.px)
        ) {
            inside = !inside;
        }
    }
    return inside;
}

// ── Component ─────────────────────────────────────────────────────────────

interface Particle { x: number; y: number; z: number; depth: number; r: number }

interface AnimState {
    openAmount: number;
    openVelocity: number;
    targetOpen: number;
    tiltX: number;
    tiltY: number;
    targetTiltX: number;
    targetTiltY: number;
    spotlight: number[];        // per-layer 0..1
    spotlightTarget: number[];  // per-layer 0..1
    /** When targetOpen flipped 0→1; resets to null on close. Drives label cascade. */
    openStartedAt: number | null;
    /** Per-layer 0..1 typewriter progress (linear, dt-driven). */
    labelProgress: number[];
    width: number;
    height: number;
    dpr: number;
    particles: Particle[];
    hoveredIndex: number | null;
}

export default function InfrastructureStack3D({
    layers,
    activeIndex,
    onLayerHover,
}: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Animation state lives in a ref so the loop never triggers React re-renders.
    const stateRef = useRef<AnimState>({
        openAmount: 0,
        openVelocity: 0,
        targetOpen: 0,
        tiltX: 0,
        tiltY: 0,
        targetTiltX: 0,
        targetTiltY: 0,
        spotlight: layers.map(() => 0),
        spotlightTarget: layers.map(() => 0),
        openStartedAt: null,
        labelProgress: layers.map(() => 0),
        width: 0,
        height: 0,
        dpr: 1,
        particles: [],
        hoveredIndex: null,
    });

    // Keep spotlight + labelProgress arrays sized to layers
    useEffect(() => {
        stateRef.current.spotlight = layers.map(
            (_, i) => stateRef.current.spotlight[i] ?? 0
        );
        stateRef.current.spotlightTarget = layers.map(() => 0);
        stateRef.current.labelProgress = layers.map(
            (_, i) => stateRef.current.labelProgress[i] ?? 0
        );
    }, [layers.length]);

    // Drive spotlight from `activeIndex`
    useEffect(() => {
        const s = stateRef.current;
        for (let i = 0; i < s.spotlightTarget.length; i++) {
            s.spotlightTarget[i] = activeIndex === i ? 1 : 0;
        }
    }, [activeIndex]);

    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const state = stateRef.current;

        // Seed particles once
        state.particles = Array.from({ length: PARTICLE_COUNT }, () => {
            const depth = Math.random();
            return {
                x: (Math.random() - 0.5) * 720,
                y: (Math.random() - 0.5) * 460,
                z: (Math.random() - 0.5) * 100,
                depth,                          // 0..1, used for parallax
                r: 0.8 + Math.random() * 1.8,
            };
        });

        // ── Resize + DPR ────────────────────────────────────────────
        const setupSize = () => {
            const rect = container.getBoundingClientRect();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            state.width = rect.width;
            state.height = rect.height;
            state.dpr = dpr;
            canvas.width = Math.round(rect.width * dpr);
            canvas.height = Math.round(rect.height * dpr);
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        setupSize();
        const ro = new ResizeObserver(setupSize);
        ro.observe(container);

        // ── Events on the canvas ─────────────────────────────────────
        // Two independent "open" signals: mouse-inside the canvas, and the
        // section being scrolled into view. The stack opens whenever either
        // is true; it closes only when BOTH are false. We also stamp the
        // timestamp of each 0→1 transition so the inline labels can cascade
        // in with a typewriter effect.
        let mouseInside = false;
        let inView = false;
        const updateOpenTarget = () => {
            const next = mouseInside || inView ? 1 : 0;
            const prev = state.targetOpen;
            state.targetOpen = next;
            if (prev === 0 && next === 1) {
                state.openStartedAt = performance.now();
            } else if (prev === 1 && next === 0) {
                state.openStartedAt = null;
            }
        };

        const handleEnter = () => {
            mouseInside = true;
            updateOpenTarget();
        };
        const handleLeave = () => {
            mouseInside = false;
            updateOpenTarget();
            state.targetTiltX = 0;
            state.targetTiltY = 0;
            if (state.hoveredIndex !== null) {
                state.hoveredIndex = null;
                onLayerHover?.(null);
            }
        };
        const handleMove = (e: MouseEvent) => {
            const rect = canvas.getBoundingClientRect();
            const nx = ((e.clientX - rect.left) / rect.width) - 0.5;
            const ny = ((e.clientY - rect.top) / rect.height) - 0.5;
            state.targetTiltY = nx * TILT_MAX_Y;       // horizontal mouse → Y rotation
            state.targetTiltX = -ny * TILT_MAX_X;      // vertical mouse → X rotation (inverted)
            // Hit-test handled in the render loop using the current projection
        };
        canvas.addEventListener('mouseenter', handleEnter);
        canvas.addEventListener('mouseleave', handleLeave);
        canvas.addEventListener('mousemove', handleMove);

        // ── IntersectionObserver: gate rAF + drive auto-expand on scroll ──
        // Multiple thresholds: ratio > 0.05 keeps the loop running, ratio > 0.35
        // counts as "in view" and auto-opens the stack so it spreads when the
        // user scrolls the section into focus.
        let visible = true;
        const io = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (!entry) return;
                const ratio = entry.intersectionRatio;
                const wasVisible = visible;
                visible = ratio > 0.05;
                inView = ratio > 0.35;
                updateOpenTarget();
                if (visible && !wasVisible) {
                    last = performance.now();
                    raf = requestAnimationFrame(frame);
                }
            },
            { threshold: [0, 0.05, 0.2, 0.35, 0.5, 0.75, 1] }
        );
        io.observe(container);

        // ── Render loop ──────────────────────────────────────────────
        let raf = 0;
        let last = performance.now();

        const frame = (now: number) => {
            if (!visible) return;
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            // Use ~60fps as the normalization base for the spring/lerp coefficients
            const t = dt * 60;

            // Spring physics: openAmount
            state.openVelocity +=
                (state.targetOpen - state.openAmount) * SPRING_STIFFNESS * t;
            state.openVelocity *= Math.pow(SPRING_DAMPING, t);
            state.openAmount += state.openVelocity * t;

            // Tilt lerp
            state.tiltX += (state.targetTiltX - state.tiltX) * TILT_LERP * t;
            state.tiltY += (state.targetTiltY - state.tiltY) * TILT_LERP * t;

            // Spotlight lerp (per layer)
            for (let i = 0; i < state.spotlight.length; i++) {
                const target = state.spotlightTarget[i] ?? 0;
                const current = state.spotlight[i] ?? 0;
                state.spotlight[i] =
                    current + (target - current) * SPOT_LERP * t;
            }

            // Typewriter cascade — each layer's labelProgress ramps linearly
            // toward 1 once its stagger threshold is reached; ramps back to 0
            // when the stack is closing. Linear (not springy) so chars appear
            // at a steady rhythm.
            const openedAt = state.openStartedAt;
            const rate = dt * 1000 / LABEL_TYPE_MS;
            for (let i = 0; i < state.labelProgress.length; i++) {
                const triggerAt = LABEL_LEAD_MS + i * LABEL_STAGGER_MS;
                const triggered =
                    openedAt !== null && now - openedAt >= triggerAt;
                const cur = state.labelProgress[i] ?? 0;
                if (triggered) {
                    state.labelProgress[i] = Math.min(1, cur + rate);
                } else {
                    state.labelProgress[i] = Math.max(0, cur - rate * 1.6);
                }
            }

            draw();
            raf = requestAnimationFrame(frame);
        };

        // ── Draw ─────────────────────────────────────────────────────
        const draw = () => {
            const { width: w, height: h } = state;
            // When the canvas is wide enough we bias the stack to the left so
            // the inline labels (which hang off the right edge) have room to
            // breathe. On narrow viewports we fall back to dead-center.
            const wideEnoughForLabels = w >= 720;
            const cx = wideEnoughForLabels ? Math.round(w * 0.34) : w / 2;
            const cy = h / 2;
            // Scale is driven by height (the limiting axis); capped so the
            // stack doesn't balloon on tall containers and crowd the labels.
            const scale = Math.min(1.05, Math.min(w, h) / 560);
            ctx.clearRect(0, 0, w, h);

            // Particles behind the stack
            for (const p of state.particles) {
                const parallaxX = state.tiltY * PARTICLE_TILT_GAIN * (p.depth + 0.4);
                const parallaxY = state.tiltX * PARTICLE_TILT_GAIN * (p.depth + 0.4);
                const px = cx + p.x * 0.5 + parallaxX;
                const py = cy + p.y * 0.5 + parallaxY;
                ctx.beginPath();
                ctx.arc(px, py, p.r * (0.4 + p.depth * 0.6), 0, Math.PI * 2);
                ctx.fillStyle = `rgba(255,255,255,${0.04 + p.depth * 0.10})`;
                ctx.fill();
            }

            const N = layers.length;
            const gap = GAP_CLOSED + (GAP_OPEN - GAP_CLOSED) * state.openAmount;
            const totalSpread = (N - 1) * (LAYER_H + gap);

            // Find the layer with the highest spotlight for stack-spread boost
            let maxSpot = 0;
            for (const s of state.spotlight) if (s > maxSpot) maxSpot = s;

            // Compute & store each layer's projected top-face polygon for hit testing
            const topPolygons: Point2[][] = new Array(N);
            // Anchor point for each layer's inline label (right-edge midpoint of top face)
            const labelAnchors: Point2[] = new Array(N);
            // Accent rgb cached per layer so the label pass can reuse it
            const layerAccents: [number, number, number][] = new Array(N);

            // Draw bottom-up so upper layers occlude lower ones
            // (with iso projection: bottom layer's top edges sit visually below,
            //  upper layers sit higher on screen — depth-sort by index ascending
            //  gives correct overlap as you stack).
            // Compute layer y-offsets (i=0 is BOTTOM)
            for (let i = 0; i < N; i++) {
                const spot = state.spotlight[i] ?? 0;
                const layer = layers[i];
                if (!layer) continue;

                // Vertical position with spread + per-layer spotlight nudge
                const baseY = i * (LAYER_H + gap) - totalSpread / 2;
                const boost = maxSpot * 10 * Math.sign(i - (N - 1) / 2);
                const yTop = baseY + LAYER_H / 2 + boost * spot;
                const yBot = baseY - LAYER_H / 2 + boost * spot;

                // 8 corners
                const S = BASE_S * (1 + spot * 0.04);
                const c000 = project(-S, yTop, -S, state.tiltX, state.tiltY, cx, cy, scale);
                const c100 = project( S, yTop, -S, state.tiltX, state.tiltY, cx, cy, scale);
                const c101 = project( S, yTop,  S, state.tiltX, state.tiltY, cx, cy, scale);
                const c001 = project(-S, yTop,  S, state.tiltX, state.tiltY, cx, cy, scale);
                const b000 = project(-S, yBot, -S, state.tiltX, state.tiltY, cx, cy, scale);
                const b100 = project( S, yBot, -S, state.tiltX, state.tiltY, cx, cy, scale);
                const b101 = project( S, yBot,  S, state.tiltX, state.tiltY, cx, cy, scale);
                const b001 = project(-S, yBot,  S, state.tiltX, state.tiltY, cx, cy, scale);

                // depth shading factor — deeper layers in the stack are darker
                const depthT = i / Math.max(1, N - 1);   // 0 = bottom, 1 = top
                const lightness = 0.55 + depthT * 0.45 + spot * 0.20;

                const accent = parseHex(layer.color);
                const tint = parseHex(layer.edgeColor);
                const topMix = mix(tint, WHITE, 0.55 * lightness);
                const rightMix = mix(accent, BLACK, 0.45 - depthT * 0.15 - spot * 0.10);
                const frontMix = mix(accent, BLACK, 0.65 - depthT * 0.12 - spot * 0.08);

                // ── Right face (+X side): c100 → c101 → b101 → b100 ──
                {
                    const grad = ctx.createLinearGradient(c100.px, c100.py, b101.px, b101.py);
                    grad.addColorStop(0, rgb(mix(rightMix, WHITE, 0.18), 0.95));
                    grad.addColorStop(1, rgb(mix(rightMix, BLACK, 0.40), 0.95));
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.moveTo(c100.px, c100.py);
                    ctx.lineTo(c101.px, c101.py);
                    ctx.lineTo(b101.px, b101.py);
                    ctx.lineTo(b100.px, b100.py);
                    ctx.closePath();
                    ctx.fill();
                }

                // ── Front face (+Z side): c001 → c101 → b101 → b001 ──
                {
                    const grad = ctx.createLinearGradient(c001.px, c001.py, b101.px, b101.py);
                    grad.addColorStop(0, rgb(mix(frontMix, WHITE, 0.12), 0.95));
                    grad.addColorStop(1, rgb(mix(frontMix, BLACK, 0.55), 0.95));
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.moveTo(c001.px, c001.py);
                    ctx.lineTo(c101.px, c101.py);
                    ctx.lineTo(b101.px, b101.py);
                    ctx.lineTo(b001.px, b001.py);
                    ctx.closePath();
                    ctx.fill();
                }

                // ── Top face: c000 → c100 → c101 → c001 ──
                {
                    const grad = ctx.createLinearGradient(c000.px, c000.py, c101.px, c101.py);
                    grad.addColorStop(0, rgb(mix(topMix, WHITE, 0.35), 0.96));
                    grad.addColorStop(1, rgb(mix(topMix, accent, 0.25), 0.96));
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.moveTo(c000.px, c000.py);
                    ctx.lineTo(c100.px, c100.py);
                    ctx.lineTo(c101.px, c101.py);
                    ctx.lineTo(c001.px, c001.py);
                    ctx.closePath();
                    ctx.fill();

                    // Bright accent stroke when active
                    ctx.lineWidth = 1.2 + spot * 1.5;
                    ctx.strokeStyle = rgb(accent, 0.55 + spot * 0.45);
                    ctx.stroke();
                }

                // Top face polygon for hit testing
                topPolygons[i] = [c000, c100, c101, c001];
                // Right-edge midpoint of top face — where the inline label hangs off
                labelAnchors[i] = {
                    px: (c100.px + c101.px) / 2,
                    py: (c100.py + c101.py) / 2,
                };
                layerAccents[i] = accent;

                // Hairline edges
                ctx.lineWidth = 0.7;
                ctx.strokeStyle = `rgba(255,255,255,${0.18 + spot * 0.25})`;
                ctx.beginPath();
                ctx.moveTo(c100.px, c100.py); ctx.lineTo(b100.px, b100.py);
                ctx.moveTo(c101.px, c101.py); ctx.lineTo(b101.px, b101.py);
                ctx.moveTo(c001.px, c001.py); ctx.lineTo(b001.px, b001.py);
                ctx.stroke();
            }

            // Drop shadow under the bottom layer — squashed elliptical radial gradient
            // Draw AFTER stack body? No — shadows belong under everything visually.
            // We're not depth-sorting, so render order is up to us. Place it before
            // the stack visually by drawing here using `globalCompositeOperation`.
            ctx.save();
            ctx.globalCompositeOperation = 'destination-over';
            {
                const shadowWidth = (BASE_S * 1.45 + state.openAmount * 80) * (scale);
                const shadowHeight = (BASE_S * 0.18 + state.openAmount * 6) * scale;
                const sy = cy + totalSpread * 0.5 + 30 * scale;
                const grad = ctx.createRadialGradient(cx, sy, 0, cx, sy, shadowWidth);
                grad.addColorStop(0, `rgba(0,0,0,${0.45 - state.openAmount * 0.18})`);
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.ellipse(cx, sy, shadowWidth, shadowHeight, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();

            // Hit test for the cursor position — find the topmost layer the mouse is over
            const m = lastMouse;
            if (m && state.targetOpen > 0.05) {
                let hit: number | null = null;
                for (let i = N - 1; i >= 0; i--) {
                    const poly = topPolygons[i];
                    if (poly && pointInPolygon(m.x, m.y, poly)) {
                        hit = i;
                        break;
                    }
                }
                if (hit !== state.hoveredIndex) {
                    state.hoveredIndex = hit;
                    onLayerHover?.(hit);
                }
            }

            // ── Inline label pass (typewriter cascade) ──────────────────
            // Each layer hangs a small monospace caption off its right edge.
            // Connector line draws first (length follows progress), then a
            // "LXX" code in accent color, then the title types out one char
            // at a time. Cursor character blinks while a label is still
            // revealing. Skip entirely on narrow viewports where there's no
            // horizontal room to the right of the stack.
            if (!wideEnoughForLabels) return;
            const blink = Math.floor(performance.now() / 480) % 2 === 0;
            for (let i = 0; i < N; i++) {
                const layer = layers[i];
                const anchor = labelAnchors[i];
                const accent = layerAccents[i];
                const progress = state.labelProgress[i] ?? 0;
                if (!layer || !anchor || !accent || progress < 0.01) continue;
                if (!layer.title && !layer.code) continue;

                const lineFrac = Math.min(1, progress * 1.6);
                const startX = anchor.px;
                const startY = anchor.py;
                const endX = startX + LABEL_GUTTER * lineFrac;
                const endY = startY;

                // Connector + anchor dot
                ctx.strokeStyle = rgb(accent, 0.75 * lineFrac);
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(endX, endY);
                ctx.stroke();
                ctx.fillStyle = rgb(accent, 0.95 * lineFrac);
                ctx.beginPath();
                ctx.arc(startX, startY, 2.5, 0, Math.PI * 2);
                ctx.fill();

                // Text starts revealing only after the connector is most of the way out
                const textProgress = Math.max(0, (progress - 0.18) / 0.82);
                if (textProgress <= 0) continue;
                const textX = endX + 8;

                // Layer code, e.g. "L01" — fades in fully with text progress
                if (layer.code) {
                    ctx.font =
                        `700 ${LABEL_CODE_PX}px ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, monospace`;
                    ctx.textBaseline = 'alphabetic';
                    ctx.fillStyle = rgb(accent, 0.95 * Math.min(1, textProgress * 2));
                    ctx.fillText(layer.code, textX, startY - 9);
                }

                // Title — character reveal with blinking cursor
                if (layer.title) {
                    const fullLen = layer.title.length;
                    const charsVisible = Math.floor(textProgress * fullLen);
                    const visible = layer.title.slice(0, charsVisible);
                    const stillTyping = charsVisible < fullLen;
                    const cursor = stillTyping && blink ? '▌' : '';
                    ctx.font =
                        `600 ${LABEL_TITLE_PX}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Inter", sans-serif`;
                    ctx.textBaseline = 'alphabetic';
                    ctx.fillStyle = `rgba(236, 242, 255, ${0.95 * Math.min(1, textProgress * 1.4)})`;
                    ctx.fillText(visible + cursor, textX, startY + 14);
                }

            }
        };

        // Track cursor for hit-testing in draw()
        let lastMouse: { x: number; y: number } | null = null;
        const trackMouse = (e: MouseEvent) => {
            const rect = canvas.getBoundingClientRect();
            lastMouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        };
        const clearMouse = () => { lastMouse = null; };
        canvas.addEventListener('mousemove', trackMouse);
        canvas.addEventListener('mouseleave', clearMouse);

        raf = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            io.disconnect();
            canvas.removeEventListener('mouseenter', handleEnter);
            canvas.removeEventListener('mouseleave', handleLeave);
            canvas.removeEventListener('mousemove', handleMove);
            canvas.removeEventListener('mousemove', trackMouse);
            canvas.removeEventListener('mouseleave', clearMouse);
        };
    }, [layers, onLayerHover]);

    return (
        <div
            ref={containerRef}
            style={{ width: '100%', height: '100%', position: 'relative' }}
            aria-label="DeepMarket infrastructure layer stack"
        >
            <canvas
                ref={canvasRef}
                style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                    cursor: 'pointer',
                }}
            />
        </div>
    );
}
