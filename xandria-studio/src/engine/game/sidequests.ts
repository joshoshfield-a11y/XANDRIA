/**
 * Side-quest wave: optional quest content built on the story-quests phase's
 * quest system (engine/game/quests.ts).
 *
 * Design:
 *   - buildSideQuestPool(spec) is a pure function of the spec: 6-9 side
 *     quests chosen from a 10-template catalog via Rng(spec.meta.seed ^
 *     SIDE_QUEST_SALT). Same spec -> identical pool (ids, objectives,
 *     targets, counts, rewards). Independent quests: no chaining, every def
 *     carries `side: true` so the QuestManager marks them available from the
 *     start (the story line keeps its locked->available chain).
 *   - Archetypes: fetch (gather a specific material, returned to the giver),
 *     hunt (kill an enemy kind), craft (craft any N recipes), explore (visit
 *     distinct maps / set foot in distinct biomes — tracked by the
 *     QuestManager's portal-aware update()), talk (open dialogues).
 *   - "Across biomes": the explore quests genuinely require travel through
 *     the seeded portal graph (deriveMapBiome per arrival is deterministic
 *     per world seed), and gather targets ride the per-biome gathering-node
 *     palettes. Placement determinism = the pool itself plus the existing
 *     seeded enemy/node/station systems it targets.
 *   - Rewards are tiered slightly below the story line (side content is
 *     optional): less XP, seeded material grants via the real item defs.
 *
 * Determinism: seeded RNG only — never Math.random/Date.now for gameplay.
 */
import { Rng } from '../core/Rng';
import type { GameSpec } from '@spec';
import type { CraftingRecipe } from './crafting';
import { buildRecipePool, resolveCraftingEnabled } from './crafting';
import { MAT_ORE, MAT_FIBER, MAT_SCRAP } from './crafting';
import { portalsEnabled } from '@spec';
import type { QuestDef, QuestObjectiveDef } from './quests';

/** Salt for the side-quest-pool stream — distinct from QUEST_SALT and every other wave's salt. */
export const SIDE_QUEST_SALT = 0x51445553; // 'QEDS'

interface SideQuestBuildCtx {
  rng: Rng;
  recipePool: CraftingRecipe[];
  enemyKinds: string[];
  crafting: boolean;
  portals: boolean;
  includeTalk: boolean;
}

interface SideQuestTemplate {
  slug: string;
  name: string;
  brief: string;
  available: (ctx: SideQuestBuildCtx) => boolean;
  build: (ctx: SideQuestBuildCtx, id: string) => QuestDef;
}

function sideRewardFor(rng: Rng, tier: number): QuestDef['rewards'] {
  const mats = [MAT_ORE, MAT_FIBER, MAT_SCRAP];
  return {
    xp: 30 + 20 * rng.int(0, 2) + tier * 15,
    items: [{ id: rng.pick(mats), count: 1 + rng.int(0, 2) }],
  };
}

