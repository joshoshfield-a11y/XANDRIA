/**
 * Crafting wave (workstream A): recipe registry, seeded recipe pool, and
 * the atomic craft() transaction.
 *
 * CONTRACTS (owned by this workstream — do not rename without coordinating
 * workstreams B and C):
 * - Material item ids: `mat_ore`, `mat_fiber`, `mat_scrap` (workstream B
 *   harvests these exact ids; defined here via ItemBuilder .material()).
 * - Station ids: `station_workbench`, `station_anvil`, `station_forge`,
 *   `station_alchemy` (workstream C places world stations with these ids;
 *   recipes reference them via recipe.stationId).
 *
 * DETERMINISM: everything seeded derives from spec.meta.seed via Rng —
 * never Math.random / Date.now. buildRecipePool(spec) is a pure function
 * of (spec.meta.seed, spec.custom.crafting.recipes.poolSize).
 *
 * craft() is validate -> consume -> grant, ATOMIC:
 * - all failure paths run before any inventory mutation;
 * - the only post-consume failure is output overflow (full backpack), which
 *   rolls the consumed ingredients back in, so a failed craft never
 *   partially consumes.
 *
 * Check order (documented so the Studio UI can mirror it):
 *   crafting-disabled -> recipe-not-found -> unknown-output /
 *   unknown-ingredient -> min-level -> missing-skill -> missing-station ->
 *   missing-ingredients -> no-room
 *
 * NPC/enemy behavior contracts are untouched; blueprints, npcInteraction.ts
 * and npcInstancing.ts are untouched.
 */
import type { GameSpec, ItemDef } from '@spec';
import { Rng } from '../core/Rng';
import { ItemBuilder } from './items/ItemBuilder';
import { LOOT_CATALOG_RECIPES, lootTier2OutputDefs } from './loot';
import { MASTER_CATALOG_RECIPES, masterTier3OutputDefs } from './mastercraft';
import { SET_CATALOG_RECIPES, setCraftedOutputDefs } from './setBonuses';
/**
 * UPGRADE LOOP (deployables): deployable field-item recipes + item defs
 * (campfire / spike trap / lure totem). Additive: the catalog append and
 * the item-def merge below are the only touch points.
 */
import { DEPLOY_CATALOG_RECIPES, deployableItemDefs } from './deployables';
import type { SkillsLike } from './skills';

// ---------------------------------------------------------------- salts

/** Salt for the recipe-pool stream off spec.meta.seed. Distinct from
 *  ENEMY_SALT / NPC_SALT / POI_SALT / STRUCTURE_CHUNK_SALT. */
export const CRAFT_SALT = 0xc0a57;

// ---------------------------------------------------------------- ids

/** FIXED CONTRACT (workstream B): material item ids harvested from nodes. */
export const MAT_ORE = 'mat_ore';
export const MAT_FIBER = 'mat_fiber';
export const MAT_SCRAP = 'mat_scrap';
/** UPGRADE LOOP (gathering-nodes): herb-patch + crystal-cluster materials. */
export const MAT_HERB = 'mat_herb';
export const MAT_CRYSTAL = 'mat_crystal';
export const MATERIAL_IDS = [MAT_ORE, MAT_FIBER, MAT_SCRAP, MAT_HERB, MAT_CRYSTAL] as const;

/**
 * FIXED CONTRACT (workstream C): station entity ids. Recipe.stationId must
 * match a station id C places in the world; a recipe with no stationId is
 * hand-crafted anywhere.
 */
export const STATION_WORKBENCH = 'station_workbench';
export const STATION_ANVIL = 'station_anvil';
export const STATION_FORGE = 'station_forge';
export const STATION_ALCHEMY = 'station_alchemy';
export const STATION_IDS = [
  STATION_WORKBENCH,
  STATION_ANVIL,
  STATION_FORGE,
  STATION_ALCHEMY,
] as const;

// ---------------------------------------------------------------- config defaults

export const DEFAULT_CRAFTING_ENABLED = true;
/** Studio GATHERING DENSITY slider range (workstream C writes it directly). */
export const DEFAULT_GATHERING_DENSITY = 100;
export const DEFAULT_RECIPE_POOL_SIZE = 8;

// ---------------------------------------------------------------- recipes

