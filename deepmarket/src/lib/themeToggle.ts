import gsap from 'gsap';

/**
 * Circular ripple reveal from the toggle button.
 * GSAP drives the animation — no CSS transition timing issues.
 */
export function rippleThemeToggle(
    e: { currentTarget: HTMLButtonElement },
    currentTheme: 'dark' | 'light',
    setTheme: (t: 'dark' | 'light') => void,
) {
    const newTheme  = currentTheme === 'dark' ? 'light' : 'dark';
    const rect      = e.currentTarget.getBoundingClientRect();
    const cx        = rect.left + rect.width  / 2;
    const cy        = rect.top  + rect.height / 2;

    // Diameter that fully covers the viewport from this point
    const maxD = Math.hypot(
        Math.max(cx, window.innerWidth  - cx),
        Math.max(cy, window.innerHeight - cy),
    ) * 2.4;

    const bg = newTheme === 'light' ? '#eef2f9' : '#04080f';

    // Create the expanding circle
    const circle = document.createElement('div');
    Object.assign(circle.style, {
        position:     'fixed',
        left:         `${cx}px`,
        top:          `${cy}px`,
        width:        '0px',
        height:       '0px',
        borderRadius: '50%',
        background:   bg,
        transform:    'translate(-50%, -50%)',
        zIndex:       '9999',
        pointerEvents:'none',
        opacity:      '1',
    });
    document.body.appendChild(circle);

    // Enable cross-element color morphing while clip expands
    document.documentElement.classList.add('theme-switching');

    gsap.timeline({
        defaults: { ease: 'power3.inOut' },
        onComplete() {
            circle.remove();
            document.documentElement.classList.remove('theme-switching');
        },
    })
    // 0 → full: expand the circle outward
    .to(circle, { width: maxD, height: maxD, duration: 0.7 })
    // At ~45% progress, flip the actual theme under the circle
    .add(() => setTheme(newTheme), 0.28)
    // Once circle is large enough, fade it away to reveal new theme
    .to(circle, { opacity: 0, duration: 0.35, ease: 'power2.out' }, 0.55);
}
