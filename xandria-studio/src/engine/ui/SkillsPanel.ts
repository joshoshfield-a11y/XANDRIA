/**
 * Skills wave: the skills UI panel.
 *
 * DOM pattern follows CraftingPanel (absolute in the engine container,
 * self-contained inline styles, capture-phase key handling). Lists every
 * skill with its rank, XP progress bar, honest per-rank effect lines, and
 * the recipes each skill gates (locked vs unlocked from the live
 * SkillSystem ranks).
 *
 * Open/close: the `K` key (capture phase) toggles; Esc closes. A small
 * floating "SKILLS" chip in the corner gives touch users the same toggle
 * (native <button>, keyboard-focusable too). The chip hides while the
 * panel is open. The panel never opens while another modal owns input
 * (the crafting panel), via the isModalOpen predicate.
 *
 * The `doc` param is injectable so unit tests can pass a minimal DOM stub.
 */
import type { ItemDef } from '@spec';
import {
  type CraftingRecipe,
  type CraftingInventory,
} from '../game/crafting';
import {
  type SkillDef,
  type SkillSystem,
} from '../game/skills';

export interface SkillsPanelOpts {
  container: HTMLElement;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** live skill system (null = panel shows "no skill data") */
  skills: () => SkillSystem | null;
  /** the seeded recipe pool for this spec (buildRecipePool — pure) */
  recipes: () => CraftingRecipe[];
  /** item def table (recipe output names) */
  defs: () => Record<string, ItemDef>;
  /** live inventory sink (unused for gating display, kept for parity) */
  inventory: () => CraftingInventory | null;
  /** ids of stations present in this map */
  stationIds: () => ReadonlySet<string>;
  /** player progression level for minLevel gates */
  playerLevel: () => number;
  /** true while another modal (the crafting panel) owns input */
  isModalOpen?: () => boolean;
}

const AMBER = '#ffb545';
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

export class SkillsPanel {
  private root: HTMLElement;
  private cardsEl: HTMLElement;
  private chip: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;

