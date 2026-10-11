/**
 * Inventory — the runtime item data model for the inventory wave.
 *
 * Owns a 24-slot backpack of stacked ItemDef entries plus five equip slots
 * (weapon/head/torso/legs/accessory). Pure data: no DOM, no three.js, no
 * Math.random/Date.now — deterministic and unit-testable.
 *
 * Item ids resolve against the `defs` table from `custom.items.defs`
 * (GameSpec, commit 513fa6a — do not change that contract). Unknown ids are
 * warned about and ignored, never thrown on.
 *
 * Shared contract with the runtime crew's wireItems:
 *   export interface InventoryLike { add(itemId: string, count?: number): number; }
 * This class satisfies it structurally (pass an Inventory wherever an
 * InventoryLike is expected).
 */
import {
  ITEM_STAT_KEYS,
  type EquipSlot,
  type ItemDef,
  type ItemStats,
  type ItemStatKey,
} from '@spec';

/** Structural contract shared with the runtime crew's wireItems. */
export interface InventoryLike {
  /** Add items; returns the leftover count that did not fit. */
  add(itemId: string, count?: number): number;
}

/** One backpack stack: an item id plus its unit count. */
export interface InventoryEntry {
  itemId: string;
  count: number;
}

export const BACKPACK_SIZE = 24;
export const MAX_STACK = 999;

/** JSON shape produced by serialize() / consumed by Inventory.deserialize(). */
export interface SerializedInventory {
  version: 1;
  slots: Array<InventoryEntry | null>;
  equipped: Partial<Record<EquipSlot, string>>;
}

const isFiniteNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

export class Inventory implements InventoryLike {
  /**
   * Consumable-use hook. The engine sets this to apply def.behavior
   * (heal/restore/buff) to the player — the inventory itself never touches
   * player HP. Fired with the ItemDef of the consumed unit.
   */
  onUseEffect: ((def: ItemDef) => void) | null = null;

  private slots: Array<InventoryEntry | null> = [];
  private equipped: Partial<Record<EquipSlot, string>> = {};

  constructor(private defs: Record<string, ItemDef>) {
    this.slots = Array.from({ length: BACKPACK_SIZE }, () => null);
  }

  // ------------------------------------------------------------ reads

  /** Resolve an item def; undefined for unknown ids. */
  getDef(itemId: string): ItemDef | undefined {
    return this.defs[itemId];
  }

  /** Backpack slots (a copy — mutate via add/remove/equip). */
  getBackpack(): Array<InventoryEntry | null> {
    return this.slots.map((s) => (s ? { ...s } : null));
  }

  /** Item id equipped in a slot, or null. */
  getEquipped(slot: EquipSlot): string | null {
    return this.equipped[slot] ?? null;
  }

  /** All equipped slots as a plain object (slot → item id). */
  getAllEquipped(): Partial<Record<EquipSlot, string>> {
    return { ...this.equipped };
  }

  /** Max stack size for an item (def.stack, clamped 1..999, default 1). */
  stackSize(itemId: string): number {
    const def = this.defs[itemId];
    const s = def?.stack;
    if (s === undefined) return 1;
    return Math.max(1, Math.min(MAX_STACK, Math.floor(s)));
  }

  /** True when the item can go into an equip slot (weapon/armor with a slot). */
  isEquippable(itemId: string): boolean {
    const def = this.defs[itemId];
    return !!def && (def.type === 'weapon' || def.type === 'armor') && def.slot !== undefined;
  }

  /** Total units of an item across backpack AND equipped slots. */
  count(itemId: string): number {
    let n = 0;
    for (const s of this.slots) if (s?.itemId === itemId) n += s.count;
    for (const id of Object.values(this.equipped)) if (id === itemId) n += 1;
    return n;
  }

  /** Backpack slots that are empty. */
  freeSlots(): number {
    return this.slots.filter((s) => s === null).length;
  }

  // ------------------------------------------------------------ add / remove

  private warnUnknown(itemId: string): void {
    // Unknown ids are a content/typo problem, not a crash — the validator
    // rejects them at spec time, the runtime skips them at play time.
    console.warn(`[inventory] unknown item id "${itemId}" — ignored`);
  }

