/**
 * Gear set bonuses wave: named equipment sets with 2-piece / 4-piece
 * additive stat thresholds.
 *
 * CONTENT
 * - Four named sets across the tier-1..3 gear bands (THE tuning table —
 *   every bonus number lives in GEAR_SETS below):
 *   1. Ironfang Raider (tier-1, uncommon band): 2 loot-wave pieces +
 *      2 new set helm/greaves.
 *   2. Emberforged (tier-2, rare band): 2 tier-2 crafted pieces +
 *      2 new set cowl/sabatons.
 *   3. Voidborn (epic band, loot path): 2 epic/legendary loot pieces +
 *      2 new set cuirass/pauldrons.
 *   4. Masterforged (tier-3, master band — the master-crafting wave IS
 *      merged into main cd39ade, so the tier-3 material stack exists):
 *      3 tier-3 master outputs + 1 new master-crafted crown.
 * - Each set grants a 2-piece and a 4-piece bonus (ItemStats), additive
 *   to the existing stat math — the set module never changes the loot
 *   ladder, equip slots, or NPC/enemy behavior contracts.
 * - Set membership is data-driven (GearSetDef.pieces lists item ids);
 *   computeSetBonuses() is a pure function of (equipped slots).
 * - Inventory.effectiveStats() = equippedStats() + active set bonuses;
 *   recomputed on every read (equip/unequip mutate equipped, so the
 *   bonuses are fresh on every equip change by construction).
 * - Drop integration: SET_DROP_ADDONS are ADDITIVE entries on the
 *   existing loot tables (loot.ts merges them in rollLoot) — existing
 *   entries, weights, and rarities are untouched; the rarity ladder
 *   itself is unchanged (boss-exclusive legendary stays boss-exclusive).
 * - The Masterforged crown arrives through SET_CATALOG_RECIPES (one
 *   additive master recipe, forge + smithing 3, appended by crafting.ts
 *   — the catalog, check order, and pool semantics are unchanged).
 *
 * DETERMINISM: no Math.random/Date.now/engine.rng anywhere. New drop
 * entries roll inside rollLoot's existing Rng(mapSeed ^ LOOT_SALT)
 * stream — same (seed, kill sequence) -> identical drops, with the
 * addon tables pinned by unit test.
 *
 * CONTRACTS (owned by this wave):
 * - Existing item ids (loot_X / craft_X namespaces) are repeated here as string
 *   literals, NOT value-imported from loot.ts — loot.ts value-imports
 *   this module for SET_DROP_ADDONS, so a value import back would be a
 *   module cycle (TDZ crash at load). Literal <-> source sync is pinned
 *   by unit test (tests/setbonuses.test.ts). Type-only imports are
 *   erased at compile and never cycle.
 * - ensureSetItemDefs(spec) merges defs ONLY when spec.custom.items
 *   already exists — it never creates custom.items, preserving
 *   wireItems' null contract (item system disabled when no item
 *   tables). Idempotent, non-destructive (Studio-authored overrides win).
 * - LootEntry type is imported TYPE-ONLY from loot.ts.
 */
import type { GameSpec, ItemDef, ItemStats, EquipSlot } from '@spec';
import type { LootEntry } from './loot';
import { ItemBuilder } from './items/ItemBuilder';
import type { CraftingRecipe } from './crafting';

// ---------------------------------------------------------------- ids

/** Existing item ids, as string literals (see CONTRACTS above — sync pinned by test). */
const LOOT_IRONFANG_BLADE = 'loot_ironfang_blade';
const LOOT_SCORCHED_PLATE = 'loot_scorched_plate';
const LOOT_VOID_EDGE = 'loot_void_edge';
const LOOT_STAR_AEGIS = 'loot_star_aegis';
const CRAFT_EMBER_BLADE = 'craft_ember_blade';
const CRAFT_SCORCHED_HARNESS = 'craft_scorched_harness';
const CRAFT_STARFALL_WARBRAND = 'craft_starfall_warbrand';
const CRAFT_DRAGONSCALE_AEGIS = 'craft_dragonscale_aegis';
const CRAFT_WILDHEART_REGALIA = 'craft_wildheart_regalia';
const MAT_CORE_FRAGMENT = 'mat_core_fragment';
const MAT_EMBER_SHARD = 'mat_ember_shard';
const STATION_FORGE = 'station_forge';