export interface RecipeIngredient {
  itemId: string;
  count: number;
}

export interface RecipeOutput {
  itemId: string;
  count: number;
}

export interface CraftingRecipe {
  /** stable recipe id, e.g. 'recipe_iron_edge' */
  id: string;
  /** display name for the recipe list UI */
  name: string;
  ingredients: RecipeIngredient[];
  output: RecipeOutput;
  /** required station id (one of STATION_IDS); undefined = hand-crafted anywhere */
  stationId?: string;
  /** progression level gate; undefined = no gate */
  minLevel?: number;
  /**
   * Skills wave: skill-gated recipes key off this id (one of the
   * SKILL_IDS in engine/game/skills.ts — 'foraging' / 'smithing' /
   * 'alchemy'). checkCraft() fails closed with 'missing-skill' when the
   * player's rank is below minSkillRank (default 1). Undefined = no gate.
   */
  skillId?: string;
  /** required skill rank for skillId-gated recipes; default 1 */
  minSkillRank?: number;
  /**
   * UPGRADE LOOP (deployables): recipes flagged here always land in the
   * seeded pool (like the minSkillRank-3 master rule below) — utility
   * recipes the seeded subset must never lock out.
   */
  alwaysInPool?: boolean;
}

/**
 * The fixed recipe catalog. The seeded pool is a deterministic subset of
 * this table (see buildRecipePool) — the catalog itself never changes at
 * runtime, so recipe ids are stable content references for B/C/e2e.
 */
const BASE_RECIPE_CATALOG: readonly CraftingRecipe[] = [
  {
    id: 'recipe_field_kit',
    name: 'Field Repair Kit',
    ingredients: [
      { itemId: MAT_SCRAP, count: 2 },
      { itemId: MAT_FIBER, count: 1 },
    ],
    output: { itemId: 'craft_field_kit', count: 1 },
  },
  {
    id: 'recipe_iron_edge',
    name: 'Iron Edge',
    ingredients: [
      { itemId: MAT_ORE, count: 3 },
      { itemId: MAT_SCRAP, count: 1 },
    ],
    output: { itemId: 'craft_iron_edge', count: 1 },
    stationId: STATION_ANVIL,
    minLevel: 2,
    skillId: 'smithing',
    minSkillRank: 2,
  },
  {
    id: 'recipe_fiber_weave',
    name: 'Fiber Weave Vest',
    ingredients: [{ itemId: MAT_FIBER, count: 4 }],
    output: { itemId: 'craft_fiber_weave', count: 1 },
    // MERGE (deployables x tutorial): the seeded pool is a shuffle of the
    // full catalog, so appending recipes re-shuffles every seed's pool —
    // the tutorial's equip step (craft gear when no drop) soft-locked on
    // seeds whose pool held no level-1 craftable equippable. The basic
    // armor must never be locked out, like the master rank-3 rule.
    alwaysInPool: true,
  },
  {
    id: 'recipe_scrap_buckler',
    name: 'Scrap Buckler',
    ingredients: [
      { itemId: MAT_SCRAP, count: 3 },
      { itemId: MAT_ORE, count: 1 },
    ],
    output: { itemId: 'craft_scrap_buckler', count: 1 },
    stationId: STATION_WORKBENCH,
    skillId: 'smithing',
    minSkillRank: 1,
  },
  {
    id: 'recipe_ember_tonic',
    name: 'Ember Tonic',
    ingredients: [
      { itemId: MAT_ORE, count: 2 },
      { itemId: MAT_FIBER, count: 2 },
    ],
    output: { itemId: 'craft_ember_tonic', count: 1 },
    stationId: STATION_ALCHEMY,
    minLevel: 3,
    skillId: 'alchemy',
    minSkillRank: 2,
  },
  {
    id: 'recipe_spark_charge',
    name: 'Spark Charge',
    ingredients: [
      { itemId: MAT_SCRAP, count: 2 },
      { itemId: MAT_ORE, count: 2 },
    ],
    output: { itemId: 'craft_spark_charge', count: 1 },
    stationId: STATION_FORGE,
    skillId: 'smithing',
    minSkillRank: 1,
  },
  {
    id: 'recipe_grip_wrap',
    name: 'Grip Wrap',
    ingredients: [
      { itemId: MAT_FIBER, count: 3 },
      { itemId: MAT_SCRAP, count: 2 },
    ],
    output: { itemId: 'craft_grip_wrap', count: 1 },
    stationId: STATION_WORKBENCH,
    minLevel: 2,
    skillId: 'smithing',
    minSkillRank: 1,
  },
  {
    id: 'recipe_alloy_greaves',
    name: 'Alloy Greaves',
    ingredients: [{ itemId: MAT_ORE, count: 4 }],
    output: { itemId: 'craft_alloy_greaves', count: 1 },
    stationId: STATION_FORGE,
    skillId: 'smithing',
    minSkillRank: 3,
  },
  {
    id: 'recipe_trail_mix',
    name: 'Trail Mix',
    ingredients: [{ itemId: MAT_FIBER, count: 5 }],
    output: { itemId: 'craft_trail_mix', count: 2 },
  },
  {
    id: 'recipe_whetstone',
    name: 'Whetstone',
    ingredients: [
      { itemId: MAT_SCRAP, count: 1 },
      { itemId: MAT_ORE, count: 1 },
    ],
    output: { itemId: 'craft_whetstone', count: 1 },
  },
];

