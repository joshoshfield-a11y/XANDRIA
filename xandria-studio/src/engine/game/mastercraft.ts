/**
 * Master-crafting wave: tier-3 "master" recipes gated at skill rank 3.
 *
 * CONTENT
 * - Four master recipes (MASTER_CATALOG_RECIPES), appended to the
 *   crafting catalog by crafting.ts — the skills wave disclosed that
 *   rank-3 content was thin (only Alloy Greaves; alchemy had no rank-3
 *   gate). Each master recipe is gated at minSkillRank 3 on one of the
 *   three skills (smithing x2, alchemy x1, foraging x1), using the
 *   existing skill-gate machinery — additive only, check order and the
 *   loot ladder are untouched.
 * - Ingredients pair a tier-2 crafting output (craft_ember_blade /
 *   craft_scorched_harness / craft_surge_elixir) with boss-loot materials
 *   (mat_ember_shard / mat_beast_hide / mat_core_fragment — the
 *   items-expansion wave's enemy-drop ids); the foraging master uses
 *   tier-1 outputs + loot materials and needs no station.
 * - Master-tier stat bands sit honestly above tier-2:
 *   Starfall Warbrand (18 dmg / 6 crit) beats Ember Blade (14 / 3) and
 *   the epic direct-drop Void Edge (16 / 5); Dragonscale Aegis
 *   (11 def / +10 maxHealth) beats every crafted armor piece below it;
 *   Primordial Draught (heal 150) beats Surge Elixir (heal 80);
 *   Wildheart Regalia (+20 maxHealth / 6 def accessory) beats the
 *   Scrap Buckler (2 def). All epic — they never touch the loot ladder
 *   (legendary stays boss-drop exclusive).
 *
 * DETERMINISM: no RNG in this module. The recipes are fixed catalog
 * entries; ingredient/output ids are stable content references.
 *
 * CONTRACTS (owned by this wave):
 * - Station ids repeat the crafting wave's literals (station_forge /
 *   station_alchemy) because crafting.ts imports this module for the
 *   master catalog — a value import of crafting's STATION_* constants
 *   would be a module cycle (same reason loot.ts repeats them).
 * - Loot material ids ARE value-imported from loot.ts: loot.ts only
 *   type-imports crafting.ts, so crafting -> mastercraft -> loot has no
 *   runtime cycle.
 * - Master recipes ride buildRecipePool's always-include rule for
 *   minSkillRank-3 recipes (see crafting.ts): earning rank 3 always
 *   unlocks them regardless of the seeded subset.
 */
import type { ItemDef } from '@spec';
import { Rng } from '../core/Rng';
import { ItemBuilder } from './items/ItemBuilder';
import {
  MAT_EMBER_SHARD,
  MAT_BEAST_HIDE,
  MAT_CORE_FRAGMENT,
} from './loot';
import type { CraftingRecipe } from './crafting';

// ---------------------------------------------------------------- ids

/** Station ids are the crafting wave's FIXED CONTRACT — repeated as
 *  literals to avoid a crafting <-> mastercraft module cycle (see above). */
const STATION_FORGE = 'station_forge';
const STATION_ALCHEMY = 'station_alchemy';

/** Tier-3 recipe output ids (craft_* namespace, like the other waves). */
export const MASTER_TIER3_OUTPUT_IDS = [
  'craft_starfall_warbrand',
  'craft_dragonscale_aegis',
  'craft_primordial_draught',
  'craft_wildheart_regalia',
] as const;

// ---------------------------------------------------------------- item defs

/**
 * Tier-3 recipe outputs. Stat bands are set honestly above the tier-2
 * outputs (lootTier2OutputDefs) and the tier-1 crafting outputs; rarity
 * caps at epic so legendary stays boss-drop exclusive on the loot ladder.
 */
