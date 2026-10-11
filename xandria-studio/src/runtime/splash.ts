/**
 * "Made with XANDRIA" splash overlay for exported/previewed games.
 *
 * Flag resolution (first match wins):
 *   1. ?splash=0|1 query param  (studio preview iframe, share links)
 *   2. window.__XANDRIA_SPLASH__ boolean  (baked into standalone exports)
 *   3. default ON  (free tier / unknown provenance always shows it)
 *
 * When enabled the splash is UNSKIPPABLE: a full-screen overlay for ~3s
 * with no dismiss control. Paid tiers remove it via the studio toggle.
 */

export const SPLASH_DURATION_MS = 3000;

/** Production generator URL used as the splash link target when the caller
 *  doesn't supply one (e.g. a standalone exported file opened from disk). */
export const DEFAULT_GENERATOR_URL =
  'https://xandria-taylorchristian-mattheisens-projects.vercel.app';

/**
 * Pure flag resolution. `search` is a location.search-style string
 * ("?splash=0"); `winFlag` is the value of window.__XANDRIA_SPLASH__.
 */
export function resolveSplash(search: string, winFlag: unknown): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  if (params.has('splash')) {
    const v = params.get('splash')!.trim().toLowerCase();
    // Explicit values win; anything else falls through to the window flag.
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  }
  if (typeof winFlag === 'boolean') return winFlag;
  return true;
}

export interface SplashOptions {
  /** Link target for "make your own" — defaults to DEFAULT_GENERATOR_URL. */
  generatorUrl?: string;
  /** Override the 3s duration (tests). */
  durationMs?: number;
}

/**
 * Show the unskippable splash overlay. Non-blocking: the game boots
 * underneath while the overlay covers the screen for `durationMs`.
 */
export function showSplash(opts: SplashOptions = {}): void {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('xandria-splash')) return;
  const duration = opts.durationMs ?? SPLASH_DURATION_MS;
  const url = opts.generatorUrl ?? DEFAULT_GENERATOR_URL;

  const overlay = document.createElement('div');
  overlay.id = 'xandria-splash';
  overlay.setAttribute('role', 'presentation');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99998',
    'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
    'gap:14px', 'background:#0a0d14', 'color:#dfe6ef',
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
    'pointer-events:all', 'user-select:none',
    'transition:opacity .4s ease',
  ].join(';');

  const mark = document.createElement('div');
  mark.textContent = '✦';
  mark.style.cssText = 'font-size:34px;color:#7af7ff;';

  const title = document.createElement('div');
  title.textContent = 'MADE WITH XANDRIA';
  title.style.cssText = 'font-size:20px;letter-spacing:.35em;color:#7af7ff;font-weight:600;';

  const sub = document.createElement('div');
  sub.textContent = 'intent → playable game';
  sub.style.cssText = 'font-size:11px;letter-spacing:.3em;color:#5a6a85;';

  const link = document.createElement('a');
  link.textContent = 'make your own →';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  // The link is decorative credit, not a skip: clicks open a new tab while
  // the splash still runs its full duration in this one.
  link.style.cssText = 'font-size:12px;letter-spacing:.2em;color:#3fd8ff;';

  overlay.append(mark, title, sub, link);
  document.body.appendChild(overlay);

  setTimeout(() => {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 450);
  }, duration);
}