/**
 * Items-expansion wave: tier-2 recipes (forged from tier-1 crafting
 * outputs + enemy-drop materials) ride the same seeded pool. Appended
 * after the base catalog so smaller pools stay exact prefixes of larger
 * ones for the same seed (the prefix property the tests pin).
 *
 * Master-crafting wave: tier-3 recipes (minSkillRank 3) are appended
 * after the tier-2 entries. They also ride buildRecipePool's
 * master always-include rule (below), so earning rank 3 always unlocks
 * them regardless of the seeded subset.
 */
const RECIPE_CATALOG: readonly CraftingRecipe[] = [
  ...BASE_RECIPE_CATALOG,
  ...LOOT_CATALOG_RECIPES,
  ...MASTER_CATALOG_RECIPES,
  // Gear sets wave: one additive master recipe for the Masterforged
  // crown (smithing 3). Catalog check order and the minSkillRank-3
  // always-include rule are untouched.
  ...SET_CATALOG_RECIPES,
  // UPGRADE LOOP (deployables): field-item recipes ride the same seeded
  // pool via alwaysInPool (below) — appended last so smaller pools stay
  // exact prefixes of larger ones for the same seed (the prefix property
  // the tests pin).
  ...DEPLOY_CATALOG_RECIPES,
  // UPGRADE LOOP (gathering-nodes): sinks for the two new node materials.
  // alwaysInPool (the deployables pattern) so the seeded subset is never
  // the reason a herb/crystal recipe is missing.
  {
    id: 'recipe_herb_poultice',
    name: 'Herb Poultice',
    ingredients: [
      { itemId: MAT_HERB, count: 3 },
      { itemId: MAT_FIBER, count: 1 },
    ],
    output: { itemId: 'craft_herb_poultice', count: 2 },
    stationId: STATION_ALCHEMY,
    alwaysInPool: true,
  },
  {
    id: 'recipe_crystal_lens',
    name: 'Crystal Lens',
    ingredients: [
      { itemId: MAT_CRYSTAL, count: 2 },
      { itemId: MAT_ORE, count: 1 },
    ],
    output: { itemId: 'craft_crystal_lens', count: 1 },
    stationId: STATION_FORGE,
    alwaysInPool: true,
  },
];

/** Catalog length — poolSize clamps to 1..this. */
export const RECIPE_CATALOG_SIZE = RECIPE_CATALOG.length;

/**
 * Build the seeded recipe pool for a spec. Pure function of
 * (spec.meta.seed, poolSize): shuffles the fixed catalog with
 * Rng(seed).fork(CRAFT_SALT) and takes the first poolSize entries.
 * Same GameSpec -> identical pool (ids, order, contents). Returned
 * recipes are deep copies — mutating them never affects the catalog or
 * a later build.
 *
 * Master-crafting wave: recipes with minSkillRank 3 (the master tier,
 * incl. Alloy Greaves) are appended after the seeded subset, deduped —
 * earning rank 3 always puts them in the pool no matter which seeded
 * subset a spec drew. The seeded prefix property is preserved (smaller
 * pools are still exact prefixes of larger ones for the same seed).
 */
