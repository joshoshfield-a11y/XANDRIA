/**
 * Items-expansion wave: enemy loot drops + tier-2 craftable gear.
 *
 * CONTENT
 * - Three enemy-drop materials (ember shard / beast hide / core fragment)
 *   — the crafting wave's brief explicitly reserved enemy drops for this
 *   wave, and tier-2 recipes consume them alongside tier-1 crafting
 *   outputs ("craftable from crafting outputs").
 * - Six direct-drop gear/consumable items on the rarity ladder
 *   (common -> legendary), wired to the existing equip slots
 *   (weapon/head/torso/legs/accessory) — equip integration is the
 *   existing Inventory.equip() path, no new UI.
 * - Three tier-2 recipes (LOOT_CATALOG_RECIPES) appended to the crafting
 *   catalog by crafting.ts — ingredients are tier-1 crafting outputs
 *   (craft_*) plus drop materials, station-gated, minLevel-gated.
 *
 * DETERMINISM: every roll derives from Rng(mapSeed ^ LOOT_SALT) — never
 * engine.rng / Math.random / Date.now. Same (mapSeed, kill sequence) ->
 * identical drops. EnemyManager resets the stream on every spawnForMap
 * (portal arrival) and lazily primes it from spec.meta.seed on the
 * initial-build spawnAll path (the portals contract: meta.seed IS this
 * map's build seed).
 *
 * CONTRACTS (owned by this wave):
 * - LOOT_SALT is distinct from ENEMY_SALT / NPC_SALT / CRAFT_SALT /
 *   STATION_SALT / GATHER_SALT (pinned by unit test).
 * - ensureLootItemDefs(spec) merges defs ONLY when spec.custom.items
 *   already exists — it never creates custom.items, preserving
 *   wireItems' null contract (item system disabled when no item tables).
 *   Idempotent, non-destructive (Studio-authored overrides win).
 * - Loot never changes NPC/enemy behavior contracts: drops roll inside
 *   the EnemyManager's existing onDeath wrapper (the die() path), behind
 *   the lootHooks opt-in. When lootHooks is null the death path is
 *   byte-identical to before.
 */
import type { GameSpec, ItemDef } from '@spec';
import { Rng } from '../core/Rng';
import { ItemBuilder } from './items/ItemBuilder';
import { SET_DROP_ADDONS } from './setBonuses';
import { ENCHANT_DROP_ADDONS } from './enchantments';
import type { CraftingRecipe } from './crafting';

/**
 * Station ids are the crafting wave's FIXED CONTRACT (crafting.ts) —
 * repeated here as literals because crafting.ts imports this module for
 * the tier-2 catalog, so a value import would be a module cycle (TDZ
 * crash at load). Sync with crafting.ts's STATION_* is pinned by unit
 * test (tests/loot.test.ts).
 */
const STATION_FORGE = 'station_forge';
const STATION_WORKBENCH = 'station_workbench';
const STATION_ALCHEMY = 'station_alchemy';

// ---------------------------------------------------------------- salts

/**
 * Salt for the loot stream off mapSeed. ('LOOT' as 0x1007 — checked
 * distinct from the other wave salts by unit test.)
 */
export const LOOT_SALT = 0x1007;

// ---------------------------------------------------------------- ids

/** FIXED CONTRACT: enemy-drop material item ids. */
export const MAT_EMBER_SHARD = 'mat_ember_shard';
export const MAT_BEAST_HIDE = 'mat_beast_hide';
export const MAT_CORE_FRAGMENT = 'mat_core_fragment';
export const LOOT_MATERIAL_IDS = [MAT_EMBER_SHARD, MAT_BEAST_HIDE, MAT_CORE_FRAGMENT] as const;

/** Direct-drop gear/consumable ids (rarity ladder common -> legendary). */
export const LOOT_GEAR_IDS = [
  'loot_ironfang_blade',
  'loot_scorched_plate',
  'loot_void_edge',
  'loot_war_helm',
  'loot_star_aegis',
  'loot_surge_tonic',
] as const;

/** Tier-2 recipe output ids (craft_* namespace, like the crafting wave). */
export const LOOT_TIER2_OUTPUT_IDS = [
  'craft_ember_blade',
  'craft_scorched_harness',
  'craft_surge_elixir',
] as const;

// ---------------------------------------------------------------- item defs