const SIDE_QUEST_CATALOG: SideQuestTemplate[] = [
  // -- fetch (gather a specific material, turn in at the giver) --
  {
    slug: 'spare_parts',
    name: 'Spare Parts',
    brief: 'The gate winch is held together with hope. Bring scrap and the smith will remember it.',
    available: (ctx) => ctx.crafting,
    build: (ctx, id) => {
      const count = 4 + ctx.rng.int(0, 2);
      return {
        id, name: 'Spare Parts', giver: 'villager', side: true,
        brief: 'The gate winch is held together with hope. Bring scrap and the smith will remember it.',
        objectives: [{ id: 'obj-fetch', kind: 'gather', desc: `Fetch ${count} scrap`, target: MAT_SCRAP, count }],
        rewards: sideRewardFor(ctx.rng, 0),
      };
    },
  },
  {
    slug: 'timber_call',
    name: 'Timber Call',
    brief: 'The palisade took a beating last storm. The builders need fiber, and they need it soon.',
    available: (ctx) => ctx.crafting,
    build: (ctx, id) => {
      const count = 5 + ctx.rng.int(0, 2);
      return {
        id, name: 'Timber Call', giver: 'villager', side: true,
        brief: 'The palisade took a beating last storm. The builders need fiber, and they need it soon.',
        objectives: [{ id: 'obj-fetch', kind: 'gather', desc: `Fetch ${count} fiber`, target: MAT_FIBER, count }],
        rewards: sideRewardFor(ctx.rng, 0),
      };
    },
  },
  {
    slug: 'ore_sample',
    name: 'Ore Sample',
    brief: 'The forge wants to test a new alloy. A few good chunks of ore will settle the argument.',
    available: (ctx) => ctx.crafting,
    build: (ctx, id) => {
      const count = 3 + ctx.rng.int(0, 2);
      return {
        id, name: 'Ore Sample', giver: 'villager', side: true,
        brief: 'The forge wants to test a new alloy. A few good chunks of ore will settle the argument.',
        objectives: [{ id: 'obj-fetch', kind: 'gather', desc: `Fetch ${count} ore`, target: MAT_ORE, count }],
        rewards: sideRewardFor(ctx.rng, 1),
      };
    },
  },
  {
    slug: 'stockpile',
    name: 'Stockpile',
    brief: 'Winter or war — either way the stores are thin. Bring whatever the land gives.',
    available: (ctx) => ctx.crafting,
    build: (ctx, id) => {
      const count = 8 + ctx.rng.int(0, 3);
      return {
        id, name: 'Stockpile', giver: 'villager', side: true,
        brief: 'Winter or war — either way the stores are thin. Bring whatever the land gives.',
        objectives: [{ id: 'obj-gather', kind: 'gather', desc: `Gather ${count} raw materials`, target: 'any', count }],
        rewards: sideRewardFor(ctx.rng, 1),
      };
    },
  },
  // -- hunt --
  {
    slug: 'pest_control',
    name: 'Pest Control',
    brief: 'They raid the stores at night and fear nothing. Teach them fear.',
    available: (ctx) => ctx.enemyKinds.length > 0,
    build: (ctx, id) => {
      const kind = ctx.enemyKinds[0];
      const count = 5 + ctx.rng.int(0, 3);
      return {
        id, name: 'Pest Control', giver: 'villager', side: true,
        brief: 'They raid the stores at night and fear nothing. Teach them fear.',
        objectives: [{ id: 'obj-hunt', kind: 'kill', desc: `Defeat ${count} ${kind}s`, target: kind, count }],
        rewards: sideRewardFor(ctx.rng, 1),
      };
    },
  },
  {
    slug: 'apex_threat',
    name: 'Apex Threat',
    brief: 'One of them runs the pack. Cut off the head and the rest scatter.',
    available: (ctx) => ctx.enemyKinds.length > 1,
    build: (ctx, id) => {
      const kind = ctx.enemyKinds[ctx.enemyKinds.length - 1];
      const count = 2 + ctx.rng.int(0, 2);
      return {
        id, name: 'Apex Threat', giver: 'villager', side: true,
        brief: 'One of them runs the pack. Cut off the head and the rest scatter.',
        objectives: [{ id: 'obj-hunt', kind: 'kill', desc: `Defeat ${count} ${kind}s`, target: kind, count }],
        rewards: sideRewardFor(ctx.rng, 2),
      };
    },
  },
  // -- craft (any recipe: deliberately distinct from the story line's
  //    named-recipe quest so one craft doesn't read as double-dipping) --
  {
    slug: 'apprentice_work',
    name: 'Apprentice Work',
    brief: 'Every master was a beginner once. Put in the hours at the workbench.',
    available: (ctx) => ctx.crafting && ctx.recipePool.length > 0,
    build: (ctx, id) => {
      const count = 2;
      return {
        id, name: 'Apprentice Work', giver: 'villager', side: true,
        brief: 'Every master was a beginner once. Put in the hours at the workbench.',
        objectives: [{
          id: 'obj-craft', kind: 'craft',
          desc: `Craft any ${count} items`,
          target: 'any', count,
        }],
        rewards: sideRewardFor(ctx.rng, 1),
      };
    },
  },
  // -- explore (tracked by QuestManager.update via the portal graph;
  //    deriveMapBiome is deterministic per world seed, so these are
  //    satisfiable exactly when the graph reaches that far) --
  {
    slug: 'waystations',
    name: 'Waystations',
    brief: 'The old roads still run between worlds. Walk them and map what you find.',
    available: (ctx) => ctx.portals,
    build: (ctx, id) => {
      const count = 3;
      return {
        id, name: 'Waystations', giver: 'villager', side: true,
        brief: 'The old roads still run between worlds. Walk them and map what you find.',
        objectives: [{
          id: 'obj-explore', kind: 'explore',
          desc: `Visit ${count} distinct maps`,
          target: 'maps', count,
        }],
        rewards: sideRewardFor(ctx.rng, 2),
      };
    },
  },
  {
    slug: 'biome_survey',
    name: 'Biome Survey',
    brief: 'No two lands beyond the portals are alike. Set foot in new country and report back.',
    available: (ctx) => ctx.portals,
    build: (ctx, id) => {
      const count = 2;
      return {
        id, name: 'Biome Survey', giver: 'villager', side: true,
        brief: 'No two lands beyond the portals are alike. Set foot in new country and report back.',
        objectives: [{
          id: 'obj-explore', kind: 'explore',
          desc: `Set foot in ${count} distinct biomes`,
          target: 'biomes', count,
        }],
        rewards: sideRewardFor(ctx.rng, 2),
      };
    },
  },
  // -- talk --
  {
    slug: 'rumor_mill',
    name: 'Rumor Mill',
    brief: 'Everyone knows something. Put the pieces together.',
    available: (ctx) => ctx.includeTalk,
    build: (ctx, id) => {
      const count = 3 + ctx.rng.int(0, 2);
      return {
        id, name: 'Rumor Mill', giver: 'villager', side: true,
        brief: 'Everyone knows something. Put the pieces together.',
        objectives: [{ id: 'obj-talk', kind: 'talk', desc: `Hear ${count} rumors`, target: 'any', count }],
        rewards: sideRewardFor(ctx.rng, 0),
      };
    },
  },
];