  /**
   * Add items: fills existing non-full stacks first, then empty slots.
   * Returns the leftover count that did not fit (0 = everything fit).
   * Unknown item ids are warned about and ignored (leftover = full count).
   */
  add(itemId: string, count = 1): number {
    if (!Number.isFinite(count) || count <= 0) return 0;
    const def = this.defs[itemId];
    if (!def) {
      this.warnUnknown(itemId);
      return Math.floor(count);
    }
    const max = this.stackSize(itemId);
    let rest = Math.floor(count);
    // 1) top up existing stacks
    for (const s of this.slots) {
      if (rest <= 0) break;
      if (s && s.itemId === itemId && s.count < max) {
        const room = max - s.count;
        const take = Math.min(room, rest);
        s.count += take;
        rest -= take;
      }
    }
    // 2) fill empty slots
    for (let i = 0; i < this.slots.length && rest > 0; i++) {
      if (this.slots[i] === null) {
        const take = Math.min(max, rest);
        this.slots[i] = { itemId, count: take };
        rest -= take;
      }
    }
    return rest;
  }

  /**
   * Remove up to `count` units of an item from the backpack (equipped items
   * must be unequipped first). Returns the number actually removed.
   */
  remove(itemId: string, count = 1): number {
    if (!Number.isFinite(count) || count <= 0) return 0;
    let rest = Math.floor(count);
    let removed = 0;
    for (let i = 0; i < this.slots.length && rest > 0; i++) {
      const s = this.slots[i];
      if (s && s.itemId === itemId) {
        const take = Math.min(s.count, rest);
        s.count -= take;
        rest -= take;
        removed += take;
        if (s.count <= 0) this.slots[i] = null;
      }
    }
    return removed;
  }

  // ------------------------------------------------------------ equip

  /**
   * Move one unit of an equippable (weapon/armor) from the backpack into its
   * def.slot. A displaced occupant returns to the backpack — if there is no
   * room, the equip FAILS CLEANLY (returns null, nothing changed).
   * Returns { displaced } (displaced = item id or null) on success,
   * null when the item is missing / not equippable / no room.
   */
  equip(itemId: string): { displaced: string | null } | null {
    const def = this.defs[itemId];
    if (!def) {
      this.warnUnknown(itemId);
      return null;
    }
    if (!this.isEquippable(itemId) || !def.slot) return null;
    const slot = def.slot;
    // locate one unit in the backpack
    const from = this.slots.findIndex((s) => s?.itemId === itemId);
    if (from < 0) return null;
    const displaced = this.equipped[slot] ?? null;
    // make room for the displaced unit BEFORE mutating anything
    if (displaced !== null && !this.hasRoomFor(displaced, from)) return null;
    // take the unit out of the backpack
    const entry = this.slots[from]!;
    entry.count -= 1;
    if (entry.count <= 0) this.slots[from] = null;
    // return the displaced occupant to the backpack
    if (displaced !== null) {
      const leftover = this.addAt(displaced, 1, from);
      // hasRoomFor guaranteed this fits; leftover can only be 0
      if (leftover > 0) {
        // defensive: restore the taken unit rather than lose items
        this.addAt(itemId, 1, from);
        return null;
      }
    }
    this.equipped[slot] = itemId;
    return { displaced };
  }

  /**
   * Move the item in an equip slot back to the backpack.
   * Returns false when the slot is empty or there is no room (no mutation).
   */
  unequip(slot: EquipSlot): boolean {
    const itemId = this.equipped[slot];
    if (!itemId) return false;
    if (!this.hasRoomFor(itemId, -1)) return false;
    const leftover = this.add(itemId, 1);
    if (leftover > 0) return false; // hasRoomFor said it fits — stay consistent
    delete this.equipped[slot];
    return true;
  }

  /** True when one more unit of itemId fits in the backpack (ignoring `skipIndex`). */
  private hasRoomFor(itemId: string, skipIndex: number): boolean {
    const max = this.stackSize(itemId);
    for (let i = 0; i < this.slots.length; i++) {
      if (i === skipIndex) continue;
      const s = this.slots[i];
      if (s === null) return true;
      if (s.itemId === itemId && s.count < max) return true;
    }
    return false;
  }

  /**
   * Place one stack into the backpack, preferring `preferredIndex` for the
   * first empty slot. Returns leftover that did not fit.
   */
  private addAt(itemId: string, count: number, preferredIndex: number): number {
    const max = this.stackSize(itemId);
    let rest = count;
    for (const s of this.slots) {
      if (rest <= 0) break;
      if (s && s.itemId === itemId && s.count < max) {
        const take = Math.min(max - s.count, rest);
        s.count += take;
        rest -= take;
      }
    }
    const order: number[] = [];
    if (preferredIndex >= 0) order.push(preferredIndex);
    for (let i = 0; i < this.slots.length; i++) order.push(i);
    for (const i of order) {
      if (rest <= 0) break;
      if (this.slots[i] === null) {
        const take = Math.min(max, rest);
        this.slots[i] = { itemId, count: take };
        rest -= take;
      }
    }
    return rest;
  }

