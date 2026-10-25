/**
 * Factions-reputation wave: the standings panel — a read-only HUD list
 * of the player's faction standings (name, tier, numeric value, bar).
 *
 * DOM pattern follows QuestTracker (absolute in the engine container,
 * self-contained inline styles, injectable `doc` for unit tests).
 * Event-driven, not per-frame: the blueprint re-renders it from the
 * standings onChange hook, so there is zero per-frame DOM cost.
 *
 * Placement: top-left below the objective panel (top:150px clears the
 * objective block, which sits at top:16px). pointer-events:none so it
 * never eats input. Compact CSS under 760px so it fits 360x780.
 */
import type { StandingTier } from '../game/factions';

export interface StandingsPanelRow {
  id: string;
  name: string;
  standing: number;
  tier: StandingTier;
}

const AMBER = '#ffb545';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class StandingsPanel {
  private root: HTMLElement;
  private listEl: HTMLElement;
  private disposed = false;

  constructor(
    private container: HTMLElement,
    private doc: Document = globalThis.document,
  ) {
    const root = el(doc, 'div', [
      'position:absolute', 'left:16px', 'top:150px', 'max-width:230px',
      'z-index:9400', 'pointer-events:none', 'display:none',
      'background:rgba(8,10,16,0.72)', `border:1px solid ${AMBER}59`,
      'border-radius:10px', 'padding:8px 12px 10px',
      'font-family:system-ui,-apple-system,sans-serif', 'color:#e8ecf4',
    ].join(';'));
    root.id = 'xandria-standings-panel';
    root.setAttribute('aria-live', 'polite');

    const head = el(doc, 'div',
      `font-size:10px;font-weight:700;letter-spacing:0.22em;color:${AMBER};margin-bottom:6px`,
      '◆ FACTIONS');
    const list = el(doc, 'div', 'display:flex;flex-direction:column;gap:6px');
    root.append(head, list);
    const style = el(doc, 'style', '', [
      '@media (max-width:760px){',
      '#xandria-standings-panel{top:128px;left:10px;max-width:180px;padding:6px 9px 8px;}',
      '#xandria-standings-panel .sf{font-size:11px;}',
      '#xandria-standings-panel .st{font-size:10px;}',
      '}',
    ].join(''));
    root.append(style);
    container.appendChild(root);
    this.root = root;
    this.listEl = list;
  }

  /** Render the live standings snapshot; always visible once rendered. */
  render(rows: StandingsPanelRow[]): void {
    if (this.disposed) return;
    while (this.listEl.firstChild) this.listEl.firstChild.remove();
    for (const r of rows) {
      const wrap = el(this.doc, 'div', '');
      const name = el(this.doc, 'div',
        'font-size:12.5px;font-weight:700;letter-spacing:0.04em;color:#ffcf7a',
        `${r.name} — ${r.tier.name} (${r.standing})`);
      name.className = 'sf';
      name.setAttribute('data-faction-row', r.id);
      // bar: standing mapped from [-1000,1000] to [0,100]%
      const pct = Math.max(0, Math.min(100, Math.round(((r.standing + 1000) / 2000) * 100)));
      const bar = el(this.doc, 'div',
        'height:6px;border-radius:3px;background:rgba(255,255,255,0.14);margin-top:3px;overflow:hidden');
      const fill = el(this.doc, 'div',
        `height:100%;width:${pct}%;background:${AMBER};border-radius:3px`);
      bar.append(fill);
      wrap.append(name, bar);
      this.listEl.append(wrap);
    }
    this.root.style.display = 'block';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.remove();
  }
}