export function buildRecipePool(spec: GameSpec): CraftingRecipe[] {
  const rawSize = spec.custom?.crafting?.recipes?.poolSize;
  const poolSize =
    Number.isFinite(rawSize)
      ? Math.max(1, Math.min(RECIPE_CATALOG_SIZE, Math.floor(rawSize as number)))
      : DEFAULT_RECIPE_POOL_SIZE;
  const rng = new Rng(spec.meta.seed).fork(CRAFT_SALT);
  const order = rng.shuffle(RECIPE_CATALOG.map((r) => r.id));
  const byId = new Map(RECIPE_CATALOG.map((r) => [r.id, r]));
  const pool = order.slice(0, poolSize).map((id) => {
    const r = byId.get(id) as CraftingRecipe;
    return {
      ...r,
      ingredients: r.ingredients.map((i) => ({ ...i })),
      output: { ...r.output },
    };
  });
  // Master always-include: rank-3-gated recipes are never locked out by
  // the seeded subset (dedup by id; deep copies like the rest).
  // UPGRADE LOOP (deployables): alwaysInPool-flagged recipes (utility
  // field-item kits) ride the same rule.
  const seen = new Set(pool.map((r) => r.id));
  for (const r of RECIPE_CATALOG) {
    if (((r.minSkillRank ?? 0) >= 3 || r.alwaysInPool) && !seen.has(r.id)) {
      seen.add(r.id);
      pool.push({
        ...r,
        ingredients: r.ingredients.map((i) => ({ ...i })),
        output: { ...r.output },
      });
    }
  }
  return pool;
}

// ---------------------------------------------------------------- item defs

/**
 * The three contract material items (workstream B harvest yields).
 * Built via ItemBuilder .material(); stackable to 999.
 */
export function materialItemDefs(): Record<string, ItemDef> {
  return {
    [MAT_ORE]: new ItemBuilder(MAT_ORE)
      .named('Iron Ore')
      .material()
      .rarity('common')
      .stackable(999)
      .value(2)
      .description('Raw ore pried from a vein. Smelts into workable iron.')
      .build(),
    [MAT_FIBER]: new ItemBuilder(MAT_FIBER)
      .named('Plant Fiber')
      .material()
      .rarity('common')
      .stackable(999)
      .value(1)
      .description('Tough plant fiber. Binds, wraps, and weaves.')
      .build(),
    [MAT_SCRAP]: new ItemBuilder(MAT_SCRAP)
      .named('Salvage Scrap')
      .material()
      .rarity('common')
      .stackable(999)
      .value(3)
      .description('Bent plates and dead circuitry. Still useful.')
      .build(),
    // UPGRADE LOOP (gathering-nodes): the two new node materials.
    [MAT_HERB]: new ItemBuilder(MAT_HERB)
      .named('Wild Herbs')
      .material()
      .rarity('common')
      .stackable(999)
      .value(2)
      .description('Bitter leaves from a herb patch. Brewable.')
      .build(),
    [MAT_CRYSTAL]: new ItemBuilder(MAT_CRYSTAL)
      .named('Amber Crystal')
      .material()
      .rarity('uncommon')
      .stackable(999)
      .value(8)
      .description('A shard pried from a crystal cluster. Hums faintly.')
      .build(),
  };
}

/**
 * Item defs for every recipe output in the catalog. Callers merge these
 * (with materialItemDefs) into the item tables before crafting runs —
 * see ensureCraftingItemDefs. Items-expansion: includes the tier-2
 * outputs (lootTier2OutputDefs) so the tier-2 recipes validate.
 * Master-crafting: includes the tier-3 outputs (masterTier3OutputDefs)
 * so the master recipes validate.
 */
