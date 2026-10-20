/**
 * Quest wave: the HUD quest tracker — a read-only panel listing the active
 * quest line with per-objective progress. Owned by the blueprint (like the
 * CraftingPanel), refreshed by the QuestManager whenever quest state changes
 * (event-driven, not per-frame — no per-frame DOM cost).
 *
 * Placement: top-right below the score panel. pointer-events:none so it
 * never eats input. Compact CSS under 760px so it fits 360x780.
 */
export interface QuestTrackerQuest {
  name: string;
  status: 'active' | 'complete';
  lines: string[];
}

const AMBER = '#ffb545';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class QuestTracker {
  private root: HTMLElement;
  private listEl: HTMLElement;
  private disposed = false;
  /**
   * HUD-polish: fired after every render. Blueprints wire it to
   * `engine.touch.repositionPauseButton()` so the touch pause button stays
   * clear of the tracker when quests appear/change height mid-run.
   */
  onRender: (() => void) | null = null;

  constructor(
    private container: HTMLElement,
    private doc: Document = globalThis.document,
  ) {
    const root = el(doc, 'div', [
      // HUD-polish: `top` lives in the <style> block below (not inline) so
      // the .xboss boss-fight shift can override it. Desktop top:136px
      // clears the score panel (measured 108px with timer + lives) with
      // margin; the old 118px overlapped the panel's bottom edge by 6px.
      'position:absolute', 'right:16px', 'max-width:250px',
      'z-index:9400', 'pointer-events:none', 'display:none',
      'background:rgba(8,10,16,0.72)', `border:1px solid ${AMBER}59`,
      'border-radius:10px', 'padding:8px 12px 10px',
      'font-family:system-ui,-apple-system,sans-serif', 'color:#e8ecf4',
    ].join(';'));
    root.id = 'xandria-quest-tracker';
    root.setAttribute('aria-live', 'polite');

    const head = el(doc, 'div',
      `font-size:10px;font-weight:700;letter-spacing:0.22em;color:${AMBER};margin-bottom:6px`,
      '◆ QUESTS');
    const list = el(doc, 'div', 'display:flex;flex-direction:column;gap:8px');
    root.append(head, list);
    // compact on small screens (360x780): narrower, tighter type.
    // .xboss shifts everything down 36px while a boss bar is up (mobile
    // audit: the centered boss bar otherwise paints over the objective /
    // score panels on 360px widths).
    const style = el(doc, 'style', '', [
      '#xandria-quest-tracker{top:136px;}',
      '@media (max-width:760px){',
      '#xandria-quest-tracker{top:106px;right:10px;max-width:196px;padding:6px 9px 8px;}',
      '#xandria-quest-tracker .qq{font-size:11px;}',
      '#xandria-quest-tracker .qo{font-size:10px;}',
      // .xboss: the shifted score panel's bottom edge is 48+101=149px on
      // small screens — 158px clears it with margin (the naive 106+36=142
      // overlapped by 7px; caught by the hud-polish e2e audit).
      '.xboss #xandria-quest-tracker{top:158px;}',
      '}',
    ].join(''));
    root.append(style);
    container.appendChild(root);
    this.root = root;
    this.listEl = list;
  }

  /** Render the live quest snapshot; empty = hidden. */
  render(quests: QuestTrackerQuest[]): void {
    if (this.disposed) return;
    while (this.listEl.firstChild) this.listEl.firstChild.remove();
    if (quests.length === 0) {
      this.root.style.display = 'none';
      this.onRender?.();
      return;
    }
    for (const q of quests) {
      const wrap = el(this.doc, 'div', '');
      const name = el(this.doc, 'div',
        `font-size:12.5px;font-weight:700;letter-spacing:0.04em;color:${q.status === 'complete' ? '#8dffa0' : '#ffcf7a'}`,
        `${q.status === 'complete' ? '✓ ' : ''}${q.name}`);
      name.className = 'qq';
      wrap.append(name);
      for (const line of q.lines) {
        const l = el(this.doc, 'div', 'font-size:11px;opacity:0.88;margin-top:2px;line-height:1.4', line);
        l.className = 'qo';
        wrap.append(l);
      }
      this.listEl.append(wrap);
    }
    this.root.style.display = 'block';
    this.onRender?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.remove();
  }
}
