/**
 * Run-journal wave: the run journal panel.
 *
 * DOM pattern follows AchievementsPanel (absolute in the engine container,
 * self-contained inline styles, capture-phase key handling, native buttons
 * for touch). Lists the last 20 finished runs, newest first, with one stat
 * row per run. The journal is written observe-only at run end (see
 * Engine.recordRunResult); this panel only reads it.
 *
 * Open: the 📜 RUN JOURNAL button on the title screen (HUD.showTitle's
 * onJournal). Close: × / Esc. Rows carry data-* attributes so e2e can assert
 * exact recorded stats.
 *
 * The `doc` param is injectable so unit tests can pass a minimal DOM stub.
 */
import type { RunJournalEntry } from '../game/Profile';

/** The panel lists the newest N entries (storage keeps JOURNAL_CAP). */
export const JOURNAL_PANEL_LIMIT = 20;

export interface JournalPanelOpts {
  container: HTMLElement;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** newest-first journal entries (read fresh on every open) */
  journal: () => RunJournalEntry[];
}

const GOLD = '#ffd76a';
const PANEL_BG = 'rgba(8,10,16,0.96)';
const TEXT = '#e8ecf4';
const DIM = '#9aa4b8';
const WON = '#8fe3a8';
const LOST = '#ff9a8a';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown date';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export class JournalPanel {
  private root: HTMLElement;
  private rowsEl: HTMLElement;
  private countEl: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;

  constructor(private readonly opts: JournalPanelOpts) {
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container;

    const root = el(doc, 'div', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9600', 'width:min(480px,94vw)', 'max-height:84vh',
      'display:none', 'flex-direction:column',
      `background:${PANEL_BG}`, `border:1px solid ${GOLD}73`, 'border-radius:12px',
      'font-family:system-ui,-apple-system,sans-serif', `color:${TEXT}`,
      'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
    ].join(';'));
    root.id = 'xandria-journal-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Run journal');

    // header
    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${GOLD}33`,
    ].join(';'));
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    headLeft.append(
      el(doc, 'div', `font-size:15px;font-weight:700;color:${GOLD};letter-spacing:0.05em`, '📜 RUN JOURNAL'),
      el(doc, 'div', `font-size:12px;color:${DIM}`, 'Every finished run, newest first'),
    );
    this.countEl = el(doc, 'div', `font-size:12px;color:${DIM}`, '');
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close run journal');
    close.addEventListener('click', () => this.hide());
    const headRight = el(doc, 'div', 'display:flex;align-items:center;gap:10px');
    headRight.append(this.countEl, close);
    head.append(headLeft, headRight);

    // run rows (scrollable)
    this.rowsEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 10px', 'display:flex',
      'flex-direction:column', 'gap:8px', 'min-height:120px',
    ].join(';'));

    const foot = el(doc, 'div', [
      'padding:8px 14px 10px', `font-size:11px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'Esc to close');

    root.append(head, this.rowsEl, foot);
    container.appendChild(root);
    this.root = root;

    this.onKey = (e: KeyboardEvent) => {
      if (!this.open_) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.hide();
      }
    };
    doc.addEventListener('keydown', this.onKey, true);
  }

  isOpen(): boolean {
    return this.open_;
  }

  /** Re-read the journal and render the newest JOURNAL_PANEL_LIMIT runs. */
  show(): void {
    if (this.disposed) return;
    this.render();
    this.root.style.display = 'flex';
    this.open_ = true;
  }

  hide(): void {
    this.root.style.display = 'none';
    this.open_ = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    (this.opts.doc ?? globalThis.document).removeEventListener('keydown', this.onKey, true);
    this.root.remove();
  }

  private render(): void {
    const doc = this.opts.doc ?? globalThis.document;
    let entries: RunJournalEntry[];
    try {
      entries = this.opts.journal() ?? [];
    } catch {
      entries = [];
    }
    const shown = entries.slice(0, JOURNAL_PANEL_LIMIT);
    this.countEl.textContent = entries.length
      ? `${entries.length} run${entries.length === 1 ? '' : 's'}`
      : '';
    this.rowsEl.innerHTML = '';
    if (!shown.length) {
      this.rowsEl.append(
        el(doc, 'div', `padding:24px 12px;text-align:center;color:${DIM};font-size:13px`,
          'No runs yet — finish a run to start your journal.'),
      );
      return;
    }
    for (const e of shown) {
      const row = el(doc, 'div', [
        'display:flex', 'flex-direction:column', 'gap:3px',
        'padding:9px 11px', 'border:1px solid rgba(154,164,184,0.25)',
        'border-radius:8px', 'background:rgba(16,22,34,0.6)',
      ].join(';'));
      row.className = 'jr-row';
      row.dataset.result = e.result;
      row.dataset.genre = e.genre;
      row.dataset.startUtc = e.startUtc;
      row.dataset.seed = String(e.seed);
      row.dataset.duration = String(e.duration);
      row.dataset.kills = String(e.kills);
      row.dataset.deaths = String(e.deaths);
      row.dataset.portals = String(e.portals);
      row.dataset.bosses = String(e.bossesKilled);
      row.dataset.xp = String(e.xpGained);

      const top = el(doc, 'div', 'display:flex;align-items:center;justify-content:space-between;gap:8px');
      const badge = el(doc, 'span', [
        'font-size:11px', 'font-weight:800', 'letter-spacing:0.08em',
        'padding:2px 8px', 'border-radius:5px',
        e.result === 'won'
          ? `background:rgba(143,227,168,0.15);color:${WON}`
          : `background:rgba(255,154,138,0.15);color:${LOST}`,
      ].join(';'), e.result === 'won' ? 'WON' : 'LOST');
      const when = el(doc, 'span', `font-size:12px;color:${DIM}`, fmtStart(e.startUtc));
      top.append(badge, when);

      const mid = el(doc, 'div', `font-size:13px;font-weight:600;color:${TEXT}`,
        `${e.genre} · ${fmtDuration(e.duration)}`);

      const bot = el(doc, 'div', `font-size:12px;color:${DIM};font-variant-numeric:tabular-nums`,
        `K ${e.kills} · D ${e.deaths} · P ${e.portals} · B ${e.bossesKilled} · +${e.xpGained} XP · seed ${e.seed}`);

      row.append(top, mid, bot);
      this.rowsEl.appendChild(row);
    }
  }
}
