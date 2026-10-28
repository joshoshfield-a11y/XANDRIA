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
import { addItemStats, computeSetBonuses } from '../setBonuses';
import { computeEnchantStats, enchantDef, ENCHANT_DEFS, type EnchantCost } from '../enchantments';
import {
  outgoingDamageType,
  outgoingDamageTypeDetail,
  type DamageType,
} from '../elemental';
import {
  buildSalvageRng,
  enchantRefundFor,
  isSetPiece,
  rollSalvageYields,
  type SalvageYield,
} from '../salvage';
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
  /** Junk-marked item ids (inventory-qol wave; absent = none). */
  junk?: string[];
  /** Acquisition order: [itemId, seq][] + the sequence counter (absent = none). */
  acq?: Array<[string, number]>;
  acqSeq?: number;
  /** Enchantments wave: [itemId, enchantId][] (absent = none). */
  ench?: Array<[string, string]>;
  /** Gear-salvage wave: salvage sequence counter (absent = 0). */
  salv?: number;
}

const isFiniteNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Gear-salvage wave: result of one salvage() call. */
export interface SalvageResult {
  ok: boolean;
  reason?: string;
  /** Exact materials granted (post-roll), present on success. */
  yields?: SalvageYield[];
  /** Enchant id cleared by this salvage (null = the piece was unenchanted). */
  enchantCleared?: string | null;
  /** True when the piece belongs to a gear set (bonus lines included). */
  setPiece?: boolean;
}

/** Gear-salvage wave: non-mutating salvage-all-junk preview. */
export interface SalvageAllPreview {
  plan: Array<{ itemId: string; units: number; yields: SalvageYield[] }>;
  skipped: Array<{ itemId: string; reason: string }>;
}

/** Gear-salvage wave: result of salvageAllJunk(). */
export interface SalvageAllResult {
  salvaged: Array<{ itemId: string; units: number; yields: SalvageYield[] }>;
  skipped: Array<{ itemId: string; reason: string }>;
  /** Merged yields across all salvaged ids. */
  yields: SalvageYield[];
}

export class Inventory implements InventoryLike {
  /**
   * Consumable-use hook. The engine sets this to apply def.behavior
   * (heal/restore/buff) to the player — the inventory itself never touches
   * player HP. Fired with the ItemDef of the consumed unit.
   */
  onUseEffect: ((def: ItemDef) => void) | null = null;

  /**
   * Change event (roadmap Priority 4: inventory change events). Fired after
   * every successful add/remove/equip/unequip/use so HUD, quests, and the
   * future world-state system can react without polling. Never throws.
   */
  onChange: (() => void) | null = null;

  private emitChange(): void {
    try { this.onChange?.(); } catch (e) { console.warn('[inventory] onChange threw', e); }
  }