export function craftedItemDefs(): Record<string, ItemDef> {
  return {
    ...lootTier2OutputDefs(),
    ...masterTier3OutputDefs(),
    // Gear sets wave: the Masterforged crown output def (additive).
    ...setCraftedOutputDefs(),
    // UPGRADE LOOP (deployables): the three crafted field-item kits.
    ...deployableItemDefs(),
    craft_field_kit: new ItemBuilder('craft_field_kit')
      .named('Field Repair Kit')
      .consumable()
      .behavior('heal', 35)
      .rarity('common')
      .stackable(5)
      .value(12)
      .description('Patches you up in the field. Restores 35 health.')
      .build(),
    craft_iron_edge: new ItemBuilder('craft_iron_edge')
      .named('Iron Edge')
      .weapon('weapon')
      .stat('damage', 6)
      .rarity('uncommon')
      .value(45)
      .description('A crude but honest blade, hammered at the anvil.')
      .build(),
    craft_fiber_weave: new ItemBuilder('craft_fiber_weave')
      .named('Fiber Weave Vest')
      .armor('torso')
      .stat('defense', 4)
      .rarity('common')
      .value(20)
      .description('Layered fiber padding. Light, quiet, better than nothing.')
      .build(),
    craft_scrap_buckler: new ItemBuilder('craft_scrap_buckler')
      .named('Scrap Buckler')
      .armor('accessory')
      .stat('defense', 2)
      .rarity('common')
      .value(18)
      .description('A dinner-plate shield, more or less.')
      .build(),
    craft_ember_tonic: new ItemBuilder('craft_ember_tonic')
      .named('Ember Tonic')
      .consumable()
      .behavior('buff', 20, 60)
      .rarity('uncommon')
      .stackable(5)
      .value(30)
      .description('Burns going down. +20% damage for 60 seconds.')
      .build(),
    craft_spark_charge: new ItemBuilder('craft_spark_charge')
      .named('Spark Charge')
      .consumable()
      .behavior('buff', 15, 30)
      .rarity('uncommon')
      .stackable(5)
      .value(28)
      .description('Overclocks your reflexes. +15% crit for 30 seconds.')
      .build(),
    craft_grip_wrap: new ItemBuilder('craft_grip_wrap')
      .named('Grip Wrap')
      .trinket()
      .stat('attackSpeed', 5)
      .rarity('uncommon')
      .value(32)
      .description('Fiber-and-scrap wrap. Swings come a little faster.')
      .build(),
    craft_alloy_greaves: new ItemBuilder('craft_alloy_greaves')
      .named('Alloy Greaves')
      .armor('legs')
      .stat('defense', 5)
      .rarity('uncommon')
      .value(40)
      .description('Forge-poured leg plates. Heavy, but they hold.')
      .build(),
    craft_trail_mix: new ItemBuilder('craft_trail_mix')
      .named('Trail Mix')
      .consumable()
      .behavior('heal', 15)
      .rarity('common')
      .stackable(10)
      .value(6)
      .description('Dried fiber-fruit and grit. Restores 15 health.')
      .build(),
    craft_whetstone: new ItemBuilder('craft_whetstone')
      .named('Whetstone')
      .consumable()
      .behavior('buff', 10, 45)
      .rarity('common')
      .stackable(5)
      .value(10)
      .description('Puts a keener edge on your next swings. +10% attack speed for 45 seconds.')
      .build(),
    // UPGRADE LOOP (gathering-nodes): outputs for the herb/crystal recipes.
    craft_herb_poultice: new ItemBuilder('craft_herb_poultice')
      .named('Herb Poultice')
      .consumable()
      .behavior('heal', 25)
      .rarity('common')
      .stackable(10)
      .value(8)
      .description('Pounded herbs in a fiber wrap. Restores 25 health.')
      .build(),
    craft_crystal_lens: new ItemBuilder('craft_crystal_lens')
      .named('Crystal Lens')
      .trinket()
      .stat('damage', 2)
      .rarity('uncommon')
      .value(60)
      .description('A focused amber lens. Your strikes bite a little deeper.')
      .build(),
  };
}

/**
 * Merge the crafting material + output defs into spec.custom.items.defs
 * (creating custom/items when absent). Idempotent and non-destructive:
 * existing defs are never overwritten, so Studio-authored overrides win.
 * Call this when resolveCraftingEnabled(spec) is true, before wireItems —
 * it is the data-side wiring workstream A owns (editorPanel.ts is C's).
 */
