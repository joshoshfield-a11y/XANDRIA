/**
 * UPGRADE LOOP (world-atlas phase): the world atlas panel.
 *
 * DOM pattern follows FastTravelPanel (centered dialog, self-contained
 * inline styles, capture-phase key handling, native buttons for touch)
 * with three deliberate differences:
 *
 *  1. PLACEMENT: the floating chip (🧭 ATLAS) stacks BELOW the 🗺 MAP
 *     chip on the left edge (top: calc(50% + 30px)) — NOT in the
 *     top-right chip stack and NOT over the quest tracker (right side)
 *     or the bottom touch controls. The hud-polish audit's boxes
 *     (tracker/score/objective/bars/boss/hint/pause) are all clear of
 *     mid-left, and the two left-edge chips never intersect each other.
 *  2. NO KEYBOARD SHORTCUT: every single-letter panel key is taken
 *     (M = world map / minimap, N = companions + mounts, J = journal,
 *     B = bestiary, K = skills, I = inventory, E = interact). The atlas
 *     opens via its chip only — stealing a key would break another
 *     panel's contract. It closes via × / Esc like the other panels.
 *  3. CONTENT: rows are the fast-travel registry enriched with the
 *     minimap's session fog percentage and the camp profile's built
 *     structures. Undiscovered maps have no registry entry and are
 *     never rendered — only the uncharted-neighbor COUNT appears.
 *
 * Open: the 🧭 ATLAS chip. Close: × / Esc. Rows list ONLY discovered
 * maps. A JUMP button runs the SAME fast-travel arrival pipeline as
 * the world-map panel (PortalManager.fastTravelTo via onTravel), so an
 * atlas arrival is identical to a walked arrival by construction.
 * The panel is created once per boot (like FastTravelPanel) and works
 * on the title screen too: the registry persists across runs on the
 * same world seed, and the chip sits above the title overlay.
 *
 * The `doc` param is injectable so unit tests can pass a minimal DOM stub.
 */
import { buildAtlasModel, type AtlasSource } from '../world/WorldAtlas';
import type { MapCoord } from '../world/MapGraph';

