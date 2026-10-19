/**
 * Crafting wave (workstream C): the crafting panel — recipe list UI.
 *
 * DOM pattern follows DialoguePanel (absolute in the engine container,
 * self-contained inline styles, the panel blocks pointer input while open,
 * capture-phase key handling owns E/Escape so blueprint bubble-phase
 * handlers never see them). The `doc` param is injectable so unit tests
 * can pass a minimal DOM stub.
 *
 * Behavior:
 * - show(stationName): opens the recipe list for the station the player
 *   is standing at. Every row's state comes from checkCraft() (the pure
 *   validation half of craft()): available recipes get a CRAFT button;
 *   missing-ingredients / missing-station / min-level rows show the honest
 *   reason and a disabled button.
 * - One click on CRAFT enqueues the recipe (queue cap 5). The queue is a
 *   short timed progress bar per item (1.2s each — juice, not a
 *   wait-wall), ticked by update(dt) off the engine frame (no Date.now).
 *   On completion craft() runs the atomic transaction; success and
 *   failure both toast (failure re-validates, so a row that went stale
 *   mid-queue fails honestly instead of consuming).
 * - Inventory counts render live: rows re-render on show and on queue
 *   completion (the only changes possible while the modal panel is open).
 * - Keyboard + touch: buttons are native <button> (focusable, Enter
 *   activates, tap works on touch); Esc/E closes; the layout is a centered
 *   modal (min(440px, 94vw), max-height 84vh, scrollable) that fits
 *   360x780.
 */
import type { ItemDef } from '@spec';
import {
  checkCraft,
  craft,
  type CraftingRecipe,
  type CraftingInventory,
} from '../game/crafting';

export interface CraftingPanelOpts {
  container: HTMLElement;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** live inventory sink (null = no inventory; craft buttons disable honestly) */
  inventory: () => CraftingInventory | null;
  /** item def table (must include the recipe output + ingredient ids) */
  defs: () => Record<string, ItemDef>;
  /** the seeded recipe pool for this spec (buildRecipePool — pure) */
  recipes: () => CraftingRecipe[];
  /** ids of stations present in this map (the missing-station check) */
  stationIds: () => ReadonlySet<string>;
  /** player progression level for minLevel gates */
  playerLevel: () => number;
  /** toast surface for craft success/failure feedback */
  toast: (msg: string) => void;
  /** per queued craft, seconds of timed progress (default 1.2) */
  queueSeconds?: number;
  /** max queued crafts (default 5) */
  queueCap?: number;
}

interface QueueItem {
  recipeId: string;
  recipeName: string;
  t: number;
  dur: number;
  barEl: HTMLElement | null;
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

export class CraftingPanel {
  private root: HTMLElement;
  private headEl: HTMLElement;
  private rowsEl: HTMLElement;
  private queueEl: HTMLElement;
  private queueListEl: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;
  private queue: QueueItem[] = [];
  /** the station id the panel is currently open at (null = not open) */
  private currentStationId: string | null = null;
  private readonly queueSeconds: number;
  private readonly queueCap: number;

  constructor(private readonly opts: CraftingPanelOpts) {
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container;
    this.queueSeconds = opts.queueSeconds ?? 1.2;
    this.queueCap = opts.queueCap ?? 5;

    const root = el(doc, 'div', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9600', 'width:min(440px,94vw)', 'max-height:84vh',
      'display:none', 'flex-direction:column',
      `background:${PANEL_BG}`, `border:1px solid ${AMBER}73`, 'border-radius:12px',
      'font-family:system-ui,-apple-system,sans-serif', `color:${TEXT}`,
      'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
    ].join(';'));
    root.id = 'xandria-crafting-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Crafting');