export function masterTier3OutputDefs(): Record<string, ItemDef> {
  return {
    craft_starfall_warbrand: new ItemBuilder('craft_starfall_warbrand')
      .named('Starfall Warbrand')
      .weapon('weapon')
      .stat('damage', 18)
      .stat('crit', 6)
      .rarity('epic')
      .stackable(1)
      .value(700)
      .description('An Ember Blade re-forged around a machine core. The edge hums in the dark.')
      .build(),
    craft_dragonscale_aegis: new ItemBuilder('craft_dragonscale_aegis')
      .named('Dragonscale Aegis')
      .armor('legs')
      .stat('defense', 11)
      .stat('maxHealth', 10)
      .rarity('epic')
      .stackable(1)
      .value(620)
      .description('Hide-stitched leg plates cured around core-light. Master smith work.')
      .build(),
    craft_primordial_draught: new ItemBuilder('craft_primordial_draught')
      .named('Primordial Draught')
      .consumable()
      .behavior('heal', 150)
      .rarity('epic')
      .stackable(5)
      .value(220)
      .description('A Surge Elixir folded over living ember. Restores 150 health.')
      .build(),
    craft_wildheart_regalia: new ItemBuilder('craft_wildheart_regalia')
      .named('Wildheart Regalia')
      .armor('accessory')
      .stat('defense', 6)
      .stat('maxHealth', 20)
      .rarity('epic')
      .stackable(1)
      .value(480)
      .description('Beast-hide regalia bound with trail-craft. The wilds approve.')
      .build(),
  };
}

// ---------------------------------------------------------------- tier-3 recipes

/**
 * Tier-3 recipe catalog entries, appended to the crafting catalog by
 * crafting.ts (kept here so the crafting wave's catalog stays the single
 * source of truth for the pool builder). All minSkillRank 3 — the
 * existing skill-gate machinery + buildRecipePool's master always-include
 * rule do the rest; no check-order changes.
 */
export const MASTER_CATALOG_RECIPES: readonly CraftingRecipe[] = [
  {
    id: 'recipe_starfall_warbrand',
    name: 'Starfall Warbrand',
    ingredients: [
      { itemId: 'craft_ember_blade', count: 1 },
      { itemId: MAT_CORE_FRAGMENT, count: 3 },
      { itemId: MAT_EMBER_SHARD, count: 2 },
    ],
    output: { itemId: 'craft_starfall_warbrand', count: 1 },
    stationId: STATION_FORGE,
    skillId: 'smithing',
    minSkillRank: 3,
  },
  {
    id: 'recipe_dragonscale_aegis',
    name: 'Dragonscale Aegis',
    ingredients: [
      { itemId: 'craft_scorched_harness', count: 1 },
      { itemId: MAT_BEAST_HIDE, count: 4 },
      { itemId: MAT_CORE_FRAGMENT, count: 2 },
    ],
    output: { itemId: 'craft_dragonscale_aegis', count: 1 },
    stationId: STATION_FORGE,
    skillId: 'smithing',
    minSkillRank: 3,
  },
  {
    id: 'recipe_primordial_draught',
    name: 'Primordial Draught',
    ingredients: [
      { itemId: 'craft_surge_elixir', count: 2 },
      { itemId: MAT_CORE_FRAGMENT, count: 2 },
      { itemId: MAT_EMBER_SHARD, count: 2 },
    ],
    output: { itemId: 'craft_primordial_draught', count: 1 },
    stationId: STATION_ALCHEMY,
    skillId: 'alchemy',
    minSkillRank: 3,
  },
  {
    id: 'recipe_wildheart_regalia',
    name: 'Wildheart Regalia',
    ingredients: [
      { itemId: 'craft_grip_wrap', count: 1 },
      { itemId: 'craft_trail_mix', count: 3 },
      { itemId: MAT_BEAST_HIDE, count: 4 },
    ],
    output: { itemId: 'craft_wildheart_regalia', count: 1 },
    // no stationId: foragers wildcraft with their hands
    skillId: 'foraging',
    minSkillRank: 3,
  },
];

// ---------------------------------------------------------------- salt (reserved)

/**
 * Salt reserved for the master-crafting stream off spec.meta.seed,
 * in case a future wave needs seeded master content (placement, pools).
 * Checked distinct from the other wave salts by unit test.
 */
export const MASTER_SALT = 0x1a57e7;

/** MASTER_SALT is a pure numeric constant — exported for the salt-distinctness test. */
export function buildMasterRng(mapSeed: number): Rng {
  return new Rng((mapSeed ^ MASTER_SALT) >>> 0);
}