export function ensureCraftingItemDefs(spec: GameSpec): void {
  spec.custom = spec.custom ?? {};
  spec.custom.items = spec.custom.items ?? {};
  spec.custom.items.defs = spec.custom.items.defs ?? {};
  const defs = spec.custom.items.defs;
  for (const [id, def] of Object.entries({
    ...materialItemDefs(),
    ...craftedItemDefs(),
  })) {
    if (defs[id] === undefined) defs[id] = def;
  }
}

// ---------------------------------------------------------------- resolvers (pure)

/** Master crafting toggle: spec.custom.crafting.enabled, default true. */
export function resolveCraftingEnabled(spec: GameSpec): boolean {
  return spec.custom?.crafting?.enabled ?? DEFAULT_CRAFTING_ENABLED;
}

/**
 * Gathering density as a 0..1 fraction (Studio slider is 0..100).
 * Pure function — no randomness, no engine access. Workstream B applies
 * it on the portal-arrival spawn path (same contract as npc/enemy density).
 */
export function resolveGatheringDensity(spec: GameSpec): number {
  const raw = spec.custom?.crafting?.gathering?.density;
  const d = Number.isFinite(raw) ? (raw as number) : DEFAULT_GATHERING_DENSITY;
  return Math.min(100, Math.max(0, d)) / 100;
}

// ---------------------------------------------------------------- craft()

export type CraftFailureReason =
  | 'crafting-disabled'
  | 'recipe-not-found'
  | 'unknown-output'
  | 'unknown-ingredient'
  | 'min-level'
  | 'missing-skill'
  | 'missing-station'
  | 'missing-ingredients'
  | 'no-room';

export interface CraftMissing {
  itemId: string;
  need: number;
  have: number;
}

export interface CraftResult {
  ok: boolean;
  recipeId: string;
  reason?: CraftFailureReason;
  /** human-readable failure detail (for the recipe UI states) */
  detail?: string;
  /** per-ingredient shortfall; present on missing-ingredients */
  missing?: CraftMissing[];
  /** what was consumed on success */
  consumed?: RecipeIngredient[];
  /** what was granted on success */
  granted?: RecipeOutput;
}

export interface CraftOptions {
  /**
   * The inventory to craft from/to. Needs add/remove/count — the shared
   * InventoryLike is add-only, so this narrower interface is declared here
   * instead of widening the items wave's contract. `Inventory` satisfies it
   * structurally.
   */
  inventory: CraftingInventory;
  /** item def table — must include the recipe output + ingredient ids */
  defs: Record<string, ItemDef>;
  /** from resolveCraftingEnabled(spec); default true */
  enabled?: boolean;
  /** player progression level for minLevel gates; default 0 */
  playerLevel?: number;
  /**
   * skill ranks for skillId-gated recipes (engine/game/skills SkillsLike).
   * Omitted = rank 0, so skill-gated recipes fail closed with
   * 'missing-skill'. Ungated recipes are unaffected.
   */
  skills?: SkillsLike;
  /**
   * station ids present in this map (workstream C supplies these).
   * A recipe with stationId fails closed ('missing-station') when its
   * station is absent — including when `stations` is omitted entirely.
   */
  stations?: ReadonlySet<string> | ((id: string) => boolean);
}

/**
 * Minimal inventory surface craft() needs. `Inventory`
 * (engine/game/items/Inventory) satisfies this structurally.
 */
export interface CraftingInventory {
  /** add items; returns leftover that did not fit (0 = all fit) */
  add(itemId: string, count?: number): number;
  /** remove up to count units; returns the number actually removed */
  remove(itemId: string, count?: number): number;
  /** total units of an item */
  count(itemId: string): number;
}

function hasStation(
  stations: CraftOptions['stations'],
  id: string,
): boolean {
  if (!stations) return false;
  return typeof stations === 'function' ? stations(id) : stations.has(id);
}

function fail(
  recipeId: string,
  reason: CraftFailureReason,
  detail: string,
  missing?: CraftMissing[],
): CraftResult {
  return { ok: false, recipeId, reason, detail, missing };
}

/**
 * checkCraft — the pure validation half of craft(): same check order,
 * no inventory mutation. Workstream C's recipe list panel uses this for
 * the available vs missing-ingredients states.
 */