export interface WorldAtlasPanelOpts extends AtlasSource {
  container: HTMLElement;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
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
const CAMP = '#4ade80';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class WorldAtlasPanel {
  private root: HTMLElement;
  private rowsEl: HTMLElement;
  private countEl: HTMLElement;
  private chip: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;
  private traveling = false;

  constructor(private readonly opts: WorldAtlasPanelOpts) {
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container;

    const root = el(doc, 'div', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9600', 'width:min(520px,94vw)', 'max-height:84vh',
      'display:none', 'flex-direction:column',
      `background:${PANEL_BG}`, `border:1px solid ${GOLD}73`, 'border-radius:12px',
      'font-family:system-ui,-apple-system,sans-serif', `color:${TEXT}`,
      'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
    ].join(';'));
    root.id = 'xandria-world-atlas-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'World atlas — discovered maps');

    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${GOLD}33`,
    ].join(';'));
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    headLeft.append(
      el(doc, 'div', `font-size:15px;font-weight:700;color:${GOLD};letter-spacing:0.05em`, '🧭 WORLD ATLAS'),
      el(doc, 'div', `font-size:12px;color:${DIM}`, 'Every map you have discovered — fog and camps at a glance'),
    );
    this.countEl = el(doc, 'div', `font-size:12px;color:${DIM}`, '');
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close world atlas');
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
    ].join(';'), 'Esc to close · Undiscovered maps stay hidden · Fog % is this session\u2019s exploration');
    root.append(head, this.rowsEl, foot);
    container.appendChild(root);
    this.root = root;

    // Floating chip — LEFT edge, stacked below the 🗺 MAP chip (see
    // header note: the MAP chip is vertically centered; this chip's top
    // edge clears its bottom edge, and mid-left clears every HUD box).
    const chip = el(doc, 'button', [
      'position:absolute', 'left:12px', 'top:calc(50% + 30px)',
      'z-index:9500', `background:${PANEL_BG}`, `border:1px solid ${GOLD}73`,
      'border-radius:8px', `color:${GOLD}`, 'font-size:12px', 'font-weight:700',
      'font-family:inherit', 'letter-spacing:0.06em', 'padding:8px 12px',
      'cursor:pointer', 'min-width:44px', 'min-height:44px',
    ].join(';'), '🧭 ATLAS') as HTMLButtonElement;
    chip.id = 'xandria-world-atlas-chip';
    chip.setAttribute('aria-label', 'Open world atlas');
    chip.addEventListener('click', () => this.toggle());
    container.appendChild(chip);
    this.chip = chip;

    // Esc closes the atlas. No letter shortcut (see header note: every
    // panel letter is taken). Capture phase, like FastTravelPanel.
    this.onKey = (e: KeyboardEvent) => {
      if (!this.open_) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      if (e.code === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        this.hide();
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
    const model = buildAtlasModel(this.opts);
    this.countEl.textContent = model.discoveredCount === 1
      ? '1 portal discovered'
      : `${model.discoveredCount} portals discovered`;
    while (this.rowsEl.firstChild) this.rowsEl.removeChild(this.rowsEl.firstChild);
    // Uncharted-neighbor count: a count only — no coords, biomes, or
    // tiers for undiscovered maps are ever rendered (no spoilers).
    const uncharted = el(doc, 'div', [
      'font-size:12px', `color:${DIM}`, 'text-align:center', 'padding:2px 0 4px',
    ].join(';'), model.unchartedCount === 0
      ? 'No neighboring maps uncharted'
      : `${model.unchartedCount} neighboring map${model.unchartedCount === 1 ? '' : 's'} still uncharted`);
    uncharted.id = 'xandria-atlas-uncharted';
    this.rowsEl.append(uncharted);
    if (model.entries.length === 0) {
      this.rowsEl.append(el(doc, 'div', `font-size:13px;color:${DIM};padding:12px;text-align:center`,
        'No maps discovered yet — walk through a portal to chart it.'));
      return;
    }
    for (const entry of model.entries) {
      const row = el(doc, 'div', [
        'display:flex', 'align-items:center', 'justify-content:space-between', 'gap:10px',
        'padding:10px 12px', 'border-radius:8px', 'background:rgba(255,255,255,0.04)',
        `border:1px solid ${entry.isCurrent ? HERE : 'rgba(255,255,255,0.08)'}`,
      ].join(';'));
      row.setAttribute('data-mx', String(entry.mx));
      row.setAttribute('data-my', String(entry.my));
      row.setAttribute('data-tier', String(entry.tier));
      row.setAttribute('data-biome', entry.biome);
      row.setAttribute('data-fog', String(entry.fogPercent));
      row.setAttribute('data-camp', String(entry.campStructures.length));
      const campLine = entry.campStructures.length > 0
        ? `Camp: ${entry.campStructures.length} structure${entry.campStructures.length === 1 ? '' : 's'} built`
        : 'Camp site only';
      const label = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px;min-width:0');
      label.append(
        el(doc, 'div', `font-size:14px;font-weight:700;color:${entry.isCurrent ? HERE : TEXT}`,
          `Map (${entry.mx}, ${entry.my})${entry.isCurrent ? ' — YOU ARE HERE' : ''}`),
        el(doc, 'div', `font-size:12px;color:${DIM}`, `${entry.biomeName} · Tier ${entry.tier}`),
        el(doc, 'div', `font-size:12px;color:${DIM}`,
          `Fog revealed ${entry.fogPercent}% · ${campLine}`),
      );
      row.append(label);
      if (!entry.isCurrent) {
        const btn = el(doc, 'button', [
          'background:rgba(30,42,64,.9)', `color:${GOLD}`, `border:1px solid ${GOLD}73`,
          'border-radius:6px', 'padding:0 16px', 'min-height:36px', 'font-size:13px',
          'font-weight:700', 'font-family:inherit', 'cursor:pointer', 'flex-shrink:0',
        ].join(';'), 'JUMP') as HTMLButtonElement;
        btn.setAttribute('aria-label', `Jump to map (${entry.mx}, ${entry.my})`);
        btn.disabled = this.traveling;
        btn.addEventListener('click', () => void this.travelTo(entry));
        row.append(btn);
      } else {
        // Camp badge on the current row, so built structures are visible
        // without reading the detail line.
        const badge = el(doc, 'div', [
          'font-size:11px', 'font-weight:700', `color:${entry.campStructures.length > 0 ? CAMP : DIM}`,
          'border:1px solid rgba(255,255,255,0.14)', 'border-radius:6px',
          'padding:4px 8px', 'flex-shrink:0',
        ].join(';'), entry.campStructures.length > 0 ? `🏕 CAMP ×${entry.campStructures.length}` : '🏕 SITE');
        row.append(badge);
      }
      this.rowsEl.append(row);
    }
  }

  private async travelTo(entry: { mx: number; my: number }): Promise<void> {
    if (this.traveling) return;
    this.traveling = true;
    this.hide();
    let ok = false;
    try {
      ok = await this.opts.onTravel({ mx: entry.mx, my: entry.my });
    } catch {
      ok = false;
    } finally {
      this.traveling = false;
    }
    // A failed travel (e.g. a transition was already running) re-opens
    // the atlas so the player can retry instead of wondering where it went.
    if (!ok && !this.disposed) this.show();
  }
}
