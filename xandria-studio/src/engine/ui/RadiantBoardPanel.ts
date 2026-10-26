/**
 * Radiant quests wave: the quest giver panel for the radiant board.
 *
 * Renders the RadiantBoard's rotating offer slots: each slot shows the
 * quest name, brief, objective line, tier-scaled reward line, and the
 * action the slot's live status allows — Accept (available), Abandon
 * (active), Turn in (complete). All three actions call the board, which
 * calls the QuestManager's EXISTING accept/abandon/turnIn methods — the
 * panel adds no lifecycle of its own, and a turn-in here grants exactly
 * what a villager-dialogue turn-in grants (same manager call).
 *
 * Placement: the toggle chip sits mid-left (left:12px, top:50%) — the
 * one screen edge this HUD leaves free (score/tracker/chips own the
 * right edge, the joystick owns bottom-left, touch buttons own
 * bottom-right). The panel itself is a centered modal in the
 * AchievementsPanel pattern. Opening the panel runs board.sync() +
 * board.syncTier() first, so a slot turned in via villager dialogue
 * re-rolls before the player ever sees a stale slot, and a tier change
 * re-rolls only still-available offers.
 *
 * Buttons carry data-radiant-action + data-radiant-slot so the e2e
 * harness clicks real UI, never manager methods directly.
 */
import type { RadiantBoard } from '../game/radiantQuests';

const AMBER = '#ffb545';
const PANEL_BG = 'rgba(8,10,16,0.92)';
const TEXT = '#e8ecf4';
const DIM = '#9aa4b8';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface RadiantBoardPanelOpts {
  container: HTMLElement;
  board: () => RadiantBoard | null;
  /** True while another modal owns input (crafting panel, quest dialogue) — the chip then refuses to open. */
  isModalOpen?: () => boolean;
  doc?: Document;
}

export class RadiantBoardPanel {
  private root: HTMLElement;
  private listEl: HTMLElement;
  private chip: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;

