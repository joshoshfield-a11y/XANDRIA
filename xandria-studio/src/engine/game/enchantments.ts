/**
 * Gear enchantment wave (upgrade loop): data-driven enchantments for
 * equipped gear, applied ADDITIVELY on top of the existing stat math.
 *
 * CONTENT
 * - ENCHANT_DEFS — THE tuning table. Six enchants, each with: the gear
 *   slots it may be applied to, additive stat effects, and a material
 *   cost. Every tuning number lives in this one table.
 * - Two new enchant-material item defs (enchant dust / star essence),
 *   merged into spec.custom.items.defs by ensureEnchantItemDefs() under
 *   the same never-create-custom.items contract as the loot/set waves.
 * - ENCHANT_DROP_ADDONS — ADDITIVE material entries on the elite loot
 *   tables (brute + turret), merged by loot.ts inside rollLoot. Bosses
 *   are brutes, so boss material rolls draw from the same merged table.
 *   The base tables, the rarity ladder, and the boss guaranteed-gear
 *   path are untouched (legendary stays boss-exclusive by construction).
 *
 * STAT ORDER (disclosed, pinned by unit test):
 *   effectiveStats() = equippedStats() + setBonusStats() + enchantStats()
 * Enchants apply LAST, after set bonuses — an enchant never changes a
 * set threshold, and a set bonus never changes an enchant's stats.
 *
 * ENCHANT STATE MODEL (disclosed): enchant state is per ITEM ID, not
 * per unit — the same precedent as the inventory-qol junk marks.
 * Enchanting an item id enchants every unit of that id; equipping any
 * unit of an enchanted id grants the bonus. Rationale: Inventory models
 * equipped gear as slot -> itemId with no per-unit instances, so a
 * per-unit model would require rewriting equip/unequip/serialize. The
 * per-id model is additive, serializes cleanly, and matches how the
 * game already treats junk marks.
 *
 * APPLY / REMOVE (Inventory.enchant / Inventory.removeEnchant):
 * - Apply validates (known item, equippable, known enchant, slot
 *   allowed, not already enchanted, all materials present) then
 *   consumes materials through Inventory.remove() — the same consume
 *   primitive craft() uses — and records the enchant. One enchant per
 *   item id: applying to an already-enchanted id is blocked until the
 *   old enchant is removed (no silent overwrite, no stacking).
 * - Remove clears the enchant and REFUNDS the full material cost
 *   through Inventory.add() (restacking into existing stacks by
 *   construction). Removing an unenchanted id is a no-op returning [].
 *
 * DETERMINISM: no Math.random/Date.now/engine.rng anywhere. Drop
 * entries roll inside rollLoot's existing Rng(mapSeed ^ LOOT_SALT)
 * stream — same (seed, kill sequence) -> identical drops, addon
 * tables included.
 *
 * CONTRACTS (owned by this wave):
 * - Existing item ids (mat_* / loot_* / craft_* namespaces) are
 *   repeated here as string literals, NOT value-imported from loot.ts
 *   — loot.ts value-imports this module for ENCHANT_DROP_ADDONS, so a
 *   value import back would be a module cycle (TDZ crash at load).
 *   Literal <-> source sync is pinned by unit test.
 * - ensureEnchantItemDefs(spec) merges defs ONLY when spec.custom.items
 *   already exists — it never creates custom.items, preserving
 *   wireItems' null contract (item system disabled when no item
 *   tables). Idempotent, non-destructive (Studio-authored overrides win).
 * - LootEntry type is imported TYPE-ONLY from loot.ts.
 */
import type { GameSpec, ItemDef, ItemStats, EquipSlot } from '@spec';
import type { DamageType } from './elemental';
import type { LootEntry } from './loot';
import { ItemBuilder } from './items/ItemBuilder';
import { addItemStats } from './setBonuses';

// ---------------------------------------------------------------- ids