/** New set-piece ids (defined in setGearDefs below). */
export const SET_IRONFANG_HELM = 'set_ironfang_helm';
export const SET_IRONFANG_GREAVES = 'set_ironfang_greaves';
export const SET_EMBERFORGED_COWL = 'set_emberforged_cowl';
export const SET_EMBERFORGED_SABATONS = 'set_emberforged_sabatons';
export const SET_VOIDBORN_CUIRASS = 'set_voidborn_cuirass';
export const SET_VOIDBORN_PAULDRONS = 'set_voidborn_pauldrons';
export const SET_MASTERFORGED_CROWN = 'set_masterforged_crown';
export const SET_PIECE_IDS = [
  SET_IRONFANG_HELM,
  SET_IRONFANG_GREAVES,
  SET_EMBERFORGED_COWL,
  SET_EMBERFORGED_SABATONS,
  SET_VOIDBORN_CUIRASS,
  SET_VOIDBORN_PAULDRONS,
  SET_MASTERFORGED_CROWN,
] as const;

// ---------------------------------------------------------------- defs

/** One threshold: wearing >= `pieces` of the set grants `bonus` (ItemStats). */
export interface SetThreshold {
  pieces: number;
  label: string;
  bonus: ItemStats;
}

/** A named gear set — all tuning lives here, one table. */
export interface GearSetDef {
  setId: string;
  name: string;
  blurb: string;
  /** Item ids of the set's pieces (4 per set). */
  pieces: readonly string[];
  /** Sorted ascending by `pieces` (2-piece, 4-piece). */
  thresholds: readonly SetThreshold[];
}

/**
 * THE set table. Four sets, tier-1..3 bands, every bonus number here.
 * Bonuses are modest additive stats that sit below a single extra
 * tier-up in gear — sets reward collection, never replace upgrades.
 */
export const GEAR_SETS: readonly GearSetDef[] = [
  {
    setId: 'ironfang_raider',
    name: 'Ironfang Raider',
    blurb: 'Scavenged raider kit — hungry and unpretentious.',
    pieces: [LOOT_IRONFANG_BLADE, SET_IRONFANG_HELM, LOOT_SCORCHED_PLATE, SET_IRONFANG_GREAVES],
    thresholds: [
      { pieces: 2, label: '2-PC: +3 defense', bonus: { defense: 3 } },
      { pieces: 4, label: '4-PC: +8 damage, +15 maxHealth', bonus: { damage: 8, maxHealth: 15 } },
    ],
  },
  {
    setId: 'emberforged',
    name: 'Emberforged',
    blurb: 'Forge-kissed harness — the ember remembers its shape.',
    pieces: [CRAFT_EMBER_BLADE, SET_EMBERFORGED_COWL, CRAFT_SCORCHED_HARNESS, SET_EMBERFORGED_SABATONS],
    thresholds: [
      { pieces: 2, label: '2-PC: +6 damage', bonus: { damage: 6 } },
      { pieces: 4, label: '4-PC: +10 crit, +25 maxHealth', bonus: { crit: 10, maxHealth: 25 } },
    ],
  },
  {
    setId: 'voidborn',
    name: 'Voidborn',
    blurb: 'Drank the light around it; it has not given it back.',
    pieces: [LOOT_VOID_EDGE, LOOT_STAR_AEGIS, SET_VOIDBORN_CUIRASS, SET_VOIDBORN_PAULDRONS],
    thresholds: [
      { pieces: 2, label: '2-PC: +8 defense, +5 crit', bonus: { defense: 8, crit: 5 } },
      { pieces: 4, label: '4-PC: +12 damage, +40 maxHealth', bonus: { damage: 12, maxHealth: 40 } },
    ],
  },
  {
    setId: 'masterforged',
    name: 'Masterforged',
    blurb: 'Master-smith work — core-light cured around the finest steel.',
    pieces: [CRAFT_STARFALL_WARBRAND, SET_MASTERFORGED_CROWN, CRAFT_WILDHEART_REGALIA, CRAFT_DRAGONSCALE_AEGIS],
    thresholds: [
      { pieces: 2, label: '2-PC: +10 damage', bonus: { damage: 10 } },
      { pieces: 4, label: '4-PC: +20 defense, +40 maxHealth', bonus: { defense: 20, maxHealth: 40 } },
    ],
  },
];

// ---------------------------------------------------------------- new item defs

