/**
 * Curated quest rewards (curated-quest-rewards wave).
 *
 * The story-quests and side-quests waves both shipped with seeded-RANDOM
 * reward content: every quest granted a random pick of {mat_ore,
 * mat_fiber, mat_scrap} regardless of what the quest was about. This module
 * replaces that with hand-curated, theme-matched reward tables that are
 * data-driven through the quest defs (the pool builders stamp them into
 * `QuestDef.rewards`), keyed by quest template slug.
 *
 * Seeded variance is kept ONLY for one small bonus-material line per quest
 * (`bonusFor`, a pure function of (pool seed, template slug)) so reward
 * delivery stays deterministic and independently replicable.
 *
 * Studio authors can override any quest's reward via
 * `spec.custom.quests.rewardOverrides[slug]` ({xp?, items?}) — the picker
 * UI lives in the Studio editor panel's QUESTS section; applyOverrides
 * merges those over the curated tables.
 *
 * Determinism: everything here is pure. Same spec -> identical defs,
 * unit-tested (tests/questrewards.test.ts).
 */
import { Rng, hashString } from '../core/Rng';

/** Item ids the curated tables reference. All exist in the item tables
 *  merged at blueprint boot (ensureCraftingItemDefs + ensureLootItemDefs). */
export const QR_GEAR = {
  /** first_blood: the hunter's reward */
  ironfangBlade: 'loot_ironfang_blade',
  /** big_game: apex-hunter plate */
  scorchedPlate: 'loot_scorched_plate',
  /** word_travels / pest_control: field tonic */
  surgeTonic: 'loot_surge_tonic',
} as const;

export const QR_CRAFT = {
  /** the_maker / apex_threat */
  ironEdge: 'craft_iron_edge',
  /** the_forager: gatherer's vest */
  fiberWeave: 'craft_fiber_weave',
  /** wayfarer / waystations: travel buckler */
  scrapBuckler: 'craft_scrap_buckler',
  /** timber_call: field medicine */
  fieldKit: 'craft_field_kit',
  /** stockpile / wayfarer: alchemy output */
  emberTonic: 'craft_ember_tonic',
} as const;

export const QR_MATS = {
  ore: 'mat_ore',
  fiber: 'mat_fiber',
  scrap: 'mat_scrap',
  emberShard: 'mat_ember_shard',
  beastHide: 'mat_beast_hide',
  coreFragment: 'mat_core_fragment',
} as const;

/** Bonus-line material pool — the ONLY seeded-random part of a quest
 *  reward. Kept to the three common gathering materials. */
export const BONUS_MATERIALS = [QR_MATS.ore, QR_MATS.fiber, QR_MATS.scrap] as const;

export interface CuratedRewardItem {
  id: string;
  count: number;
}

/** Hand-curated {xp, items} for one quest template. `items` grants exactly
 *  these — theme-matched gear, bundles or consumables. */
export interface CuratedQuestReward {
  xp: number;
  items: CuratedRewardItem[];
}

/**
 * Main-story curated rewards, keyed by story template slug
 * (engine/game/quests.ts QUEST_CATALOG).
 * first_blood -> weapon, big_game -> armor, the_forager -> gathering gear +
 * materials, the_maker -> crafting bundle, word_travels -> consumables,
 * wayfarer -> travel gear.
 */
export const CURATED_STORY_REWARDS: Record<string, CuratedQuestReward> = {
  first_blood: {
    xp: 150,
    items: [{ id: QR_GEAR.ironfangBlade, count: 1 }],
  },
  big_game: {
    xp: 200,
    items: [{ id: QR_GEAR.scorchedPlate, count: 1 }],
  },
  the_forager: {
    xp: 120,
    items: [
      { id: QR_CRAFT.fiberWeave, count: 1 },
      { id: QR_MATS.fiber, count: 4 },
    ],
  },
  the_maker: {
    xp: 160,
    items: [
      { id: QR_CRAFT.ironEdge, count: 1 },
      { id: QR_CRAFT.fieldKit, count: 2 },
    ],
  },
  word_travels: {
    xp: 120,
    items: [
      { id: QR_GEAR.surgeTonic, count: 2 },
      { id: QR_MATS.coreFragment, count: 1 },
    ],
  },
  wayfarer: {
    xp: 180,
    items: [
      { id: QR_CRAFT.scrapBuckler, count: 1 },
      { id: QR_CRAFT.emberTonic, count: 1 },
    ],
  },
};

/**
 * Side-quest curated rewards, keyed by side template slug
 * (engine/game/sidequests.ts SIDE_QUEST_CATALOG). Deliberately minor —
 * materials, one consumable or a single common/uncommon gear piece —
 * tiered below the story line.
 */
export const CURATED_SIDE_REWARDS: Record<string, CuratedQuestReward> = {
  spare_parts:   { xp: 60, items: [{ id: QR_MATS.scrap, count: 3 }] },
  timber_call:   { xp: 60, items: [{ id: QR_CRAFT.fieldKit, count: 1 }] },
  ore_sample:    { xp: 60, items: [{ id: QR_MATS.ore, count: 3 }] },
  stockpile:     { xp: 80, items: [{ id: QR_CRAFT.emberTonic, count: 1 }] },
  pest_control:  { xp: 80, items: [{ id: QR_GEAR.surgeTonic, count: 1 }] },
  apex_threat:   { xp: 100, items: [{ id: QR_CRAFT.ironEdge, count: 1 }] },
  apprentice_work:{ xp: 70, items: [{ id: QR_MATS.fiber, count: 4 }] },
  waystations:   { xp: 80, items: [{ id: QR_CRAFT.scrapBuckler, count: 1 }] },
  biome_survey:  { xp: 80, items: [{ id: QR_MATS.beastHide, count: 2 }] },
  rumor_mill:    { xp: 60, items: [{ id: QR_MATS.coreFragment, count: 1 }] },
};