/** Enemy-drop materials — harvestable only from kills, never from nodes. */
export function lootMaterialDefs(): Record<string, ItemDef> {
  return {
    [MAT_EMBER_SHARD]: new ItemBuilder(MAT_EMBER_SHARD)
      .named('Ember Shard')
      .material()
      .rarity('uncommon')
      .stackable(999)
      .value(8)
      .description('A still-warm shard of ember-forged plating. Burns nothing; forges everything.')
      .build(),
    [MAT_BEAST_HIDE]: new ItemBuilder(MAT_BEAST_HIDE)
      .named('Beast Hide')
      .material()
      .rarity('common')
      .stackable(999)
      .value(4)
      .description('Thick hide torn from a husk-beast. Takes stitching well.')
      .build(),
    [MAT_CORE_FRAGMENT]: new ItemBuilder(MAT_CORE_FRAGMENT)
      .named('Core Fragment')
      .material()
      .rarity('uncommon')
      .stackable(999)
      .value(10)
      .description('A humming fragment of a machine core. Still faintly warm.')
      .build(),
  };
}

/**
 * Direct-drop gear: weapons/armor/consumables on the rarity ladder,
 * equippable through the existing equip slots (Inventory.equip).
 */
export function lootGearDefs(): Record<string, ItemDef> {
  return {
    loot_ironfang_blade: new ItemBuilder('loot_ironfang_blade')
      .named('Ironfang Blade')
      .weapon('weapon')
      .stat('damage', 9)
      .rarity('uncommon')
      .stackable(1)
      .value(120)
      .description('A scavenged blade with a hungry edge. Better than issue steel.')
      .build(),
    loot_scorched_plate: new ItemBuilder('loot_scorched_plate')
      .named('Scorched Plate')
      .armor('torso')
      .stat('defense', 8)
      .rarity('rare')
      .stackable(1)
      .value(200)
      .description('Battle-scorched plate, still sound. Smells of ozone.')
      .build(),
    loot_void_edge: new ItemBuilder('loot_void_edge')
      .named('Void Edge')
      .weapon('weapon')
      .stat('damage', 16)
      .stat('crit', 5)
      .rarity('epic')
      .stackable(1)
      .value(450)
      .description('An edge that drinks the light around it. Handle with respect.')
      .build(),
    loot_war_helm: new ItemBuilder('loot_war_helm')
      .named('War Helm')
      .armor('head')
      .stat('defense', 5)
      .stat('maxHealth', 10)
      .rarity('rare')
      .stackable(1)
      .value(180)
      .description('A dented war helm. The last owner does not miss it.')
      .build(),
    loot_star_aegis: new ItemBuilder('loot_star_aegis')
      .named('Starforged Aegis')
      .armor('accessory')
      .stat('defense', 10)
      .stat('maxHealth', 25)
      .rarity('legendary')
      .stackable(1)
      .value(900)
      .description('An aegis hammered from fallen star-metal. Bosses only.')
      .build(),
    loot_surge_tonic: new ItemBuilder('loot_surge_tonic')
      .named('Surge Tonic')
      .consumable()
      .behavior('heal', 50)
      .rarity('uncommon')
      .stackable(5)
      .value(30)
      .description('Fizzes like a storm. Restores 50 health.')
      .build(),
  };
}

/** Tier-2 recipe outputs — forged FROM tier-1 crafting outputs + drop materials. */
export function lootTier2OutputDefs(): Record<string, ItemDef> {
  return {
    craft_ember_blade: new ItemBuilder('craft_ember_blade')
      .named('Ember Blade')
      .weapon('weapon')
      .stat('damage', 14)
      .stat('crit', 3)
      .rarity('rare')
      .stackable(1)
      .value(320)
      .description('An Iron Edge re-forged around living ember. The forge remembers.')
      .build(),
    craft_scorched_harness: new ItemBuilder('craft_scorched_harness')
      .named('Scorched Harness')
      .armor('torso')
      .stat('defense', 7)
      .stat('maxHealth', 5)
      .rarity('rare')
      .stackable(1)
      .value(260)
      .description('A buckler grown into a full harness, hide-stitched and heat-cured.')
      .build(),
    craft_surge_elixir: new ItemBuilder('craft_surge_elixir')
      .named('Surge Elixir')
      .consumable()
      .behavior('heal', 80)
      .rarity('epic')
      .stackable(5)
      .value(90)
      .description('An Ember Tonic cut with core-light. Restores 80 health.')
      .build(),
  };
}