/** The seven new set-piece item defs (2 uncommon, 2 rare, 3 epic). */
export function setGearDefs(): Record<string, ItemDef> {
  return {
    [SET_IRONFANG_HELM]: new ItemBuilder(SET_IRONFANG_HELM)
      .named('Ironfang Helm')
      .armor('head')
      .stat('defense', 3)
      .rarity('uncommon')
      .stackable(1)
      .value(90)
      .description('Ironfang Raider piece (1/4). A dented helm, still loyal.')
      .build(),
    [SET_IRONFANG_GREAVES]: new ItemBuilder(SET_IRONFANG_GREAVES)
      .named('Ironfang Greaves')
      .armor('legs')
      .stat('defense', 3)
      .rarity('uncommon')
      .stackable(1)
      .value(90)
      .description('Ironfang Raider piece (2/4). Greaves that have outrun their owners.')
      .build(),
    [SET_EMBERFORGED_COWL]: new ItemBuilder(SET_EMBERFORGED_COWL)
      .named('Emberforged Cowl')
      .armor('head')
      .stat('defense', 5)
      .stat('maxHealth', 8)
      .rarity('rare')
      .stackable(1)
      .value(240)
      .description('Emberforged piece (1/4). Heat-cured plate, amber-veined.')
      .build(),
    [SET_EMBERFORGED_SABATONS]: new ItemBuilder(SET_EMBERFORGED_SABATONS)
      .named('Emberforged Sabatons')
      .armor('legs')
      .stat('defense', 5)
      .rarity('rare')
      .stackable(1)
      .value(210)
      .description('Emberforged piece (2/4). Sabatons that leave warm footprints.')
      .build(),
    [SET_VOIDBORN_CUIRASS]: new ItemBuilder(SET_VOIDBORN_CUIRASS)
      .named('Voidborn Cuirass')
      .armor('torso')
      .stat('defense', 9)
      .stat('maxHealth', 15)
      .rarity('epic')
      .stackable(1)
      .value(520)
      .description('Voidborn piece (1/4). Starlight never reaches the bottom of it.')
      .build(),
    [SET_VOIDBORN_PAULDRONS]: new ItemBuilder(SET_VOIDBORN_PAULDRONS)
      .named('Voidborn Pauldrons')
      .armor('legs')
      .stat('defense', 8)
      .stat('crit', 4)
      .rarity('epic')
      .stackable(1)
      .value(500)
      .description('Voidborn piece (2/4). Shouldered night.')
      .build(),
    [SET_MASTERFORGED_CROWN]: new ItemBuilder(SET_MASTERFORGED_CROWN)
      .named('Masterforged Crown')
      .armor('head')
      .stat('defense', 8)
      .stat('maxHealth', 20)
      .rarity('epic')
      .stackable(1)
      .value(680)
      .description('Masterforged piece (1/4). Only a rank-3 smith may forge it.')
      .build(),
  };
}

/**
 * The crown's def, for crafting.ts's craftedItemDefs() — the recipe
 * output must be a known def (the catalog-consistency test iterates the
 * full catalog). Same object the blueprint merge uses; no duplication.
 */
export function setCraftedOutputDefs(): Record<string, ItemDef> {
  return { [SET_MASTERFORGED_CROWN]: setGearDefs()[SET_MASTERFORGED_CROWN] };
}

/**
 * Merge the set-piece defs into spec.custom.items.defs. Idempotent and
 * non-destructive (existing defs win). NEVER creates custom.items — when
 * the spec has no item tables the item system (and sets) stays off.
 */
export function ensureSetItemDefs(spec: GameSpec): void {
  const items = spec.custom?.items;
  if (!items) return;
  items.defs = items.defs ?? {};
  const defs = items.defs;
  for (const [id, def] of Object.entries(setGearDefs())) {
    if (defs[id] === undefined) defs[id] = def;
  }
}

// ---------------------------------------------------------------- master recipe (additive)

/**
 * One additive master recipe for the Masterforged crown: forge +
 * smithing rank 3, pairing the tier-2 harness with boss-loot materials.
 * Appended to RECIPE_CATALOG by crafting.ts — catalog check order and
 * the minSkillRank-3 always-include rule are untouched.
 */
export const SET_CATALOG_RECIPES: readonly CraftingRecipe[] = [
  {
    id: 'recipe_masterforged_crown',
    name: 'Masterforged Crown',
    ingredients: [
      { itemId: CRAFT_SCORCHED_HARNESS, count: 1 },
      { itemId: MAT_CORE_FRAGMENT, count: 3 },
      { itemId: MAT_EMBER_SHARD, count: 2 },
    ],
    output: { itemId: SET_MASTERFORGED_CROWN, count: 1 },
    stationId: STATION_FORGE,
    skillId: 'smithing',
    minSkillRank: 3,
  },
];

// ---------------------------------------------------------------- drop addons (additive)

/**
 * ADDITIVE drop entries for the existing loot tables (merged by loot.ts
 * inside rollLoot — existing entries/weights/rarities are untouched).
 * Weights are small relative to the base tables so the loot ladder's
 * feel is unchanged; the rarity ladder is unchanged (no legendary here,
 * so legendary stays boss-exclusive by construction).
 */
