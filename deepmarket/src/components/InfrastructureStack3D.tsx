import { useEffect, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export type LayerSpec = {
    color: string;       // brand accent for that layer's flowing line
    edgeColor: string;   // (legacy — kept for prop compatibility, used as a soft tint)
};

interface Props {
    triggerRef: RefObject<HTMLElement | null>;
    layers: LayerSpec[];
    activeIndex: number | null;
    onLayerHover?: (i: number | null) => void;
}

const SLAB_W = 3.5;
const SLAB_H = 0.42;
const SLAB_D = 2.5;

const COLLAPSED_GAP = 0.46;   // tight stack: bodies almost touching
const EXPANDED_GAP  = 0.92;   // base spread once section is in view
const HOVER_BOOST   = 0.45;   // extra spread when any layer is hovered

// Build a closed-loop perimeter (top-edge rectangle) as a flat array [x,y,z, x,y,z, ...]
function buildTopPerimeter(w: number, h: number, d: number): number[] {
    const x = w / 2, y = h / 2, z = d / 2;
    return [
        -x, y, -z,
         x, y, -z,
         x, y,  z,
        -x, y,  z,
        -x, y, -z, // close the loop
    ];
}

// Internal grid lines on the top face — 3×3 division (2 cross lines each axis)
function buildTopGrid(w: number, h: number, d: number): number[] {
    const x = w / 2, y = h / 2, z = d / 2;
    const pts: number[] = [];
    // Two lines parallel to Z (vertical in top view)
    for (let i = 1; i <= 2; i++) {
        const px = -x + (w * i) / 3;
        pts.push(px, y, -z, px, y, z);
    }
    // Two lines parallel to X
    for (let i = 1; i <= 2; i++) {
        const pz = -z + (d * i) / 3;
        pts.push(-x, y, pz, x, y, pz);
    }
    return pts;
}

export default function InfrastructureStack3D({
    triggerRef,
    layers,
    activeIndex,
    onLayerHover,
}: Props) {
    const mountRef = useRef<HTMLDivElement>(null);
    const apiRef = useRef<{ setActive: (i: number | null) => void } | null>(null);

    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return;

        const width  = mount.clientWidth;
        const height = mount.clientHeight;
        const N = layers.length;

        // ── Scene ──
        const scene = new THREE.Scene();

        // ── Camera (isometric-feel) ──
        const camera = new THREE.PerspectiveCamera(28, width / height, 0.1, 100);
        camera.position.set(5.5, 3.6, 6.4);
        camera.lookAt(0, 0, 0);

        // ── Renderer ──
        const renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance',
        });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.setClearColor(0x000000, 0);
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.background = 'transparent';
        renderer.domElement.style.width  = '100%';
        renderer.domElement.style.height = '100%';
        mount.appendChild(renderer.domElement);

        // ── Cluster (parent for tilt + idle rotation) ──
        const cluster = new THREE.Group();
        cluster.rotation.y = THREE.MathUtils.degToRad(-26);
        scene.add(cluster);

        // Pre-built shared geometries
        const boxGeo  = new THREE.BoxGeometry(SLAB_W, SLAB_H, SLAB_D);
        const edgeGeo = new THREE.EdgesGeometry(boxGeo);

        // ── Build layers ──
        type LayerNode = {
            group: THREE.Group;
            wireframe: THREE.LineSegments;
            wireMat: THREE.LineBasicMaterial;
            innerGrid: THREE.LineSegments;
            innerMat: THREE.LineBasicMaterial;
            flow: Line2;
            flowMat: LineMaterial;
            hitMesh: THREE.Mesh;          // invisible solid for raycast
            collapsedY: number;
            expandedY:  number;
            spotlight:  number;            // 0..1 — driven by activeIndex
            expansion:  number;            // 0..1 — driven by ScrollTrigger
            index: number;
        };

        const nodes: LayerNode[] = [];

        layers.forEach((layer, i) => {
            const group = new THREE.Group();

            // Static wireframe (white, faint)
            const wireMat = new THREE.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.18,
            });
            const wireframe = new THREE.LineSegments(edgeGeo, wireMat);
            group.add(wireframe);

            // Top-face internal grid (sliced-cube look)
            const innerGeoArr = buildTopGrid(SLAB_W, SLAB_H, SLAB_D);
            const innerGeo = new THREE.BufferGeometry();
            innerGeo.setAttribute('position', new THREE.Float32BufferAttribute(innerGeoArr, 3));
            const innerMat = new THREE.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.08,
            });
            const innerGrid = new THREE.LineSegments(innerGeo, innerMat);
            group.add(innerGrid);

            // Animated brand-blue dashed perimeter line (Line2 supports thick + dashed + dashOffset)
            const flowGeo = new LineGeometry();
            flowGeo.setPositions(buildTopPerimeter(SLAB_W, SLAB_H, SLAB_D));
            const flowMat = new LineMaterial({
                color: new THREE.Color(layer.color).getHex(),
                linewidth: 2.4,            // pixel-space when worldUnits=false
                worldUnits: false,
                dashed: true,
                dashSize: 0.55,
                gapSize: 0.30,
                transparent: true,
                opacity: 0.85,
            });
            flowMat.resolution.set(width, height);
            const flow = new Line2(flowGeo, flowMat);
            flow.computeLineDistances();
            group.add(flow);

            // Invisible solid for hover raycast (no visible material)
            const hitMat = new THREE.MeshBasicMaterial({
                transparent: true,
                opacity: 0,
                depthWrite: false,
            });
            const hitMesh = new THREE.Mesh(boxGeo, hitMat);
            group.add(hitMesh);

            const collapsedY = i * COLLAPSED_GAP - ((N - 1) * COLLAPSED_GAP) / 2;
            const expandedY  = i * EXPANDED_GAP  - ((N - 1) * EXPANDED_GAP)  / 2;
            group.position.set(0, collapsedY, 0);

            cluster.add(group);
            nodes.push({
                group, wireframe, wireMat, innerGrid, innerMat,
                flow, flowMat, hitMesh,
                collapsedY, expandedY,
                spotlight: 0, expansion: 0, index: i,
            });
        });

        // ── Hover (raycaster) ──
        const ndcRay = new THREE.Vector2(99, 99);
        const raycaster = new THREE.Raycaster();
        let hovered: LayerNode | null = null;

        const onPointerMove = (e: PointerEvent) => {
            const rect = renderer.domElement.getBoundingClientRect();
            const nx = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
            const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            ndcRay.set(nx, ny);
        };
        const onPointerLeave = () => ndcRay.set(99, 99);
        renderer.domElement.addEventListener('pointermove', onPointerMove);
        renderer.domElement.addEventListener('pointerleave', onPointerLeave);

        // ── ScrollTrigger: drive expansion (collapsed → base expanded) on enter ──
        const isMobile = window.matchMedia('(max-width: 900px)').matches;

        const ctx = gsap.context(() => {
            if (!triggerRef.current) return;

            if (!isMobile) {
                nodes.forEach((node, i) => {
                    gsap.to(node, {
                        expansion: 1,
                        ease: 'power3.out',
                        delay: i * 0.05,
                        scrollTrigger: {
                            trigger: triggerRef.current,
                            start: 'top 75%',
                            end:   'top 15%',
                            scrub: 1,
                        },
                    });
                });
                // Subtle stack rotation tied to scroll for parallax depth
                gsap.to(cluster.rotation, {
                    y: THREE.MathUtils.degToRad(-12),
                    ease: 'none',
                    scrollTrigger: {
                        trigger: triggerRef.current,
                        start: 'top bottom',
                        end:   'bottom top',
                        scrub: 1.4,
                    },
                });
            }
        }, mountRef);

        // Idle slow rotation (sine yoyo on top of scroll-driven Y rotation)
        const idleTween = gsap.to(cluster.rotation, {
            x: THREE.MathUtils.degToRad(2),
            duration: 5.5,
            ease: 'sine.inOut',
            yoyo: true,
            repeat: -1,
        });

        // Mobile: skip pin/scroll, expand immediately
        if (isMobile) {
            nodes.forEach(n => { n.expansion = 1; });
        }

        // Public API: parent drives spotlight via activeIndex
        apiRef.current = {
            setActive: (i: number | null) => {
                nodes.forEach((n, idx) => {
                    gsap.to(n, {
                        spotlight: i === idx ? 1 : 0,
                        duration: 0.5,
                        ease: 'power3.out',
                        overwrite: true,
                    });
                });
            },
        };

        // ── Render loop ──
        let raf = 0;
        let running = true;
        let lastTime = performance.now();

        const animate = () => {
            if (!running) return;
            const now = performance.now();
            const dt = Math.min(0.05, (now - lastTime) / 1000);
            lastTime = now;

            // Hover detection
            raycaster.setFromCamera(ndcRay, camera);
            const hits = raycaster.intersectObjects(nodes.map(n => n.hitMesh), false);
            const hitNode = hits[0]
                ? nodes.find(n => n.hitMesh === hits[0].object) ?? null
                : null;
            if (hitNode !== hovered) {
                hovered = hitNode;
                renderer.domElement.style.cursor = hovered ? 'pointer' : 'default';
                onLayerHover?.(hovered ? hovered.index : null);
            }

            // Global "any layer focused" amount (for stack spread boost)
            let maxSpot = 0;
            nodes.forEach(n => { if (n.spotlight > maxSpot) maxSpot = n.spotlight; });

            // Per-layer transforms
            nodes.forEach((n) => {
                const exp = n.expansion;          // 0..1 from scroll
                const spot = n.spotlight;         // 0..1 from activeIndex
                const baseY = n.collapsedY + (n.expandedY - n.collapsedY) * exp;
                const boost = (n.expandedY - n.collapsedY) * (HOVER_BOOST / EXPANDED_GAP) * maxSpot;
                n.group.position.y = baseY + Math.sign(n.expandedY) * boost * 0.5;
                n.group.position.z = spot * 0.8;
                const sc = 1 + spot * 0.06;
                n.group.scale.set(sc, sc, sc);

                // Brightness: hovered → bright; non-hovered when sibling hovered → dim
                const isFocused  = spot > 0.05;
                const dim        = !isFocused ? maxSpot : 0;
                n.wireMat.opacity  = (0.18 + spot * 0.45) * (1 - dim * 0.7);
                n.innerMat.opacity = (0.08 + spot * 0.15) * (1 - dim * 0.85);
                n.flowMat.opacity  = (0.85 + spot * 0.15) * (1 - dim * 0.55);
                n.flowMat.linewidth = 2.4 + spot * 1.6;

                // Animate dash flowing around the perimeter
                n.flowMat.dashOffset = (n.flowMat.dashOffset || 0) - dt * (1.2 + spot * 1.8);
            });

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
            nodes.forEach(n => n.flowMat.resolution.set(w, h));
        };
        const ro = new ResizeObserver(onResize);
        ro.observe(mount);

        // ── Cleanup ──
        return () => {
            running = false;
            cancelAnimationFrame(raf);
            idleTween.kill();
            ctx.revert();
            ScrollTrigger.getAll().forEach(t => {
                if (t.trigger === triggerRef.current) t.kill();
            });
            ro.disconnect();
            renderer.domElement.removeEventListener('pointermove', onPointerMove);
            renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
            nodes.forEach(n => {
                n.wireMat.dispose();
                n.innerMat.dispose();
                n.flowMat.dispose();
                (n.hitMesh.material as THREE.Material).dispose();
                (n.innerGrid.geometry as THREE.BufferGeometry).dispose();
                (n.flow.geometry as LineGeometry).dispose();
            });
            edgeGeo.dispose();
            boxGeo.dispose();
            renderer.dispose();
            if (renderer.domElement.parentNode === mount) {
                mount.removeChild(renderer.domElement);
            }
            apiRef.current = null;
        };
    }, [triggerRef, layers, onLayerHover]);

    useEffect(() => {
        apiRef.current?.setActive(activeIndex);
    }, [activeIndex]);

    return (
        <div
            ref={mountRef}
            style={{ width: '100%', height: '100%', position: 'relative' }}
            aria-label="DeepMarket infrastructure layer stack"
        />
    );
}
