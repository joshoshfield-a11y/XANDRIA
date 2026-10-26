/**
 * UPGRADE LOOP (companion-system): the companion panel.
 *
 * DOM pattern follows SkillsPanel (absolute in the engine container,
 * self-contained inline styles, capture-phase key handling). Lists the
 * three companions with their HP, a rename input per entry, SUMMON /
 * SELECT and DISMISS controls, and the "Heal at campfire" button (which
 * refuses honestly when no campfire is live — the manager owns the gate).
 *
 * Open/close: the `N` key (capture phase) toggles; Esc closes. A small
 * floating "COMPANIONS" chip in the corner gives touch users the same
 * toggle (native <button>, keyboard-focusable too). The chip sits below
 * the skills (top:12) and achievements/bestiary (top:52) chips so the
 * three never overlap at 360x780. The panel never opens while another
 * modal owns input, via the isModalOpen predicate.
 *
 * The `doc` param is injectable so unit tests can pass a minimal DOM stub.
 */
import {
  companionDefOf,
  type CompanionsManager,
} from '../game/companions';

export interface CompanionPanelOpts {
  container: HTMLElement;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** live companions manager (null = panel shows "no companion data") */
  manager: () => CompanionsManager | null;
  /** true while another modal owns input */
  isModalOpen?: () => boolean;
}

