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
import { EQUIP_SLOTS, ITEM_RARITIES, ITEM_TYPES, type EquipSlot, type ItemDef, type ItemRarity } from '@spec';
import type { Input } from '../core/Input';
import { Inventory, BACKPACK_SIZE } from '../game/items/Inventory';
import { unitSellPrice, isSellable } from '../game/economy';
import {
  ITEM_TIERS,
  ITEM_TIER_LABELS,
  type ItemTier,
  NO_FILTER,
  SORT_MODE_LABELS,
  type InventoryFilter,
  type InventorySortMode,
  applyInventoryView,
} from '../game/items/inventoryView';

/**
 * Optional sell integration (vendor-economy wave). When present the HUD
 * offers "sell junk", crediting scrap via addScrap at
 * unitSellPrice(def, sellMult) per unit sold. Absent on blueprints
 * without the economy — the sell button is hidden, not faked.
 */
export interface InventorySellHooks {
  addScrap: (n: number) => void;
  sellMult: number;
}
import type { SetUiReport } from '../game/setBonuses';
import type { CritStats } from '../game/crit';
import { ENCHANT_DEFS } from '../game/enchantments';
import { ELEMENTAL_TABLE } from '../game/elemental';
import {
  type GearLoadout,
  type ApplyLoadoutResult,
  loadoutPieceCount,
} from '../game/loadouts';

/**
 * Loadout hooks (loadout-presets wave). When present the HUD offers a
 * LOADOUTS section; persistence lives with the caller (itemKit reads /
 * writes the active save slot's profile) — the HUD only renders and
 * reports. Absent on panels built without an item kit.
 */
export interface LoadoutHooks {
  /** Current 3-slot rack (fresh copies). */
  list: () => GearLoadout[];
  /** Snapshot the live equip set under a name (slot-validated). */
  capture: (name: string) => GearLoadout;
  /** Overwrite one slot with a snapshot (persisted by the caller). */
  save: (index: number, loadout: GearLoadout) => void;
  /** Rename one slot; false when the name is blank / index bad. */
  rename: (index: number, name: string) => boolean;
  /** Clear one slot back to its default empty state. */
  clear: (index: number) => void;
  /** Apply one slot through the equip/unequip path (combat-guarded). */
  apply: (index: number) => ApplyLoadoutResult;
  /** Live combat guard (Engine.inCombat) for the apply refusal message. */
  inCombat: () => boolean;
}

import { isSetPiece, type SalvageYield } from '../game/salvage';

/**
 * Optional salvage integration (gear-salvage wave). When present the
 * HUD forwards clearFromLoadouts to Inventory.salvage(), which fires
 * it only when zero units of the salvaged id remain (the
 * loadout-snapshot rule — see engine/game/salvage.ts). Absent on
 * trees without the loadout-presets wave: the hook is simply never
 * called, and salvaging works identically.
 */
export interface InventorySalvageHooks {
  clearFromLoadouts?: (itemId: string) => void;}

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
.xinv .sets { margin-top:6px; }
.xinv .setrow { font-size:12px; padding:6px 8px; border:1px solid rgba(140,180,220,.22); border-radius:8px;
  margin-bottom:6px; background:rgba(16,24,40,.55); }
