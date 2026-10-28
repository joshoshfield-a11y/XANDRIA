/**
 * Gear loadout presets — named equip-set snapshots on the equip /
 * inventory / set-bonus systems (upgrade loop: loadout-presets).
 *
 * A loadout is a full equip-set snapshot: equip slot -> item id, for the
 * five equip slots. Three named slots per save slot, stored in Profile
 * (`gearLoadouts`, per save slot via the save-slots store) so a loadout
 * survives portal travel (the portal path never touches Profile) and
 * save/reload (the slots store is localStorage-backed).
 *
 * Pure module: no DOM, no three.js, no Math.random/Date.now. The apply
 * path reuses Inventory.equip()/unequip() EXACTLY — the same primitives
 * the HUD click path uses — so set bonuses recompute by construction:
 * Inventory.setBonusStats() is a pure function of the equipped slots,
 * recomputed fresh on every read. Nothing here invents a parallel
 * equip path, changes the loot ladder, or touches equip slot semantics.
 *
 * Apply semantics (exact-set): applying a loadout reproduces the
 * snapshot exactly — slots present in the snapshot are equipped, slots
 * absent from it are unequipped. Items the player no longer owns are
 * skipped and reported (never thrown on); a slot whose unequip fails
 * (backpack full) is reported blocked and its equip is skipped.
 * Applying is refused while in combat: the caller supplies the
 * state-driven `isInCombat` guard (Engine.inCombat(), the same guard
 * the difficulty-modes wave uses); this module never guesses combat
 * state from anything else.
 */
import { EQUIP_SLOTS, type EquipSlot, type ItemDef } from '@spec';

/** Named loadout slots per save slot (brief: 3). */
export const MAX_LOADOUTS = 3;
/** Display-name cap for a renamed loadout (same cap as save-slot names). */
export const MAX_LOADOUT_NAME_LENGTH = 24;

/** One named equip-set snapshot: equip slot -> item id (absent = unequipped). */
export interface GearLoadout {
  name: string;
  equipped: Partial<Record<EquipSlot, string>>;
}

/** Default slot names, in slot order. */
export function defaultLoadoutName(index: number): string {
  return `Loadout ${index + 1}`;
}

/** The fresh 3-slot rack: named, empty (nothing equipped in any slot). */
export function defaultGearLoadouts(): GearLoadout[] {
  return Array.from({ length: MAX_LOADOUTS }, (_, i) => ({
    name: defaultLoadoutName(i),
    equipped: {},
  }));
}

/** Sanitize a loadout display name: trim/collapse whitespace, cap length. */
export function sanitizeLoadoutName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback;
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, MAX_LOADOUT_NAME_LENGTH);
  return clean || fallback;
}

function isEquipSlot(slot: unknown): slot is EquipSlot {
  return typeof slot === 'string' && (EQUIP_SLOTS as readonly string[]).includes(slot);
}

/**
 * Validate a stored gearLoadouts value into exactly MAX_LOADOUTS slots.
 * Malformed entries are repaired (never thrown on): non-array input
 * yields the default rack; short racks are padded with default-named
 * empty slots; long racks are truncated; per-slot names sanitize to
 * their default when blank; equipped entries keep only string item ids
 * on real equip slots, with duplicate item ids dropped (the second
 * slot claiming an id loses it — one unit cannot be in two slots).
 * Returns fresh copies — callers may mutate freely.
 */
export function validateGearLoadouts(raw: unknown): GearLoadout[] {
  const out: GearLoadout[] = defaultGearLoadouts();
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < Math.min(raw.length, MAX_LOADOUTS); i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const seen = new Set<string>();
    const equipped: Partial<Record<EquipSlot, string>> = {};
    const src = e.equipped;
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const [slot, itemId] of Object.entries(src as Record<string, unknown>)) {
        if (!isEquipSlot(slot)) continue;
        if (typeof itemId !== 'string' || !itemId) continue;
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        equipped[slot] = itemId;
      }
    }
    out[i] = {
      name: sanitizeLoadoutName(e.name, defaultLoadoutName(i)),
      equipped,
    };
  }
  return out;
}

/**
 * Capture the current equip set as a loadout snapshot. Only entries
 * whose def exists, is equippable, and belongs in that slot are kept —
 * a snapshot can never name an item in a slot it does not belong to.
 * The name is sanitized; the equipped map is a fresh copy.
 */