/** All loot-wave defs merged (materials + gear + tier-2 outputs). */
export function lootItemDefs(): Record<string, ItemDef> {
  return {
    ...lootMaterialDefs(),
    ...lootGearDefs(),
    ...lootTier2OutputDefs(),
  };
}

/**
 * Merge the loot-wave defs into spec.custom.items.defs. Idempotent and
 * non-destructive (existing defs win). NEVER creates custom.items — when
 * the spec has no item tables the item system (and loot) stays off.
 */
export function ensureLootItemDefs(spec: GameSpec): void {
  const items = spec.custom?.items;
  if (!items) return;
  items.defs = items.defs ?? {};
  const defs = items.defs;
  for (const [id, def] of Object.entries(lootItemDefs())) {
    if (defs[id] === undefined) defs[id] = def;
  }
}

// ---------------------------------------------------------------- tier-2 recipes

/**
 * Tier-2 recipe catalog entries, appended to the crafting catalog by
 * crafting.ts (kept here so the crafting wave's catalog stays the single
 * source of truth for the pool builder). Ingredients pair a tier-1
 * crafting output (craft_*) with enemy-drop materials (mat_*).
 */
export const LOOT_CATALOG_RECIPES: readonly CraftingRecipe[] = [
  {
    id: 'recipe_ember_blade',
    name: 'Ember Blade',
    ingredients: [
      { itemId: 'craft_iron_edge', count: 1 },
      { itemId: MAT_EMBER_SHARD, count: 3 },
    ],
    output: { itemId: 'craft_ember_blade', count: 1 },
    stationId: STATION_FORGE,
    minLevel: 4,
  },
  {
    id: 'recipe_scorched_harness',
    name: 'Scorched Harness',
    ingredients: [
      { itemId: 'craft_scrap_buckler', count: 1 },
      { itemId: MAT_BEAST_HIDE, count: 3 },
    ],
    output: { itemId: 'craft_scorched_harness', count: 1 },
    stationId: STATION_WORKBENCH,
    minLevel: 3,
  },
  {
    id: 'recipe_surge_elixir',
    name: 'Surge Elixir',
    ingredients: [
      { itemId: 'craft_ember_tonic', count: 1 },
      { itemId: MAT_CORE_FRAGMENT, count: 2 },
    ],
    output: { itemId: 'craft_surge_elixir', count: 2 },
    stationId: STATION_ALCHEMY,
    minLevel: 5,
  },
];

// ---------------------------------------------------------------- drop tables

export interface LootDrop {
  itemId: string;
  count: number;
}

export interface LootEntry {
  itemId: string;
  weight: number;
  min: number;
  max: number;
}

export interface LootTable {
  /** always-eligible material drops */
  materials: readonly LootEntry[];
  /** gear/consumable drops (weapons, armor, tonics) */
  gear: readonly LootEntry[];
  /** weight of the "nothing drops" outcome */
  nothing: number;
}

/**
 * Base drop tables, exported READ-ONLY for tests (do not mutate).
 * Gear-set bonus pieces merge in ADDITIVELY via SET_DROP_ADDONS in
 * rollLoot — this table's entries/weights are never modified by that
 * merge (pinned by tests/setbonuses.test.ts).
 */
export const DROP_TABLES: Record<string, LootTable> = {
  walker: {
    materials: [
      { itemId: MAT_EMBER_SHARD, weight: 40, min: 1, max: 2 },
      { itemId: MAT_BEAST_HIDE, weight: 30, min: 1, max: 2 },
    ],
    gear: [
      { itemId: 'loot_surge_tonic', weight: 12, min: 1, max: 1 },
      { itemId: 'loot_ironfang_blade', weight: 6, min: 1, max: 1 },
      { itemId: 'loot_scorched_plate', weight: 4, min: 1, max: 1 },
    ],
    nothing: 20,
  },
  brute: {
    materials: [
      { itemId: MAT_EMBER_SHARD, weight: 50, min: 1, max: 3 },
      { itemId: MAT_BEAST_HIDE, weight: 35, min: 1, max: 2 },
    ],
    gear: [
      { itemId: 'loot_surge_tonic', weight: 10, min: 1, max: 1 },
      { itemId: 'loot_ironfang_blade', weight: 8, min: 1, max: 1 },
      { itemId: 'loot_war_helm', weight: 5, min: 1, max: 1 },
      { itemId: 'loot_void_edge', weight: 3, min: 1, max: 1 },
    ],
    nothing: 10,
  },
  drone: {
    materials: [
      { itemId: MAT_CORE_FRAGMENT, weight: 45, min: 1, max: 2 },
    ],
    gear: [
      { itemId: 'loot_surge_tonic', weight: 10, min: 1, max: 1 },
      { itemId: 'loot_scorched_plate', weight: 5, min: 1, max: 1 },
    ],
    nothing: 25,
  },
  flyer: {
    materials: [
      { itemId: MAT_CORE_FRAGMENT, weight: 45, min: 1, max: 2 },
    ],
    gear: [
      { itemId: 'loot_surge_tonic', weight: 10, min: 1, max: 1 },
      { itemId: 'loot_scorched_plate', weight: 5, min: 1, max: 1 },
    ],
    nothing: 25,
  },
  turret: {
    materials: [
      { itemId: MAT_CORE_FRAGMENT, weight: 55, min: 1, max: 3 },
    ],
    gear: [
      { itemId: 'loot_surge_tonic', weight: 8, min: 1, max: 1 },
      { itemId: 'loot_war_helm', weight: 4, min: 1, max: 1 },
      { itemId: 'loot_void_edge', weight: 4, min: 1, max: 1 },
    ],
    nothing: 15,
  },
};

