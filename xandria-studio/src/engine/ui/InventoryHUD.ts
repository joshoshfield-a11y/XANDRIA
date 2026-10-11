/**
 * InventoryHUD — DOM overlay inventory UI for the game HUD.
 *
 * Backpack grid (24), five equip slots (weapon/head/torso/legs/accessory),
 * item tooltip (name, rarity color, stats, description), rarity-colored
 * borders. Zero three.js cost; follows the HUD.ts DOM-overlay pattern
 * (scoped CSS, container-relative positioning).
 *
 * PAUSE BEHAVIOR (coordinator wiring):
 * - The HUD never pauses the engine itself. While open it sets
 *   `input.enabled = false` (restored on close) so the player stands still,
 *   but the world keeps ticking.
 * - `onOpenChange(open)` fires on toggle — wire it to engine.pause/resume
 *   if the game should freeze while the inventory is up.
 * - Escape closes the HUD via its own keydown listener, but engine Input
 *   ALSO maps Escape → 'pause'. The coordinator must skip its engine-pause
 *   toggle while `hud.isOpen()` is true.
 * - `update()` must be called once per frame for gamepad input.
 * - Call `refresh()` after any external inventory mutation (loot pickup,
 *   quest grants) so the DOM matches the model.
 */
import { EQUIP_SLOTS, type EquipSlot, type ItemDef, type ItemRarity } from '@spec';
import type { Input } from '../core/Input';
import { Inventory, BACKPACK_SIZE } from '../game/items/Inventory';

export const RARITY_COLORS: Record<ItemRarity, string> = {
  common: '#9a9a9a',
  uncommon: '#4dff6a',
  rare: '#4da6ff',
  epic: '#c97aff',
  legendary: '#ffb13d',
};

export const PACK_COLS = 6;

const CSS = `
.xinv { position:absolute; inset:0; z-index:20; font-family:'Segoe UI',system-ui,sans-serif; color:#e8ecf1; user-select:none; }
.xinv .shade { position:absolute; inset:0; background:rgba(4,6,10,.62); }
.xinv .panel { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:min(560px, calc(100% - 40px)); max-height:calc(100% - 40px); overflow-y:auto;
  background:rgba(10,14,20,.94); border:1px solid rgba(140,180,220,.35); border-radius:12px;
  padding:16px 18px; backdrop-filter:blur(6px); }
.xinv .title { font-size:15px; font-weight:800; letter-spacing:.22em; margin-bottom:10px; color:#ffd23f; }
.xinv .sec { font-size:10.5px; letter-spacing:.18em; opacity:.6; margin:10px 0 6px; }
.xinv .equiprow { display:flex; gap:8px; }
.xinv .grid { display:grid; grid-template-columns:repeat(6, 1fr); gap:6px; }
.xinv .cell { position:relative; aspect-ratio:1; border:1px solid rgba(140,180,220,.25); border-radius:8px;
  background:rgba(20,28,44,.6); cursor:pointer; display:flex; align-items:center; justify-content:center;
  overflow:hidden; padding:2px; }
.xinv .cell .nm { font-size:9.5px; line-height:1.25; text-align:center; word-break:break-word;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; opacity:.95; }
.xinv .cell .ct { position:absolute; right:3px; bottom:2px; font-size:10px; font-weight:700; color:#ffd23f;
  text-shadow:0 1px 3px #000; }
.xinv .cell .sl { font-size:8.5px; letter-spacing:.1em; opacity:.45; text-align:center; }
.xinv .cell.cursor { outline:2px solid #ffd23f; outline-offset:1px; }
.xinv .cell:hover { border-color:rgba(255,210,63,.7); }
.xinv .msg { min-height:18px; font-size:12.5px; color:#7af7ff; margin-top:10px; }
.xinv .hint { font-size:11px; opacity:.55; margin-top:4px; }
.xinv .tip { position:fixed; z-index:30; max-width:260px; pointer-events:none;
  background:rgba(8,11,18,.96); border:1px solid rgba(140,180,220,.4); border-radius:8px;
  padding:10px 12px; font-size:12px; }
.xinv .tip .tn { font-size:13px; font-weight:700; margin-bottom:2px; }
.xinv .tip .tm { font-size:10.5px; letter-spacing:.12em; opacity:.7; margin-bottom:6px; }
.xinv .tip .ts { color:#7dffa8; margin:2px 0; }
.xinv .tip .tb { color:#7af7ff; margin:2px 0; }
.xinv .tip .td { opacity:.8; line-height:1.45; margin-top:6px; }
.xinv .tip .tv { opacity:.6; margin-top:6px; font-size:11px; }
@media (max-width:760px) { .xinv .grid { grid-template-columns:repeat(6, 1fr); } .xinv .cell .nm { font-size:8.5px; } }
`;