/** Existing material ids, as string literals (see CONTRACTS — sync pinned by test). */
const MAT_EMBER_SHARD = 'mat_ember_shard';
const MAT_BEAST_HIDE = 'mat_beast_hide';

/** New enchant-material ids (defined in enchantMaterialDefs below). */
export const MAT_ENCHANT_DUST = 'mat_enchant_dust';
export const MAT_STAR_ESSENCE = 'mat_star_essence';
export const ENCHANT_MATERIAL_IDS = [MAT_ENCHANT_DUST, MAT_STAR_ESSENCE] as const;

// ---------------------------------------------------------------- material defs

/** Enchant materials — dropped by elites/bosses, consumed by enchanting. */
export function enchantMaterialDefs(): Record<string, ItemDef> {
  return {
    [MAT_ENCHANT_DUST]: new ItemBuilder(MAT_ENCHANT_DUST)
      .named('Enchant Dust')
      .material()
      .rarity('uncommon')
      .stackable(999)
      .value(12)
      .description('Fine dust that holds a charge. The base note of every enchantment.')
      .build(),
    [MAT_STAR_ESSENCE]: new ItemBuilder(MAT_STAR_ESSENCE)
      .named('Star Essence')
      .material()
      .rarity('rare')
      .stackable(999)
      .value(30)
      .description('Condensed starlight, cold to the touch. For the sharper enchants.')
      .build(),
  };
}

/**
 * Merge the enchant-material defs into spec.custom.items.defs.
 * Idempotent and non-destructive (existing defs win). NEVER creates
 * custom.items — when the spec has no item tables the item system (and
 * enchants) stays off.
 */
export function ensureEnchantItemDefs(spec: GameSpec): void {
  const items = spec.custom?.items;
  if (!items) return;
  items.defs = items.defs ?? {};
  const defs = items.defs;
  for (const [id, def] of Object.entries(enchantMaterialDefs())) {
    if (defs[id] === undefined) defs[id] = def;
  }
}

// ---------------------------------------------------------------- enchant defs

/** One material cost line: item id x count. */
export interface EnchantCost {
  itemId: string;
  count: number;
}

/** One enchant — all tuning lives in ENCHANT_DEFS below. */
export interface EnchantDef {
  id: string;
  name: string;
  blurb: string;
  /** Gear slots this enchant may be applied to. */
  slots: readonly EquipSlot[];
  /** Additive stats granted while the enchanted item is equipped. */
  stats: ItemStats;
  /**
   * ELEMENTAL-DAMAGE-TYPES: the damage type this enchant lends the
   * weapon it is applied to (see elemental.ts outgoingDamageType —
   * weapon slot only). Absent for defensive enchants, which grant no
   * damage type. Adding a type here changes no stat math and no
   * enchant/ability contract: the type flows only through the
   * elemental step in Enemy.damage().
   */
  damageType?: DamageType;
  /** Materials consumed on apply; refunded in full on remove. */
  cost: readonly EnchantCost[];
}

/**
 * THE enchant table. Six enchants across the gear bands; bonuses are
 * modest additive stats that sit below a single tier-up in gear —
 * enchants reward material hunting, never replace upgrades.
 */
