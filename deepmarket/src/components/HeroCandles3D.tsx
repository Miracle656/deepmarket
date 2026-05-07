import { useEffect, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// Candle layout — matches the v3 Blender render's iso formation.
type CandleSpec = {
    x: number;
    yOffset: number;
    height: number;
    type: 'up' | 'down';
};

export const CANDLES: CandleSpec[] = [
    { x: -3.6, yOffset:  0.10, height: 1.6, type: 'up'   },
    { x: -2.7, yOffset: -0.40, height: 1.0, type: 'down' },
    { x: -1.8, yOffset:  0.20, height: 1.9, type: 'up'   },
    { x: -0.9, yOffset: -0.30, height: 1.1, type: 'down' },
    { x:  0.0, yOffset:  0.00, height: 1.4, type: 'up'   },
    { x:  0.9, yOffset: -0.35, height: 1.2, type: 'down' },
    { x:  1.8, yOffset:  0.30, height: 1.8, type: 'up'   },
    { x:  2.7, yOffset: -0.20, height: 1.0, type: 'down' },
    { x:  3.7, yOffset:  0.50, height: 2.6, type: 'up'   },
];

const COLORS = {
    upBody:    new THREE.Color('#1c6fff'),
    upWick:    new THREE.Color('#4d9fff'),
    downBody:  new THREE.Color('#ff4d6a'),
    downWick:  new THREE.Color('#ff7a92'),
} as const;

const BODY_W = 0.42;
const BODY_D = 0.42;
const WICK_R = 0.045;
const WICK_LEN = 0.55;

function buildCandle(spec: CandleSpec): THREE.Group {
    const group = new THREE.Group();
    const isUp = spec.type === 'up';

    const bodyGeo = new THREE.BoxGeometry(BODY_W, spec.height, BODY_D);
    const bodyMat = new THREE.MeshStandardMaterial({
        color: isUp ? COLORS.upBody : COLORS.downBody,
        emissive: isUp ? COLORS.upBody : COLORS.downBody,
        emissiveIntensity: 0.35,
        roughness: 0.35,
        metalness: 0.0,
        transparent: true,
        opacity: 1,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(body);

    const wickGeo = new THREE.CylinderGeometry(WICK_R, WICK_R, WICK_LEN, 8);
    const wickMat = new THREE.MeshStandardMaterial({
        color: isUp ? COLORS.upWick : COLORS.downWick,
        emissive: isUp ? COLORS.upWick : COLORS.downWick,
        emissiveIntensity: 1.6,
        roughness: 0.6,
        transparent: true,
        opacity: 1,
    });
    const wickTop = new THREE.Mesh(wickGeo, wickMat);
    wickTop.position.y = spec.height / 2 + WICK_LEN / 2;
    group.add(wickTop);

    const wickBot = new THREE.Mesh(wickGeo, wickMat);
    wickBot.position.y = -spec.height / 2 - WICK_LEN / 2;
    group.add(wickBot);

    group.position.set(spec.x, spec.yOffset, 0);
    group.userData = {
        type: spec.type,
        baseY: spec.yOffset,
        body,
        wickTop,
        wickBot,
        spotlight: 0,  // 0..1 — driven by ScrollTrigger timeline
    };
    return group;
}

interface Props {
    triggerRef?: RefObject<HTMLElement | null>;
    onActiveIndexChange?: (index: number | null) => void;
}

export default function HeroCandles3D({ triggerRef, onActiveIndexChange }: Props) {
    const mountRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return;

        const width  = mount.clientWidth;
        const height = mount.clientHeight;

        // ── Scene / Camera / Renderer ──
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);
        camera.position.set(0, 0.4, 11);
        camera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance',
        });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.15;
        renderer.setClearColor(0x000000, 0);
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.background = 'transparent';
        renderer.domElement.style.width  = '100%';
        renderer.domElement.style.height = '100%';
        mount.appendChild(renderer.domElement);

        // ── Lighting ──
        scene.add(new THREE.AmbientLight(0xcfe0ff, 0.55));

        const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
        keyLight.position.set(5, 6, 4);
        scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight(0xffd9e0, 0.45);
        fillLight.position.set(-4, -2, 3);
        scene.add(fillLight);

        const rimLight = new THREE.DirectionalLight(0xffffff, 1.2);
        rimLight.position.set(0, 2, -6);
        scene.add(rimLight);

        const bottomGlow = new THREE.PointLight(0x1c6fff, 30, 12, 1.4);
        bottomGlow.position.set(0, -2.2, 1.5);
        scene.add(bottomGlow);

        // Spotlight — moves with the focused candle to add a shaft of light
        const spot = new THREE.SpotLight(0xffffff, 0, 14, Math.PI / 6, 0.45, 1.4);
        spot.position.set(0, 6, 5);
        spot.target.position.set(0, 0, 0);
        scene.add(spot);
        scene.add(spot.target);

        // ── Cluster ──
        const cluster = new THREE.Group();
        cluster.rotation.x = THREE.MathUtils.degToRad(-6);
        cluster.rotation.z = THREE.MathUtils.degToRad(8);
        scene.add(cluster);

        const candles: THREE.Group[] = CANDLES.map(spec => {
            const c = buildCandle(spec);
            cluster.add(c);
            return c;
        });

        // ── Pointer / hover ──
        const ndc = new THREE.Vector2(0, 0);
        const ndcRay = new THREE.Vector2(99, 99);
        const raycaster = new THREE.Raycaster();
        let hovered: THREE.Group | null = null;

        const onPointerMove = (e: PointerEvent) => {
            const rect = renderer.domElement.getBoundingClientRect();
            const nx = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
            const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            ndc.set(nx, ny);
            ndcRay.set(nx, ny);
        };
        const onPointerLeave = () => {
            ndc.set(0, 0);
            ndcRay.set(99, 99);
        };
        renderer.domElement.addEventListener('pointermove', onPointerMove);
        renderer.domElement.addEventListener('pointerleave', onPointerLeave);

        // ── Entrance: drop in from above with tumble + overshoot ──
        candles.forEach((c) => {
            const targetY = c.userData.baseY as number;
            c.position.y = targetY + 12;
            c.rotation.z = THREE.MathUtils.degToRad(-18);
            c.scale.setScalar(0.55);
            c.children.forEach(child => {
                const m = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
                if (m) m.opacity = 0;
            });
        });
        renderer.render(scene, camera);

        const introTl = gsap.timeline({ delay: 0.15 });
        candles.forEach((c, i) => {
            const targetY = c.userData.baseY as number;
            const t = i * 0.09;
            introTl.to(c.position, { y: targetY,        duration: 1.15, ease: 'back.out(1.05)' }, t);
            introTl.to(c.rotation, { z: 0,              duration: 1.20, ease: 'power3.out'    }, t);
            introTl.to(c.scale,    { x: 1, y: 1, z: 1,  duration: 1.00, ease: 'back.out(1.4)' }, t);
            c.children.forEach(child => {
                const m = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
                if (m) introTl.to(m, { opacity: 1, duration: 0.55, ease: 'power2.out' }, t + 0.10);
            });
        });

        // ── Idle slow rotation (paused while ScrollTrigger is active) ──
        const idleTween = gsap.to(cluster.rotation, {
            y: THREE.MathUtils.degToRad(8),
            duration: 6,
            ease: 'sine.inOut',
            yoyo: true,
            repeat: -1,
        });

        // ── ScrollTrigger choreography ──
        // Master timeline: each candle gets 1/N of progress; within its phase,
        // spotlight ramps 0→1→0. The cluster slides slightly horizontally so
        // the focal candle drifts toward the visual center.
        let masterST: ScrollTrigger | null = null;
        const N = candles.length;

        if (triggerRef?.current) {
            const masterTl = gsap.timeline({
                scrollTrigger: {
                    trigger: triggerRef.current,
                    start: 'top top',
                    end: `+=${N * 280}`, // ~280px scroll per candle
                    pin: true,
                    pinSpacing: true,
                    scrub: 1,
                    snap: {
                        snapTo: candles.map((_, i) => (i + 0.5) / N),
                        duration: { min: 0.2, max: 0.5 },
                        ease: 'power1.inOut',
                    },
                    onUpdate: (self) => {
                        const idx = Math.min(N - 1, Math.max(0, Math.floor(self.progress * N)));
                        if (self.isActive) onActiveIndexChange?.(idx);
                    },
                    onLeave:     () => { onActiveIndexChange?.(null); idleTween.resume(); },
                    onLeaveBack: () => { onActiveIndexChange?.(null); idleTween.resume(); },
                    onEnter:     () => { idleTween.pause(); },
                    onEnterBack: () => { idleTween.pause(); },
                    invalidateOnRefresh: true,
                },
            });
            masterST = masterTl.scrollTrigger ?? null;

            // Slide cluster left as scroll progresses, so each candle drifts to focal x≈0
            const startX = -CANDLES[0].x;          // first candle centered
            const endX   = -CANDLES[N - 1].x;      // last candle centered
            masterTl.fromTo(cluster.position,
                { x: startX },
                { x: endX, duration: 1, ease: 'none' },
                0
            );

            // Per-candle spotlight: 0 → 1 → 0 within its phase
            candles.forEach((c, i) => {
                const phaseStart = i / N;
                const enterEnd   = phaseStart + (1 / N) * 0.30;
                const exitStart  = phaseStart + (1 / N) * 0.70;
                const phaseEnd   = (i + 1) / N;

                masterTl.to(c.userData, {
                    spotlight: 1,
                    duration: enterEnd - phaseStart,
                    ease: 'power2.out',
                }, phaseStart);
                masterTl.to(c.userData, {
                    spotlight: 0,
                    duration: phaseEnd - exitStart,
                    ease: 'power2.in',
                }, exitStart);
            });
        }

        // ── Render loop ──
        let raf = 0;
        let running = true;
        let lastTime = performance.now();
        const targetParallax = new THREE.Vector2(0, 0);
        const currentParallax = new THREE.Vector2(0, 0);
        const hoverState = new WeakMap<THREE.Group, { lift: number; glow: number }>();
        candles.forEach(c => hoverState.set(c, { lift: 0, glow: 0 }));

        const animate = () => {
            if (!running) return;
            const now = performance.now();
            const dt = Math.min(0.05, (now - lastTime) / 1000);
            lastTime = now;

            // Parallax (continues to work alongside scroll choreography)
            targetParallax.set(ndc.x * 0.35, ndc.y * 0.25);
            currentParallax.lerp(targetParallax, Math.min(1, dt * 6));

            // Compute global "any spotlight active" for dimming logic
            let maxSpot = 0;
            let focusedIdx = -1;
            candles.forEach((c, i) => {
                const s = c.userData.spotlight as number;
                if (s > maxSpot) { maxSpot = s; focusedIdx = i; }
            });

            // Raycast for hover
            raycaster.setFromCamera(ndcRay, camera);
            const hits = raycaster.intersectObjects(cluster.children, true);
            const hitGroup = hits[0]?.object.parent as THREE.Group | undefined;
            const newHover = hitGroup && CANDLES[candles.indexOf(hitGroup)] ? hitGroup : null;
            if (newHover !== hovered) {
                hovered = newHover;
                renderer.domElement.style.cursor = hovered ? 'pointer' : 'default';
            }

            // Per-candle: combine hover + spotlight
            candles.forEach((c, i) => {
                const state = hoverState.get(c)!;
                const hoverTarget = c === hovered ? 1 : 0;
                state.lift  += (hoverTarget - state.lift)  * Math.min(1, dt * 8);
                state.glow  += (hoverTarget - state.glow)  * Math.min(1, dt * 6);

                const s = c.userData.spotlight as number;
                const baseY = c.userData.baseY as number;

                // Position: hover lift + spotlight forward+up
                c.position.y = baseY + state.lift * 0.45 + s * 0.55;
                c.position.z = s * 1.6;
                const sc = 1 + s * 0.18;
                c.scale.set(sc, sc, sc);

                // Other-candle dim factor
                const dimFromOthers = (i !== focusedIdx) ? maxSpot * 0.65 : 0;

                const body = c.userData.body as THREE.Mesh;
                const bodyMat = body.material as THREE.MeshStandardMaterial;
                bodyMat.emissiveIntensity = 0.35 + state.glow * 0.95 + s * 1.4;
                bodyMat.opacity = 1 - dimFromOthers;
                bodyMat.transparent = bodyMat.opacity < 0.999;

                const wickTop = c.userData.wickTop as THREE.Mesh;
                const wickBot = c.userData.wickBot as THREE.Mesh;
                [wickTop, wickBot].forEach(w => {
                    const m = w.material as THREE.MeshStandardMaterial;
                    m.opacity = 1 - dimFromOthers;
                    m.transparent = m.opacity < 0.999;
                    m.emissiveIntensity = 1.6 + s * 1.5;
                });
            });

            // Move the moving spotlight to the focused candle's world position
            if (focusedIdx >= 0) {
                const focusedCandle = candles[focusedIdx];
                const wp = new THREE.Vector3();
                focusedCandle.getWorldPosition(wp);
                spot.position.set(wp.x, wp.y + 5, wp.z + 4);
                spot.target.position.set(wp.x, wp.y, wp.z);
                spot.target.updateMatrixWorld();
                spot.intensity = maxSpot * 60;
            } else {
                spot.intensity = 0;
            }

            // Apply parallax (combines with the ScrollTrigger-driven cluster.position.x)
            // The masterTl writes to cluster.position.x; we add parallax via the parent scene transform-equivalent.
            // To avoid stomping, we apply parallax on rotation only when ScrollTrigger isn't active.
            const stActive = masterST?.isActive ?? false;
            if (!stActive) {
                cluster.position.x += currentParallax.x * 0.08; // additive nudge, won't fight scroll
                cluster.position.y = currentParallax.y * 0.25;
            } else {
                cluster.position.y = currentParallax.y * 0.15;
            }

            renderer.render(scene, camera);
            raf = requestAnimationFrame(animate);
        };
        raf = requestAnimationFrame(animate);

        // ── Resize ──
        const onResize = () => {
            const w = mount.clientWidth;
            const h = mount.clientHeight;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
        };
        const ro = new ResizeObserver(onResize);
        ro.observe(mount);

        // ── Cleanup ──
        return () => {
            running = false;
            cancelAnimationFrame(raf);
            idleTween.kill();
            introTl.kill();
            if (masterST) masterST.kill();
            ScrollTrigger.getAll().forEach(t => {
                if (t.trigger === triggerRef?.current) t.kill();
            });
            ro.disconnect();
            renderer.domElement.removeEventListener('pointermove', onPointerMove);
            renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
            candles.forEach(c => {
                c.traverse(obj => {
                    const m = obj as THREE.Mesh;
                    if (m.geometry) m.geometry.dispose();
                    if (m.material) {
                        const mat = m.material as THREE.Material | THREE.Material[];
                        if (Array.isArray(mat)) mat.forEach(x => x.dispose());
                        else mat.dispose();
                    }
                });
            });
            renderer.dispose();
            if (renderer.domElement.parentNode === mount) {
                mount.removeChild(renderer.domElement);
            }
        };
    }, [triggerRef, onActiveIndexChange]);

    return (
        <div
            ref={mountRef}
            style={{
                width: '100%',
                height: '100%',
                position: 'relative',
                cursor: 'default',
            }}
            aria-label="DeepMarket — interactive 3D candlestick chart"
        />
    );
}