    // header
    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${AMBER}33`,
    ].join(';'));
    const title = el(doc, 'div', `font-size:15px;font-weight:700;color:${AMBER};letter-spacing:0.05em`, 'CRAFTING');
    this.headEl = el(doc, 'div', `font-size:12px;color:${DIM}`, '');
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close crafting panel');
    close.addEventListener('click', () => this.hide());
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    headLeft.append(title, this.headEl);
    head.append(headLeft, close);

    // recipe rows (scrollable)
    this.rowsEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 10px', 'display:flex',
      'flex-direction:column', 'gap:8px', 'min-height:120px',
    ].join(';'));

    // queue
    this.queueEl = el(doc, 'div', [
      'padding:8px 14px 6px', `border-top:1px solid ${AMBER}33`, 'display:none',
      'flex-direction:column', 'gap:6px',
    ].join(';'));
    const qTitle = el(doc, 'div', `font-size:11px;font-weight:700;color:${DIM};letter-spacing:0.08em`, 'QUEUE');
    this.queueListEl = el(doc, 'div', 'display:flex;flex-direction:column;gap:6px');
    this.queueEl.append(qTitle, this.queueListEl);

    // footer hint
    const foot = el(doc, 'div', [
      'padding:8px 14px 10px', `font-size:11px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'E / Esc to close');

    root.append(head, this.rowsEl, this.queueEl, foot);
    container.appendChild(root);
    this.root = root;

    // Capture phase: the panel owns E/Escape while open, so the
    // interaction prompts (bubble/capture on the same window) never see them.
    this.onKey = (e: KeyboardEvent) => {
      if (!this.open_) return;
      if (e.code === 'Escape' || e.code === 'KeyE') {
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

  /**
   * The station contract id the panel is currently anchored to
   * (station_workbench, …) — null when closed or unanchored. The quest
   * wave can use this to tell which station the player is crafting at.
   */
  get anchoredStationId(): string | null {
    return this.currentStationId;
  }

  /** Visible for tests: queued recipe ids. */
  get queuedIds(): string[] {
    return this.queue.map((q) => q.recipeId);
  }

  /** Open the panel at a station. Re-opening swaps the station name in place. */
  show(stationName: string, stationId?: string): void {
    if (this.disposed) return;
    this.headEl.textContent = `at ${stationName}`;
    this.currentStationId = stationId ?? null;
    this.root.style.display = 'flex';
    this.open_ = true;
    this.renderRows();
    this.renderQueue();
  }

  hide(): void {
    if (this.disposed) return;
    this.root.style.display = 'none';
    this.open_ = false;
    this.currentStationId = null;
  }

  /**
   * Stations for the missing-station check. When open at a specific station,
   * only that station counts (the player pressed [E] on it — a Forge recipe
   * at the Workbench must read "Needs a Forge", not craft). The opts set is
   * the fallback when the panel isn't anchored to a station (unit tests).
   */
  private activeStations(): ReadonlySet<string> {
    return this.currentStationId !== null ? new Set([this.currentStationId]) : this.opts.stationIds();
  }

  /**
   * Per-frame: tick the craft queue. Rows re-render on show() and after each
   * queued craft completes (the only inventory changes possible while the
   * modal panel is open) — no timer, so CRAFT buttons are never detached
   * from under the pointer.
   */
  update(dt: number): void {
    if (this.disposed || !this.open_) return;
    this.tickQueue(dt);
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
    this.queue = [];
  }

  // ------------------------------------------------------------ queue

  private enqueue(recipeId: string): void {
    if (this.queue.length >= this.queueCap) {
      this.opts.toast(`Queue full (${this.queueCap}) — wait for a craft to finish.`);
      return;
    }
    const recipe = this.opts.recipes().find((r) => r.id === recipeId);
    if (!recipe) return;
    this.queue.push({ recipeId, recipeName: recipe.name, t: 0, dur: this.queueSeconds, barEl: null });
    this.renderQueue();
  }

  /** Advance the head of the queue; run craft() when its timer completes. */
  private tickQueue(dt: number): void {
    const head = this.queue[0];
    if (!head) return;
    head.t += dt;
    const k = Math.min(1, head.t / head.dur);
    if (head.barEl) head.barEl.style.width = `${Math.round(k * 100)}%`;
    if (k < 1) return;
    this.queue.shift();
    this.completeCraft(head.recipeId);
    this.renderQueue();
    this.renderRows();
  }

  /** Run the atomic transaction at queue completion; re-validates first. */
  private completeCraft(recipeId: string): void {
    const inv = this.opts.inventory();
    const recipes = this.opts.recipes();
    const recipe = recipes.find((r) => r.id === recipeId);
    if (!recipe) return;
    if (!inv) {
      this.opts.toast('No inventory — nothing to craft into.');
      return;
    }
    const craftOpts = {
      inventory: inv,
      defs: this.opts.defs(),
      enabled: true,
      playerLevel: this.opts.playerLevel(),
      stations: this.activeStations(),
    };
    const verdict = checkCraft(recipes, recipeId, craftOpts);
    if (!verdict.ok) {
      // Went stale mid-queue (ingredients spent, station gone): fail
      // honestly, consume nothing.
      this.opts.toast(`${recipe.name}: ${verdict.detail ?? verdict.reason}`);
      return;
    }
    const res = craft(recipes, recipeId, craftOpts);
    if (res.ok && res.granted) {
      const def = this.opts.defs()[res.granted.itemId];
      this.opts.toast(`Crafted ${res.granted.count > 1 ? `${res.granted.count}× ` : ''}${def?.name ?? res.granted.itemId}`);
    } else {
      this.opts.toast(`${recipe.name}: ${res.detail ?? res.reason}`);
    }
  }

  private renderQueue(): void {
    const doc = this.opts.doc ?? globalThis.document;
    while (this.queueListEl.firstChild) this.queueListEl.firstChild.remove();
    for (const q of this.queue) {
      const row = el(doc, 'div', 'display:flex;flex-direction:column;gap:3px');
      const label = el(doc, 'div', `font-size:12px;color:${TEXT}`, q.recipeName);
      const track = el(doc, 'div', 'height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden');
      const bar = el(doc, 'div', `height:100%;width:0%;background:${AMBER};border-radius:3px`);
      track.append(bar);
      row.append(label, track);
      this.queueListEl.append(row);
      q.barEl = bar;
    }
    this.queueEl.style.display = this.queue.length ? 'flex' : 'none';
  }

  // ------------------------------------------------------------ rows

  /** Rebuild the recipe rows from checkCraft() states. */
  private renderRows(): void {
    const doc = this.opts.doc ?? globalThis.document;
    const recipes = this.opts.recipes();
    const inv = this.opts.inventory();
    const defs = this.opts.defs();
    const craftOpts = {
      inventory: inv ?? { add: () => 1, remove: () => 0, count: () => 0 },
      defs,
      enabled: true,
      playerLevel: this.opts.playerLevel(),
      stations: this.activeStations(),
    };
    while (this.rowsEl.firstChild) this.rowsEl.firstChild.remove();
    if (!recipes.length) {
      this.rowsEl.append(el(doc, 'div', `font-size:13px;color:${DIM};padding:12px 4px`, 'No recipes in this spec\u2019s pool.'));
      return;
    }
    for (const recipe of recipes) {
      const verdict = inv ? checkCraft(recipes, recipe.id, { ...craftOpts, inventory: inv }) : null;
      this.rowsEl.append(this.recipeRow(doc, recipe, verdict, defs, inv));
    }
  }

  private recipeRow(
    doc: Document,
    recipe: CraftingRecipe,
    verdict: ReturnType<typeof checkCraft> | null,
    defs: Record<string, ItemDef>,
    inv: CraftingInventory | null,
  ): HTMLElement {
    const row = el(doc, 'div', [
      'border:1px solid rgba(255,255,255,0.09)', 'border-radius:8px',
      'padding:9px 10px', 'display:flex', 'flex-direction:column', 'gap:5px',
      'background:rgba(255,255,255,0.025)',
    ].join(';'));

    const top = el(doc, 'div', 'display:flex;align-items:baseline;justify-content:space-between;gap:8px');
    const name = el(doc, 'div', 'font-size:13.5px;font-weight:700', recipe.name);
    const outDef = defs[recipe.output.itemId];
    const out = el(doc, 'div', `font-size:12px;color:${AMBER}`,
      `\u2192 ${recipe.output.count > 1 ? `${recipe.output.count}\u00d7 ` : ''}${outDef?.name ?? recipe.output.itemId}`);
    top.append(name, out);

    const ingBits = recipe.ingredients.map((ing) => {
      const have = inv?.count(ing.itemId) ?? 0;
      const d = defs[ing.itemId];
      const label = d?.name ?? ing.itemId;
      const ok = have >= ing.count;
      return { text: `${ing.count}\u00d7 ${label} (${have}/${ing.count})`, ok };
    });
    const ingLine = el(doc, 'div', `font-size:12px;color:${DIM}`, '');
    // build with spans so shortfalls read red
    ingBits.forEach((b, i) => {
      if (i > 0) ingLine.append(doc.createTextNode('  \u00b7  '));
      const s = el(doc, 'span', b.ok ? '' : 'color:#ff7a6b;font-weight:600', b.text);
      ingLine.append(s);
    });

    const bottom = el(doc, 'div', 'display:flex;align-items:center;justify-content:space-between;gap:8px');
    let reason = '';
    let canCraft = false;
    if (!inv) {
      reason = 'No inventory in this scene.';
    } else if (verdict && !verdict.ok) {
      reason = this.reasonText(verdict.reason, verdict.detail, recipe);
    } else {
      canCraft = true;
    }
    const reasonEl = el(doc, 'div', `font-size:11.5px;color:${canCraft ? DIM : '#ff9a8a'}`,
      canCraft ? (recipe.stationId ? `Craft at a ${this.stationLabel(recipe.stationId)}` : 'Hand-crafted anywhere') : reason);
    const btn = el(doc, 'button', [
      'background:' + (canCraft ? AMBER : 'rgba(255,255,255,0.07)'),
      'color:' + (canCraft ? '#14100a' : DIM),
      'border:none', 'border-radius:6px', 'padding:7px 14px',
      'font-size:12.5px', 'font-weight:700', 'font-family:inherit',
      'cursor:' + (canCraft ? 'pointer' : 'default'),
      'opacity:' + (canCraft ? '1' : '0.55'),
    ].join(';'), 'CRAFT') as HTMLButtonElement;
    btn.disabled = !canCraft;
    if (canCraft) btn.addEventListener('click', () => this.enqueue(recipe.id));
    bottom.append(reasonEl, btn);

    row.append(top, ingLine, bottom);
    return row;
  }

  private stationLabel(stationId: string): string {
    const short = stationId.split('_')[1];
    if (short === 'workbench') return 'Workbench';
    if (short === 'anvil') return 'Anvil';
    if (short === 'forge') return 'Forge';
    if (short === 'alchemy') return 'Alchemy Table';
    return stationId;
  }

  private reasonText(reason: string | undefined, detail: string | undefined, recipe: CraftingRecipe): string {
    switch (reason) {
      case 'missing-ingredients': return 'Missing ingredients.';
      case 'missing-station': return recipe.stationId ? `Needs a ${this.stationLabel(recipe.stationId)}.` : 'Needs a station.';
      case 'min-level': return detail ?? 'Level too low.';
      case 'no-room': return 'Backpack full.';
      case 'unknown-output':
      case 'unknown-ingredient': return 'Recipe content error (no item def).';
      case 'crafting-disabled': return 'Crafting is disabled.';
      default: return detail ?? 'Unavailable.';
    }
  }
}
