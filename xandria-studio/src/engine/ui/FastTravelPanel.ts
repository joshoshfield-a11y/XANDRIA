/**
 * UPGRADE LOOP (fast-travel phase): the world-map panel.
 *
 * DOM pattern follows SkillsPanel (centered dialog, self-contained inline
 * styles, capture-phase key handling, native buttons for touch) with one
 * deliberate placement difference: the floating chip sits at the LEFT edge,
 * vertically centered — NOT in the top-right chip stack (SKILLS top:12,
 * BESTIARY/achievements top:52) and NOT over the quest tracker (top:136
 * desktop / top:106 mobile, right side). The hud-polish audit checks the
 * tracker/score/objective/bars/boss/hint/pausebtn boxes for pairwise
 * overlap; this chip intersects none of them on desktop or 360x780
 * (mid-left is clear of the objective panel, the bottom-left bars, and
 * the bottom touch controls), and the centered dialog overlays nothing
 * persistently — it is a modal, closed by default.
 *
 * Open: the 🗺 MAP chip, or the M key (capture phase). Close: × / Esc / M.
 * Rows list ONLY discovered portals (undiscovered maps are never rendered
 * — the registry simply has no entry for them). The current map's row is
 * marked and has no travel button. Travel buttons are >= 36px tall.
 * Travel is cost-free; the panel never reads a wallet or currency.
 *
 * The `doc` param is injectable so unit tests can pass a minimal DOM stub.
 */
import { BIOMES } from '../world/Biomes';
import type { DiscoveredPortal } from '../world/FastTravel';
import type { MapCoord } from '../world/MapGraph';

export interface FastTravelPanelOpts {
  container: HTMLElement;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** discovered portals, read fresh on every open */
  discovered: () => DiscoveredPortal[];
  /** current map coordinate */
  current: () => MapCoord;
  /** run the travel; resolves true when the player arrived */
  onTravel: (coord: MapCoord) => Promise<boolean>;
  /** true while another modal owns input (panel refuses to open) */
  isModalOpen?: () => boolean;
}