/** Every quest template slug with a curated table (story + side), for
 *  Studio pickers and override validation. */
export const QUEST_REWARD_SLUGS: string[] = [
  ...Object.keys(CURATED_STORY_REWARDS),
  ...Object.keys(CURATED_SIDE_REWARDS),
];

/** Salt for the bonus-material stream off the pool seed. Distinct from
 *  every other wave's salt — never reuse a salt for a second stream. */
export const QUEST_REWARD_BONUS_SALT = 0xb0157;

/**
 * The small seeded bonus-material line for one quest. Pure function of
 * (poolSeed, templateSlug) — an INDEPENDENT stream, not the shared pool
 * rng, so a test can replicate it exactly without replaying the pool.
 * Returns one material, count 1..2.
 */
export function questBonusItem(poolSeed: number, slug: string): CuratedRewardItem {
  const rng = new Rng(((poolSeed >>> 0) ^ QUEST_REWARD_BONUS_SALT ^ hashString(slug)) >>> 0);
  return { id: rng.pick(BONUS_MATERIALS), count: rng.int(1, 2) };
}

/**
 * All curated item ids referenced by the tables — the blueprint boot
 * ensures (ensureCraftingItemDefs + ensureLootItemDefs) must keep these
 * present or QuestManager skips them at turn-in (never grants blind).
 */
export function allCuratedItemIds(): string[] {
  const ids = new Set<string>();
  for (const t of [...Object.values(CURATED_STORY_REWARDS), ...Object.values(CURATED_SIDE_REWARDS)]) {
    for (const i of t.items) ids.add(i.id);
  }
  for (const m of BONUS_MATERIALS) ids.add(m);
  return [...ids].sort();
}

/** Studio-authored override for one quest's curated reward. */
export interface QuestRewardOverride {
  /** override xp (undefined = keep the curated xp) */
  xp?: number;
  /** override item lines (undefined = keep the curated items) */
  items?: CuratedRewardItem[];
}

/** Validate one override value; returns error strings (empty = valid). */
export function validateQuestRewardOverride(slug: string, ov: unknown): string[] {
  const errs: string[] = [];
  const p = `custom.quests.rewardOverrides.${slug}`;
  if (ov === null || typeof ov !== 'object') return [`${p} must be an object`];
  const o = ov as Record<string, unknown>;
  if (o.xp !== undefined && (!Number.isFinite(o.xp) || (o.xp as number) < 0))
    errs.push(`${p}.xp must be a non-negative number`);
  if (o.items !== undefined) {
    if (!Array.isArray(o.items)) errs.push(`${p}.items must be an array`);
    else for (let i = 0; i < o.items.length; i++) {
      const it = o.items[i] as Record<string, unknown>;
      if (typeof it?.id !== 'string' || !it.id) errs.push(`${p}.items[${i}].id must be a non-empty string`);
      if (!Number.isInteger(it?.count) || (it.count as number) < 1)
        errs.push(`${p}.items[${i}].count must be an integer >= 1`);
    }
  }
  return errs;
}

/**
 * Merge Studio overrides over the curated reward for one template slug.
 * Unknown slugs return null (caller logs/skips — never merge blind).
 */
export function curatedQuestReward(
  spec: { custom?: { quests?: { rewardOverrides?: Record<string, QuestRewardOverride> } } },
  slug: string,
): (CuratedQuestReward & { story: boolean }) | null {
  const base =
    CURATED_STORY_REWARDS[slug] !== undefined
      ? { ...CURATED_STORY_REWARDS[slug], items: CURATED_STORY_REWARDS[slug].items.map((i) => ({ ...i })), story: true }
      : CURATED_SIDE_REWARDS[slug] !== undefined
        ? { ...CURATED_SIDE_REWARDS[slug], items: CURATED_SIDE_REWARDS[slug].items.map((i) => ({ ...i })), story: false }
        : null;
  if (!base) return null;
  const ov = spec.custom?.quests?.rewardOverrides?.[slug];
  if (!ov) return base;
  if (ov.xp !== undefined) base.xp = ov.xp;
  if (ov.items !== undefined) base.items = ov.items.map((i) => ({ id: i.id, count: i.count }));
  return base;
}

/**
 * Loud check over every Studio override in a spec: unknown slugs and
 * shape errors are returned as strings. Use in tests / Studio tooling —
 * the pool builder itself applies only known slugs (never throws on
 * authored content).
 */
export function validateQuestRewardOverrides(
  spec: { custom?: { quests?: { rewardOverrides?: Record<string, unknown> } } },
): string[] {
  const errs: string[] = [];
  const ov = spec.custom?.quests?.rewardOverrides;
  if (ov === undefined) return errs;
  if (ov === null || typeof ov !== 'object') return ['custom.quests.rewardOverrides must be an object'];
  for (const [slug, val] of Object.entries(ov)) {
    if (!QUEST_REWARD_SLUGS.includes(slug))
      errs.push(`custom.quests.rewardOverrides.${slug}: unknown quest slug (expected one of ${QUEST_REWARD_SLUGS.join('|')})`);
    errs.push(...validateQuestRewardOverride(slug, val));
  }
  return errs;
}