/** Bosses always drop epic+ gear: Void Edge or the legendary Starforged Aegis. */
const BOSS_GEAR = ['loot_void_edge', 'loot_star_aegis'] as const;

/**
 * WORLD-TIERS (upgrade loop): rarity index of each direct-drop gear id,
 * cached from the authored defs. Drives the tier weight shift below —
 * rarer gear gains weight faster as tiers climb. Legendary stays
 * boss-exclusive (boss drops never go through the weighted roll).
 */
const GEAR_RARITY_IDX: Record<string, number> = (() => {
  const idx: Record<string, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
  const out: Record<string, number> = {};
  for (const [id, def] of Object.entries(lootGearDefs())) {
    out[id] = idx[def.rarity ?? 'common'] ?? 0;
  }
  return out;
})();

/**
 * Weight multiplier for one gear entry at the given tier. Tier 1 = 1.0
 * for every entry (the authored tables, byte-identical). Higher tiers
 * boost rarer gear more: mult = 1 + (tier-1) * rarityIdx * 0.25, so at
 * tier 3 a rare drop weighs 2x and an epic 2.5x its authored weight,
 * while uncommon gear only gains 1.5x. Materials and the "nothing"
 * weight are untouched — the tier makes GOOD drops better, it never
 * makes drops more frequent.
 */
export function tierGearWeightMult(itemId: string, tier: number): number {
  const t = Number.isFinite(tier) ? Math.max(1, Math.floor(tier)) : 1;
  if (t <= 1) return 1;
  const ri = GEAR_RARITY_IDX[itemId] ?? 0;
  return 1 + (t - 1) * ri * 0.25;
}

// ---------------------------------------------------------------- bestiary surface

/**
 * BESTIARY wave (additive, read-only): expose the drop tables for the
 * codex UI. Chance percentages are computed from the SAME weights
 * rollLoot() uses, so the codex never lies about drops. Unknown kinds
 * fall back to the walker table — the same fallback the roller uses.
 * `isBoss` kills are not rolled from a table: bosses always drop one
 * epic+ gear piece plus two material rolls (BOSS_GEAR above).
 */
export interface BestiaryLootEntry {
  itemId: string;
  min: number;
  max: number;
  /** 0..100 chance this entry is the one rolled on a non-boss kill */
  chancePct: number;
}

export interface BestiaryLootTable {
  materials: readonly BestiaryLootEntry[];
  gear: readonly BestiaryLootEntry[];
}

export function lootTableForBestiary(kind: string): BestiaryLootTable {
  const t = DROP_TABLES[kind] ?? DROP_TABLES.walker;
  const all = [...t.materials, ...t.gear];
  let total = t.nothing;
  for (const e of all) total += e.weight;
  const pct = (e: LootEntry): BestiaryLootEntry => ({
    itemId: e.itemId,
    min: e.min,
    max: e.max,
    chancePct: total > 0 ? (e.weight / total) * 100 : 0,
  });
  return {
    materials: t.materials.map(pct),
    gear: t.gear.map(pct),
  };
}

/** Boss kill loot, as rolled by rollLoot(isBoss=true): guaranteed epic+ gear + 2 material rolls. */
export function bossLootForBestiary(): { gear: readonly string[]; materialRolls: number } {
  return { gear: BOSS_GEAR, materialRolls: 2 };
}

