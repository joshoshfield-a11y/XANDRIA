/**
 * Gear salvage / dismantling wave (upgrade loop): break gear down into
 * crafting materials. No new items, no currency — materials only.
 *
 * CONTENT
 * - SALVAGE_TABLE — THE tuning table. One row per rarity; every yield
 *   number lives here. Each row is a list of material lines; exactly
 *   one line per row carries a min..max range (the seeded variance,
 *   disclosed in the table comments). All other lines are fixed.
 * - Set-bonus pieces (GEAR_SETS membership) return a flat bonus line
 *   (SET_PIECE_SALVAGE_BONUS) on top of the rarity row, per unit.
 * - Enchanted pieces return the enchant's FULL material cost on top
 *   of the rarity row (the enchant is cleared by the salvage; the
 *   cost lines are the refund, exactly as removeEnchant refunds).
 * - Yield variance is seeded: one roll per salvaged unit from
 *   Rng(SALVAGE_SALT ^ hashString(itemId) ^ seq), where seq is the
 *   Inventory's monotonic salvage counter (serialized, so the stream
 *   survives save/reload; same play sequence -> identical yields).
 *   The roll consumes exactly one Rng stream per unit, in table order.
 *
 * SALVAGE RULES (disclosed, pinned by unit + e2e tests):
 * - Salvageable: weapon/armor defs (equippable gear) with >= 1 unit in
 *   the BACKPACK. Materials, consumables, trinkets and keys are never
 *   salvageable (reason 'not-salvageable').
 * - Equipped items are NEVER salvageable: if the item id is equipped
 *   in ANY slot, salvage is blocked (reason 'equipped') even when
 *   spare backpack copies exist. Rationale: enchant state is per item
 *   id (the enchantments wave's precedent), so salvaging a backpack
 *   copy of an enchanted equipped id would silently strip the
 *   equipped piece's enchant. Unequip first, then salvage.
 * - One unit per salvage() call. salvageAllJunk() salvages every
 *   backpack unit of every junk-marked salvageable id, in backpack
 *   slot order, skipping equipped / non-salvageable ids honestly
 *   (reported in `skipped`, nothing consumed for them).
 * - Yields are granted through Inventory.add() — the same material
 *   seams craft() consumes from. No craft-check, loot-ladder, or
 *   equip-semantics changes; no new material defs (every yield id
 *   already exists in the crafting / loot / enchant catalogs).
 * - Salvage never pays currency and never creates new items.
 * - Backpack room: yields must fit before the item is consumed
 *   (reason 'no-room', nothing consumed) — salvaging must never
 *   destroy an item to make room for materials that then overflow.
 *
 * LOADOUT SNAPSHOTS (disclosed): the gear-loadout-presets wave
 * (feature/upgrade-loadout-presets) is NOT merged into main, so this
 * tree has no loadout store to clear. Salvage therefore exposes the
 * clearing as a hook + a pure helper, and the merge of that wave can
 * wire it in one place (see REPORT.md for the exact snippet):
 * - clearSalvagedFromLoadouts(loadouts, itemId) removes the item id
 *   from every snapshot's equipped map (mutating the snapshots in
 *   place, returning whether anything changed).
 * - Inventory.salvage()/salvageAllJunk() accept
 *   { onClearLoadout?: (itemId) => void }, invoked after a successful
 *   salvage ONLY when zero units of the id remain in the inventory
 *   (backpack + equipped) — i.e. salvaging the last copy clears the
 *   snapshots; salvaging one of several copies does not. The wiring
 *   layer (the loadout wave's itemKit hooks) only has to pass the
 *   callback; the zero-remaining rule lives here and is unit-pinned.
 * - EXACT RULE: salvaging the LAST unit of an id clears that id from
 *   every loadout snapshot; salvaging one of several units does NOT
 *   clear it (the snapshot still names an item the player owns).
 *   Until the loadout wave merges, the hook is unwired and snapshots
 *   cannot exist in this tree, so nothing is lost by salvaging.
 *
 * DETERMINISM: no Math.random/Date.now/engine.rng anywhere. The only
 * RNG is the seeded per-unit stream above; the table itself is fixed.
 *
 * CONTRACTS (owned by this wave):
 * - Yield material ids are string literals naming ids from the
 *   crafting / loot / enchant catalogs (value-importing those modules
 *   here would risk cycles: loot.ts already imports setBonuses and
 *   enchantments). Literal <-> catalog sync is pinned by unit test:
 *   every yield id must resolve to a type:'material' def in the merged
 *   catalogs.
 * - Set membership is read from GEAR_SETS (setBonuses.ts) at call
 *   time, so Studio overrides of piece stats never affect it; only
 *   membership matters.
 */