  // ------------------------------------------------------------ use

  /**
   * Consume one unit of a consumable: fires onUseEffect(def) so the engine
   * can apply def.behavior (heal/restore/buff), then decrements the stack.
   * Returns true when a unit was consumed. Non-consumables and missing items
   * return false without firing the callback.
   */
  use(itemId: string): boolean {
    const def = this.defs[itemId];
    if (!def) {
      this.warnUnknown(itemId);
      return false;
    }
    if (def.type !== 'consumable') return false;
    const idx = this.slots.findIndex((s) => s?.itemId === itemId);
    if (idx < 0) return false;
    // fire the effect BEFORE decrementing so the callback sees a live entry
    if (this.onUseEffect) {
      try {
        this.onUseEffect(def);
      } catch (e) {
        // a buggy effect hook must not corrupt inventory state
        console.warn(`[inventory] onUseEffect threw for "${itemId}"`, e);
      }
    }
    const s = this.slots[idx]!;
    s.count -= 1;
    if (s.count <= 0) this.slots[idx] = null;
    return true;
  }

  // ------------------------------------------------------------ stats

  /**
   * Sum of stats granted by equipped items (additive, per the ItemStats
   * contract — all finite numbers). Missing/NaN stat values are skipped.
   */
  equippedStats(): ItemStats {
    const out: ItemStats = {};
    for (const key of ITEM_STAT_KEYS as readonly ItemStatKey[]) {
      let sum = 0;
      let any = false;
      for (const id of Object.values(this.equipped)) {
        const v = this.defs[id]?.stats?.[key];
        if (isFiniteNum(v)) {
          sum += v;
          any = true;
        }
      }
      if (any) out[key] = sum;
    }
    return out;
  }

  // ------------------------------------------------------------ save / load

  /** Serialize to a JSON string for save games. */
  serialize(): string {
    const data: SerializedInventory = {
      version: 1,
      slots: this.slots.map((s) => (s ? { itemId: s.itemId, count: s.count } : null)),
      equipped: { ...this.equipped },
    };
    return JSON.stringify(data);
  }

  /**
   * Restore from serialize(). Never throws: malformed JSON or unknown item
   * ids are warned about and skipped, leaving an empty inventory.
   */
  static deserialize(defs: Record<string, ItemDef>, json: string): Inventory {
    const inv = new Inventory(defs);
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      console.warn('[inventory] deserialize: invalid JSON — starting empty');
      return inv;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      console.warn('[inventory] deserialize: not an object — starting empty');
      return inv;
    }
    const d = data as Partial<SerializedInventory>;
    if (Array.isArray(d.slots)) {
      for (let i = 0; i < Math.min(d.slots.length, BACKPACK_SIZE); i++) {
        const s = d.slots[i];
        if (s === null || s === undefined) continue;
        if (typeof s !== 'object' || Array.isArray(s)) continue;
        const { itemId, count } = s as { itemId?: unknown; count?: unknown };
        if (typeof itemId !== 'string' || !defs[itemId]) {
          if (typeof itemId === 'string') inv.warnUnknown(itemId);
          continue;
        }
        if (!isFiniteNum(count) || count <= 0) continue;
        inv.slots[i] = { itemId, count: Math.min(Math.floor(count), inv.stackSize(itemId)) };
      }
    }
    if (d.equipped && typeof d.equipped === 'object') {
      for (const [slot, itemId] of Object.entries(d.equipped)) {
        if (typeof itemId !== 'string' || !defs[itemId]) {
          if (typeof itemId === 'string') inv.warnUnknown(itemId);
          continue;
        }
        const def = defs[itemId];
        // only restore items that actually belong in that slot
        if ((def.type === 'weapon' || def.type === 'armor') && def.slot === slot) {
          inv.equipped[slot as EquipSlot] = itemId;
        } else {
          console.warn(`[inventory] deserialize: "${itemId}" does not belong in slot "${slot}" — skipped`);
        }
      }
    }
    return inv;
  }
}