const SLOT_LABELS: Record<EquipSlot, string> = {
  weapon: 'WEAPON', head: 'HEAD', torso: 'TORSO', legs: 'LEGS', accessory: 'ACC',
};

const rarityOf = (def: ItemDef): ItemRarity => def.rarity ?? 'common';

interface Cursor { area: 'pack' | 'equip'; index: number }

function rarityBorder(def: ItemDef): string {
  const c = RARITY_COLORS[rarityOf(def)];
  return `border-color:${c}; box-shadow:inset 0 0 12px ${c}22;`;
}

function statsLine(def: ItemDef): string {
  if (!def.stats) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(def.stats)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    parts.push(`${v > 0 ? '+' : ''}${v} ${k}`);
  }
  return parts.join(', ');
}

export class InventoryHUD {
  /** Fires on open/close — the coordinator wires engine pause/resume here. */
  onOpenChange: ((open: boolean) => void) | null = null;

  private root: HTMLDivElement;
  private panel: HTMLDivElement;
  private equipCells: HTMLDivElement[] = [];
  private packCells: HTMLDivElement[] = [];
  private msgEl: HTMLDivElement;
  private tip: HTMLDivElement;
  private openFlag = false;
  private cursor: Cursor = { area: 'pack', index: 0 };
  private input: Input | null = null;
  private inputWasEnabled = true;
  private disposers: Array<() => void> = [];
  private msgTimer: ReturnType<typeof setTimeout> | null = null;
  // gamepad edge state (standard mapping: 9=start, 0=A, 1=B, 12-15=dpad)
  private gpPrev: boolean[] = [];
  private gpRepeatAt = 0;
  private gpRepeatDir = -1;