export function checkCraft(
  pool: readonly CraftingRecipe[],
  recipeId: string,
  opts: CraftOptions,
): CraftResult {
  const enabled = opts.enabled ?? DEFAULT_CRAFTING_ENABLED;
  if (!enabled) {
    return fail(recipeId, 'crafting-disabled', 'Crafting is disabled for this spec.');
  }
  const recipe = pool.find((r) => r.id === recipeId);
  if (!recipe) {
    return fail(recipeId, 'recipe-not-found', `Recipe "${recipeId}" is not in this spec's pool.`);
  }
  if (!opts.defs[recipe.output.itemId]) {
    return fail(
      recipeId,
      'unknown-output',
      `Output item "${recipe.output.itemId}" has no item def — content problem, not a player problem.`,
    );
  }
  for (const ing of recipe.ingredients) {
    if (!opts.defs[ing.itemId]) {
      return fail(
        recipeId,
        'unknown-ingredient',
        `Ingredient "${ing.itemId}" has no item def — content problem, not a player problem.`,
      );
    }
  }
  const level = opts.playerLevel ?? 0;
  if (recipe.minLevel !== undefined && level < recipe.minLevel) {
    return fail(
      recipeId,
      'min-level',
      `Requires level ${recipe.minLevel} (player is ${level}).`,
    );
  }
  if (recipe.skillId !== undefined) {
    const reqRank = recipe.minSkillRank ?? 1;
    const haveRank = opts.skills ? opts.skills.rankOf(recipe.skillId) : 0;
    if (haveRank < reqRank) {
      const skillName = opts.skills ? opts.skills.skillName(recipe.skillId) : recipe.skillId;
      return fail(
        recipeId,
        'missing-skill',
        `Requires ${skillName} rank ${reqRank} (you are rank ${haveRank}).`,
      );
    }
  }
  if (recipe.stationId !== undefined && !hasStation(opts.stations, recipe.stationId)) {
    return fail(
      recipeId,
      'missing-station',
      `Requires a ${recipe.stationId} nearby.`,
    );
  }
  const missing: CraftMissing[] = [];
  for (const ing of recipe.ingredients) {
    const have = opts.inventory.count(ing.itemId);
    if (have < ing.count) missing.push({ itemId: ing.itemId, need: ing.count, have });
  }
  if (missing.length > 0) {
    const detail = missing
      .map((m) => `${m.itemId}: need ${m.need}, have ${m.have}`)
      .join('; ');
    return fail(recipeId, 'missing-ingredients', `Missing ingredients — ${detail}.`, missing);
  }
  return { ok: true, recipeId };
}

/**
 * craft — the atomic transaction: validate (checkCraft) -> consume all
 * ingredients -> grant the output. The only post-consume failure is a
 * full backpack, which rolls the ingredients back in, so a failed craft
 * never leaves a partial consume behind.
 */
export function craft(
  pool: readonly CraftingRecipe[],
  recipeId: string,
  opts: CraftOptions,
): CraftResult {
  const verdict = checkCraft(pool, recipeId, opts);
  if (!verdict.ok) return verdict;
  const recipe = pool.find((r) => r.id === recipeId) as CraftingRecipe;

  const consumed: RecipeIngredient[] = [];
  for (const ing of recipe.ingredients) {
    const removed = opts.inventory.remove(ing.itemId, ing.count);
    consumed.push({ itemId: ing.itemId, count: removed });
    if (removed < ing.count) {
      // Cannot happen: checkCraft just counted enough, and nothing runs
      // between the check and here in a single-threaded engine. If it
      // ever does, roll back what we took and fail honestly.
      for (const c of consumed) opts.inventory.add(c.itemId, c.count);
      return fail(
        recipeId,
        'missing-ingredients',
        `Ingredients changed mid-craft; rolled back.`,
      );
    }
  }

  const granted: RecipeOutput = { ...recipe.output };
  const leftover = opts.inventory.add(granted.itemId, granted.count);
  if (leftover > 0) {
    // Backpack full: roll the ingredients back in. The freed stacks
    // guarantee the rollback fits, so atomicity holds.
    for (const c of consumed) opts.inventory.add(c.itemId, c.count);
    return fail(
      recipeId,
      'no-room',
      `No room for ${granted.itemId} — ingredients returned.`,
    );
  }
  return { ok: true, recipeId, consumed, granted };
}