/** The seeded loot stream for one map: Rng(mapSeed ^ LOOT_SALT), never engine.rng. */
export function buildLootRng(mapSeed: number): Rng {
  return new Rng((mapSeed ^ LOOT_SALT) >>> 0);
}

function weightedPick(rng: Rng, entries: readonly LootEntry[]): LootEntry {
  let total = 0;
  for (const e of entries) total += e.weight;
  let x = rng.range(0, total);
  for (const e of entries) {
    x -= e.weight;
    if (x <= 0) return e;
  }
  return entries[entries.length - 1];
}

function toDrop(rng: Rng, e: LootEntry): LootDrop {
  return { itemId: e.itemId, count: e.max > e.min ? rng.int(e.min, e.max) : e.min };
}

/**
 * Roll one kill's loot. Pure in (rng state, kind, isBoss, tier) — the
 * caller owns the rng stream (EnemyManager keeps Rng(mapSeed ^ LOOT_SALT)).
 * Unknown kinds fall back to the walker table. Non-boss kills roll at
 * most one table entry (possibly nothing); bosses always drop one
 * epic+ gear piece plus two material rolls. Legendary drops are
 * boss-exclusive by construction.
 *
 * WORLD-TIERS: the optional tier (default 1 = identity) scales GEAR entry
 * weights via tierGearWeightMult — rarer gear gets likelier on deeper
 * maps. Tier 1 rolls are byte-identical to the pre-tier tables.
 * Gear sets wave: SET_DROP_ADDONS (setBonuses.ts) merges ADDITIVE gear
 * entries onto the base tables — the base entries, weights, and rarities
 * below are untouched by that merge (pinned by unit test). Same
 * (seed, kill sequence) -> identical drops, addon tables included.
 * Enchantments wave: ENCHANT_DROP_ADDONS (enchantments.ts) merges
 * ADDITIVE material entries onto the brute/turret tables the same way
 * (boss material rolls included — bosses are brutes).
 */
/**
 * UPGRADE LOOP (difficulty-modes): chanceMult scales the drop chance by
 * narrowing (m > 1) or widening (m < 1) the "nothing" slot of the drop
 * table only. Loot ladder tiers, item ids and per-entry weights are
 * untouched. No extra RNG draws — chanceMult = 1 is byte-identical to
 * before, and the same (rng state, chanceMult) always yields the same
 * drops. The boss guaranteed-drop path is unaffected.
 */
export function rollLoot(rng: Rng, kind: string, isBoss: boolean, tier = 1, chanceMult = 1): LootDrop[] {
  const t = DROP_TABLES[kind] ?? DROP_TABLES.walker;
  const drops: LootDrop[] = [];
  // additive only: base material entries first, enchant-material entries
  // appended (brute/turret — the elite tables; bosses are brutes, so boss
  // material rolls draw from the same merged table). Base entries,
  // weights, and rarities below are untouched by the merge.
  const materials = [...t.materials, ...(ENCHANT_DROP_ADDONS[kind] ?? [])];
  if (isBoss) {
    drops.push({ itemId: rng.pick(BOSS_GEAR), count: 1 });
    for (let i = 0; i < 2 && materials.length > 0; i++) {
      drops.push(toDrop(rng, weightedPick(rng, materials)));
    }
    return drops;
  }
  const m = Number.isFinite(chanceMult) && chanceMult >= 0 ? chanceMult : 1;
  // m = 0 means "no drops": the nothing slot is infinitely wide.
  if (m === 0) return drops;
  const nothingW = t.nothing / m;
  // additive only: base gear entries first, set-bonus entries appended
  const gear = [...t.gear, ...(SET_DROP_ADDONS[kind] ?? [])];
  const all = [...materials, ...gear];
  let total = nothingW;
  for (const e of all) total += e.weight * (t.gear.includes(e) ? tierGearWeightMult(e.itemId, tier) : 1);
  const x = rng.range(0, total);
  if (x < nothingW) return drops;
  let y = x - nothingW;
  for (const e of all) {
    y -= e.weight * (t.gear.includes(e) ? tierGearWeightMult(e.itemId, tier) : 1);
    if (y <= 0) { drops.push(toDrop(rng, e)); return drops; }
  }
  drops.push(toDrop(rng, all[all.length - 1]));
  return drops;
}
