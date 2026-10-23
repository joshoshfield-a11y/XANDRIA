/**
 * Achievements wave: the achievement codex panel.
 *
 * DOM pattern follows SkillsPanel (absolute in the engine container,
 * self-contained inline styles, capture-phase key handling, native buttons
 * for touch). Lists every achievement in table order with unlocked/locked
 * states, a progress bar for countable triggers, and the reward line.
 *
 * Open/close: the `J` key (capture phase) toggles; Esc closes. A small
 * floating trophy chip in the corner gives touch users the same toggle.
 * The panel never opens while another modal owns input, via the
 * isModalOpen predicate. Unlocks refresh the open panel live through the
 * manager's onUnlocked subscription.
 *
 * The `doc` param is injectable so unit tests can pass a minimal DOM stub.
 */
import {
  type AchievementDef,
  type AchievementManager,
} from '../game/achievements';

export interface AchievementsPanelOpts {
  container: HTMLElement;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** live achievement manager (null = panel shows "no data") */
  achievements: () => AchievementManager | null;
  /** true while another modal (crafting panel / dialogue) owns input */
  isModalOpen?: () => boolean;
}

const AMBER = '#ffb545';
const GOLD = '#ffd76a';
const PANEL_BG = 'rgba(8,10,16,0.96)';
const TEXT = '#e8ecf4';
const DIM = '#9aa4b8';
const LOCKED = '#ff9a8a';
const UNLOCKED = '#8fe3a8';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

function rewardLine(def: AchievementDef): string {
  const parts: string[] = [];
  if (def.reward.xp) parts.push(`+${def.reward.xp} XP`);
  if (def.reward.score) parts.push(`+${def.reward.score} score`);
  return parts.length ? `Reward: ${parts.join(' · ')}` : 'No reward';
}

export class AchievementsPanel {
  private root: HTMLElement;
  private cardsEl: HTMLElement;
  private countEl: HTMLElement;
  private chip: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private unsubUnlock: (() => void) | null = null;
  private disposed = false;
  private open_ = false;

