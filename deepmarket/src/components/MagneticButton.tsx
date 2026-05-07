import { useRef, type ReactNode, type HTMLAttributes } from 'react';
import gsap from 'gsap';

interface Props extends HTMLAttributes<HTMLDivElement> {
    children: ReactNode;
    strength?: number;
    className?: string;
}

export default function MagneticButton({
    children,
    strength = 30,
    className,
    style,
    ...rest
}: Props) {
    const wrapRef    = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
        const wrap = wrapRef.current;
        const content = contentRef.current;
        if (!wrap || !content) return;
        const r = wrap.getBoundingClientRect();
        const x = e.clientX - r.left - r.width  / 2;
        const y = e.clientY - r.top  - r.height / 2;
        gsap.to(content, {
            x: (x / r.width)  * strength,
            y: (y / r.height) * strength,
            duration: 0.45,
            ease: 'power3.out',
            overwrite: true,
        });
    };

    const onLeave = () => {
        if (!contentRef.current) return;
        gsap.to(contentRef.current, {
            x: 0, y: 0,
            duration: 0.6,
            ease: 'elastic.out(1, 0.4)',
            overwrite: true,
        });
    };

    return (
        <div
            ref={wrapRef}
            onMouseMove={onMove}
            onMouseLeave={onLeave}
            className={className}
            style={{ display: 'inline-block', ...style }}
            {...rest}
        >
            <div ref={contentRef} style={{ display: 'inline-block', willChange: 'transform' }}>
                {children}
            </div>
        </div>
    );
}