export const SET_DROP_ADDONS: Record<string, readonly LootEntry[]> = {
  walker: [
    { itemId: SET_IRONFANG_HELM, weight: 4, min: 1, max: 1 },
    { itemId: SET_IRONFANG_GREAVES, weight: 4, min: 1, max: 1 },
  ],
  brute: [
    { itemId: SET_IRONFANG_HELM, weight: 5, min: 1, max: 1 },
    { itemId: SET_IRONFANG_GREAVES, weight: 5, min: 1, max: 1 },
    { itemId: SET_EMBERFORGED_COWL, weight: 5, min: 1, max: 1 },
    { itemId: SET_EMBERFORGED_SABATONS, weight: 5, min: 1, max: 1 },
    { itemId: SET_VOIDBORN_CUIRASS, weight: 3, min: 1, max: 1 },
    { itemId: SET_VOIDBORN_PAULDRONS, weight: 3, min: 1, max: 1 },
  ],
  drone: [],
  flyer: [],
  turret: [
    { itemId: SET_EMBERFORGED_COWL, weight: 4, min: 1, max: 1 },
    { itemId: SET_EMBERFORGED_SABATONS, weight: 4, min: 1, max: 1 },
    { itemId: SET_VOIDBORN_CUIRASS, weight: 4, min: 1, max: 1 },
    { itemId: SET_VOIDBORN_PAULDRONS, weight: 4, min: 1, max: 1 },
  ],
};

// ---------------------------------------------------------------- computation

const isFiniteNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Add two ItemStats maps (finite numbers only). */
export function addItemStats(a: ItemStats, b: ItemStats): ItemStats {
  const out: ItemStats = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {})) {
    if (!isFiniteNum(v)) continue;
    const cur = out[k as keyof ItemStats];
    out[k as keyof ItemStats] = (isFiniteNum(cur) ? cur : 0) + v;
  }
  return out;
}

/** Per-set resolution: which pieces are equipped, which thresholds fire. */
export interface ResolvedSet {
  setId: string;
  name: string;
  blurb: string;
  pieces: readonly string[];
  /** All thresholds, ascending (the UI marks which are active). */
  thresholds: readonly SetThreshold[];
  equippedCount: number;
  /** Thresholds whose `pieces` requirement is met, ascending. */
  active: SetThreshold[];
  /** Sum of the active threshold bonuses. */
  bonus: ItemStats;
}

/** Full set-bonus state for the currently equipped loadout. */
export interface SetBonusReport {
  sets: ResolvedSet[];
  /** Additive total across all sets' active thresholds. */
  bonusStats: ItemStats;
}

/**
 * Pure: compute active set bonuses from the equipped slots. Callers pass
 * inventory.getAllEquipped() (or any slot→id map). Never throws.
 */
export function computeSetBonuses(
  equipped: Partial<Record<EquipSlot, string>>,
): SetBonusReport {
  const equippedIds = new Set(Object.values(equipped).filter((id): id is string => typeof id === 'string'));
  const sets: ResolvedSet[] = GEAR_SETS.map((set) => {
    const equippedCount = set.pieces.filter((id) => equippedIds.has(id)).length;
    const active = set.thresholds.filter((t) => equippedCount >= t.pieces);
    let bonus: ItemStats = {};
    for (const t of active) bonus = addItemStats(bonus, t.bonus);
    return { setId: set.setId, name: set.name, blurb: set.blurb, pieces: set.pieces, thresholds: set.thresholds, equippedCount, active, bonus };
  });
  let bonusStats: ItemStats = {};
  for (const s of sets) bonusStats = addItemStats(bonusStats, s.bonus);
  return { sets, bonusStats };
}

/**
 * The UI-facing report: computeSetBonuses() plus per-set ownership
 * (backpack + equipped), so the inventory HUD can show "pieces
 * collected" separately from the equipped thresholds. `inv` needs
 * only { getAllEquipped(), count(id) } — an Inventory satisfies this
 * structurally.
 */
export interface SetUiReport extends SetBonusReport {
  /** setId -> pieces owned anywhere (backpack stacks + equipped). */
  owned: Record<string, number>;
  /** setId -> pieceId -> owned count, for the detail rows. */
  ownedPieces: Record<string, Record<string, number>>;
}

export function buildSetUiReport(inv: {
  getAllEquipped(): Partial<Record<EquipSlot, string>>;
  count(itemId: string): number;
}): SetUiReport {
  const base = computeSetBonuses(inv.getAllEquipped());
  const owned: Record<string, number> = {};
  const ownedPieces: Record<string, Record<string, number>> = {};
  for (const set of base.sets) {
    owned[set.setId] = 0;
    ownedPieces[set.setId] = {};
    for (const id of set.pieces) {
      const n = Math.max(0, inv.count(id));
      ownedPieces[set.setId][id] = n;
      if (n > 0) owned[set.setId] += 1;
    }
  }
  return { ...base, owned, ownedPieces };
}