import type { EquipSlot, ItemDef, ItemRarity } from '@spec';
import { Rng, hashString } from '../core/Rng';
import { GEAR_SETS } from './setBonuses';
import { enchantDef, type EnchantCost } from './enchantments';

/** Distinct from every other wave salt (pinned by unit test). */
export const SALVAGE_SALT = 0x5a11a6e;

/** One material yield line: item id x count, with an optional seeded range. */
export interface SalvageYieldLine {
  itemId: string;
  /** Fixed count when min === max; otherwise rng.int(min, max). */
  min: number;
  max: number;
}

/** One granted yield: item id x exact count (post-roll). */
export interface SalvageYield {
  itemId: string;
  count: number;
}

/** One table row: the rarity's base yields, in roll order. */
export interface SalvageRow {
  rarity: ItemRarity;
  yields: readonly SalvageYieldLine[];
}

/**
 * THE salvage table. All tuning in one place; yields are crafting
 * materials only (mat_* ids — see the catalog-sync pin in the tests).
 * Variance: exactly one ranged line per row (marked RANGE); every
 * other line is fixed. Ranged lines roll rng.int(min, max) in table
 * order from the per-unit seeded stream.
 */
export const SALVAGE_TABLE: readonly SalvageRow[] = [
  {
    rarity: 'common',
    yields: [
      { itemId: 'mat_scrap', min: 2, max: 3 }, // RANGE: scrap varies 2-3
      { itemId: 'mat_fiber', min: 1, max: 1 },
    ],
  },
  {
    rarity: 'uncommon',
    yields: [
      { itemId: 'mat_scrap', min: 2, max: 2 },
      { itemId: 'mat_ore', min: 2, max: 3 }, // RANGE: ore varies 2-3
      { itemId: 'mat_fiber', min: 1, max: 1 },
    ],
  },
  {
    rarity: 'rare',
    yields: [
      { itemId: 'mat_ore', min: 3, max: 3 },
      { itemId: 'mat_ember_shard', min: 2, max: 3 }, // RANGE: ember varies 2-3
      { itemId: 'mat_beast_hide', min: 1, max: 1 },
    ],
  },
  {
    rarity: 'epic',
    yields: [
      { itemId: 'mat_ember_shard', min: 3, max: 4 }, // RANGE: ember varies 3-4
      { itemId: 'mat_core_fragment', min: 2, max: 2 },
      { itemId: 'mat_beast_hide', min: 2, max: 2 },
    ],
  },
  {
    rarity: 'legendary',
    yields: [
      { itemId: 'mat_core_fragment', min: 4, max: 5 }, // RANGE: core varies 4-5
      { itemId: 'mat_star_essence', min: 3, max: 3 },
      { itemId: 'mat_ember_shard', min: 3, max: 3 },
    ],
  },
];

/**
 * Flat bonus returned for every salvaged unit that belongs to a gear
 * set (GEAR_SETS membership), on top of the rarity row. Per unit, so
 * salvaging two copies of a set piece pays it twice.
 */
export const SET_PIECE_SALVAGE_BONUS: readonly SalvageYieldLine[] = [
  { itemId: 'mat_ember_shard', min: 2, max: 2 },
  { itemId: 'mat_core_fragment', min: 1, max: 1 },
];

/** Row lookup by rarity (undefined when the rarity has no row — never for real defs). */
export function salvageRowFor(rarity: ItemRarity): SalvageRow | undefined {
  return SALVAGE_TABLE.find((r) => r.rarity === rarity);
}

