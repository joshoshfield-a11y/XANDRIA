/**
 * Open World — Portals, workstream B: the loading-screen overlay.
 *
 * Fade out → brief loader ("Entering new territory" + map coords + spinner)
 * → fade in. Pure DOM, modeled on the HUD overlay pattern (absolute in the
 * engine container, no pointer-events leaks). The overlay blocks pointer
 * input while covered so the player can't fight the transition.
 *
 * Timing is setTimeout-based (not transitionend): reliable headless and on
 * the mobile viewport, and it keeps working while the main thread is busy
 * building the next map.
 */
export class PortalTransitionOverlay {
  private root: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private subEl: HTMLDivElement;
  private covered = false;
  private disposed = false;

  constructor(container: HTMLElement) {
    const root = document.createElement('div');
    root.id = 'xandria-portal-transition';
    root.setAttribute('aria-live', 'polite');
    root.style.cssText = [
      'position:absolute', 'inset:0', 'z-index:9000',
      'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
      'gap:14px', 'background:rgba(6,8,14,0.96)',
      'opacity:0', 'pointer-events:none',
      'transition:opacity 300ms ease',
      'font-family:system-ui,-apple-system,sans-serif', 'color:#e8ecf4',
      'text-align:center', 'padding:24px',
    ].join(';');

    const spinner = document.createElement('div');
    spinner.style.cssText = [
      'width:44px', 'height:44px', 'border-radius:50%',
      'border:4px solid rgba(255,194,63,0.25)', 'border-top-color:#ffc23f',
      'animation:xandria-portal-spin 0.9s linear infinite',
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'font-size:22px;font-weight:600;letter-spacing:0.02em';
    title.textContent = 'Entering new territory';

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:13px;opacity:0.72';

    const style = document.createElement('style');
    style.textContent =
      '@keyframes xandria-portal-spin { to { transform: rotate(360deg); } }';
    root.append(style, spinner, title, sub);
    container.appendChild(root);
    this.root = root;
    this.titleEl = title;
    this.subEl = sub;
  }

  get isCovered(): boolean { return this.covered; }

  /** Fade out and show the loader. Resolves once the screen is fully covered. */
  cover(title = 'Entering new territory', sub = ''): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.titleEl.textContent = title;
    this.subEl.textContent = sub;
    this.subEl.style.display = sub ? '' : 'none';
    this.root.style.pointerEvents = 'auto';
    // force a style recalc so the opacity transition actually runs
    void this.root.offsetWidth;
    this.root.style.opacity = '1';
    return new Promise((resolve) => {
      setTimeout(() => {
        if (!this.disposed) this.covered = true;
        resolve();
      }, 330);
    });
  }

  /** Hide the loader and fade back in. Resolves once the screen is clear. */
  reveal(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.root.style.opacity = '0';
    this.root.style.pointerEvents = 'none';
    return new Promise((resolve) => {
      setTimeout(() => {
        if (!this.disposed) this.covered = false;
        resolve();
      }, 330);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.root.remove();
  }
}