export interface BuildSideQuestPoolOpts {
  /**
   * false in genres without villagers (fps/arena, platformer, topdown never
   * construct the talk session) — the talk side quest is filtered out.
   */
  includeTalk?: boolean;
}

/**
 * Seeded side-quest pool. Pure function of (spec, opts): same spec →
 * identical quest ids, names, objectives, targets, counts, rewards.
 * 6-10 quests (seeded), independent — no chaining. Studio override:
 * spec.custom.quests.sideQuestCount (1-12); the `enabled` master toggle is
 * honored by the blueprints (no manager at all when false).
 */
export function buildSideQuestPool(spec: GameSpec, opts: BuildSideQuestPoolOpts = {}): QuestDef[] {
  const rng = new Rng((spec.meta.seed ^ SIDE_QUEST_SALT) >>> 0);
  const includeTalk = opts.includeTalk ?? spec.meta.genre === 'third-person-action';
  const ctx: SideQuestBuildCtx = {
    rng,
    recipePool: buildRecipePool(spec),
    enemyKinds: (spec.enemies ?? []).map((e) => e.kind),
    crafting: resolveCraftingEnabled(spec),
    portals: portalsEnabled(spec),
    includeTalk,
  };
  const eligible = SIDE_QUEST_CATALOG.filter((t) => t.available(ctx));
  const authored = spec.custom?.quests?.sideQuestCount;
  let count: number;
  if (typeof authored === 'number' && Number.isFinite(authored)) {
    count = Math.max(1, Math.min(12, Math.floor(authored)));
  } else {
    count = 6 + Math.floor(rng.next() * 5); // 6..10
  }
  count = Math.min(count, eligible.length);
  const picked = rng.shuffle([...eligible]).slice(0, count);
  const defs = picked.map((t, i) => t.build(ctx, `quest_side_${i + 1}_${t.slug}`));
  // Validate in dev the way the story pool is validated (loud on bad content).
  for (const d of defs) {
    const errs = validateSideQuestDef(d);
    if (errs.length > 0) throw new Error(`side-quest pool: invalid def: ${errs.join('; ')}`);
  }
  return defs;
}

/** Local structural check (mirrors validateQuestDef; story defs are checked by their own wave). */
function validateSideQuestDef(def: QuestDef): string[] {
  const errs: string[] = [];
  if (!def.id || typeof def.id !== 'string') errs.push('quest id must be a non-empty string');
  if (def.side !== true) errs.push(`quest ${def.id}: side quests must carry side: true`);
  if (def.requiresQuests && def.requiresQuests.length > 0) {
    errs.push(`quest ${def.id}: side quests must not chain (no requiresQuests)`);
  }
  const kinds = ['kill', 'gather', 'craft', 'talk', 'explore'];
  for (const o of def.objectives as QuestObjectiveDef[]) {
    if (!kinds.includes(o.kind)) errs.push(`quest ${def.id}: unknown objective kind '${(o as { kind: unknown }).kind}'`);
    if (!o.target || typeof o.target !== 'string') errs.push(`quest ${def.id}: objective target must be a string`);
    if (!Number.isFinite(o.count) || o.count < 1) errs.push(`quest ${def.id}: objective count must be >= 1`);
  }
  if (typeof def.rewards?.xp !== 'number' || def.rewards.xp < 0) errs.push(`quest ${def.id}: rewards.xp must be >= 0`);
  if (!Array.isArray(def.rewards?.items)) errs.push(`quest ${def.id}: rewards.items must be an array`);
  return errs;
}