/** True when the item id belongs to any gear set in GEAR_SETS. */
export function isSetPiece(itemId: string): boolean {
  return GEAR_SETS.some((set) => set.pieces.includes(itemId));
}

/**
 * Deterministic per-unit seed: SALVAGE_SALT ^ hash(itemId) ^ seq.
 * seq is the Inventory's monotonic salvage counter (0-based). Same
 * (itemId, seq) -> identical stream, regardless of when it runs.
 */
export function salvageSeedFor(itemId: string, seq: number): number {
  return (SALVAGE_SALT ^ hashString(itemId) ^ (seq >>> 0)) >>> 0;
}

/** Fresh seeded stream for one salvage unit. */
export function buildSalvageRng(itemId: string, seq: number): Rng {
  return new Rng(salvageSeedFor(itemId, seq));
}

/**
 * Pure: roll one unit's yields from a seeded stream.
 * - Base: the def's rarity row, in table order (ranged lines roll).
 * - Enchant refund: when `enchantCost` is given, its lines are appended
 *   verbatim (the enchant's full cost, exactly as removeEnchant
 *   refunds) — the enchant itself is cleared by the caller.
 * - Set bonus: when `setPiece` is true, SET_PIECE_SALVAGE_BONUS lines
 *   are appended.
 * Duplicate material ids across the three groups are merged by
 * summing (order: base lines first, then enchant lines, then set
 * bonus). Never throws; unknown rarity yields [].
 */
export function rollSalvageYields(
  def: ItemDef,
  rng: Rng,
  extras?: { enchantCost?: readonly EnchantCost[]; setPiece?: boolean },
): SalvageYield[] {
  const out: SalvageYield[] = [];
  const push = (itemId: string, count: number): void => {
    if (count <= 0) return;
    const existing = out.find((y) => y.itemId === itemId);
    if (existing) existing.count += count;
    else out.push({ itemId, count });
  };
  const row = salvageRowFor(def.rarity ?? 'common');
  if (row) {
    for (const line of row.yields) {
      const count = line.max > line.min ? rng.int(line.min, line.max) : line.min;
      push(line.itemId, count);
    }
  }
  for (const c of extras?.enchantCost ?? []) push(c.itemId, c.count);
  if (extras?.setPiece) {
    for (const line of SET_PIECE_SALVAGE_BONUS) push(line.itemId, line.min);
  }
  return out;
}

/** Enchant cost lines for an enchant id (the refund a salvage pays). */
export function enchantRefundFor(enchantId: string | null): EnchantCost[] {
  if (!enchantId) return [];
  const def = enchantDef(enchantId);
  return def ? def.cost.map((c) => ({ ...c })) : [];
}

// ---------------------------------------------------------------- loadout snapshots

/**
 * Structural shape of a gear-loadout snapshot (the loadout-presets
 * wave's GearLoadout: name + slot -> item id). Structural on purpose:
 * this wave must not value-import the unmerged loadouts module.
 */
export interface LoadoutSnapshotLike {
  equipped: Partial<Record<EquipSlot, string>>;
}

/**
 * Pure helper for the loadout-presets wiring layer: remove `itemId`
 * from every snapshot's equipped map (in place). Returns true when at
 * least one snapshot named the item. A snapshot that loses its last
 * piece is kept (empty), never deleted — the rack shape is the
 * loadout wave's to own. Never throws on malformed snapshots.
 */
export function clearSalvagedFromLoadouts(
  loadouts: readonly LoadoutSnapshotLike[] | null | undefined,
  itemId: string,
): boolean {
  if (!Array.isArray(loadouts)) return false;
  let changed = false;
  for (const snap of loadouts) {
    if (!snap || typeof snap !== 'object') continue;
    const equipped = (snap as LoadoutSnapshotLike).equipped;
    if (!equipped || typeof equipped !== 'object') continue;
    for (const [slot, id] of Object.entries(equipped)) {
      if (id === itemId) {
        delete (equipped as Record<string, string | undefined>)[slot];
        changed = true;
      }
    }
  }
  return changed;
}
