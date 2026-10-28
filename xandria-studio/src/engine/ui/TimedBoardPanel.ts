/**
 * Timed quests wave: the quest giver panel for the timed board.
 *
 * Renders the TimedBoard's rotating offer slots: each slot shows the
 * quest name, brief, objective line, time limit + reward-scale line,
 * the live countdown for active quests, and the action the slot's
 * live status allows — Accept (available), Abandon (active), Turn in
 * (complete), Try again (failed — restarts the clock from the full
 * limit with progress reset). All actions call the board, which calls
 * the QuestManager's EXISTING accept/abandon/turnIn methods plus its
 * timed-scoped reaccept — the panel adds no lifecycle of its own, and
 * a turn-in here grants exactly what a villager-dialogue turn-in
 * grants (same manager call, scaled reward already in the def).
 *
 * Placement: the toggle chip sits mid-left BELOW the radiant chip
 * (left:12px, top:calc(50% + 28px)) — the radiant chip owns 50%±22px,
 * so this one clears it by 6px. The panel itself is a centered modal
 * in the RadiantBoardPanel pattern. Opening the panel runs
 * board.sync() first, so a slot turned in via villager dialogue
 * re-rolls before the player ever sees a stale slot (failed slots
 * are never re-rolled by sync — they stay for Try again).
 *
 * Buttons carry data-timed-action + data-timed-slot so the e2e
 * harness clicks real UI, never manager methods directly.
 */
import type { TimedBoard } from '../game/timedQuests';
import { formatTimedRemaining } from '../game/quests';

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

export interface TimedBoardPanelOpts {
  container: HTMLElement;
  board: () => TimedBoard | null;
  /** True while another modal owns input (quest dialogue) — the chip then refuses to open. */
  isModalOpen?: () => boolean;
  doc?: Document;
}

export class TimedBoardPanel {
  private root: HTMLElement;
  private listEl: HTMLElement;
  private chip: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;