  constructor(
    private container: HTMLElement,
    private inventory: Inventory,
    opts?: { input?: Input },
  ) {
    if (opts?.input) this.input = opts.input;
    if (typeof document !== 'undefined') {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    container.style.position = 'relative';

    this.root = document.createElement('div');
    this.root.className = 'xinv';
    this.root.style.display = 'none';
    const shade = document.createElement('div');
    shade.className = 'shade';
    shade.addEventListener('click', () => this.close());
    this.panel = document.createElement('div');
    this.panel.className = 'panel';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'INVENTORY';
    this.panel.appendChild(title);

    const equipSec = document.createElement('div');
    equipSec.className = 'sec';
    equipSec.textContent = 'EQUIPPED';
    this.panel.appendChild(equipSec);
    const equipRow = document.createElement('div');
    equipRow.className = 'equiprow';
    for (const slot of EQUIP_SLOTS) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.slot = slot;
      cell.addEventListener('click', () => this.onEquipCellClick(slot));
      cell.addEventListener('mouseenter', (e) => this.showTipForEquipped(slot, e));
      cell.addEventListener('mouseleave', () => this.hideTip());
      equipRow.appendChild(cell);
      this.equipCells.push(cell);
    }
    this.panel.appendChild(equipRow);

    const packSec = document.createElement('div');
    packSec.className = 'sec';
    packSec.textContent = 'BACKPACK';
    this.panel.appendChild(packSec);
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (let i = 0; i < BACKPACK_SIZE; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = String(i);
      cell.addEventListener('click', () => this.onPackCellClick(i));
      cell.addEventListener('mouseenter', (e) => this.showTipForPack(i, e));
      cell.addEventListener('mouseleave', () => this.hideTip());
      grid.appendChild(cell);
      this.packCells.push(cell);
    }
    this.panel.appendChild(grid);

    this.msgEl = document.createElement('div');
    this.msgEl.className = 'msg';
    this.panel.appendChild(this.msgEl);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'I / Tab: close · arrows: move · Enter: equip / use · click item: equip / use · click equipped: unequip';
    this.panel.appendChild(hint);

    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.style.display = 'none';
    this.root.append(shade, this.panel, this.tip);
    container.appendChild(this.root);

    // keyboard: I / Tab toggle, Esc closes, arrows + Enter when open
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.code === 'KeyI' || e.code === 'Tab') {
        e.preventDefault();
        this.toggle();
        return;
      }
      if (!this.openFlag) return;
      if (e.code === 'Escape') { e.preventDefault(); this.close(); return; }
      if (e.code.startsWith('Arrow')) { e.preventDefault(); this.moveCursor(e.code); return; }
      if (e.code === 'Enter') { e.preventDefault(); this.confirm(); return; }
    };
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
    this.refresh();
  }

  // ------------------------------------------------------------ open/close

  isOpen(): boolean { return this.openFlag; }

  toggle(): void { this.openFlag ? this.close() : this.open(); }

  open(): void {
    if (this.openFlag) return;
    this.openFlag = true;
    this.root.style.display = '';
    if (this.input) {
      this.inputWasEnabled = this.input.enabled;
      this.input.enabled = false;
    }
    this.refresh();
    this.onOpenChange?.(true);
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.root.style.display = 'none';
    this.hideTip();
    if (this.input) this.input.enabled = this.inputWasEnabled;
    this.onOpenChange?.(false);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    if (this.msgTimer) clearTimeout(this.msgTimer);
    this.root.remove();
  }

  // ------------------------------------------------------------ render

  /** Re-render every cell from the inventory model. */
  refresh(): void {
    const pack = this.inventory.getBackpack();
    for (let i = 0; i < BACKPACK_SIZE; i++) {
      const cell = this.packCells[i];
      const entry = pack[i];
      if (!entry) {
        cell.innerHTML = '';
        cell.style.cssText = '';
      } else {
        const def = this.inventory.getDef(entry.itemId);
        const name = def?.name ?? entry.itemId;
        cell.innerHTML = '';
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = name;
        cell.appendChild(nm);
        if (entry.count > 1) {
          const ct = document.createElement('div');
          ct.className = 'ct';
          ct.textContent = `×${entry.count}`;
          cell.appendChild(ct);
        }
        cell.style.cssText = def ? rarityBorder(def) : '';
      }
      cell.classList.toggle('cursor', this.openFlag && this.cursor.area === 'pack' && this.cursor.index === i);
    }
    for (let j = 0; j < EQUIP_SLOTS.length; j++) {
      const slot = EQUIP_SLOTS[j];
      const cell = this.equipCells[j];
      const itemId = this.inventory.getEquipped(slot);
      cell.innerHTML = '';
      if (!itemId) {
        const sl = document.createElement('div');
        sl.className = 'sl';
        sl.textContent = SLOT_LABELS[slot];
        cell.appendChild(sl);
        cell.style.cssText = '';
      } else {
        const def = this.inventory.getDef(itemId);
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = def?.name ?? itemId;
        cell.appendChild(nm);
        cell.style.cssText = def ? rarityBorder(def) : '';
      }
      cell.classList.toggle('cursor', this.openFlag && this.cursor.area === 'equip' && this.cursor.index === j);
    }
  }

  /** Transient feedback line inside the panel. */
  toast(msg: string, ms = 2200): void {
    this.msgEl.textContent = msg;
    if (this.msgTimer) clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => {
      this.msgEl.textContent = '';
      this.msgTimer = null;
    }, ms);
  }

  // ------------------------------------------------------------ actions

  /** Keyboard/mouse "confirm" on the cursor cell. */
  private confirm(): void {
    if (this.cursor.area === 'equip') {
      this.unequipAt(this.cursor.index);
    } else {
      this.activatePackCell(this.cursor.index);
    }
  }

  private onPackCellClick(i: number): void {
    this.cursor = { area: 'pack', index: i };
    this.activatePackCell(i);
  }

  private onEquipCellClick(slot: EquipSlot): void {
    this.cursor = { area: 'equip', index: EQUIP_SLOTS.indexOf(slot) };
    this.unequipAt(this.cursor.index);
  }

  private activatePackCell(i: number): void {
    const entry = this.inventory.getBackpack()[i];
    if (!entry) return;
    const def = this.inventory.getDef(entry.itemId);
    if (!def) return;
    if (def.type === 'weapon' || def.type === 'armor') {
      const r = this.inventory.equip(entry.itemId);
      if (r) this.toast(r.displaced ? `Equipped ${def.name} (swapped)` : `Equipped ${def.name}`);
      else this.toast('No room to swap — backpack full');
    } else if (def.type === 'consumable') {
      if (this.inventory.use(entry.itemId)) this.toast(`Used ${def.name}`);
      else this.toast(`Can't use ${def.name}`);
    } else {
      this.toast(`${def.name}: no action (keepsake)`);
    }
    this.refresh();
  }

  private unequipAt(j: number): void {
    const slot = EQUIP_SLOTS[j];
    const itemId = this.inventory.getEquipped(slot);
    if (!itemId) return;
    const def = this.inventory.getDef(itemId);
    if (this.inventory.unequip(slot)) this.toast(`Unequipped ${def?.name ?? itemId}`);
    else this.toast('No room — backpack full');
    this.refresh();
  }

  // ------------------------------------------------------------ cursor

  private moveCursor(code: string): void {
    const cur = this.cursor;
    if (cur.area === 'pack') {
      const row = Math.floor(cur.index / PACK_COLS);
      const col = cur.index % PACK_COLS;
      if (code === 'ArrowLeft' && col > 0) cur.index -= 1;
      else if (code === 'ArrowRight' && col < PACK_COLS - 1) cur.index += 1;
      else if (code === 'ArrowDown' && row < BACKPACK_SIZE / PACK_COLS - 1) cur.index += PACK_COLS;
      else if (code === 'ArrowUp') {
        if (row > 0) cur.index -= PACK_COLS;
        else this.cursor = { area: 'equip', index: Math.min(col, EQUIP_SLOTS.length - 1) };
      }
    } else {
      if (code === 'ArrowLeft' && cur.index > 0) cur.index -= 1;
      else if (code === 'ArrowRight' && cur.index < EQUIP_SLOTS.length - 1) cur.index += 1;
      else if (code === 'ArrowDown') this.cursor = { area: 'pack', index: Math.min(cur.index, PACK_COLS - 1) };
    }
    this.refresh();
  }

  // ------------------------------------------------------------ tooltip

  private showTipForPack(i: number, e: MouseEvent): void {
    const entry = this.inventory.getBackpack()[i];
    if (!entry) return;
    const def = this.inventory.getDef(entry.itemId);
    if (!def) return;
    this.showTip(def, entry.count, e.clientX, e.clientY);
  }

  private showTipForEquipped(slot: EquipSlot, e: MouseEvent): void {
    const itemId = this.inventory.getEquipped(slot);
    if (!itemId) return;
    const def = this.inventory.getDef(itemId);
    if (!def) return;
    this.showTip(def, 1, e.clientX, e.clientY);
  }

  private showTip(def: ItemDef, count: number, x: number, y: number): void {
    const rarity = rarityOf(def);
    this.tip.innerHTML = '';
    const color = RARITY_COLORS[rarity];
    const n = document.createElement('div');
    n.className = 'tn';
    n.style.color = color;
    n.textContent = def.name;
    const m = document.createElement('div');
    m.className = 'tm';
    m.textContent = `${def.type.toUpperCase()} · ${rarity.toUpperCase()}${count > 1 ? ` · ×${count}` : ''}`;
    this.tip.append(n, m);
    const stats = statsLine(def);
    if (stats) {
      const s = document.createElement('div');
      s.className = 'ts';
      s.textContent = stats;
      this.tip.appendChild(s);
    }
    if (def.behavior) {
      const b = document.createElement('div');
      b.className = 'tb';
      const amt = def.behavior.amount !== undefined ? ` ${def.behavior.amount}` : '';
      const dur = def.behavior.duration ? ` (${def.behavior.duration}s)` : '';
      b.textContent = `Use: ${def.behavior.effect}${amt}${dur}`;
      this.tip.appendChild(b);
    }
    if (def.description) {
      const d = document.createElement('div');
      d.className = 'td';
      d.textContent = def.description;
      this.tip.appendChild(d);
    }
    if (def.value !== undefined) {
      const v = document.createElement('div');
      v.className = 'tv';
      v.textContent = `value: ${def.value}c`;
      this.tip.appendChild(v);
    }
    // textContent everywhere above: def text is spec/LLM-sourced — never innerHTML
    this.tip.style.display = '';
    this.tip.style.borderColor = color;
    const pad = 14;
    const w = Math.min(260, window.innerWidth - pad * 2);
    this.tip.style.left = `${Math.min(x + pad, window.innerWidth - w - pad)}px`;
    this.tip.style.top = `${Math.min(y + pad, window.innerHeight - 160)}px`;
  }

  private hideTip(): void {
    this.tip.style.display = 'none';
  }

  // ------------------------------------------------------------ gamepad

  /**
   * Poll the gamepad (standard mapping). The coordinator calls this once per
   * frame. Start toggles, dpad moves the cursor (with repeat), A confirms,
   * B closes. No-op without a connected pad. Follows Input.pollGamepad's
   * access pattern (guarded navigator.getGamepads).
   */
  update(): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads
      ? navigator.getGamepads()
      : [];
    const gp = pads && pads[0];
    if (!gp) { this.gpPrev = []; return; }
    const pressed = (i: number): boolean => !!gp.buttons[i]?.pressed;
    const edge = (i: number): boolean => pressed(i) && !this.gpPrev[i];
    if (edge(9)) { this.toggle(); } // Start
    if (this.openFlag) {
      if (edge(1)) { this.close(); return; } // B
      if (edge(0)) this.confirm(); // A
      // dpad cursor with key-repeat while held
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      const dirs = [12, 13, 14, 15]; // up down left right
      const held = dirs.findIndex((b) => pressed(b));
      if (held >= 0) {
        if (held !== this.gpRepeatDir || now >= this.gpRepeatAt) {
          const code = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'][held];
          this.moveCursor(code);
          this.gpRepeatDir = held;
          this.gpRepeatAt = now + (this.gpPrev[dirs[held]] ? 180 : 350);
        }
      } else {
        this.gpRepeatDir = -1;
      }
    }
    this.gpPrev = gp.buttons.map((b) => b.pressed);
  }
}
