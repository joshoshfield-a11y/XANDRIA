/**
 * Inventory-qol wave: pure view helpers for the inventory HUD.
 *
 * Item-tier grouping, power scoring, filtering, and sorting — client-side
 * only. The backpack model keeps slot order; these project a display
 * order for the HUD. Deterministic: no Math.random/Date.now anywhere.
 */
import {
  ITEM_RARITIES,
  type ItemDef,
  type ItemRarity,
  type ItemType,
} from '@spec';
import type { Inventory, InventoryEntry } from './Inventory';

/**
 * UI-side gear tier, derived from the item-id namespace convention the
 * content waves already use: `mat_*` = tier-1 crafting ingredients
 * (gathering + loot materials), `craft_*` = crafted gear (crafting-wave
 * outputs + the loot wave's tier-2 forged outputs), everything else =
 * found (loot drops, quest items, misc). Deliberately NOT a schema field:
 * it is a display grouping only, so content contracts are untouched.
 */
export const ITEM_TIERS = ['raw', 'crafted', 'found'] as const;
export type ItemTier = (typeof ITEM_TIERS)[number];

export const ITEM_TIER_LABELS: Record<ItemTier, string> = {
  raw: 'Raw',
  crafted: 'Crafted',
  found: 'Found',
};

export function itemTierOf(itemId: string): ItemTier {
  if (itemId.startsWith('mat_')) return 'raw';
  if (itemId.startsWith('craft_')) return 'crafted';
  return 'found';
}

/** Index on the ITEM_RARITIES ladder (common=0 .. legendary=4). */
export function rarityIndex(rarity: ItemRarity | undefined): number {
  const i = ITEM_RARITIES.indexOf(rarity ?? 'common');
  return i < 0 ? 0 : i;
}

/**
 * Deterministic power score for the "power" sort: rarity weight plus the
 * sum of positive numeric stats. Documented, not a game-system value —
 * nothing in the sim reads it.
 */
export function powerScore(def: ItemDef): number {
  let s = rarityIndex(def.rarity) * 100;
  if (def.stats) {
    for (const v of Object.values(def.stats)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) s += v;
    }
  }
  return s;
}

export interface InventoryFilter {
  type: ItemType | 'all';
  rarity: ItemRarity | 'all';
  tier: ItemTier | 'all';
}

export const NO_FILTER: InventoryFilter = { type: 'all', rarity: 'all', tier: 'all' };

export type InventorySortMode = 'default' | 'rarity' | 'power' | 'newest';

export const SORT_MODE_LABELS: Record<InventorySortMode, string> = {
  default: 'Default',
  rarity: 'Rarity',
  power: 'Power',
  newest: 'Newest',
};

/** One display row: backpack slot index + its entry. */
export interface ViewSlot {
  slot: number;
  entry: InventoryEntry;
}

/**
 * Project the backpack into display order: filter first, then sort.
 * Ties always break on slot index, so the order is fully deterministic.
 */
export function applyInventoryView(
  inv: Inventory,
  filter: InventoryFilter,
  sort: InventorySortMode,
): ViewSlot[] {
  const pack = inv.getBackpack();
  const rows: ViewSlot[] = [];
  for (let slot = 0; slot < pack.length; slot++) {
    const entry = pack[slot];
    if (!entry) continue;
    const def = inv.getDef(entry.itemId);
    if (!def) continue;
    if (filter.type !== 'all' && def.type !== filter.type) continue;
    if (filter.rarity !== 'all' && (def.rarity ?? 'common') !== filter.rarity) continue;
    if (filter.tier !== 'all' && itemTierOf(entry.itemId) !== filter.tier) continue;
    rows.push({ slot, entry });
  }
  const defOf = (id: string): ItemDef => inv.getDef(id) as ItemDef;
  switch (sort) {
    case 'rarity':
      rows.sort(
        (a, b) =>
          rarityIndex(defOf(b.entry.itemId).rarity) -
            rarityIndex(defOf(a.entry.itemId).rarity) ||
          a.slot - b.slot,
      );
      break;
    case 'power':
      rows.sort(
        (a, b) =>
          powerScore(defOf(b.entry.itemId)) - powerScore(defOf(a.entry.itemId)) ||
          a.slot - b.slot,
      );
      break;
    case 'newest':
      rows.sort(
        (a, b) =>
          inv.acquiredOrder(b.entry.itemId) - inv.acquiredOrder(a.entry.itemId) ||
          a.slot - b.slot,
      );
      break;
    default:
      rows.sort((a, b) => a.slot - b.slot);
      break;
  }
  return rows;
}