export const ENCHANT_DEFS: readonly EnchantDef[] = [
  {
    id: 'ench_sharp',
    name: 'Sharpened Edge',
    blurb: 'Dust-honed edge — cuts a fraction deeper.',
    slots: ['weapon'],
    stats: { damage: 4 },
    damageType: 'physical',
    cost: [{ itemId: MAT_ENCHANT_DUST, count: 3 }],
  },
  {
    id: 'ench_warded',
    name: 'Warded Plating',
    blurb: 'Dust-set wards — turns the glancing blow.',
    slots: ['head', 'torso', 'legs'],
    stats: { defense: 4 },
    cost: [{ itemId: MAT_ENCHANT_DUST, count: 3 }],
  },
  {
    id: 'ench_vital',
    name: 'Vital Surge',
    blurb: 'Starlight stitched into the lining — more breath in the fight.',
    slots: ['head', 'torso', 'legs', 'accessory'],
    stats: { maxHealth: 15 },
    cost: [
      { itemId: MAT_STAR_ESSENCE, count: 2 },
      { itemId: MAT_EMBER_SHARD, count: 2 },
    ],
  },
  {
    id: 'ench_deadly',
    name: 'Deadly Precision',
    blurb: 'Starlight on the edge — finds the seam every time.',
    slots: ['weapon'],
    stats: { crit: 5 },
    damageType: 'shock',
    cost: [{ itemId: MAT_STAR_ESSENCE, count: 3 }],
  },
  {
    id: 'ench_sturdy',
    name: 'Sturdy Frame',
    blurb: 'Hide-bound, dust-set — built to outlast the wearer.',
    slots: ['torso', 'legs'],
    stats: { defense: 6, maxHealth: 5 },
    cost: [
      { itemId: MAT_BEAST_HIDE, count: 4 },
      { itemId: MAT_ENCHANT_DUST, count: 3 },
    ],
  },
  {
    id: 'ench_starlit',
    name: 'Starlit Edge',
    blurb: 'Starlight and dust in equal measure — bright and hungry.',
    slots: ['weapon', 'accessory'],
    stats: { damage: 3, crit: 3 },
    // Star essence is "cold to the touch" (the material def's own
    // description) — the frost type is grounded in that text.
    damageType: 'frost',
    cost: [
      { itemId: MAT_STAR_ESSENCE, count: 2 },
      { itemId: MAT_ENCHANT_DUST, count: 2 },
    ],
  },
];

/** Lookup by id (undefined for unknown ids). */
export function enchantDef(enchantId: string): EnchantDef | undefined {
  return ENCHANT_DEFS.find((d) => d.id === enchantId);
}

// ---------------------------------------------------------------- drop addons (additive)

/**
 * ADDITIVE material entries for the elite loot tables (merged by
 * loot.ts inside rollLoot — existing entries/weights/rarities are
 * untouched). Weights are small relative to the base tables so the
 * loot ladder's feel is unchanged; the rarity ladder is unchanged
 * (these are materials, not gear — no legendary anything here).
 * Bosses are brutes, so boss material rolls draw from the brute
 * entries; the boss guaranteed-gear path is untouched.
 */
export const ENCHANT_DROP_ADDONS: Record<string, readonly LootEntry[]> = {
  brute: [
    { itemId: MAT_ENCHANT_DUST, weight: 12, min: 1, max: 2 },
    { itemId: MAT_STAR_ESSENCE, weight: 6, min: 1, max: 1 },
  ],
  turret: [
    { itemId: MAT_ENCHANT_DUST, weight: 12, min: 1, max: 2 },
    { itemId: MAT_STAR_ESSENCE, weight: 8, min: 1, max: 1 },
  ],
};

// ---------------------------------------------------------------- computation

/**
 * Pure: additive enchant stats for the currently equipped loadout.
 * `equipped` maps slot -> item id; `enchants` maps item id -> enchant
 * id (Inventory's per-id enchant state). An enchant counts only when
 * its slots include the slot the item is equipped in — so an enchant
 * applied to a weapon never leaks onto armor if the same item id
 * somehow lands in another slot. Never throws.
 */
export function computeEnchantStats(
  equipped: Partial<Record<EquipSlot, string>>,
  enchants: ReadonlyMap<string, string>,
): ItemStats {
  let out: ItemStats = {};
  for (const [slot, itemId] of Object.entries(equipped)) {
    if (typeof itemId !== 'string') continue;
    const enchantId = enchants.get(itemId);
    if (!enchantId) continue;
    const def = enchantDef(enchantId);
    if (!def) continue;
    if (!def.slots.includes(slot as EquipSlot)) continue;
    out = addItemStats(out, def.stats);
  }
  return out;
}