const AMBER = '#ffb545';
const PANEL_BG = 'rgba(8,10,16,0.96)';
const TEXT = '#e8ecf4';
const DIM = '#9aa4b8';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class CompanionPanel {
  private root: HTMLElement;
  private cardsEl: HTMLElement;
  private chip: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;

  constructor(private readonly opts: CompanionPanelOpts) {
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
    root.id = 'xandria-companions-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Companions');

    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${AMBER}33`,
    ].join(';'));
    const title = el(doc, 'div', `font-size:15px;font-weight:700;color:${AMBER};letter-spacing:0.05em`, 'COMPANIONS');
    const sub = el(doc, 'div', `font-size:12px;color:${DIM}`, 'Summon a follower — it fights beside you and survives portal travel');
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close companions panel');
    close.addEventListener('click', () => this.hide());
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    headLeft.append(title, sub);
    head.append(headLeft, close);

    this.cardsEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 10px', 'display:flex',
      'flex-direction:column', 'gap:8px', 'min-height:120px',
    ].join(';'));

    const foot = el(doc, 'div', [
      'padding:8px 14px 10px', `font-size:11px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'N / Esc to close — campfire heals a wounded companion');
    root.append(head, this.cardsEl, foot);
    container.appendChild(root);
    this.root = root;

    // floating chip — below the skills/achievements/bestiary chips
    const chip = el(doc, 'button', [
      'position:absolute', 'right:12px', 'top:92px', 'z-index:9500',
      `background:${PANEL_BG}`, `border:1px solid ${AMBER}73`, 'border-radius:8px',
      `color:${AMBER}`, 'font-size:12px', 'font-weight:700', 'font-family:inherit',
      'letter-spacing:0.06em', 'padding:8px 12px', 'cursor:pointer', 'min-height:28px',
    ].join(';'), 'COMPANIONS') as HTMLButtonElement;
    chip.id = 'xandria-companions-chip';
    chip.setAttribute('aria-label', 'Open companions panel');
    chip.addEventListener('click', () => this.toggle());
    container.appendChild(chip);
    this.chip = chip;

    this.onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      if (this.open_) {
        if (e.code === 'Escape' || e.code === 'KeyN') {
          e.stopPropagation();
          e.preventDefault();
          this.hide();
        }
        return;
      }
      if (e.code === 'KeyN' && !(this.opts.isModalOpen?.() ?? false)) {
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

  refresh(): void {
    if (this.disposed || !this.open_) return;
    this.renderCards();
  }

  private renderCards(): void {
    const doc = this.opts.doc ?? globalThis.document;
    const mgr = this.opts.manager();
    this.cardsEl.replaceChildren();
    if (!mgr) {
      this.cardsEl.append(el(doc, 'div', `font-size:13px;color:${DIM}`, 'No companion data in this run.'));
      return;
    }
    for (const entry of mgr.rosterView) {
      const def = companionDefOf(entry.defId);
      if (!def) continue;
      const active = mgr.activeCompanionId === entry.defId;
      const card = el(doc, 'div', [
        'display:flex', 'flex-direction:column', 'gap:6px', 'padding:10px 12px',
        'border-radius:8px', `border:1px solid ${active ? AMBER : 'rgba(154,164,184,0.25)'}`,
        `background:${active ? 'rgba(255,181,69,0.08)' : 'rgba(255,255,255,0.02)'}`,
      ].join(';'));
      const row = el(doc, 'div', 'display:flex;align-items:center;gap:8px');
      const nameInput = doc.createElement('input') as HTMLInputElement;
      nameInput.type = 'text';
      nameInput.value = entry.name;
      nameInput.maxLength = 40;
      nameInput.setAttribute('aria-label', `Rename ${def.name}`);
      nameInput.style.cssText = 'flex:1;min-width:0;background:rgba(255,255,255,0.06);border:1px solid rgba(154,164,184,0.35);border-radius:6px;color:#e8ecf4;font-size:14px;font-weight:700;padding:6px 8px;min-height:28px;font-family:inherit';
      nameInput.addEventListener('change', () => {
        if (mgr.rename(entry.defId, nameInput.value)) this.renderCards();
        else nameInput.value = entry.name;
      });
      const role = el(doc, 'span', `font-size:11px;color:${DIM};text-transform:uppercase;letter-spacing:0.06em`, def.role);
      const hp = el(doc, 'span', `font-size:12px;color:${entry.hp > 0 ? '#8fe3a8' : '#ff9a8a'}`, `${entry.hp}/${def.maxHp} HP`);
      row.append(nameInput, role, hp);
      const desc = el(doc, 'div', `font-size:12px;color:${DIM}`, def.desc);
      const btnRow = el(doc, 'div', 'display:flex;gap:8px;flex-wrap:wrap');
      const summon = el(doc, 'button', [
        'background:transparent', `color:${AMBER}`, `border:1px solid ${AMBER}73`,
        'border-radius:6px', 'padding:6px 12px', 'font-size:13px', 'font-weight:700',
        'cursor:pointer', 'font-family:inherit', 'min-height:28px',
      ].join(';'), active ? 'ACTIVE' : 'SUMMON');
      summon.setAttribute('data-companion-summon', entry.defId);
      if (!active) summon.addEventListener('click', () => { mgr.summon(entry.defId); this.renderCards(); });
      btnRow.append(summon);
      if (active) {
        const dismiss = el(doc, 'button', [
          'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
          'border-radius:6px', 'padding:6px 12px', 'font-size:13px',
          'cursor:pointer', 'font-family:inherit', 'min-height:28px',
        ].join(';'), 'DISMISS');
        dismiss.setAttribute('data-companion-dismiss', entry.defId);
        dismiss.addEventListener('click', () => { mgr.dismiss(); this.renderCards(); });
        const heal = el(doc, 'button', [
          'background:transparent', 'color:#8fe3a8', 'border:1px solid rgba(143,227,168,0.5)',
          'border-radius:6px', 'padding:6px 12px', 'font-size:13px',
          'cursor:pointer', 'font-family:inherit', 'min-height:28px',
        ].join(';'), 'HEAL AT CAMPFIRE');
        heal.setAttribute('data-companion-heal', entry.defId);
        heal.addEventListener('click', () => { mgr.healAtCampfire(); this.renderCards(); });
        btnRow.append(dismiss, heal);
      }
      card.append(row, desc, btnRow);
      this.cardsEl.append(card);
    }
  }
}
