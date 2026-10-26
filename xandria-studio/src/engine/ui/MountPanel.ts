/**
 * UPGRADE LOOP (mounts): the mounts UI panel.
 *
 * DOM pattern follows SkillsPanel (absolute in the engine container,
 * self-contained inline styles, capture-phase key handling). Lists the
 * three seeded mounts with speed multiplier, stamina pool, drain/regen
 * rates, a live stamina bar, and Summon/Dismiss buttons.
 *
 * Open/close: the `N` key (capture phase) toggles; Esc closes. (KeyM was
 * already taken by the minimap toggle.) A floating "MOUNTS" chip gives
 * touch users the same toggle. The panel never opens while another modal
 * owns input, via the isModalOpen predicate. Stamina bars refresh on a
 * 250ms interval while open (cleared on close/dispose) — the only
 * polling in the panel, and only while visible.
 */
import { MOUNT_DEFS, type MountManager } from '../game/mounts';

export interface MountPanelOpts {
  container: HTMLElement;
  doc?: Document;
  mounts: () => MountManager | null;
  isModalOpen?: () => boolean;
}

const AMBER = '#ffb545';
const PANEL_BG = 'rgba(8,10,16,0.96)';
const TEXT = '#e8ecf4';
const DIM = '#9aa4b8';
const GOOD = '#8fe3a8';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class MountPanel {
  private root: HTMLElement;
  private cardsEl: HTMLElement;
  private chip: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: MountPanelOpts) {
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
    root.id = 'xandria-mounts-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Mounts');

    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${AMBER}33`,
    ].join(';'));
    const title = el(doc, 'div', `font-size:15px;font-weight:700;color:${AMBER};letter-spacing:0.05em`, 'MOUNTS');
    const sub = el(doc, 'div', `font-size:12px;color:${DIM}`, 'Ride faster. Stamina drains while moving.');
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close mounts panel');
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
    ].join(';'), 'N / Esc to close — mounts stay through combat and portal travel');
    root.append(head, this.cardsEl, foot);
    container.appendChild(root);
    this.root = root;

    const chip = el(doc, 'button', [
      'position:absolute', 'right:12px', 'top:56px', 'z-index:9500',
      `background:${PANEL_BG}`, `border:1px solid ${AMBER}73`, 'border-radius:8px',
      `color:${AMBER}`, 'font-size:12px', 'font-weight:700', 'font-family:inherit',
      'letter-spacing:0.06em', 'padding:8px 12px', 'cursor:pointer',
    ].join(';'), 'MOUNTS') as HTMLButtonElement;
    chip.id = 'xandria-mounts-chip';
    chip.setAttribute('aria-label', 'Open mounts panel');
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

  get isOpen(): boolean { return this.open_; }
  get chipEl(): HTMLElement { return this.chip; }

  show(): void {
    if (this.disposed) return;
    if (this.opts.isModalOpen?.() ?? false) return;
    this.root.style.display = 'flex';
    this.chip.style.display = 'none';
    this.open_ = true;
    this.renderCards();
    if (this.refreshTimer === null) {
      this.refreshTimer = setInterval(() => { if (this.open_) this.renderCards(); }, 250);
    }
  }

  hide(): void {
    if (this.disposed) return;
    this.root.style.display = 'none';
    this.chip.style.display = '';
    this.open_ = false;
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  toggle(): void {
    if (this.open_) this.hide();
    else this.show();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    const w = (this.opts.doc as (Document & { defaultView?: Window }) | undefined)?.defaultView
      ?? (globalThis as unknown as { window?: Window }).window;
    w?.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
    this.chip.remove();
  }

  private renderCards(): void {
    const mgr = this.opts.mounts();
    const doc = this.opts.doc ?? globalThis.document;
    while (this.cardsEl.firstChild) this.cardsEl.firstChild.remove();
    if (!mgr) {
      this.cardsEl.appendChild(el(doc, 'div', `font-size:13px;color:${DIM};padding:10px`, 'No mount data.'));
      return;
    }
    for (const def of MOUNT_DEFS) {
      const stamina = mgr.staminaOf(def.id);
      const pct = Math.round((stamina / def.staminaMax) * 100);
      const active = mgr.activeId === def.id;
      const card = el(doc, 'div', [
        'border:1px solid rgba(154,164,184,0.35)', 'border-radius:8px', 'padding:10px 12px',
        'display:flex', 'flex-direction:column', 'gap:6px',
        active ? `border-color:${AMBER}` : '',
      ].join(';'));
      const row = el(doc, 'div', 'display:flex;justify-content:space-between;align-items:baseline');
      row.append(
        el(doc, 'span', `font-size:14px;font-weight:700;color:${active ? AMBER : TEXT}`, def.name + (active ? ' — RIDING' : '')),
        el(doc, 'span', `font-size:12px;color:${DIM}`, `×${def.speedMult} speed`),
      );
      card.appendChild(row);
      card.appendChild(el(doc, 'div', `font-size:12px;color:${DIM}`, def.blurb));
      card.appendChild(el(doc, 'div', `font-size:12px;color:${DIM}`,
        `Stamina ${Math.round(stamina)}/${def.staminaMax} · drains ${def.drainPerSec}/s moving · regens ${def.regenPerSec}/s`));
      const barWrap = el(doc, 'div', 'height:8px;border-radius:4px;background:rgba(154,164,184,0.25);overflow:hidden');
      const bar = el(doc, 'div', `height:100%;width:${pct}%;background:${active ? AMBER : GOOD};border-radius:4px`);
      barWrap.appendChild(bar);
      card.appendChild(barWrap);
      const btn = el(doc, 'button', [
        'align-self:flex-start', 'margin-top:2px', 'padding:7px 14px', 'border-radius:6px',
        'font-family:inherit', 'font-size:13px', 'font-weight:700', 'cursor:pointer',
        active ? 'background:transparent;color:#ff9a8a;border:1px solid rgba(255,154,138,0.5)'
          : `background:${AMBER};color:#10131a;border:none`,
      ].join(';'), active ? 'Dismiss' : 'Summon');
      btn.addEventListener('click', () => {
        if (active) mgr.dismiss();
        else mgr.summon(def.id);
        this.renderCards();
      });
      card.appendChild(btn);
      this.cardsEl.appendChild(card);
    }
  }
}
