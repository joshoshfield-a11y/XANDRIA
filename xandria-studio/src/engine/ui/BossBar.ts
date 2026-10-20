/**
 * Boss-fights wave: the boss health bar — a DOM component in the QuestTracker
 * mold. Event-driven, not per-frame: setHealth/setPhase/show/hide only touch
 * the DOM when the value actually changed, so a bound boss costs zero DOM
 * writes on frames where its health didn't move, and a hidden bar costs
 * nothing at all.
 *
 * Placement: top-center. pointer-events:none so it never eats input.
 * Compact CSS under 760px so it fits 360x780.
 */
const RED = '#ff4d3d';
const AMBER = '#ffb545';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class BossBar {
  private root: HTMLElement;
  private nameEl: HTMLElement;
  private phaseEl: HTMLElement;
  private fillEl: HTMLElement;
  private disposed = false;
  private lastName: string | null = null;
  private lastFrac = -1;
  private lastPhase: string | null = null;
  private visible = false;

  constructor(
    container: HTMLElement,
    private doc: Document = globalThis.document,
  ) {
    const root = el(doc, 'div', [
      'position:absolute', 'top:14px', 'left:50%', 'transform:translateX(-50%)',
      'width:min(460px,72vw)', 'z-index:9400', 'pointer-events:none',
      'display:none', 'text-align:center',
      'font-family:system-ui,-apple-system,sans-serif',
    ].join(';'));
    root.id = 'xandria-boss-bar';
    root.setAttribute('aria-live', 'off');

    const name = el(doc, 'div',
      `font-size:13px;font-weight:800;letter-spacing:0.28em;color:${RED};text-shadow:0 0 12px ${RED}66;margin-bottom:4px`,
      '');
    name.className = 'bb-name';
    const track = el(doc, 'div', [
      'height:12px', 'border-radius:6px', 'overflow:hidden',
      'background:rgba(10,8,8,0.78)', `border:1px solid ${RED}55`,
      'box-shadow:0 0 18px rgba(255,77,61,0.25)',
    ].join(';'));
    const fill = el(doc, 'div',
      `height:100%;width:100%;border-radius:6px;background:linear-gradient(90deg,#ff2a1a,${RED});transition:width 120ms linear`, '');
    fill.className = 'bb-fill';
    track.append(fill);
    const phase = el(doc, 'div',
      `font-size:10px;font-weight:700;letter-spacing:0.22em;color:${AMBER};margin-top:4px;opacity:0.9`,
      '');
    phase.className = 'bb-phase';
    root.append(name, track, phase);
    const style = el(doc, 'style', '', [
      '@media (max-width:760px){',
      '#xandria-boss-bar{top:10px;}',
      '#xandria-boss-bar .bb-name{font-size:11px;letter-spacing:0.2em;}',
      '#xandria-boss-bar .bb-phase{font-size:9px;}',
      '}',
    ].join(''));
    root.append(style);
    container.appendChild(root);
    this.root = root;
    this.nameEl = name;
    this.phaseEl = phase;
    this.fillEl = fill;
  }

  /** Show the bar for a boss (name set once; no-op when already shown). */
  show(name: string): void {
    if (this.disposed) return;
    if (!this.visible) { this.visible = true; this.root.style.display = 'block'; }
    if (name !== this.lastName) { this.lastName = name; this.nameEl.textContent = name; }
  }

  /** Health fraction 0..1 — writes the DOM only when the value moved. */
  setHealth(frac: number): void {
    if (this.disposed || !this.visible) return;
    // quantize to 0.1%: sub-pixel width changes are invisible, and this
    // keeps a boss under sustained damage from writing the DOM per frame
    const q = Math.round(Math.max(0, Math.min(1, frac)) * 1000);
    if (q === this.lastFrac) return;
    this.lastFrac = q;
    this.fillEl.style.width = `${q / 10}%`;
  }

  /** Phase label — writes the DOM only when the phase changed. */
  setPhase(phase: string): void {
    if (this.disposed || !this.visible) return;
    if (phase === this.lastPhase) return;
    this.lastPhase = phase;
    this.phaseEl.textContent = phase.toUpperCase();
  }

  /** Hide the bar (boss dead, map left, flag off). */
  hide(): void {
    if (this.disposed) return;
    if (!this.visible) return;
    this.visible = false;
    this.root.style.display = 'none';
    this.lastName = null;
    this.lastFrac = -1;
    this.lastPhase = null;
  }

  get isVisible(): boolean { return this.visible; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.remove();
  }
}