  private slots: Array<InventoryEntry | null> = [];
  private equipped: Partial<Record<EquipSlot, string>> = {};
  /**
   * Inventory-qol wave: junk-marked item ids. Marking is per item id (all
   * units of that id count as junk) — simple, deterministic, and it
   * serializes cleanly. Equipped items are never junk-actionable.
   */
  private junk = new Set<string>();
  /**
   * Inventory-qol wave: monotonic acquisition sequence for the "newest"
   * sort. Bumped on every successful add(); derived from the event
   * sequence, never Date.now/Math.random — deterministic given the same
   * play sequence. Maps itemId -> last-acquired sequence number.
   */
  private acqSeq = 0;
  private acqOrder = new Map<string, number>();
  /**
   * Enchantments wave: per-item-id enchant state (itemId -> enchantId).
   * Per-id, not per-unit — the same precedent as junk marks: Inventory
   * models equipped gear as slot -> itemId with no per-unit instances.
   * One enchant per item id; see engine/game/enchantments.ts.
   */
  private enchants = new Map<string, string>();
  /**
   * Gear-salvage wave: monotonic salvage counter. Seeds the per-unit
   * yield stream (Rng(SALVAGE_SALT ^ hash(itemId) ^ seq)) — derived
   * from the event sequence like acqSeq, never Date.now/Math.random,
   * so yields are deterministic given the same play sequence and
   * survive save/reload via serialize().
   */
  private salvSeq = 0;

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
    // Gathering-nodes phase: null slots must never match — with the old
    // `s?.itemId === itemId` test, a null slot's itemId reads as undefined,
    // so count(undefined) matched every empty slot and then dereferenced
    // it (`s.count` on null). The guard keeps defined-id behavior identical
    // and makes undefined queries return 0 instead of throwing.
    for (const s of this.slots) if (s && s.itemId === itemId) n += s.count;
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
    const startRest = rest;
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
    if (rest < startRest) {
      // inventory-qol: record acquisition order (deterministic event counter)
      this.acqOrder.set(itemId, ++this.acqSeq);
    }
    this.emitChange();
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
    if (removed > 0) this.emitChange();
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
    this.emitChange();
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
    this.emitChange();
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
    this.emitChange();
    return true;
  }

  // ------------------------------------------------------------ junk + acquisition order

  /**
   * Inventory-qol wave: true when the item id is junk-marked. Marking is
   * per item id (every unit of that id counts as junk). Junk flags never
   * touch equip semantics; mass actions only operate on the backpack.
   */
  isJunk(itemId: string): boolean {
    return this.junk.has(itemId);
  }

  /**
   * Mark or unmark an item id as junk. Unknown ids are warned about and
   * ignored (same policy as add/remove). Fires onChange when the set
   * changed.
   */
  setJunk(itemId: string, flag: boolean): void {
    if (!this.defs[itemId]) {
      this.warnUnknown(itemId);
      return;
    }
    const had = this.junk.has(itemId);
    if (flag && !had) {
      this.junk.add(itemId);
      this.emitChange();
    } else if (!flag && had) {
      this.junk.delete(itemId);
      this.emitChange();
    }
  }

  /** All junk-marked item ids (in marking order). */
  junkItemIds(): string[] {
    return [...this.junk];
  }

  /** Drop all junk marks. Fires onChange when anything was marked. */
  clearJunk(): void {
    if (this.junk.size > 0) {
      this.junk.clear();
      this.emitChange();
    }
  }

  /**
   * Drop junk marks for item ids that no longer exist anywhere in the
   * backpack or equipped slots (housekeeping after mass actions).
   */
  pruneJunk(): void {
    let changed = false;
    for (const id of [...this.junk]) {
      if (this.count(id) === 0) {
        this.junk.delete(id);
        changed = true;
      }
    }
    if (changed) this.emitChange();
  }

  /**
   * Acquisition sequence number for the "newest" sort (0 = never added
   * this session/deserialized without order data). Higher = acquired
   * later. Deterministic: derived from the add() event sequence.
   */
  acquiredOrder(itemId: string): number {
    return this.acqOrder.get(itemId) ?? 0;
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

  /**
   * Gear set bonuses wave: the additive stat bonuses from the currently
   * equipped gear sets (2-piece / 4-piece thresholds). Pure function of
   * the equipped slots — equip/unequip mutate `equipped`, so the bonuses
   * are recomputed fresh on every equip change by construction. Never
   * throws; see engine/game/setBonuses.ts for the tuning table.
   */
  setBonusStats(): ItemStats {
    return computeSetBonuses(this.getAllEquipped()).bonusStats;
  }

  // ------------------------------------------------------------ enchantments

  /** Enchant id applied to an item id, or null (per-id state, see above). */
  getEnchant(itemId: string): string | null {
    return this.enchants.get(itemId) ?? null;
  }

  /** All enchanted item ids (in application order). */
  enchantedItemIds(): string[] {
    return [...this.enchants.keys()];
  }

  /**
   * Enchantments wave: apply an enchant to an item id you own (backpack
   * or equipped). Validation order: unknown item -> not equippable ->
   * unknown enchant -> slot mismatch -> already enchanted -> missing
   * materials. On success the material cost is consumed through
   * remove() (the same consume primitive craft() uses) and the enchant
   * recorded; nothing is consumed on failure. Returns { ok } plus a
   * machine-readable reason on failure; never throws.
   */
  enchant(itemId: string, enchantId: string): { ok: boolean; reason?: string } {
    const def = this.defs[itemId];
    if (!def) {
      this.warnUnknown(itemId);
      return { ok: false, reason: 'unknown-item' };
    }
    if (!this.isEquippable(itemId) || !def.slot) return { ok: false, reason: 'not-equippable' };
    const ench = enchantDef(enchantId);
    if (!ench) return { ok: false, reason: 'unknown-enchant' };
    if (!ench.slots.includes(def.slot)) return { ok: false, reason: 'slot-mismatch' };
    if (this.enchants.has(itemId)) return { ok: false, reason: 'already-enchanted' };
    // all materials present? (count() covers backpack + equipped; materials
    // are never equipped, so this is effectively the backpack count.)
    for (const c of ench.cost) {
      if (this.count(c.itemId) < c.count) return { ok: false, reason: 'missing-materials' };
    }
    // consume (defensive rollback: remove() on a counted item cannot
    // short-change, but never leave a half-consumed enchant behind).
    const consumed: EnchantCost[] = [];
    for (const c of ench.cost) {
      const removed = this.remove(c.itemId, c.count);
      consumed.push({ itemId: c.itemId, count: removed });
      if (removed < c.count) {
        for (const r of consumed) this.add(r.itemId, r.count);
        return { ok: false, reason: 'missing-materials' };
      }
    }
    this.enchants.set(itemId, enchantId);
    this.emitChange();
    return { ok: true };
  }

  /**
   * Enchantments wave: remove the enchant from an item id and REFUND
   * its full material cost through add() (restacking into existing
   * stacks by construction). Returns the refunded cost lines; [] when
   * the item is not enchanted (a no-op, nothing refunded).
   */
  removeEnchant(itemId: string): EnchantCost[] {
    const enchantId = this.enchants.get(itemId);
    if (!enchantId) return [];
    const ench = enchantDef(enchantId);
    this.enchants.delete(itemId);
    if (!ench) {
      this.emitChange();
      return [];
    }
    for (const c of ench.cost) this.add(c.itemId, c.count);
    this.emitChange();
    return ench.cost.map((c) => ({ ...c }));
  }

  /**
   * Enchantments wave: additive stat bonuses from the currently
   * equipped enchanted gear. Pure function of (equipped slots, per-id
   * enchant state) — recomputed fresh on every read by construction.
   */
  enchantStats(): ItemStats {
    return computeEnchantStats(this.getAllEquipped(), this.enchants);
  }

  /**
   * ELEMENTAL-DAMAGE-TYPES: the outgoing damage type for melee /
   * projectile attacks — the weapon-slot enchant's damageType, else
   * 'physical'. Pure function of (equipped slots, per-id enchant
   * state); see elemental.ts outgoingDamageType for the precedence
   * rules. Enchant state serializes already (ench: [...] in
   * serialize/deserialize), so the outgoing type survives save/reload
   * by construction — no new persisted field.
   */
  outgoingDamageType(): DamageType {
    return outgoingDamageType(this.getAllEquipped(), this.enchants);
  }

  /** Outgoing type + the enchant id that set it (null = no typed enchant). */
  outgoingDamageTypeDetail(): { type: DamageType; enchantId: string | null } {
    return outgoingDamageTypeDetail(this.getAllEquipped(), this.enchants);
  }

  /**
   * Gear set bonuses wave: the stat math the engine actually uses —
   * equipped item stats PLUS active set bonuses, additive (addItemStats
   * merges finite numbers only). Equip slot semantics and the loot ladder
   * are untouched; equippedStats() keeps its original contract.
   *
   * Enchantments wave: enchants apply LAST, after set bonuses —
   * effectiveStats() = equipped + set bonuses + enchants (see
   * engine/game/enchantments.ts for the disclosed order).
   */
  effectiveStats(): ItemStats {
    return addItemStats(addItemStats(this.equippedStats(), this.setBonusStats()), this.enchantStats());
  }

  // ------------------------------------------------------------ gear salvage

  /** Monotonic salvage counter (the per-unit yield stream position). */
  salvageCount(): number {
    return this.salvSeq;
  }

  /** Backpack-only units of an item (equipped units never count here). */
  private backpackCount(itemId: string): number {
    let n = 0;
    for (const s of this.slots) if (s?.itemId === itemId) n += s.count;
    return n;
  }

  /** True when the item id is equipped in any slot. */
  private isEquippedAnywhere(itemId: string): boolean {
    return Object.values(this.equipped).includes(itemId);
  }

  /**
   * Gear-salvage wave: is one unit of this item salvageable right now?
   * Rules (see engine/game/salvage.ts): known weapon/armor def, at
   * least one backpack unit, and NOT equipped in any slot — equipped
   * items are never salvageable, even with spare backpack copies.
   */
  isSalvageable(itemId: string): { ok: boolean; reason?: string } {
    const def = this.defs[itemId];
    if (!def) return { ok: false, reason: 'unknown-item' };
    if (!this.isEquippable(itemId) || !def.slot) return { ok: false, reason: 'not-salvageable' };
    if (this.isEquippedAnywhere(itemId)) return { ok: false, reason: 'equipped' };
    if (this.backpackCount(itemId) <= 0) return { ok: false, reason: 'not-owned' };
    return { ok: true };
  }

  /**
   * Gear-salvage wave: the exact yields the NEXT salvage() of this item
   * would grant, rolled from the current sequence position without
   * consuming it — so a HUD confirm preview and the confirmed salvage
   * always agree. Null when the item is not salvageable.
   */
  salvagePreview(itemId: string): SalvageYield[] | null {
    if (!this.isSalvageable(itemId).ok) return null;
    const def = this.defs[itemId]!;
    const rng = buildSalvageRng(itemId, this.salvSeq);
    return rollSalvageYields(def, rng, {
      enchantCost: enchantRefundFor(this.enchants.get(itemId) ?? null),
      setPiece: isSetPiece(itemId),
    });
  }

  /**
   * True when every yield line fits in the backpack AFTER the salvaged
   * unit is removed (simulated, no mutation): the freed slot counts,
   * so a full backpack can still salvage when the yields stack into
   * the freed slot or existing stacks.
   */
  private canFitAfterRemoval(yields: readonly SalvageYield[], itemId: string): boolean {
    // Simulate slot contents: [itemId, count][] over the 24 slots.
    const sim: Array<{ itemId: string; count: number } | null> = this.slots.map(
      (s) => (s ? { itemId: s.itemId, count: s.count } : null),
    );
    // Remove one unit of the salvaged item first (frees its slot when
    // the stack empties — gear stacks are size 1 in the catalogs).
    for (let i = 0; i < sim.length; i++) {
      const s = sim[i];
      if (s && s.itemId === itemId) {
        s.count -= 1;
        if (s.count <= 0) sim[i] = null;
        break;
      }
    }
    for (const y of yields) {
      let need = y.count;
      const max = this.stackSize(y.itemId);
      for (const s of sim) {
        if (need <= 0) break;
        if (s && s.itemId === y.itemId && s.count < max) {
          const take = Math.min(max - s.count, need);
          s.count += take;
          need -= take;
        }
      }
      for (let i = 0; i < sim.length && need > 0; i++) {
        if (sim[i] === null) {
          const take = Math.min(max, need);
          sim[i] = { itemId: y.itemId, count: take };
          need -= take;
        }
      }
      if (need > 0) return false;
    }
    return true;
  }

  /**
   * Gear-salvage wave: dismantle ONE backpack unit into crafting
   * materials (never currency, never new items). Validation order:
   * unknown item -> not salvageable -> equipped -> not owned ->
   * no-room. On success the unit is removed, the per-id enchant (if
   * any) is cleared with its cost refunded inside the yields, set
   * pieces pay the set bonus, and materials land via add() — the same
   * seams craft() consumes from. `onClearLoadout` fires only when
   * zero units of the id remain afterwards (the loadout-snapshot
   * rule — see engine/game/salvage.ts). Never throws.
   */
  salvage(
    itemId: string,
    opts?: { onClearLoadout?: (itemId: string) => void },
  ): SalvageResult {
    const def = this.defs[itemId];
    if (!def) {
      this.warnUnknown(itemId);
      return { ok: false, reason: 'unknown-item' };
    }
    const check = this.isSalvageable(itemId);
    if (!check.ok) return { ok: false, reason: check.reason };
    const enchantId = this.enchants.get(itemId) ?? null;
    const setPiece = isSetPiece(itemId);
    const rng = buildSalvageRng(itemId, this.salvSeq);
    const yields = rollSalvageYields(def, rng, {
      enchantCost: enchantRefundFor(enchantId),
      setPiece,
    });
    if (!this.canFitAfterRemoval(yields, itemId)) return { ok: false, reason: 'no-room' };
    const removed = this.remove(itemId, 1);
    if (removed < 1) return { ok: false, reason: 'not-owned' };
    this.salvSeq += 1;
    if (enchantId) this.enchants.delete(itemId);
    for (const y of yields) this.add(y.itemId, y.count);
    this.pruneJunk();
    if (this.count(itemId) === 0 && opts?.onClearLoadout) {
      try {
        opts.onClearLoadout(itemId);
      } catch (e) {
        console.warn('[inventory] onClearLoadout threw', e);
      }
    }
    return { ok: true, yields, enchantCleared: enchantId, setPiece };
  }

  /**
   * Gear-salvage wave: junk ids to consider for salvage-all, in
   * deterministic order — backpack first-appearance slot order, then
   * junk ids owned only in equipped slots (so an equipped junk piece
   * is reported as skipped, not silently ignored).
   */
  private junkSalvageOrder(): string[] {
    const order: string[] = [];
    for (const s of this.slots) {
      if (s && this.junk.has(s.itemId) && !order.includes(s.itemId)) order.push(s.itemId);
    }
    for (const id of Object.values(this.equipped)) {
      if (id && this.junk.has(id) && !order.includes(id)) order.push(id);
    }
    return order;
  }
  /**
   * Gear-salvage wave: non-mutating preview of salvageAllJunk() —
   * per-id unit counts and exact yields, in the same backpack-slot
   * order and with the same per-unit seeds the real run will use
   * (enchant refund on the first unit of an enchanted id only, set
   * bonus per unit). Skipped ids carry their block reason.
   */
  previewSalvageAllJunk(): SalvageAllPreview {
    const plan: SalvageAllPreview['plan'] = [];
    const skipped: SalvageAllPreview['skipped'] = [];
    const order = this.junkSalvageOrder();
    let seq = this.salvSeq;
    for (const itemId of order) {
      const check = this.isSalvageable(itemId);
      if (!check.ok) {
        skipped.push({ itemId, reason: check.reason ?? 'not-salvageable' });
        continue;
      }
      const def = this.defs[itemId]!;
      const units = this.backpackCount(itemId);
      const yields: SalvageYield[] = [];
      const merge = (ys: SalvageYield[]): void => {
        for (const y of ys) {
          const e = yields.find((v) => v.itemId === y.itemId);
          if (e) e.count += y.count;
          else yields.push({ ...y });
        }
      };
      for (let u = 0; u < units; u++) {
        const rng = buildSalvageRng(itemId, seq);
        seq += 1;
        merge(
          rollSalvageYields(def, rng, {
            // enchant state is per id: only the first salvaged unit
            // of an enchanted id pays the refund.
            enchantCost: u === 0 ? enchantRefundFor(this.enchants.get(itemId) ?? null) : [],
            setPiece: isSetPiece(itemId),
          }),
        );
      }
      plan.push({ itemId, units, yields });
    }
    return { plan, skipped };
  }

  /**
   * Gear-salvage wave: salvage every backpack unit of every
   * junk-marked salvageable id (the inventory-qol junk path), in
   * backpack slot order. Equipped / non-salvageable ids are skipped
   * honestly (nothing consumed for them); a unit that cannot fit its
   * yields stops that id only. Returns per-id results + merged yields.
   */
  salvageAllJunk(opts?: { onClearLoadout?: (itemId: string) => void }): SalvageAllResult {
    const salvaged: SalvageAllResult['salvaged'] = [];
    const skipped: SalvageAllResult['skipped'] = [];
    const merged: SalvageYield[] = [];
    const mergeInto = (ys: SalvageYield[]): void => {
      for (const y of ys) {
        const e = merged.find((v) => v.itemId === y.itemId);
        if (e) e.count += y.count;
        else merged.push({ ...y });
      }
    };
    const order = this.junkSalvageOrder();
    for (const itemId of order) {
      const check = this.isSalvageable(itemId);
      if (!check.ok) {
        skipped.push({ itemId, reason: check.reason ?? 'not-salvageable' });
        continue;
      }
      let units = 0;
      const yields: SalvageYield[] = [];
      while (this.backpackCount(itemId) > 0) {
        const r = this.salvage(itemId, opts);
        if (!r.ok) {
          skipped.push({ itemId, reason: r.reason ?? 'not-salvageable' });
          break;
        }
        units += 1;
        for (const y of r.yields ?? []) {
          const e = yields.find((v) => v.itemId === y.itemId);
          if (e) e.count += y.count;
          else yields.push({ ...y });
        }
      }
      if (units > 0) {
        salvaged.push({ itemId, units, yields });
        mergeInto(yields);
      }
    }
    return { salvaged, skipped, yields: merged };
  }

  // ------------------------------------------------------------ save / load

  /** Serialize to a JSON string for save games. */
  serialize(): string {
    const data: SerializedInventory = {
      version: 1,
      slots: this.slots.map((s) => (s ? { itemId: s.itemId, count: s.count } : null)),
      equipped: { ...this.equipped },
      junk: [...this.junk],
      acq: [...this.acqOrder.entries()],
      acqSeq: this.acqSeq,
      ench: [...this.enchants.entries()],
      salv: this.salvSeq,
    };
    return JSON.stringify(data);
  }

  /**
   * PORTALS-D: replace the entire inventory contents from a serialize() JSON
   * string (portal transitions — player state must survive map changes).
   * Unknown item ids are skipped (same policy as deserialize). Malformed
   * JSON leaves the inventory UNCHANGED (never wipes the player's items on
   * a corrupt snapshot). Fires onChange once.
   */
  restore(serialized: string): void {
    try {
      JSON.parse(serialized);
    } catch {
      console.warn('[inventory] restore: invalid JSON — inventory unchanged');
      return;
    }
    const fresh = Inventory.deserialize(this.defs, serialized);
    // deserialize() never throws; copy its validated state over wholesale.
    this.slots = fresh.slots;
    this.equipped = fresh.equipped;
    this.junk = fresh.junk;
    this.acqOrder = fresh.acqOrder;
    this.acqSeq = fresh.acqSeq;
    this.enchants = fresh.enchants;
    this.salvSeq = fresh.salvSeq;
    this.emitChange();
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
    // inventory-qol: restore junk marks + acquisition order (validated).
    if (Array.isArray(d.junk)) {
      for (const id of d.junk) {
        if (typeof id === 'string' && defs[id]) inv.junk.add(id);
      }
    }
    if (Array.isArray(d.acq)) {
      let maxSeq = 0;
      for (const pair of d.acq) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [id, seq] = pair as [unknown, unknown];
        if (typeof id !== 'string' || !defs[id]) continue;
        if (!isFiniteNum(seq)) continue;
        const s = Math.floor(seq);
        inv.acqOrder.set(id, s);
        if (s > maxSeq) maxSeq = s;
      }
      inv.acqSeq = Math.max(
        inv.acqSeq,
        maxSeq,
        isFiniteNum(d.acqSeq) ? Math.floor(d.acqSeq) : 0,
      );
    } else if (isFiniteNum(d.acqSeq)) {
      inv.acqSeq = Math.max(inv.acqSeq, Math.floor(d.acqSeq));
    }
    // enchantments: restore per-id enchant state (validated: known item
    // def + known enchant id; anything else is warned about and skipped).
    if (Array.isArray(d.ench)) {
      const known = new Set(ENCHANT_DEFS.map((e) => e.id));
      for (const pair of d.ench) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [id, enchId] = pair as [unknown, unknown];
        if (typeof id !== 'string' || !defs[id]) {
          if (typeof id === 'string') inv.warnUnknown(id);
          continue;
        }
        if (typeof enchId !== 'string' || !known.has(enchId)) {
          console.warn(`[inventory] deserialize: unknown enchant "${String(enchId)}" for "${id}" — skipped`);
          continue;
        }
        inv.enchants.set(id, enchId);
      }
    }
    // gear salvage: restore the salvage sequence counter (validated).
    if (isFiniteNum(d.salv)) {
      inv.salvSeq = Math.max(0, Math.floor(d.salv));
    }
    return inv;
  }
}