const GOLD = '#ffd76a';
const PANEL_BG = 'rgba(8,10,16,0.96)';
const TEXT = '#e8ecf4';
const DIM = '#9aa4b8';
const HERE = '#8fe3a8';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class FastTravelPanel {
  private root: HTMLElement;
  private rowsEl: HTMLElement;
  private countEl: HTMLElement;
  private chip: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;
  private traveling = false;

  constructor(private readonly opts: FastTravelPanelOpts) {
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
    root.id = 'xandria-fast-travel-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'World map — fast travel');

    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${GOLD}33`,
    ].join(';'));
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    headLeft.append(
      el(doc, 'div', `font-size:15px;font-weight:700;color:${GOLD};letter-spacing:0.05em`, '🗺 WORLD MAP'),
      el(doc, 'div', `font-size:12px;color:${DIM}`, 'Travel to a portal you have discovered — free, instant'),
    );
    this.countEl = el(doc, 'div', `font-size:12px;color:${DIM}`, '');
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close world map');
    close.addEventListener('click', () => this.hide());
    const headRight = el(doc, 'div', 'display:flex;align-items:center;gap:10px');
    headRight.append(this.countEl, close);
    head.append(headLeft, headRight);

    this.rowsEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 10px', 'display:flex',
      'flex-direction:column', 'gap:8px', 'min-height:120px',
    ].join(';'));

    const foot = el(doc, 'div', [
      'padding:8px 14px 10px', `font-size:11px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'M / Esc to close · Undiscovered portals stay hidden');
    root.append(head, this.rowsEl, foot);
    container.appendChild(root);
    this.root = root;

    // Floating chip — LEFT edge, vertically centered (see header note:
    // the top-right stack and the quest tracker both live on the right).
    const chip = el(doc, 'button', [
      'position:absolute', 'left:12px', 'top:50%', 'transform:translateY(-50%)',
      'z-index:9500', `background:${PANEL_BG}`, `border:1px solid ${GOLD}73`,
      'border-radius:8px', `color:${GOLD}`, 'font-size:12px', 'font-weight:700',
      'font-family:inherit', 'letter-spacing:0.06em', 'padding:8px 12px',
      'cursor:pointer', 'min-width:44px', 'min-height:44px',
    ].join(';'), '🗺 MAP') as HTMLButtonElement;
    chip.id = 'xandria-fast-travel-chip';
    chip.setAttribute('aria-label', 'Open world map');
    chip.addEventListener('click', () => this.toggle());
    container.appendChild(chip);
    this.chip = chip;

    this.onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      if (this.open_) {
        if (e.code === 'Escape' || e.code === 'KeyM') {
          e.stopPropagation();
          e.preventDefault();
          this.hide();
        }
        return;
      }
      if (e.code === 'KeyM' && !(this.opts.isModalOpen?.() ?? false)) {
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
    this.renderRows();
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

  /** Re-render the rows (call after discovery changes while open). */
  refresh(): void {
    if (this.disposed || !this.open_) return;
    this.renderRows();
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

  private renderRows(): void {
    const doc = this.opts.doc ?? globalThis.document;
    const cur = this.opts.current();
    const portals = this.opts.discovered();
    this.countEl.textContent = portals.length === 1 ? '1 portal discovered' : `${portals.length} portals discovered`;
    while (this.rowsEl.firstChild) this.rowsEl.removeChild(this.rowsEl.firstChild);
    if (portals.length === 0) {
      this.rowsEl.append(el(doc, 'div', `font-size:13px;color:${DIM};padding:12px;text-align:center`,
        'No portals discovered yet — walk through a portal to chart it.'));
      return;
    }
    for (const p of portals) {
      const here = p.mx === cur.mx && p.my === cur.my;
      const row = el(doc, 'div', [
        'display:flex', 'align-items:center', 'justify-content:space-between', 'gap:10px',
        'padding:10px 12px', 'border-radius:8px', 'background:rgba(255,255,255,0.04)',
        `border:1px solid ${here ? HERE : 'rgba(255,255,255,0.08)'}`,
      ].join(';'));
      row.setAttribute('data-mx', String(p.mx));
      row.setAttribute('data-my', String(p.my));
      const biomeName = BIOMES[p.biome]?.name ?? p.biome;
      const label = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px;min-width:0');
      label.append(
        el(doc, 'div', `font-size:14px;font-weight:700;color:${here ? HERE : TEXT}`,
          `Map (${p.mx}, ${p.my})${here ? ' — YOU ARE HERE' : ''}`),
        el(doc, 'div', `font-size:12px;color:${DIM}`, `${biomeName} · Tier ${p.tier}`),
      );
      row.append(label);
      if (!here) {
        const btn = el(doc, 'button', [
          'background:rgba(30,42,64,.9)', `color:${GOLD}`, `border:1px solid ${GOLD}73`,
          'border-radius:6px', 'padding:0 16px', 'min-height:36px', 'font-size:13px',
          'font-weight:700', 'font-family:inherit', 'cursor:pointer', 'flex-shrink:0',
        ].join(';'), 'TRAVEL') as HTMLButtonElement;
        btn.setAttribute('aria-label', `Travel to map (${p.mx}, ${p.my})`);
        btn.disabled = this.traveling;
        btn.addEventListener('click', () => void this.travelTo(p));
        row.append(btn);
      }
      this.rowsEl.append(row);
    }
  }

  private async travelTo(p: DiscoveredPortal): Promise<void> {
    if (this.traveling) return;
    this.traveling = true;
    this.hide();
    let ok = false;
    try {
      ok = await this.opts.onTravel({ mx: p.mx, my: p.my });
    } catch {
      ok = false;
    } finally {
      this.traveling = false;
    }
    // A failed travel (e.g. a transition was already running) re-opens the
    // map so the player can retry instead of wondering where it went.
    if (!ok && !this.disposed) this.show();
  }
}