  constructor(private readonly opts: SkillsPanelOpts) {
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container;

    const root = el(doc, 'div', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9600', 'width:min(440px,94vw)', 'max-height:84vh',
      'display:none', 'flex-direction:column',
      `background:${PANEL_BG}`, `border:1px solid ${AMBER}73`, 'border-radius:12px',
      'font-family:system-ui,-apple-system,sans-serif', `color:${TEXT}`,
      'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
    ].join(';'));
    root.id = 'xandria-skills-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Skills');

    // header
    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${AMBER}33`,
    ].join(';'));
    const title = el(doc, 'div', `font-size:15px;font-weight:700;color:${AMBER};letter-spacing:0.05em`, 'SKILLS');
    const sub = el(doc, 'div', `font-size:12px;color:${DIM}`, 'Earn XP from the world — ranks unlock recipes');
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close skills panel');
    close.addEventListener('click', () => this.hide());
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    headLeft.append(title, sub);
    head.append(headLeft, close);

    // skill cards (scrollable)
    this.cardsEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 10px', 'display:flex',
      'flex-direction:column', 'gap:8px', 'min-height:120px',
    ].join(';'));

    const foot = el(doc, 'div', [
      'padding:8px 14px 10px', `font-size:11px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'K / Esc to close');

    root.append(head, this.cardsEl, foot);
    container.appendChild(root);
    this.root = root;

    // floating chip — the touch + mouse entry point (native button)
    const chip = el(doc, 'button', [
      'position:absolute', 'right:12px', 'top:12px', 'z-index:9500',
      `background:${PANEL_BG}`, `border:1px solid ${AMBER}73`, 'border-radius:8px',
      `color:${AMBER}`, 'font-size:12px', 'font-weight:700', 'font-family:inherit',
      'letter-spacing:0.06em', 'padding:8px 12px', 'cursor:pointer',
    ].join(';'), 'SKILLS') as HTMLButtonElement;
    chip.id = 'xandria-skills-chip';
    chip.setAttribute('aria-label', 'Open skills panel');
    chip.addEventListener('click', () => this.toggle());
    container.appendChild(chip);
    this.chip = chip;

    // Capture phase: the panel owns K/Escape. While closed, K opens (but
    // never while another modal owns input or the user is typing).
    this.onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      if (this.open_) {
        if (e.code === 'Escape' || e.code === 'KeyK') {
          e.stopPropagation();
          e.preventDefault();
          this.hide();
        }
        return;
      }
      if (e.code === 'KeyK' && !(this.opts.isModalOpen?.() ?? false)) {
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
  }

  hide(): void {
    if (this.disposed) return;
    this.root.style.display = 'none';
    this.chip.style.display = '';
    this.open_ = false;
  }

  toggle(): void {
    if (this.open_) this.hide();
    else this.show();
  }

  /** Re-render the cards (call after XP changes while open). */
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
    this.root.remove();
    this.chip.remove();
  }

  // ------------------------------------------------------------ cards

  private renderCards(): void {
    const doc = this.opts.doc ?? globalThis.document;
    const skills = this.opts.skills();
    while (this.cardsEl.firstChild) this.cardsEl.firstChild.remove();
    if (!skills) {
      this.cardsEl.append(el(doc, 'div', `font-size:13px;color:${DIM};padding:12px 4px`, 'No skill data in this scene.'));
      return;
    }
    for (const def of skills.defs()) {
      this.cardsEl.append(this.skillCard(doc, skills, def));
    }
  }

  private skillCard(doc: Document, skills: SkillSystem, def: SkillDef): HTMLElement {
    const card = el(doc, 'div', [
      'border:1px solid rgba(255,255,255,0.09)', 'border-radius:8px',
      'padding:10px 12px', 'display:flex', 'flex-direction:column', 'gap:6px',
      'background:rgba(255,255,255,0.025)',
    ].join(';'));

    const rank = skills.rankOf(def.id);
    const maxRank = def.xpThresholds.length;
    const top = el(doc, 'div', 'display:flex;align-items:baseline;justify-content:space-between;gap:8px');
    top.append(
      el(doc, 'div', 'font-size:13.5px;font-weight:700', def.name),
      el(doc, 'div', `font-size:12px;color:${AMBER}`, `RANK ${rank}/${maxRank}`),
    );
    card.append(top);
    card.append(el(doc, 'div', `font-size:12px;color:${DIM}`, def.desc));

    // XP progress bar
    const need = skills.xpForNextRank(def.id);
    const xp = skills.xpOf(def.id);
    const barLabel = need === null
      ? `MAX RANK — ${xp} XP`
      : `${xp} / ${def.xpThresholds[rank]} XP to rank ${rank + 1}`;
    card.append(el(doc, 'div', `font-size:11.5px;color:${DIM}`, barLabel));
    const track = el(doc, 'div', 'height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden');
    const bar = el(doc, 'div', `height:100%;width:${Math.round(skills.progressToNext(def.id) * 100)}%;background:${AMBER};border-radius:3px`);
    track.append(bar);
    card.append(track);

    // per-rank effect lines; the current rank reads bright, the rest dim
    const fx = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    def.effects.forEach((line, i) => {
      const cur = i === rank - 1;
      fx.append(el(doc, 'div', `font-size:11.5px;color:${cur ? TEXT : DIM};${cur ? 'font-weight:600' : ''}`, (cur ? '▸ ' : '· ') + line));
    });
    card.append(fx);

    // gated recipes for this skill, with honest lock state
    const gated = this.opts.recipes().filter((r) => r.skillId === def.id);
    if (gated.length) {
      const list = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
      list.append(el(doc, 'div', `font-size:11px;font-weight:700;color:${DIM};letter-spacing:0.08em`, 'GATED RECIPES'));
      for (const r of gated) {
        const req = r.minSkillRank ?? 1;
        const locked = rank < req;
        const outName = this.opts.defs()[r.output.itemId]?.name ?? r.output.itemId;
        list.append(el(doc, 'div', `font-size:11.5px;color:${locked ? LOCKED : UNLOCKED}`,
          `${locked ? 'LOCKED' : 'UNLOCKED'} — ${r.name} → ${outName} (requires rank ${req})`));
      }
      card.append(list);
    }
    return card;
  }
}