.xinv .setrow .sn { font-weight:700; color:#ffd23f; }
.xinv .setrow .sc { opacity:.75; font-size:11px; margin-left:6px; }
.xinv .setrow .st { font-size:11px; margin-top:2px; opacity:.85; }
.xinv .setrow .st.on { color:#7dffa8; font-weight:700; }
.xinv .setrow .st.off { opacity:.45; }
.xinv .enchs { margin-top:6px; }
.xinv .enchrow { font-size:12px; padding:6px 8px; border:1px solid rgba(140,180,220,.22); border-radius:8px;
  margin-bottom:6px; background:rgba(16,24,40,.55); }
.xinv .enchrow .en { font-weight:700; color:#ffd23f; }
.xinv .enchrow .es { opacity:.75; font-size:11px; margin-left:6px; }
.xinv .enchrow .ea { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
.xinv .enchrow button { min-height:28px; background:rgba(30,42,64,.9); color:#e8ecf1;
  border:1px solid rgba(140,180,220,.35); border-radius:6px; font-size:12px; padding:2px 10px; cursor:pointer; }
.xinv .enchrow button:hover { border-color:rgba(255,210,63,.7); }
.xinv .enchrow button:disabled { opacity:.45; cursor:default; }
.xinv .loadouts { margin-top:6px; }
.xinv .loadrow { font-size:12px; padding:6px 8px; border:1px solid rgba(140,180,220,.22); border-radius:8px;
  margin-bottom:6px; background:rgba(16,24,40,.55); }
.xinv .loadrow .ln { font-weight:700; color:#ffd23f; }
.xinv .loadrow .ls { opacity:.75; font-size:11px; margin-left:6px; }
.xinv .loadrow .la { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
.xinv .loadrow button { min-height:28px; background:rgba(30,42,64,.9); color:#e8ecf1;
  border:1px solid rgba(140,180,220,.35); border-radius:6px; font-size:12px; padding:2px 10px; cursor:pointer; }
.xinv .loadrow button:hover { border-color:rgba(255,210,63,.7); }
.xinv .loadrow input { min-height:28px; background:rgba(20,28,44,.95); color:#e8ecf1;
  border:1px solid rgba(255,210,63,.6); border-radius:6px; font-size:12px; padding:2px 8px; max-width:180px; }.xinv .salvs { margin-top:6px; }
.xinv .salvrow { font-size:12px; padding:6px 8px; border:1px solid rgba(140,180,220,.22); border-radius:8px;
  margin-bottom:6px; background:rgba(16,24,40,.55); }
.xinv .salvrow .sn { font-weight:700; color:#ffd23f; }
.xinv .salvrow .ss { opacity:.75; font-size:11px; margin-left:6px; }
.xinv .salvrow .sy { font-size:11px; margin-top:2px; color:#7dffa8; }
.xinv .salvrow button { min-height:28px; background:rgba(30,42,64,.9); color:#e8ecf1;
  border:1px solid rgba(140,180,220,.35); border-radius:6px; font-size:12px; padding:2px 10px; cursor:pointer; margin-top:4px; }
.xinv .salvrow button:hover { border-color:rgba(255,210,63,.7); }.xinv .tip { position:fixed; z-index:30; max-width:260px; pointer-events:none;
  background:rgba(8,11,18,.96); border:1px solid rgba(140,180,220,.4); border-radius:8px;
  padding:10px 12px; font-size:12px; }
.xinv .tip .tn { font-size:13px; font-weight:700; margin-bottom:2px; }
.xinv .tip .tm { font-size:10.5px; letter-spacing:.12em; opacity:.7; margin-bottom:6px; }
.xinv .tip .ts { color:#7dffa8; margin:2px 0; }
.xinv .tip .tb { color:#7af7ff; margin:2px 0; }
.xinv .tip .td { opacity:.8; line-height:1.45; margin-top:6px; }
.xinv .tip .tv { opacity:.6; margin-top:6px; font-size:11px; }
.xinv .tools { display:flex; gap:6px; flex-wrap:wrap; margin:2px 0 6px; }
.xinv .tools select { min-height:28px; background:rgba(20,28,44,.85); color:#e8ecf1;
  border:1px solid rgba(140,180,220,.35); border-radius:6px; font-size:12px; padding:2px 4px; max-width:32%; }
.xinv .actions { display:flex; gap:6px; flex-wrap:wrap; margin:6px 0 2px; }
.xinv .actions button, .xinv .confirm button { min-height:28px; background:rgba(30,42,64,.9); color:#e8ecf1;
  border:1px solid rgba(140,180,220,.35); border-radius:6px; font-size:12px; padding:2px 10px; cursor:pointer; }
.xinv .actions button:hover, .xinv .confirm button:hover { border-color:rgba(255,210,63,.7); }
.xinv .actions button.on { border-color:#ffd23f; color:#ffd23f; }
.xinv .confirm { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:6px 0 2px;
  font-size:12.5px; color:#ffd23f; }
.xinv .cell .jk { position:absolute; left:3px; top:2px; font-size:8px; font-weight:800; letter-spacing:.08em;
  color:#0a0e14; background:#ffb13d; border-radius:4px; padding:1px 4px; }
.xinv .cell.isjunk { border-style:dashed; }
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
  // inventory-qol: filter/sort/junk view state (client-side projection only)
  private filter: InventoryFilter = { ...NO_FILTER };
  private sort: InventorySortMode = 'default';
  private junkMode = false;
  /** Display index -> backpack slot (rebuilt by refresh()). */
  private viewSlots: number[] = [];
  private sellHooks: InventorySellHooks | null = null;
  private junkModeBtn!: HTMLButtonElement;
  private actionsEl!: HTMLDivElement;
  private confirmEl!: HTMLDivElement;
  // Gear sets wave: resolver for the set-bonus UI section (null = hidden).
  private setReport: (() => SetUiReport) | null = null;
  private setSection: HTMLDivElement;
  private setRows: HTMLDivElement;
  // CRIT-SYSTEM: resolver for the CRIT STATS section (null = hidden).
  private critReport: (() => CritStats) | null = null;
  private critSection: HTMLDivElement;
  private critRows: HTMLDivElement;
  // Enchantments wave: enchant-action section (reads live inventory state).
  private enchSection: HTMLDivElement;
  private enchRows: HTMLDivElement;
  // Loadout-presets wave: loadout section (reads the rack via hooks).
  private loadoutHooks: LoadoutHooks | null = null;
  private loadoutSection: HTMLDivElement;
  private loadoutRows: HTMLDivElement;
  /** Slot index currently in inline-rename mode (null = none). */
  private renamingIndex: number | null = null;  // Gear-salvage wave: salvage section (reads live inventory state).
  private salvSection: HTMLDivElement;
  private salvRows: HTMLDivElement;
  private salvageHooks: InventorySalvageHooks | null = null;
  constructor(
    private container: HTMLElement,
    private inventory: Inventory,
    opts?: { input?: Input; sell?: InventorySellHooks | null; setReport?: () => SetUiReport; critReport?: () => CritStats; loadouts?: LoadoutHooks | null; salvageHooks?: InventorySalvageHooks | null },
  ) {
    if (opts?.input) this.input = opts.input;
    if (opts?.sell) this.sellHooks = opts.sell;
    if (opts?.salvageHooks) this.salvageHooks = opts.salvageHooks;
    if (opts?.setReport) this.setReport = opts.setReport;
    if (opts?.critReport) this.critReport = opts.critReport;
    if (opts?.loadouts) this.loadoutHooks = opts.loadouts;
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
    this.buildToolbar();

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

    // Gear sets wave: set-bonus indicator (pieces collected, thresholds active).
    this.setSection = document.createElement('div');
    this.setSection.className = 'sets';
    const setSec = document.createElement('div');
    setSec.className = 'sec';
    setSec.textContent = 'SET BONUSES';
    this.setSection.appendChild(setSec);
    this.setRows = document.createElement('div');
    this.setSection.appendChild(this.setRows);
    this.panel.appendChild(this.setSection);

    // Loadout-presets wave: named equip-set snapshots (save / rename /
    // apply / delete). Renders from the hooks' rack on every refresh().
    this.loadoutSection = document.createElement('div');
    this.loadoutSection.className = 'loadouts';
    const loadSec = document.createElement('div');
    loadSec.className = 'sec';
    loadSec.textContent = 'LOADOUTS';
    this.loadoutSection.appendChild(loadSec);
    this.loadoutRows = document.createElement('div');
    this.loadoutSection.appendChild(this.loadoutRows);
    this.panel.appendChild(this.loadoutSection);

    // CRIT-SYSTEM: live crit stats (equipped weapon tier + smithing rank).
    this.critSection = document.createElement('div');
    this.critSection.className = 'crits';
    const critSec = document.createElement('div');
    critSec.className = 'sec';
    critSec.textContent = 'CRIT STATS';
    this.critSection.appendChild(critSec);
    this.critRows = document.createElement('div');
    this.critSection.appendChild(this.critRows);
    this.panel.appendChild(this.critSection);

    // Enchantments wave: per-equipped-gear enchant actions (apply from
    // the table, remove with full material refund). One row per
    // equipped equippable item; unenchanted rows offer every
    // slot-applicable enchant, enchanted rows offer removal.
    this.enchSection = document.createElement('div');
    this.enchSection.className = 'enchs';
    const enchSec = document.createElement('div');
    enchSec.className = 'sec';
    enchSec.textContent = 'ENCHANTMENTS';
    this.enchSection.appendChild(enchSec);
    this.enchRows = document.createElement('div');
    this.enchSection.appendChild(this.enchRows);
    this.panel.appendChild(this.enchSection);

    // Gear-salvage wave: per-backpack-gear salvage rows with exact
    // yield previews (confirm step before anything is dismantled).
    // Equipped gear never appears here — equipped items are never
    // salvageable, so only backpack units are listed.
    this.salvSection = document.createElement('div');
    this.salvSection.className = 'salvs';
    const salvSec = document.createElement('div');
    salvSec.className = 'sec';
    salvSec.textContent = 'SALVAGE';
    this.salvSection.appendChild(salvSec);
    this.salvRows = document.createElement('div');
    this.salvSection.appendChild(this.salvRows);
    this.panel.appendChild(this.salvSection);

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
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.toggleJunkAt(i);
      });
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
    hint.textContent = 'I / Tab: close · arrows: move · Enter: equip / use · click item: equip / use · click equipped: unequip · right-click: mark junk';
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

  // ------------------------------------------------------------ toolbar (inventory-qol)

  private cap(s: string): string {
    return s.length ? s[0].toUpperCase() + s.slice(1) : s;
  }

  /** Filter/sort selects + junk/sell/destroy actions. All >=28px touch targets. */
  private buildToolbar(): void {
    const tools = document.createElement('div');
    tools.className = 'tools';

    const mkSelect = (
      label: string,
      options: Array<[string, string]>,
      onChange: (v: string) => void,
    ): HTMLSelectElement => {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', label);
      sel.title = label;
      for (const [value, text] of options) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        onChange(sel.value);
        this.clampCursor();
        this.refresh();
      });
      tools.appendChild(sel);
      return sel;
    };

    mkSelect(
      'Filter by type',
      [['all', 'Type: all'], ...ITEM_TYPES.map((t): [string, string] => [t, `Type: ${this.cap(t)}`])],
      (v) => { this.filter = { ...this.filter, type: v as InventoryFilter['type'] }; },
    );
    mkSelect(
      'Filter by rarity',
      [['all', 'Rarity: all'], ...ITEM_RARITIES.map((r): [string, string] => [r, `Rarity: ${this.cap(r)}`])],
      (v) => { this.filter = { ...this.filter, rarity: v as ItemRarity | 'all' }; },
    );
    mkSelect(
      'Filter by tier',
      [['all', 'Tier: all'], ...ITEM_TIERS.map((t): [string, string] => [t, `Tier: ${ITEM_TIER_LABELS[t as ItemTier]}`])],
      (v) => { this.filter = { ...this.filter, tier: v as ItemTier | 'all' }; },
    );
    mkSelect(
      'Sort',
      (Object.keys(SORT_MODE_LABELS) as InventorySortMode[]).map(
        (m): [string, string] => [m, `Sort: ${SORT_MODE_LABELS[m]}`],
      ),
      (v) => { this.sort = v as InventorySortMode; },
    );
    this.panel.appendChild(tools);

    const actions = document.createElement('div');
    actions.className = 'actions';
    this.actionsEl = actions;

    const mkButton = (text: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', onClick);
      actions.appendChild(b);
      return b;
    };

    this.junkModeBtn = mkButton('Mark junk: off', () => {
      this.junkMode = !this.junkMode;
      this.junkModeBtn.textContent = `Mark junk: ${this.junkMode ? 'on' : 'off'}`;
      this.junkModeBtn.classList.toggle('on', this.junkMode);
      this.junkModeBtn.setAttribute('aria-pressed', String(this.junkMode));
      this.toast(this.junkMode ? 'Junk mode: tap items to mark/unmark' : 'Junk mode off');
    });
    mkButton('Mark shown junk', () => this.markShownJunk());
    if (this.sellHooks) mkButton('Sell junk', () => this.sellJunkFlow());
    mkButton('Destroy junk', () => this.destroyJunkFlow());
    mkButton('Salvage junk', () => this.salvageJunkFlow());
    this.panel.appendChild(actions);

    const confirm = document.createElement('div');
    confirm.className = 'confirm';
    confirm.style.display = 'none';
    this.confirmEl = confirm;
    this.panel.appendChild(confirm);
  }

  /** Two-step inline confirm (no native confirm() — testable + touch-safe). */
  private askConfirm(text: string, onYes: () => void): void {
    this.confirmEl.innerHTML = '';
    this.confirmEl.style.display = '';
    const span = document.createElement('span');
    span.textContent = text;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.textContent = 'Confirm';
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'Cancel';
    const done = () => {
      this.confirmEl.innerHTML = '';
      this.confirmEl.style.display = 'none';
    };
    yes.addEventListener('click', () => { done(); onYes(); });
    no.addEventListener('click', done);
    this.confirmEl.append(span, yes, no);
  }

  /** Backpack entries (slot, entry, def) currently junk-marked. */
  private junkBackpackEntries(): Array<{ slot: number; itemId: string; count: number; def: ItemDef }> {
    const out: Array<{ slot: number; itemId: string; count: number; def: ItemDef }> = [];
    const pack = this.inventory.getBackpack();
    for (let slot = 0; slot < pack.length; slot++) {
      const entry = pack[slot];
      if (!entry || !this.inventory.isJunk(entry.itemId)) continue;
      const def = this.inventory.getDef(entry.itemId);
      if (!def) continue;
      out.push({ slot, itemId: entry.itemId, count: entry.count, def });
    }
    return out;
  }

  /** Toggle junk on the display cell at view index i. */
  private toggleJunkAt(i: number): void {
    const slot = this.viewSlots[i];
    if (slot === undefined) return;
    const entry = this.inventory.getBackpack()[slot];
    if (!entry) return;
    const now = !this.inventory.isJunk(entry.itemId);
    this.inventory.setJunk(entry.itemId, now);
    const def = this.inventory.getDef(entry.itemId);
    this.toast(now ? `Marked junk: ${def?.name ?? entry.itemId}` : `Unmarked: ${def?.name ?? entry.itemId}`);
    this.refresh();
  }

  /** Mark every currently shown (filtered) item as junk. */
  private markShownJunk(): void {
    let n = 0;
    const pack = this.inventory.getBackpack();
    for (const slot of this.viewSlots) {
      const entry = pack[slot];
      if (!entry || this.inventory.isJunk(entry.itemId)) continue;
      this.inventory.setJunk(entry.itemId, true);
      n++;
    }
    this.toast(n > 0 ? `Marked ${n} shown item${n === 1 ? '' : 's'} as junk` : 'Nothing shown to mark');
    this.refresh();
  }

  /** Sell-all-junk with exact per-unit pricing + inline confirm. */
  private sellJunkFlow(): void {
    const hooks = this.sellHooks;
    if (!hooks) return;
    const entries = this.junkBackpackEntries();
    if (entries.length === 0) {
      this.toast('No junk to sell');
      return;
    }
    let total = 0;
    let units = 0;
    let skipped = 0;
    for (const e of entries) {
      if (!isSellable(e.def)) { skipped += e.count; continue; }
      const unit = unitSellPrice(e.def, hooks.sellMult);
      total += unit * e.count;
      units += e.count;
    }
    if (units === 0) {
      this.toast('Junk has no sell value');
      return;
    }
    const skipNote = skipped > 0 ? ` (${skipped} unsellable skipped)` : '';
    this.askConfirm(`Sell ${units} junk for ${total} scrap?${skipNote}`, () => {
      let sold = 0;
      let gained = 0;
      for (const e of this.junkBackpackEntries()) {
        if (!isSellable(e.def)) continue;
        const unit = unitSellPrice(e.def, hooks.sellMult);
        const removed = this.inventory.remove(e.itemId, e.count);
        if (removed > 0) {
          hooks.addScrap(unit * removed);
          sold += removed;
          gained += unit * removed;
        }
      }
      this.inventory.pruneJunk();
      this.clampCursor();
      this.refresh();
      this.toast(`Sold ${sold} junk for ${gained} scrap`);
    });
  }

  /** Destroy-all-junk with inline confirm. Irreversible — always confirms. */
  private destroyJunkFlow(): void {
    const entries = this.junkBackpackEntries();
    if (entries.length === 0) {
      this.toast('No junk to destroy');
      return;
    }
    const units = entries.reduce((n, e) => n + e.count, 0);
    this.askConfirm(`Destroy ${units} junk item${units === 1 ? '' : 's'}? Cannot be undone.`, () => {
      let n = 0;
      for (const e of this.junkBackpackEntries()) {
        n += this.inventory.remove(e.itemId, e.count);
      }
      this.inventory.pruneJunk();
      this.clampCursor();
      this.refresh();
      this.toast(`Destroyed ${n} junk item${n === 1 ? '' : 's'}`);
    });
  }

  /** "2× Iron Ore, 1× Plant Fiber" from a yield list (def names, textContent-safe). */
  private yieldText(yields: readonly SalvageYield[]): string {
    return yields
      .map((y) => `${y.count}× ${this.inventory.getDef(y.itemId)?.name ?? y.itemId}`)
      .join(', ');
  }

  /** Salvage-one-unit flow: exact-yield preview, inline confirm, then salvage. */
  private salvageOneFlow(itemId: string): void {
    const def = this.inventory.getDef(itemId);
    if (!def) return;
    const preview = this.inventory.salvagePreview(itemId);
    if (!preview) {
      this.toast(`${def.name} cannot be salvaged`);
      this.refresh();
      return;
    }
    this.askConfirm(`Salvage ${def.name} for ${this.yieldText(preview)}? The item will be dismantled.`, () => {
      const r = this.inventory.salvage(itemId, {
        onClearLoadout: this.salvageHooks?.clearFromLoadouts,
      });
      if (!r.ok) {
        this.toast(`Cannot salvage: ${r.reason ?? 'failed'}`);
      } else {
        this.toast(`Salvaged ${def.name} → ${this.yieldText(r.yields ?? [])}`);
      }
      this.clampCursor();
      this.refresh();
    });
  }

  /** Salvage-all-junk flow: reuses the junk-marking path + inline confirm. */
  private salvageJunkFlow(): void {
    const preview = this.inventory.previewSalvageAllJunk();
    if (preview.plan.length === 0) {
      this.toast(
        preview.skipped.length > 0
          ? 'Junk cannot be salvaged (equipped or not gear)'
          : 'No junk to salvage',
      );
      return;
    }
    const units = preview.plan.reduce((n, p) => n + p.units, 0);
    const merged: SalvageYield[] = [];
    for (const p of preview.plan) {
      for (const y of p.yields) {
        const e = merged.find((v) => v.itemId === y.itemId);
        if (e) e.count += y.count;
        else merged.push({ ...y });
      }
    }
    const skipNote =
      preview.skipped.length > 0
        ? ` (${preview.skipped.length} junk item${preview.skipped.length === 1 ? '' : 's'} skipped: ${preview.skipped.map((s) => s.reason).join(', ')})`
        : '';
    this.askConfirm(`Salvage ${units} junk item${units === 1 ? '' : 's'} for ${this.yieldText(merged)}?${skipNote}`, () => {
      const r = this.inventory.salvageAllJunk({
        onClearLoadout: this.salvageHooks?.clearFromLoadouts,
      });
      const done = r.salvaged.reduce((n, s) => n + s.units, 0);
      if (done === 0) {
        this.toast('Nothing salvaged');
      } else {
        this.toast(`Salvaged ${done} junk item${done === 1 ? '' : 's'} → ${this.yieldText(r.yields)}`);
      }
      this.clampCursor();
      this.refresh();
    });
  }

  private clampCursor(): void {
    if (this.cursor.area === 'pack') {
      const max = Math.max(0, this.viewSlots.length - 1);
      if (this.cursor.index > max) this.cursor.index = max;
    }
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

  /**
   * Re-render every cell from the inventory model through the current
   * filter/sort projection. Display index i maps to backpack slot
   * viewSlots[i]; cells past the view are hidden (client-side only —
   * the model keeps slot order).
   */
  refresh(): void {
    const view = applyInventoryView(this.inventory, this.filter, this.sort);
    this.viewSlots = view.map((v) => v.slot);
    for (let i = 0; i < BACKPACK_SIZE; i++) {
      const cell = this.packCells[i];
      const row = i < view.length ? view[i] : null;
      if (!row) {
        cell.innerHTML = '';
        cell.style.cssText = '';
        cell.style.display = 'none';
        cell.classList.remove('cursor', 'isjunk');
        continue;
      }
      cell.style.display = '';
      const entry = row.entry;
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
      if (this.inventory.isJunk(entry.itemId)) {
        const jk = document.createElement('div');
        jk.className = 'jk';
        jk.textContent = 'JUNK';
        cell.appendChild(jk);
      }
      cell.style.cssText = def ? rarityBorder(def) : '';
      cell.classList.toggle('isjunk', this.inventory.isJunk(entry.itemId));
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
    this.renderSetRows();
    this.renderLoadoutRows();
    this.renderCritRows();
    this.renderEnchantRows();
    this.renderSalvageRows();
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

  /**
   * Gear sets wave: render the SET BONUSES section. Only sets with at
   * least one owned piece show (no clutter for untouched sets); each
   * row shows pieces collected (owned/equipped) and which thresholds
   * are active. textContent everywhere (def text is spec-sourced —
   * never innerHTML).
   */
  /**
   * CRIT-SYSTEM: render the CRIT STATS section. One line: crit chance
   * and crit damage multiplier from the live equipped-weapon tier +
   * smithing rank, plus the inputs so the numbers are auditable.
   * Hidden when no resolver is wired (blueprints without an item kit).
   */
  private renderCritRows(): void {
    this.critRows.innerHTML = '';
    if (!this.critReport) {
      this.critSection.style.display = 'none';
      return;
    }
    this.critSection.style.display = '';
    let report: CritStats;
    try {
      report = this.critReport();
    } catch {
      return;
    }
    const pct = Math.round(report.chance * 1000) / 10;
    const row = document.createElement('div');
    row.className = 'critrow';
    const main = document.createElement('div');
    main.textContent = `CRIT ${pct}% chance · ×${report.multiplier.toFixed(1)} damage`;
    row.appendChild(main);
    const sub = document.createElement('div');
    sub.textContent = `weapon: ${report.tier} · smithing rank ${report.skillRank}`;
    row.appendChild(sub);
    this.critRows.appendChild(row);
    // ELEMENTAL-DAMAGE-TYPES: live outgoing damage type (weapon enchant
    // or physical). Rendered in the same loadout-readout section as the
    // crit stats; the type is the inventory's own resolver, so this row
    // can never disagree with the damage the avatar actually deals.
    const detail = this.inventory.outgoingDamageTypeDetail();
    const elem = document.createElement('div');
    elem.className = 'elemrow';
    const def = ELEMENTAL_TABLE[detail.type];
    elem.textContent = detail.enchantId
      ? `DAMAGE TYPE ${def.label} — via ${ENCHANT_DEFS.find((e) => e.id === detail.enchantId)?.name ?? detail.enchantId}`
      : `DAMAGE TYPE ${def.label}`;
    elem.style.color = def.color;
    this.critRows.appendChild(elem);
  }

  private renderSetRows(): void {
    this.setRows.innerHTML = '';
    if (!this.setReport) {
      this.setSection.style.display = 'none';
      return;
    }
    this.setSection.style.display = '';
    let report: SetUiReport;
    try {
      report = this.setReport();
    } catch {
      return;
    }
    for (const set of report.sets) {
      const owned = report.owned[set.setId] ?? 0;
      if (owned <= 0) continue;
      const row = document.createElement('div');
      row.className = 'setrow';
      row.dataset.setId = set.setId;
      const head = document.createElement('div');
      const sn = document.createElement('span');
      sn.className = 'sn';
      sn.textContent = set.name;
      const sc = document.createElement('span');
      sc.className = 'sc';
      sc.textContent = `${owned}/${set.pieces.length} owned · ${set.equippedCount}/${set.pieces.length} equipped`;
      head.append(sn, sc);
      row.appendChild(head);
      for (const t of set.thresholds) {
        const on = set.active.includes(t);
        const div = document.createElement('div');
        div.className = `st ${on ? 'on' : 'off'}`;
        div.textContent = `${on ? 'ACTIVE' : `${set.equippedCount}/${t.pieces}`} — ${t.label}`;
        row.appendChild(div);
      }
      this.setRows.appendChild(row);
    }
  }

  /**
   * Loadout-presets wave: render the LOADOUTS section. One row per rack
   * slot: name + piece summary + Apply / Save / Rename / Delete. Apply
   * stays enabled during combat on purpose — the refusal is a visible,
   * state-driven toast at click time (the pure apply path refuses whole
   * while in combat), not a silently disabled button. All buttons are
   * >=28px touch targets (CSS above). textContent everywhere.
   */
  private renderLoadoutRows(): void {
    this.loadoutRows.innerHTML = '';
    if (!this.loadoutHooks) {
      this.loadoutSection.style.display = 'none';
      return;
    }
    this.loadoutSection.style.display = '';
    let rack: GearLoadout[];
    try {
      rack = this.loadoutHooks.list();
    } catch {
      return;
    }
    rack.forEach((loadout, index) => {
      const row = document.createElement('div');
      row.className = 'loadrow';
      row.dataset.loadoutIndex = String(index);
      row.dataset.loadoutName = loadout.name;
      const head = document.createElement('div');
      const nm = document.createElement('span');
      nm.className = 'ln';
      nm.textContent = loadout.name;
      const pieces = loadoutPieceCount(loadout);
      const summary = document.createElement('span');
      summary.className = 'ls';
      summary.textContent = pieces === 0
        ? 'empty'
        : `${pieces}/5 pieces: ${EQUIP_SLOTS.filter((s) => loadout.equipped[s])
          .map((s) => this.inventory.getDef(loadout.equipped[s]!)?.name ?? loadout.equipped[s])
          .join(', ')}`;
      head.append(nm, summary);
      row.appendChild(head);

      if (this.renamingIndex === index) {
        const acts = document.createElement('div');
        acts.className = 'la';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = loadout.name;
        input.setAttribute('aria-label', `Rename ${loadout.name}`);
        input.maxLength = 24;
        const finish = (commitRename: boolean) => {
          const idx = this.renamingIndex;
          this.renamingIndex = null;
          if (commitRename && idx !== null) {
            const ok = this.loadoutHooks!.rename(idx, input.value);
            this.toast(ok ? `Renamed to "${this.loadoutHooks!.list()[idx]?.name ?? input.value}"` : 'Rename needs a non-empty name');
          }
          this.refresh();
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
          e.stopPropagation();
        });
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'load-rename-confirm';
        okBtn.textContent = 'Save name';
        okBtn.addEventListener('click', () => finish(true));
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'load-rename-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => finish(false));
        acts.append(input, okBtn, cancelBtn);
        row.appendChild(acts);
        this.loadoutRows.appendChild(row);
        return;
      }

      const acts = document.createElement('div');
      acts.className = 'la';
      const mkBtn = (cls: string, text: string, onClick: () => void): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.dataset.loadoutIndex = String(index);
        b.textContent = text;
        b.addEventListener('click', onClick);
        acts.appendChild(b);
        return b;
      };
      mkBtn('load-apply', 'Apply', () => {
        let result: ApplyLoadoutResult;
        try {
          result = this.loadoutHooks!.apply(index);
        } catch {
          this.toast('Loadout apply failed');
          return;
        }
        if (!result.ok) {
          this.toast('Cannot change loadout in combat');
          return;
        }
        const parts: string[] = [];
        if (result.applied.length > 0) parts.push(`applied ${result.applied.length} slot${result.applied.length === 1 ? '' : 's'}`);
        if (result.missing.length > 0) {
          const names = result.missing.map((m) => this.inventory.getDef(m.itemId ?? '')?.name ?? m.itemId ?? m.slot);
          parts.push(`missing: ${names.join(', ')}`);
        }
        if (result.blocked.length > 0) parts.push(`${result.blocked.length} blocked (backpack full?)`);
        if (parts.length === 0) parts.push('already equipped');
        this.toast(`Loadout "${loadout.name}": ${parts.join(' · ')}`);
        this.refresh();
      });
      mkBtn('load-save', 'Save current set', () => {
        const snap = this.loadoutHooks!.capture(loadout.name);
        this.loadoutHooks!.save(index, snap);
        const n = loadoutPieceCount(snap);
        this.toast(`Saved "${loadout.name}" (${n}/5 pieces)`);
        this.refresh();
      });
      mkBtn('load-rename', 'Rename', () => {
        this.renamingIndex = index;
        this.refresh();
        const input = this.loadoutRows.querySelector<HTMLInputElement>('.loadrow input');
        input?.focus();
        input?.select();
      });
      mkBtn('load-delete', 'Delete', () => {
        this.askConfirm(`Delete loadout "${loadout.name}"? This clears the saved set.`, () => {
          this.loadoutHooks!.clear(index);
          this.toast(`Deleted loadout "${loadout.name}"`);
          this.refresh();
        });
      });
      row.appendChild(acts);
      this.loadoutRows.appendChild(row);
    });
  }

  /**
   * Enchantments wave: render the ENCHANTMENTS section. One row per
   * equipped equippable item: its current enchant (or "unenchanted"),
   * apply buttons for every slot-applicable enchant (with exact cost
   * text, disabled when the materials are short), and a remove button
   * that refunds the full cost. textContent everywhere. All buttons
   * are >=28px touch targets (CSS above).
   */
  private renderEnchantRows(): void {
    this.enchRows.innerHTML = '';
    const equipped = this.inventory.getAllEquipped();
    const rows: Array<{ slot: EquipSlot; itemId: string; def: ItemDef }> = [];
    for (const slot of EQUIP_SLOTS) {
      const itemId = equipped[slot];
      if (!itemId) continue;
      const def = this.inventory.getDef(itemId);
      if (!def || !this.inventory.isEquippable(itemId)) continue;
      rows.push({ slot, itemId, def });
    }
    if (rows.length === 0) {
      this.enchSection.style.display = 'none';
      return;
    }
    this.enchSection.style.display = '';
    for (const { slot, itemId, def } of rows) {
      const row = document.createElement('div');
      row.className = 'enchrow';
      row.dataset.slot = slot;
      row.dataset.itemId = itemId;
      const head = document.createElement('div');
      const nm = document.createElement('span');
      nm.className = 'en';
      nm.textContent = def.name;
      const st = document.createElement('span');
      st.className = 'es';
      const cur = this.inventory.getEnchant(itemId);
      const curDef = cur ? ENCHANT_DEFS.find((e) => e.id === cur) : undefined;
      st.textContent = curDef
        ? `enchanted: ${curDef.name}${curDef.damageType ? ` · ${ELEMENTAL_TABLE[curDef.damageType].label} damage` : ''}`
        : 'unenchanted';
      if (curDef) {
        row.dataset.enchantId = curDef.id;
        if (curDef.damageType) row.dataset.damageType = curDef.damageType;
      }
      head.append(nm, st);
      row.appendChild(head);
      const acts = document.createElement('div');
      acts.className = 'ea';
      if (curDef) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ench-remove';
        rm.dataset.slot = slot;
        rm.dataset.itemId = itemId;
        rm.textContent = `Remove ${curDef.name} (refund)`;
        rm.addEventListener('click', () => {
          const refunded = this.inventory.removeEnchant(itemId);
          const desc = refunded.map((c) => `${c.count}× ${this.inventory.getDef(c.itemId)?.name ?? c.itemId}`).join(', ');
          this.toast(refunded.length ? `Removed ${curDef.name} — refunded ${desc}` : `Removed ${curDef.name}`);
          this.refresh();
        });
        acts.appendChild(rm);
      } else {
        for (const ench of ENCHANT_DEFS) {
          if (!ench.slots.includes(slot)) continue;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ench-apply';
          b.dataset.slot = slot;
          b.dataset.itemId = itemId;
          b.dataset.enchantId = ench.id;
          const costText = ench.cost.map((c) => `${c.count}× ${this.inventory.getDef(c.itemId)?.name ?? c.itemId}`).join(', ');
          const short = ench.cost.some((c) => this.inventory.count(c.itemId) < c.count);
          b.textContent = `${ench.name}${ench.damageType ? ` — ${ELEMENTAL_TABLE[ench.damageType].label}` : ''} (${costText})`;
          b.disabled = short;
          b.title = short ? 'Not enough materials' : `Apply ${ench.name}`;
          b.addEventListener('click', () => {
            const r = this.inventory.enchant(itemId, ench.id);
            if (r.ok) this.toast(`Enchanted ${def.name} with ${ench.name}`);
            else this.toast(`Cannot enchant: ${r.reason ?? 'failed'}`);
            this.refresh();
          });
          acts.appendChild(b);
        }
      }
      row.appendChild(acts);
      this.enchRows.appendChild(row);
    }
  }

  /**
   * Gear-salvage wave: render the SALVAGE section. One row per distinct
   * salvageable backpack gear id (slot order): name, count, enchant /
   * set-piece badges, the exact yield preview for the next unit, and
   * a Salvage button that goes through the two-step confirm. Equipped
   * gear never renders here (never salvageable). Hidden when the
   * backpack holds no salvageable gear. textContent everywhere.
   */
  private renderSalvageRows(): void {
    this.salvRows.innerHTML = '';
    const seen = new Set<string>();
    const rows: Array<{ itemId: string; def: ItemDef; count: number }> = [];
    for (const entry of this.inventory.getBackpack()) {
      if (!entry || seen.has(entry.itemId)) continue;
      seen.add(entry.itemId);
      if (!this.inventory.isSalvageable(entry.itemId).ok) continue;
      const def = this.inventory.getDef(entry.itemId);
      if (!def) continue;
      rows.push({ itemId: entry.itemId, def, count: entry.count });
    }
    if (rows.length === 0) {
      this.salvSection.style.display = 'none';
      return;
    }
    this.salvSection.style.display = '';
    for (const { itemId, def, count } of rows) {
      const row = document.createElement('div');
      row.className = 'salvrow';
      row.dataset.itemId = itemId;
      const head = document.createElement('div');
      const nm = document.createElement('span');
      nm.className = 'sn';
      nm.textContent = def.name;
      const st = document.createElement('span');
      st.className = 'ss';
      const badges: string[] = [];
      if (count > 1) badges.push(`×${count}`);
      const enchId = this.inventory.getEnchant(itemId);
      const enchDef = enchId ? ENCHANT_DEFS.find((e) => e.id === enchId) : undefined;
      if (enchDef) badges.push(`enchanted: ${enchDef.name} (refund included)`);
      if (isSetPiece(itemId)) badges.push('set piece (bonus materials included)');
      st.textContent = badges.join(' · ');
      head.append(nm, st);
      row.appendChild(head);
      const preview = this.inventory.salvagePreview(itemId);
      const y = document.createElement('div');
      y.className = 'sy';
      y.textContent = preview ? `Salvage → ${this.yieldText(preview)}` : 'Cannot be salvaged';
      row.appendChild(y);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'salvage-one';
      b.dataset.itemId = itemId;
      b.textContent = 'Salvage 1';
      b.addEventListener('click', () => this.salvageOneFlow(itemId));
      row.appendChild(b);
      this.salvRows.appendChild(row);
    }
  }

  // ------------------------------------------------------------ actions

  /** Keyboard/mouse "confirm" on the cursor cell. */
  private confirm(): void {
    if (this.cursor.area === 'equip') {
      this.unequipAt(this.cursor.index);
    } else if (this.junkMode) {
      this.toggleJunkAt(this.cursor.index);
    } else {
      this.activatePackCell(this.cursor.index);
    }
  }

  private onPackCellClick(i: number): void {
    this.cursor = { area: 'pack', index: i };
    if (this.junkMode) {
      this.toggleJunkAt(i);
      return;
    }
    this.activatePackCell(i);
  }

  private onEquipCellClick(slot: EquipSlot): void {
    this.cursor = { area: 'equip', index: EQUIP_SLOTS.indexOf(slot) };
    this.unequipAt(this.cursor.index);
  }

  /** i = display index (maps to a backpack slot via viewSlots). */
  private activatePackCell(i: number): void {
    const slot = this.viewSlots[i];
    if (slot === undefined) return;
    const entry = this.inventory.getBackpack()[slot];
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
      // pack cursor runs over display indices (the filter/sort view)
      const maxIndex = Math.max(0, this.viewSlots.length - 1);
      if (cur.index > maxIndex) cur.index = maxIndex;
      const row = Math.floor(cur.index / PACK_COLS);
      const col = cur.index % PACK_COLS;
      if (code === 'ArrowLeft' && col > 0) cur.index -= 1;
      else if (code === 'ArrowRight' && col < PACK_COLS - 1 && cur.index < maxIndex) cur.index += 1;
      else if (code === 'ArrowDown' && cur.index + PACK_COLS <= maxIndex) cur.index += PACK_COLS;
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
    const slot = this.viewSlots[i];
    if (slot === undefined) return;
    const entry = this.inventory.getBackpack()[slot];
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