  constructor(private readonly opts: AchievementsPanelOpts) {
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container;

    const root = el(doc, 'div', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9600', 'width:min(440px,94vw)', 'max-height:84vh',
      'display:none', 'flex-direction:column',
      `background:${PANEL_BG}`, `border:1px solid ${GOLD}73`, 'border-radius:12px',
      'font-family:system-ui,-apple-system,sans-serif', `color:${TEXT}`,
      'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
    ].join(';'));
    root.id = 'xandria-achievements-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Achievements');

    // header
    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${GOLD}33`,
    ].join(';'));
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    headLeft.append(
      el(doc, 'div', `font-size:15px;font-weight:700;color:${GOLD};letter-spacing:0.05em`, '🏆 ACHIEVEMENTS'),
      el(doc, 'div', `font-size:12px;color:${DIM}`, 'Deeds of the run — progress persists across portals and reloads'),
    );
    this.countEl = el(doc, 'div', `font-size:12px;color:${DIM}`, '');
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close achievements panel');
    close.addEventListener('click', () => this.hide());
    const headRight = el(doc, 'div', 'display:flex;align-items:center;gap:10px');
    headRight.append(this.countEl, close);
    head.append(headLeft, headRight);

    // achievement cards (scrollable)
    this.cardsEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 10px', 'display:flex',
      'flex-direction:column', 'gap:8px', 'min-height:120px',
    ].join(';'));

    const foot = el(doc, 'div', [
      'padding:8px 14px 10px', `font-size:11px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'J / Esc to close');

    root.append(head, this.cardsEl, foot);
    container.appendChild(root);
    this.root = root;

    // floating chip — the touch + mouse entry point (native button)
    const chip = el(doc, 'button', [
      'position:absolute', 'right:12px', 'top:52px', 'z-index:9500',
      `background:${PANEL_BG}`, `border:1px solid ${GOLD}73`, 'border-radius:8px',
      `color:${GOLD}`, 'font-size:14px', 'font-weight:700', 'font-family:inherit',
      'padding:8px 10px', 'cursor:pointer', 'min-width:44px', 'min-height:44px',
    ].join(';'), '🏆') as HTMLButtonElement;
    chip.id = 'xandria-achievements-chip';
    chip.setAttribute('aria-label', 'Open achievements panel');
    chip.addEventListener('click', () => this.toggle());
    container.appendChild(chip);
    this.chip = chip;

    // Capture phase: the panel owns J/Escape. While closed, J opens (but
    // never while another modal owns input or the user is typing).
    this.onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      if (this.open_) {
        if (e.code === 'Escape' || e.code === 'KeyJ') {
          e.stopPropagation();
          e.preventDefault();
          this.hide();
        }
        return;
      }
      if (e.code === 'KeyJ' && !(this.opts.isModalOpen?.() ?? false)) {
        e.stopPropagation();
        e.preventDefault();
        this.show();
      }
    };
    const w = (doc as Document & { defaultView?: Window }).defaultView ?? (globalThis as unknown as { window?: Window }).window;
    w?.addEventListener('keydown', this.onKey, true);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Visible for tests: the floating toggle chip. */
  get chipEl(): HTMLElement {
    return this.chip;
  }

  show(): void {
    if (this.disposed) return;
    if (this.opts.isModalOpen?.() ?? false) return;
    this.root.style.display = 'flex';
    this.chip.style.display = 'none';
    this.open_ = true;
    this.renderCards();
    if (!this.unsubUnlock) {
      const mgr = this.opts.achievements();
      if (mgr) this.unsubUnlock = mgr.onUnlocked(() => this.refresh());
    }
  }

  hide(): void {
    if (this.disposed) return;
    this.root.style.display = 'none';
    this.chip.style.display = '';
    this.open_ = false;
    if (this.unsubUnlock) {
      this.unsubUnlock();
      this.unsubUnlock = null;
    }
  }

  toggle(): void {
    if (this.open_) this.hide();
    else this.show();
  }

  /** Re-render the cards (call after unlocks while open). */
  refresh(): void {
    if (this.disposed || !this.open_) return;
    this.renderCards();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.open_ = false;
    this.root.style.display = 'none';
    const w = (this.opts.doc as (Document & { defaultView?: Window }) | undefined)?.defaultView
      ?? (globalThis as unknown as { window?: Window }).window;
    w?.removeEventListener('keydown', this.onKey, true);
    if (this.unsubUnlock) {
      this.unsubUnlock();
      this.unsubUnlock = null;
    }
    this.root.remove();
    this.chip.remove();
  }

  // ------------------------------------------------------------ cards

  private renderCards(): void {
    const doc = this.opts.doc ?? globalThis.document;
    const mgr = this.opts.achievements();
    while (this.cardsEl.firstChild) this.cardsEl.firstChild.remove();
    if (!mgr) {
      this.countEl.textContent = '';
      this.cardsEl.append(el(doc, 'div', `font-size:13px;color:${DIM};padding:12px 4px`, 'No achievement data in this scene.'));
      return;
    }
    const defs = mgr.defs();
    const unlocked = defs.filter((d) => mgr.isUnlocked(d.id)).length;
    this.countEl.textContent = `${unlocked} / ${defs.length}`;
    for (const def of defs) {
      this.cardsEl.append(this.achievementCard(doc, mgr, def));
    }
  }

  private achievementCard(doc: Document, mgr: AchievementManager, def: AchievementDef): HTMLElement {
    const done = mgr.isUnlocked(def.id);
    const card = el(doc, 'div', [
      `border:1px solid ${done ? `${GOLD}66` : 'rgba(255,255,255,0.09)'}`,
      'border-radius:8px', 'padding:10px 12px', 'display:flex',
      'flex-direction:column', 'gap:6px',
      `background:${done ? 'rgba(255,215,106,0.06)' : 'rgba(255,255,255,0.025)'}`,
    ].join(';'));
    card.setAttribute('data-achievement-id', def.id);
    card.setAttribute('data-achievement-state', done ? 'unlocked' : 'locked');

    const top = el(doc, 'div', 'display:flex;align-items:baseline;justify-content:space-between;gap:8px');
    top.append(
      el(doc, 'div', `font-size:13.5px;font-weight:700;color:${done ? GOLD : TEXT}`, `${done ? '🏆 ' : ''}${def.name}`),
      el(doc, 'div', `font-size:11px;font-weight:700;letter-spacing:0.06em;color:${done ? UNLOCKED : LOCKED}`,
        done ? 'UNLOCKED' : 'LOCKED'),
    );
    card.append(top);
    card.append(el(doc, 'div', `font-size:12px;color:${DIM}`, def.description));

    // progress bar for countable triggers
    const prog = mgr.progressOf(def.id);
    if (!done && prog) {
      const pct = prog.target > 0 ? Math.min(100, Math.round((prog.current / prog.target) * 100)) : 0;
      card.append(el(doc, 'div', `font-size:11.5px;color:${DIM}`, `${prog.current} / ${prog.target}`));
      const track = el(doc, 'div', 'height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden');
      const bar = el(doc, 'div', `height:100%;width:${pct}%;background:${AMBER};border-radius:3px`);
      track.append(bar);
      card.append(track);
    }
    card.append(el(doc, 'div', `font-size:11.5px;color:${DIM}`, rewardLine(def)));
    return card;
  }
}