export function captureLoadout(
  name: string,
  equipped: Partial<Record<EquipSlot, string>>,
  defs: Record<string, ItemDef>,
): GearLoadout {
  const kept: Partial<Record<EquipSlot, string>> = {};
  for (const slot of EQUIP_SLOTS) {
    const itemId = equipped[slot];
    if (!itemId) continue;
    const def = defs[itemId];
    if (!def) continue;
    if ((def.type !== 'weapon' && def.type !== 'armor') || def.slot !== slot) continue;
    kept[slot] = itemId;
  }
  return { name: sanitizeLoadoutName(name, defaultLoadoutName(0)), equipped: kept };
}

/** Minimal inventory surface applyGearLoadout needs (Inventory satisfies it). */
export interface LoadoutInventory {
  getEquipped(slot: EquipSlot): string | null;
  count(itemId: string): number;
  equip(itemId: string): { displaced: string | null } | null;
  unequip(slot: EquipSlot): boolean;
}

export interface LoadoutApplySlotResult {
  slot: EquipSlot;
  itemId: string | null;
}

/** Result of one apply: per-slot outcomes, never thrown on. */
export interface ApplyLoadoutResult {
  ok: boolean;
  /** Refusal reason when ok is false ('in-combat' only — see module doc). */
  reason?: string;
  /** Slots whose final state now matches the snapshot via a change. */
  applied: EquipSlot[];
  /** Slots already matching the snapshot (no change needed). */
  unchanged: EquipSlot[];
  /** Snapshot items the player does not own (skipped, reported). */
  missing: LoadoutApplySlotResult[];
  /** Slots that could not be changed (unequip/equip failed — e.g. backpack full). */
  blocked: LoadoutApplySlotResult[];
}

/**
 * Apply a loadout through Inventory.equip()/unequip() exactly.
 * Refused whole (ok: false, reason 'in-combat', nothing changed) while
 * the caller's isInCombat() guard reports combat. Otherwise exact-set:
 * every slot is driven to the snapshot state; missing items are
 * skipped and reported; failures are reported per slot; never throws
 * (a throwing inventory primitive is caught and reported blocked).
 */
export function applyGearLoadout(
  inv: LoadoutInventory,
  loadout: GearLoadout,
  defs: Record<string, ItemDef>,
  isInCombat: () => boolean,
): ApplyLoadoutResult {
  const result: ApplyLoadoutResult = { ok: true, applied: [], unchanged: [], missing: [], blocked: [] };
  let inCombat = false;
  try {
    inCombat = isInCombat();
  } catch {
    inCombat = false;
  }
  if (inCombat) {
    result.ok = false;
    result.reason = 'in-combat';
    return result;
  }
  for (const slot of EQUIP_SLOTS) {
    const target = loadout.equipped[slot] ?? null;
    let current: string | null = null;
    try {
      current = inv.getEquipped(slot);
    } catch {
      result.blocked.push({ slot, itemId: target });
      continue;
    }
    if (current === target) {
      result.unchanged.push(slot);
      continue;
    }
    // Validate the target before touching anything in this slot.
    if (target !== null) {
      const def = defs[target];
      const slotOk = !!def && (def.type === 'weapon' || def.type === 'armor') && def.slot === slot;
      if (!slotOk) {
        result.missing.push({ slot, itemId: target });
        continue;
      }
      // Owned? count() covers backpack + equipped; the item cannot be
      // equipped elsewhere (slot-validated), so count 0 = not owned.
      let owned = 0;
      try {
        owned = inv.count(target);
      } catch {
        owned = 0;
      }
      if (owned <= 0) {
        result.missing.push({ slot, itemId: target });
        continue;
      }
    }
    // Unequip the current occupant first (exact-set semantics; equip()
    // alone would swap, but the swap path needs backpack room for the
    // displaced unit too — unequip-first keeps failure reporting honest).
    if (current !== null) {
      let ok = false;
      try {
        ok = inv.unequip(slot);
      } catch {
        ok = false;
      }
      if (!ok) {
        result.blocked.push({ slot, itemId: target });
        continue;
      }
    }
    if (target === null) {
      result.applied.push(slot);
      continue;
    }
    let equipped: { displaced: string | null } | null = null;
    try {
      equipped = inv.equip(target);
    } catch {
      equipped = null;
    }
    if (equipped === null) {
      result.blocked.push({ slot, itemId: target });
      continue;
    }
    result.applied.push(slot);
  }
  return result;
}

/** Count equipped pieces in a loadout snapshot (0..5) for UI summaries. */
export function loadoutPieceCount(loadout: GearLoadout): number {
  return EQUIP_SLOTS.reduce((n, s) => n + (loadout.equipped[s] ? 1 : 0), 0);
}