  constructor(private readonly opts: TimedBoardPanelOpts) {
    const doc = opts.doc ?? globalThis.document;
    const root = el(doc, 'div', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9600', 'width:min(460px,94vw)', 'max-height:84vh',
      'display:none', 'flex-direction:column',
      `background:${PANEL_BG}`, `border:1px solid ${AMBER}73`, 'border-radius:12px',
      'font-family:system-ui,-apple-system,sans-serif', `color:${TEXT}`,
      'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
    ].join(';'));
    root.id = 'xandria-timed-board-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Timed quest board');

    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${AMBER}33`,
    ].join(';'));
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    headLeft.append(
      el(doc, 'div', `font-size:15px;font-weight:700;color:${AMBER};letter-spacing:0.05em`, '⏱ TIMED BOARD'),
      el(doc, 'div', `font-size:12px;color:${DIM}`, 'Beat the clock for scaled rewards — fail, and the quest can be tried again'),
    );
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close timed board');
    close.addEventListener('click', () => this.hide());
    head.append(headLeft, close);

    this.listEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 10px', 'display:flex',
      'flex-direction:column', 'gap:8px', 'min-height:120px',
    ].join(';'));

    const foot = el(doc, 'div', [
      'padding:8px 14px 10px', `font-size:11px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'The clock runs on game-time only — pausing and portal travel never steal a second. Esc to close');

    root.append(head, this.listEl, foot);
    opts.container.appendChild(root);
    this.root = root;

    // Toggle chip — mid-left below the radiant chip.
    const chip = el(doc, 'button', [
      'position:absolute', 'left:12px', 'top:calc(50% + 28px)',
      'z-index:9500', `background:${PANEL_BG}`, `border:1px solid ${AMBER}73`,
      'border-radius:8px', `color:${AMBER}`, 'font-size:14px', 'font-weight:700',
      'font-family:inherit', 'padding:8px 10px', 'cursor:pointer',
      'min-width:44px', 'min-height:44px',
    ].join(';'), '⏱') as HTMLButtonElement;
    chip.id = 'xandria-timed-board-chip';
    chip.setAttribute('aria-label', 'Open timed quest board');
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
    // Fresh view first: dialogue turn-ins re-roll; failed slots stay
    // for Try again (sync never re-rolls a failed slot).
    board.sync();
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

  /** Re-render from the board's live slots (called by the board's onChanged and by quest changes). */
  render(): void {
    if (this.disposed) return;
    const board = this.opts.board();
    while (this.listEl.firstChild) this.listEl.firstChild.remove();
    if (!board) {
      this.listEl.append(el(this.opts.doc ?? globalThis.document, 'div',
        `font-size:13px;color:${DIM};text-align:center;padding:16px`, 'No timed board on this run.'));
      return;
    }
    const doc = this.opts.doc ?? globalThis.document;
    const slots = board.getSlots();
    if (slots.length === 0) {
      this.listEl.append(el(doc, 'div',
        `font-size:13px;color:${DIM};text-align:center;padding:16px`,
        'No timed work right now — this world offers no quests against the clock.'));
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
      const limit = def.timed ? formatTimedRemaining(def.timed.limitSeconds) : '—';
      const scale = def.timed ? `×${def.timed.rewardScale}` : '—';
      const card = el(doc, 'div', [
        'display:flex', 'flex-direction:column', 'gap:4px',
        'padding:10px 12px', 'border-radius:8px',
        `border:1px solid ${slot.status === 'complete' ? '#8dffa033' : slot.status === 'failed' ? '#ff6b6b55' : AMBER + '33'}`,
        'background:rgba(255,255,255,0.03)',
      ].join(';'));
      card.setAttribute('data-timed-slot', String(i));
      card.setAttribute('data-timed-quest-id', def.id);
      const title = el(doc, 'div', `font-size:14px;font-weight:700;color:${slot.status === 'complete' ? '#8dffa0' : slot.status === 'failed' ? '#ff9a9a' : '#ffcf7a'}`,
        `${slot.status === 'complete' ? '✓ ' : slot.status === 'failed' ? '✗ ' : ''}${def.name}`);
      const brief = el(doc, 'div', `font-size:12px;color:${DIM};line-height:1.4`, def.brief);
      const objLine = el(doc, 'div', 'font-size:12px;opacity:0.9',
        obj ? `• ${obj.desc}` : '');
      const clockLine = el(doc, 'div', 'font-size:12px;opacity:0.9',
        slot.status === 'active' && slot.remainingSeconds !== null
          ? `⏱ ${formatTimedRemaining(slot.remainingSeconds)} left of ${limit} · reward ${scale}`
          : `⏱ ${limit} limit · reward ${scale}`);
      const reward = el(doc, 'div', `font-size:11px;color:${DIM}`, `Reward: ${rewardLine}`);
      const status = el(doc, 'div', `font-size:11px;color:${DIM}`,
        slot.status === 'available' ? 'Offer — not yet accepted'
          : slot.status === 'active' ? 'In progress — clock running'
            : slot.status === 'complete' ? 'Complete — turn it in'
              : slot.status === 'failed' ? 'Time expired — no reward; try again for a fresh clock'
                : slot.status);
      card.append(title, brief, objLine, clockLine, reward, status);
      const actionRow = el(doc, 'div', 'display:flex;gap:8px;margin-top:4px');
      const mkBtn = (label: string, action: string): HTMLElement => {
        const b = el(doc, 'button', [
          'background:rgba(255,181,69,0.16)', `border:1px solid ${AMBER}73`,
          'border-radius:6px', `color:${AMBER}`, 'font-size:12px', 'font-weight:700',
          'font-family:inherit', 'padding:6px 12px', 'cursor:pointer',
        ].join(';'), label);
        b.setAttribute('data-timed-action', action);
        b.setAttribute('data-timed-slot', String(i));
        b.addEventListener('click', () => {
          if (action === 'accept') board.accept(i);
          else if (action === 'abandon') board.abandon(i);
          else if (action === 'turnin') board.turnIn(i);
          else if (action === 'reaccept') board.reaccept(i);
          this.render();
        });
        return b;
      };
      if (slot.status === 'available') actionRow.append(mkBtn('Accept', 'accept'));
      else if (slot.status === 'active') actionRow.append(mkBtn('Abandon', 'abandon'));
      else if (slot.status === 'complete') actionRow.append(mkBtn('Turn in', 'turnin'));
      else if (slot.status === 'failed') actionRow.append(mkBtn('Try again', 'reaccept'));
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