  constructor(private readonly opts: RadiantBoardPanelOpts) {
    const doc = opts.doc ?? globalThis.document;
    const root = el(doc, 'div', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9600', 'width:min(460px,94vw)', 'max-height:84vh',
      'display:none', 'flex-direction:column',
      `background:${PANEL_BG}`, `border:1px solid ${AMBER}73`, 'border-radius:12px',
      'font-family:system-ui,-apple-system,sans-serif', `color:${TEXT}`,
      'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
    ].join(';'));
    root.id = 'xandria-radiant-board-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Radiant quest board');

    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${AMBER}33`,
    ].join(';'));
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    headLeft.append(
      el(doc, 'div', `font-size:15px;font-weight:700;color:${AMBER};letter-spacing:0.05em`, '◆ RADIANT BOARD'),
      el(doc, 'div', `font-size:12px;color:${DIM}`, 'Endless work — accept, finish, turn in, and the board deals a fresh offer'),
    );
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close radiant board');
    close.addEventListener('click', () => this.hide());
    head.append(headLeft, close);

    this.listEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 10px', 'display:flex',
      'flex-direction:column', 'gap:8px', 'min-height:120px',
    ].join(';'));

    const foot = el(doc, 'div', [
      'padding:8px 14px 10px', `font-size:11px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'Abandoning a quest re-rolls its slot — the replacement is seeded, never random. Esc to close');

    root.append(head, this.listEl, foot);
    opts.container.appendChild(root);
    this.root = root;

    // Toggle chip — mid-left, the HUD edge nothing else claims.
    const chip = el(doc, 'button', [
      'position:absolute', 'left:12px', 'top:50%', 'transform:translateY(-50%)',
      'z-index:9500', `background:${PANEL_BG}`, `border:1px solid ${AMBER}73`,
      'border-radius:8px', `color:${AMBER}`, 'font-size:14px', 'font-weight:700',
      'font-family:inherit', 'padding:8px 10px', 'cursor:pointer',
      'min-width:44px', 'min-height:44px',
    ].join(';'), '◆') as HTMLButtonElement;
    chip.id = 'xandria-radiant-board-chip';
    chip.setAttribute('aria-label', 'Open radiant quest board');
    chip.addEventListener('click', () => this.toggle());
    opts.container.appendChild(chip);
    this.chip = chip;

    this.onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      if (this.open_ && e.code === 'Escape') this.hide();
    };
    doc.addEventListener('keydown', this.onKey);
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
    const board = this.opts.board();
    if (!board) return;
    // Fresh view first: dialogue turn-ins re-roll, tier moves re-roll
    // offers only — never accepted quests.
    board.sync();
    board.syncTier();
    this.render();
    this.root.style.display = 'flex';
    this.open_ = true;
  }

  hide(): void {
    if (this.disposed) return;
    this.root.style.display = 'none';
    this.open_ = false;
  }

  toggle(): void {
    if (this.open_) this.hide();
    else this.show();
  }

  /** Re-render from the board's live slots (called by the board's onChanged). */
  render(): void {
    if (this.disposed) return;
    const board = this.opts.board();
    while (this.listEl.firstChild) this.listEl.firstChild.remove();
    if (!board) {
      this.listEl.append(el(this.opts.doc ?? globalThis.document, 'div',
        `font-size:13px;color:${DIM};text-align:center;padding:16px`, 'No radiant board on this run.'));
      return;
    }
    const doc = this.opts.doc ?? globalThis.document;
    const slots = board.getSlots();
    if (slots.length === 0) {
      this.listEl.append(el(doc, 'div',
        `font-size:13px;color:${DIM};text-align:center;padding:16px`,
        'No radiant work right now — this world offers no repeatable quests.'));
      return;
    }
    slots.forEach((slot, i) => {
      const def = slot.def;
      const obj = def.objectives[0];
      const rewardLine = [
        `${def.rewards.xp} XP`,
        ...def.rewards.items.map((r) => `${r.id} ×${r.count}`),
        ...(def.rewards.bonus ?? []).map((r) => `${r.id} ×${r.count} (bonus)`),
      ].join(' · ');
      const card = el(doc, 'div', [
        'display:flex', 'flex-direction:column', 'gap:4px',
        'padding:10px 12px', 'border-radius:8px',
        `border:1px solid ${slot.status === 'complete' ? '#8dffa033' : AMBER + '33'}`,
        'background:rgba(255,255,255,0.03)',
      ].join(';'));
      card.setAttribute('data-radiant-slot', String(i));
      card.setAttribute('data-radiant-quest-id', def.id);
      const title = el(doc, 'div', `font-size:14px;font-weight:700;color:${slot.status === 'complete' ? '#8dffa0' : '#ffcf7a'}`,
        `${slot.status === 'complete' ? '✓ ' : ''}${def.name}`);
      const brief = el(doc, 'div', `font-size:12px;color:${DIM};line-height:1.4`, def.brief);
      const objLine = el(doc, 'div', 'font-size:12px;opacity:0.9',
        obj ? `• ${obj.desc}` : '');
      const reward = el(doc, 'div', `font-size:11px;color:${DIM}`, `Reward: ${rewardLine}`);
      const status = el(doc, 'div', `font-size:11px;color:${DIM}`,
        slot.status === 'available' ? 'Offer — not yet accepted'
          : slot.status === 'active' ? 'In progress'
            : slot.status === 'complete' ? 'Complete — turn it in'
              : slot.status);
      card.append(title, brief, objLine, reward, status);
      const actionRow = el(doc, 'div', 'display:flex;gap:8px;margin-top:4px');
      const mkBtn = (label: string, action: string): HTMLElement => {
        const b = el(doc, 'button', [
          'background:rgba(255,181,69,0.16)', `border:1px solid ${AMBER}73`,
          'border-radius:6px', `color:${AMBER}`, 'font-size:12px', 'font-weight:700',
          'font-family:inherit', 'padding:6px 12px', 'cursor:pointer',
        ].join(';'), label);
        b.setAttribute('data-radiant-action', action);
        b.setAttribute('data-radiant-slot', String(i));
        b.addEventListener('click', () => {
          if (action === 'accept') board.accept(i);
          else if (action === 'abandon') board.abandon(i);
          else if (action === 'turnin') board.turnIn(i);
          this.render();
        });
        return b;
      };
      if (slot.status === 'available') actionRow.append(mkBtn('Accept', 'accept'));
      else if (slot.status === 'active') actionRow.append(mkBtn('Abandon', 'abandon'));
      else if (slot.status === 'complete') actionRow.append(mkBtn('Turn in', 'turnin'));
      if (actionRow.childNodes.length > 0) card.append(actionRow);
      this.listEl.append(card);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    (this.opts.doc ?? globalThis.document).removeEventListener('keydown', this.onKey);
    this.root.remove();
    this.chip.remove();
  }
}
