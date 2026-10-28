/**
 * Quest wave: the main story/quest-line system.
 *
 * Data model:
 *   QuestDef — { id, name, giver, brief, objectives[], rewards, requiresQuests? }
 *   QuestObjectiveDef — { id, kind, desc, target, count }
 *     kind 'kill'    — target = enemy kind (spec.enemies[].kind), fed by blueprint onDeath
 *     kind 'gather'  — target = material id or 'any', fed by GatheringManager onHarvested
 *     kind 'craft'   — target = recipe id, fed by CraftingPanel onCrafted
 *     kind 'talk'    — target = npc role or 'any', fed by QuestTalkSession on dialogue open
 *     kind 'explore' — target = 'portals', fed by QuestManager.update reading portal transitions
 *   QuestRewardDef — { xp, items[], bonus? } (xp via Progression, items + the
 *   small seeded bonus-material line via Inventory when wired)
 *
 * Seeded pool: buildQuestPool(spec) is a pure function of the spec — 3-5
 * main-story quests from the catalog via Rng(spec.meta.seed ^ QUEST_SALT),
 * chained (quest N requires quest N-1 turned in). Same spec → identical pool.
 *
 * Player-scoped persistence (NOT map-local): the QuestManager is owned by
 * the blueprint and NEVER registered in engine.portalEntities, so portal
 * departure/arrival (which only despawns map-local systems) leaves quest
 * progress untouched — the same standing as Progression and Inventory.
 * portalSnapshot()/portalRestore() mirror Progression's API for rebuild
 * scenarios and are wired into PortalState's capture/apply.
 *
 * Quest hooks are data-driven: objective kinds map to event methods on the
 * manager (advance table below). The side-quests phase adds new kinds by
 * extending QuestObjectiveKind + the table — no dispatch changes needed.
 * requires/produces seam: questRequiresFor/questProducesFor build the
 * Interactable.requires/produces strings the talk session stamps onto NPC
 * interactables (quest:accept:<id>, quest:turnin:<id>,
 * quest:turned-in:<id>).
 *
 * Determinism: seeded RNG only — never Math.random/Date.now for gameplay.
 */
import { Rng } from '../core/Rng';
import { deriveMapBiome } from '../world/Biomes';
import type { GameSpec, ItemDef } from '@spec';
import type { Progression } from './Progression';
import type { LevelGain } from './progressionCurve';
import type { CraftingRecipe } from './crafting';
import { buildRecipePool } from './crafting';
import { resolveCraftingEnabled } from './crafting';
import { portalsEnabled } from '@spec';
import { curatedQuestReward, questBonusItem } from './questRewards';
import type { QuestTracker, QuestTrackerQuest } from '../ui/QuestTracker';

/** Salt for the quest-pool stream — distinct from every other wave's salt. */
export const QUEST_SALT = 0x51455354; // 'QEST'

export type QuestObjectiveKind = 'kill' | 'gather' | 'craft' | 'talk' | 'explore';

export interface QuestObjectiveDef {
  /** stable within the quest, e.g. 'obj-kill' */
  id: string;
  kind: QuestObjectiveKind;
  /** human line without progress, e.g. 'Defeat 6 walkers' */
  desc: string;
  /**
   * kind id: enemy kind | material id | 'any' (gather/talk/craft) | recipe id |
   * npc role | 'portals' | 'maps' | 'biomes' (explore).
   */
  target: string;
  count: number;
}

export interface QuestRewardItem {
  id: string;
  count: number;
}

export interface QuestRewardDef {
  /** XP granted via Progression.addXp (no-op when progression disabled) */
  xp: number;
  /** item ids granted via Inventory.add — skipped when a def is missing */
  items: QuestRewardItem[];
  /**
   * Seeded bonus-material line (curated-quest-rewards wave): one small
   * material grant kept on an independent seeded stream so the curated
   * tables stay the reward's theme. Granted after items at turn-in, with
   * the same skip-when-missing-def honesty.
   */
  bonus?: QuestRewardItem[];
}

export interface QuestDef {
  /** 'quest_story_1_first_blood' — stable per spec seed */
  id: string;
  name: string;
  /** npc role that can offer / accept turn-in ('villager', or 'any') */
  giver: string;
  /** one-line story shown in the quest dialogue */
  brief: string;
  objectives: QuestObjectiveDef[];
  rewards: QuestRewardDef;
  /** quest ids that must be turned in before this unlocks (the quest line) */
  requiresQuests?: string[];
  /**
   * side-quest marker (side-quests wave): independent quests that start
   * 'available' and never chain. Story quests leave this unset and follow
   * the locked → available line via requiresQuests.
   */
  side?: boolean;
  /**
   * radiant-quests wave: endless repeatable quests from the radiant board.
   * A radiant def is registered after construction (registerRadiantDefs),
   * starts 'available', never chains, never carries a standing gate, and
   * is the ONLY kind the manager's abandon()/removeRadiantDef() touch.
   * At accept/progress/complete/turn-in time a radiant def is a plain
   * QuestDef — the grant path makes no distinction, so radiant turn-ins
   * feed XP, inventory, standings, and achievements exactly like any
   * other quest's.
   */
  radiant?: boolean;
  /**
   * factions-reputation wave: optional standing gate. The quest stays
   * 'locked' (and accept() refuses it) until the player's standing with
   * the faction reaches min. Honored by the accept path ONLY — it never
   * blocks progress, completion, or turn-in of an already-accepted quest.
   * No seeded quest ships gated; gating is opt-in per def.
   */
  minStanding?: { factionId: string; min: number };
  /**
   * factions-reputation wave: optional standing reward granted at
   * turn-in (via opts.onQuestTurnedIn). Absent = the manager's caller
   * decides (the blueprint default is +20 to 'freeholds').
   */
  standingReward?: { factionId: string; amount: number };
  /**
   * timed-quests wave: a game-time countdown. Present ONLY on timed
   * defs (built by engine/game/timedQuests.ts and registered through
   * registerTimedDefs). limitSeconds is game-time seconds of
   * QuestManager.update(dt) accumulation — never wall-clock — and
   * rewardScale multiplies the def's base XP and item counts at BUILD
   * time, so turn-in grants the scaled reward through the existing
   * curated-reward lines with no grant-path change. On expiry the
   * quest's status becomes 'failed' (see QuestStatus); reaccept()
   * restarts it. Timed defs never chain and never carry a standing
   * gate (enforced by registerTimedDefs, like radiant defs).
   */
  timed?: { limitSeconds: number; rewardScale: number };
}

export type QuestStatus = 'locked' | 'available' | 'active' | 'complete' | 'turned-in' | 'failed';

interface QuestRuntime {
  def: QuestDef;
  status: QuestStatus;
  progress: number[];
  /**
   * timed-quests wave: game-time seconds accumulated while this quest
   * was 'active', via update(dt) only. Never sampled from a wall clock,
   * so pause / loading / portal-transition time (periods when
   * update() is not called) consumes nothing. Carried in portal
   * snapshots so portal travel preserves the timer exactly.
   */
  elapsedSeconds: number;
}

/** Validate a QuestDef the way the item-def validator does: loud on bad content. */
export function validateQuestDef(def: QuestDef): string[] {
  const errs: string[] = [];
  if (!def || typeof def !== 'object') return ['quest def must be an object'];
  if (!def.id || typeof def.id !== 'string') errs.push('quest id must be a non-empty string');
  if (!def.name || typeof def.name !== 'string') errs.push('quest name must be a non-empty string');
  if (!Array.isArray(def.objectives) || def.objectives.length === 0) {
    errs.push(`quest ${def.id}: objectives must be a non-empty array`);
  } else {
    const kinds: QuestObjectiveKind[] = ['kill', 'gather', 'craft', 'talk', 'explore'];
    for (const o of def.objectives) {
      if (!kinds.includes(o.kind)) errs.push(`quest ${def.id}: unknown objective kind '${(o as { kind: unknown }).kind}'`);
      if (!o.target || typeof o.target !== 'string') errs.push(`quest ${def.id}: objective target must be a string`);
      if (!Number.isFinite(o.count) || o.count < 1) errs.push(`quest ${def.id}: objective count must be >= 1`);
    }
  }
  if (!def.rewards || typeof def.rewards.xp !== 'number' || def.rewards.xp < 0) {
    errs.push(`quest ${def.id}: rewards.xp must be a non-negative number`);
  }
  if (!Array.isArray(def.rewards?.items)) errs.push(`quest ${def.id}: rewards.items must be an array`);
  if (def.minStanding !== undefined) {
    const g = def.minStanding;
    if (!g || typeof g.factionId !== 'string' || !g.factionId) errs.push(`quest ${def.id}: minStanding.factionId must be a non-empty string`);
    if (!g || !Number.isFinite(g.min)) errs.push(`quest ${def.id}: minStanding.min must be a finite number`);
  }
  if (def.standingReward !== undefined) {
    const r = def.standingReward;
    if (!r || typeof r.factionId !== 'string' || !r.factionId) errs.push(`quest ${def.id}: standingReward.factionId must be a non-empty string`);
    if (!r || !Number.isFinite(r.amount)) errs.push(`quest ${def.id}: standingReward.amount must be a finite number`);
  }
  if (def.rewards?.bonus !== undefined) {
    if (!Array.isArray(def.rewards.bonus)) errs.push(`quest ${def.id}: rewards.bonus must be an array`);
    else for (let i = 0; i < def.rewards.bonus.length; i++) {
      const b = def.rewards.bonus[i] as { id?: unknown; count?: unknown };
      if (typeof b?.id !== 'string' || !b.id) errs.push(`quest ${def.id}: rewards.bonus[${i}].id must be a non-empty string`);
      if (!Number.isInteger(b?.count) || (b.count as number) < 1)
        errs.push(`quest ${def.id}: rewards.bonus[${i}].count must be an integer >= 1`);
    }
  }
  if (def.timed !== undefined) {
    const t = def.timed;
    if (!t || typeof t !== 'object') errs.push(`quest ${def.id}: timed must be an object`);
    else {
      if (!Number.isFinite(t.limitSeconds) || t.limitSeconds <= 0)
        errs.push(`quest ${def.id}: timed.limitSeconds must be a positive finite number (game-time seconds)`);
      if (!Number.isFinite(t.rewardScale) || t.rewardScale <= 0)
        errs.push(`quest ${def.id}: timed.rewardScale must be a positive finite number`);
    }
  }
  return errs;
}

/** Format a game-time countdown (seconds) as M:SS for the tracker/panels. */
export function formatTimedRemaining(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function resolveQuestsEnabled(spec: GameSpec): boolean {
  return spec.custom?.quests?.enabled ?? true;
}

// ---------------------------------------------------------------------------
// Seeded quest pool
// ---------------------------------------------------------------------------

interface QuestBuildCtx {
  rng: Rng;
  spec: GameSpec;
  recipePool: CraftingRecipe[];
  enemyKinds: string[];
  crafting: boolean;
  portals: boolean;
  includeTalk: boolean;
}

interface QuestTemplate {
  slug: string;
  name: string;
  brief: string;
  available: (ctx: QuestBuildCtx) => boolean;
  build: (ctx: QuestBuildCtx, id: string) => QuestDef;
}

/**
 * Curated story rewards (curated-quest-rewards wave): the theme-matched
 * reward table for this template slug, merged with the Studio-authored
 * override (custom.quests.rewardOverrides), plus the one small seeded
 * bonus-material line from an INDEPENDENT stream (pure function of
 * (pool seed, slug) — replicable without replaying the pool).
 */
function storyRewardsFor(spec: GameSpec, slug: string): QuestRewardDef {
  const curated = curatedQuestReward(spec, slug);
  if (!curated) throw new Error(`[quests] no curated reward table for story slug "${slug}"`);
  return {
    xp: curated.xp,
    items: curated.items,
    bonus: [questBonusItem(spec.meta.seed, slug)],
  };
}

const QUEST_CATALOG: QuestTemplate[] = [
  {
    slug: 'first_blood',
    name: 'First Blood',
    brief: 'The wilds press closer every night. Thin their numbers and the settlement will see you paid.',
    available: (ctx) => ctx.enemyKinds.length > 0,
    build: (ctx, id) => {
      const kind = ctx.enemyKinds[0];
      const count = 4 + ctx.rng.int(0, 3);
      return {
        id, name: 'First Blood', giver: 'villager',
        brief: 'The wilds press closer every night. Thin their numbers and the settlement will see you paid.',
        objectives: [{ id: 'obj-kill', kind: 'kill', desc: `Defeat ${count} ${kind}s`, target: kind, count }],
        rewards: storyRewardsFor(ctx.spec, 'first_blood'),
      };
    },
  },
  {
    slug: 'big_game',
    name: 'Big Game',
    brief: 'Something big stalks the treeline. Bring it down and the hunters will remember your name.',
    available: (ctx) => ctx.enemyKinds.includes('brute') || ctx.enemyKinds.length > 1,
    build: (ctx, id) => {
      const kind = ctx.enemyKinds.includes('brute') ? 'brute' : ctx.enemyKinds[ctx.enemyKinds.length - 1];
      const count = 2 + ctx.rng.int(0, 2);
      return {
        id, name: 'Big Game', giver: 'villager',
        brief: 'Something big stalks the treeline. Bring it down and the hunters will remember your name.',
        objectives: [{ id: 'obj-kill', kind: 'kill', desc: `Defeat ${count} ${kind}s`, target: kind, count }],
        rewards: storyRewardsFor(ctx.spec, 'big_game'),
      };
    },
  },
  {
    slug: 'the_forager',
    name: 'The Forager',
    brief: 'We are running low on raw materials. The land provides — take what you need and bring it home.',
    available: (ctx) => ctx.crafting,
    build: (ctx, id) => {
      const count = 4 + ctx.rng.int(0, 2);
      return {
        id, name: 'The Forager', giver: 'villager',
        brief: 'We are running low on raw materials. The land provides — take what you need and bring it home.',
        objectives: [{ id: 'obj-gather', kind: 'gather', desc: `Gather ${count} raw materials`, target: 'any', count }],
        rewards: storyRewardsFor(ctx.spec, 'the_forager'),
      };
    },
  },
  {
    slug: 'the_maker',
    name: 'The Maker',
    brief: 'A steady hand at the workbench is worth a squad of guards. Make something useful.',
    available: (ctx) => {
      if (!ctx.crafting || ctx.recipePool.length === 0) return false;
      return ctx.recipePool.some((r) => r.minLevel === undefined);
    },
    build: (ctx, id) => {
      const candidates = ctx.recipePool.filter((r) => r.minLevel === undefined);
      // Prefer station-free recipes (craftable at any workbench); fall back
      // to a stationed one and name the station in the objective.
      const recipe = candidates.find((r) => !r.stationId) ?? candidates[0];
      const where = recipe.stationId ? ` at a ${stationShortName(recipe.stationId)}` : '';
      return {
        id, name: 'The Maker', giver: 'villager',
        brief: 'A steady hand at the workbench is worth a squad of guards. Make something useful.',
        objectives: [{
          id: 'obj-craft', kind: 'craft',
          desc: `Craft ${recipe.name}${where}`,
          target: recipe.id, count: 1,
        }],
        rewards: storyRewardsFor(ctx.spec, 'the_maker'),
      };
    },
  },
  {
    slug: 'word_travels',
    name: 'Word Travels',
    brief: 'Word travels faster than feet. Speak with the others — hear what the settlement fears.',
    available: (ctx) => ctx.includeTalk,
    build: (ctx, id) => {
      const count = 2 + ctx.rng.int(0, 2);
      return {
        id, name: 'Word Travels', giver: 'villager',
        brief: 'Word travels faster than feet. Speak with the others — hear what the settlement fears.',
        objectives: [{ id: 'obj-talk', kind: 'talk', desc: `Speak with ${count} villagers`, target: 'villager', count }],
        rewards: storyRewardsFor(ctx.spec, 'word_travels'),
      };
    },
  },
  {
    slug: 'wayfarer',
    name: 'Wayfarer',
    brief: 'There are doors between worlds out here. Walk through one and come back to tell the tale.',
    available: (ctx) => ctx.portals,
    build: (ctx, id) => {
      const count = 1 + ctx.rng.int(0, 1);
      return {
        id, name: 'Wayfarer', giver: 'villager',
        brief: 'There are doors between worlds out here. Walk through one and come back to tell the tale.',
        objectives: [{
          id: 'obj-explore', kind: 'explore',
          desc: count === 1 ? 'Pass through a portal' : `Pass through ${count} portals`,
          target: 'portals', count,
        }],
        rewards: storyRewardsFor(ctx.spec, 'wayfarer'),
      };
    },
  },
];

function stationShortName(stationId: string): string {
  const m: Record<string, string> = {
    station_workbench: 'Workbench',
    station_anvil: 'Anvil',
    station_forge: 'Forge',
    station_alchemy: 'Alchemy Lab',
  };
  return m[stationId] ?? stationId;
}

export interface BuildQuestPoolOpts {
  /**
   * false in genres without villagers (fps/arena, platformer, topdown never
   * construct the talk session) — the talk quest is filtered out of the pool.
   */
  includeTalk?: boolean;
}

/**
 * Seeded main-story quest pool. Pure function of (spec, opts): same spec →
 * identical quest ids, names, objectives, targets, counts, rewards, chain.
 * 3-5 quests (seeded), chained — quest N requires quest N-1 turned in.
 */
export function buildQuestPool(spec: GameSpec, opts: BuildQuestPoolOpts = {}): QuestDef[] {
  const rng = new Rng((spec.meta.seed ^ QUEST_SALT) >>> 0);
  const includeTalk = opts.includeTalk ?? spec.meta.genre === 'third-person-action';
  const ctx: QuestBuildCtx = {
    rng,
    spec,
    recipePool: buildRecipePool(spec),
    enemyKinds: (spec.enemies ?? []).map((e) => e.kind),
    crafting: resolveCraftingEnabled(spec),
    portals: portalsEnabled(spec),
    includeTalk,
  };
  const eligible = QUEST_CATALOG.filter((t) => t.available(ctx));
  // Studio-authored exact count wins; otherwise the seeded 3..5.
  const authored = spec.custom?.quests?.questCount;
  let count: number;
  if (typeof authored === 'number' && Number.isFinite(authored)) {
    count = Math.max(1, Math.min(8, Math.floor(authored)));
  } else {
    count = 3 + Math.floor(rng.next() * 3);
  }
  count = Math.min(count, eligible.length);
  const picked = rng.shuffle([...eligible]).slice(0, count);
  const defs = picked.map((t, i) => t.build(ctx, `quest_story_${i + 1}_${t.slug}`));
  // the quest line: each quest unlocks when the previous is turned in
  defs.forEach((d, i) => {
    if (i > 0) d.requiresQuests = [defs[i - 1].id];
  });
  return defs;
}

// ---------------------------------------------------------------------------
// requires/produces seam (Interaction.ts Interactable fields)
// ---------------------------------------------------------------------------

/** `quest:turned-in:<questId>` expressions for a def's prerequisites. */
export function questRequiresFor(def: QuestDef): string[] {
  return (def.requiresQuests ?? []).map((q) => `quest:turned-in:${q}`);
}

/** `quest:accept:<id>` / `quest:turnin:<id>` production tokens. */
export function questProducesFor(action: 'accept' | 'turnin', def: QuestDef): string {
  return `quest:${action}:${def.id}`;
}

// ---------------------------------------------------------------------------
// QuestManager — player-scoped quest state
// ---------------------------------------------------------------------------

export interface QuestManagerOpts {
  defs: QuestDef[];
  /** live inventory sink (null = no inventory; item rewards are skipped honestly) */
  inventory: () => { add(itemId: string, count: number): number } | null;
  /** item def table — reward ids without a def are skipped, never granted blind */
  defsTable: () => Record<string, ItemDef>;
  progression: Progression | null;
  tracker?: QuestTracker | null;
  /**
   * Called after any quest state change (accept/progress/turn-in/restore).
   * Blueprints wire the talk session's dialogue refresh here so an open
   * quest dialogue live-updates when its quest completes mid-conversation.
   */
  onQuestsChanged?: () => void;
  /** toast surface */
  toast: (msg: string) => void;
  /** portal transition counter (explore objectives); default 0 = no portals */
  getTransitions?: () => number;
  /**
   * Current map coordinate for explore objectives with target 'maps' /
   * 'biomes' (side-quests wave). Null = unknown (no tracking that frame).
   * Blueprints wire engine.portalManager?.coord.
   */
  getCurrentMap?: () => { mx: number; my: number } | null;
  /**
   * World seed for deriveMapBiome (side-quests wave 'biomes' objectives).
   * Blueprints wire the portal manager's world seed (NOT spec.meta.seed,
   * which is the current map's build seed).
   */
  worldSeed?: number;
  /**
   * Genres without villagers: the story line auto-accepts at construction
   * and auto-turns-in on completion (no dialogue exists to do it).
   */
  autoAccept?: boolean;
  /**
   * factions-reputation wave: current standing for a faction id.
   * Absent = 0 for every faction (unknown = neutral default). The
   * blueprint wires this to the live FactionStandings object; the
   * standings onChange hook calls refreshStandingGates().
   */
  standingOf?: (factionId: string) => number;
  /**
   * factions-reputation wave: called after a quest's rewards land and
   * its status flips to turned-in. The blueprint wires it to
   * standings.onQuestComplete(def). Observe-only — it never changes
   * the turn-in itself.
   */
  onQuestTurnedIn?: (def: QuestDef) => void;
  /** called after an XP grant causes a level-up (blueprint wires the modal);
   * progression-curve: carries the LevelGain so stat growth applies. */
  onLevelUp?: (gain?: LevelGain) => void;
}

/** Portal-safe quest snapshot (mirrors Progression.portalSnapshot). */
export interface QuestPortalSnapshot {
  version: 1;
  states: Record<string, { status: QuestStatus; progress: number[]; elapsed?: number }>;
  /**
   * Side-quests wave: distinct maps / biomes visited (explore 'maps' /
   * 'biomes' objectives). Optional so story-wave snapshots restore cleanly.
   */
  visited?: { maps: string[]; biomes: string[] };
}

export interface NpcQuestActions {
  accept: QuestDef[];
  turnIn: QuestDef[];
  locked: QuestDef[];
  /**
   * timed-quests wave: failed timed quests this giver can offer again.
   * The dialogue shows them as Retry buttons (reaccept()); the timed
   * board panel shows the same path as Try again.
   */
  failed: QuestDef[];
}

export class QuestManager {
  private readonly quests: QuestRuntime[];
  private readonly byId = new Map<string, QuestRuntime>();
  private lastTransitions: number;
  private readonly autoAccept: boolean;
  /**
   * timed-quests wave: last whole-second countdown value displayed per
   * timed quest id. update() refreshes the tracker only when a whole
   * second ticks over, so the countdown is event-driven (≤1 DOM update
   * per second per active timed quest) with zero per-frame DOM cost.
   */
  private readonly lastWholeRemaining = new Map<string, number>();
  /** side-quests wave: distinct maps/biomes visited (explore objectives) */
  private readonly visitedMaps = new Set<string>();
  private readonly visitedBiomes = new Set<string>();
  private lastMx = Number.NaN;
  private lastMy = Number.NaN;

  constructor(private readonly opts: QuestManagerOpts) {
    this.autoAccept = opts.autoAccept ?? false;
    this.quests = opts.defs.map((def) => ({
      def,
      status: 'locked' as QuestStatus,
      progress: def.objectives.map(() => 0),
      elapsedSeconds: 0,
    }));
    for (const q of this.quests) this.byId.set(q.def.id, q);
    if (this.quests.length > 0) {
      this.quests[0].status = 'available';
    }
    // side-quests wave: independent quests are available from the start.
    for (const q of this.quests) {
      if (q.def.side === true) q.status = 'available';
    }
    // factions-reputation wave: standing gates demote anything gated
    // and unmet back to locked — including side quests — before any
    // auto-accept runs, so a gated quest can never start locked-out.
    this.applyStandingGates();
    if (this.autoAccept) {
      // No villagers in this genre: accept everything offerable now (no
      // dialogue exists to do it); completion auto-turns-in as before.
      for (const q of this.quests) {
        if (q.status === 'available') this.accept(q.def.id);
      }
    }
    this.lastTransitions = this.transitions();
    this.refreshTracker();
  }

  /** All quest defs in line order. */
  get defs(): QuestDef[] {
    return this.quests.map((q) => q.def);
  }

  /**
   * Radiant-quests wave: register radiant defs AFTER construction (the
   * radiant board generates them from the live player level / map seed,
   * which do not exist at construction time). Additive only: a def is
   * accepted only when it passes validateQuestDef, carries radiant: true,
   * has no chain and no standing gate, and is not already registered;
   * anything else is skipped (never throws — the board must survive a
   * bad offer without taking the manager down). Registered defs start
   * 'available' and are never auto-accepted, even in autoAccept genres
   * (auto-accept runs at construction only, by design — the board's
   * Accept button is the accept path for radiant quests everywhere).
   */
  registerRadiantDefs(defs: QuestDef[]): void {
    let changed = false;
    for (const def of defs) {
      if (!def || def.radiant !== true) continue;
      if (validateQuestDef(def).length > 0) continue;
      if (def.requiresQuests && def.requiresQuests.length > 0) continue;
      if (def.minStanding !== undefined) continue;
      if (this.byId.has(def.id)) continue;
      const runtime: QuestRuntime = { def, status: 'available', progress: def.objectives.map(() => 0), elapsedSeconds: 0 };
      this.quests.push(runtime);
      this.byId.set(def.id, runtime);
      changed = true;
    }
    if (changed) this.refreshTracker();
  }

  /**
   * Timed-quests wave: register timed defs AFTER construction (the
   * timed board generates them from the live map seed, which does not
   * exist at construction time — the same shape as registerRadiantDefs).
   * Additive only: a def is accepted only when it passes
   * validateQuestDef, carries a timed countdown, has no chain and no
   * standing gate, is not already registered, and is not radiant;
   * anything else is skipped (never throws — the board must survive a
   * bad offer without taking the manager down). Registered defs start
   * 'available' and are never auto-accepted, even in autoAccept genres
   * (auto-accept runs at construction only — the board's Accept button
   * and the villager dialogue are the accept paths for timed quests).
   */
  registerTimedDefs(defs: QuestDef[]): void {
    let changed = false;
    for (const def of defs) {
      if (!def || def.timed === undefined) continue;
      if (def.radiant === true) continue;
      if (validateQuestDef(def).length > 0) continue;
      if (def.requiresQuests && def.requiresQuests.length > 0) continue;
      if (def.minStanding !== undefined) continue;
      if (this.byId.has(def.id)) continue;
      const runtime: QuestRuntime = {
        def,
        status: 'available',
        progress: def.objectives.map(() => 0),
        elapsedSeconds: 0,
      };
      this.quests.push(runtime);
      this.byId.set(def.id, runtime);
      changed = true;
    }
    if (changed) this.refreshTracker();
  }

  /**
   * Timed-quests wave: drop a timed def from the roster. Only timed
   * defs in 'available', 'turned-in', or 'failed' states are removable
   * this way — an active/complete timed quest must go through
   * abandon()/turnIn() so progress is never silently discarded.
   * Unknown ids and non-timed defs are no-ops. The board calls this
   * when it re-rolls a slot (turned-in def out, fresh offer in).
   */
  removeTimedDef(id: string): boolean {
    const q = this.byId.get(id);
    if (!q || q.def.timed === undefined) return false;
    if (q.status !== 'available' && q.status !== 'turned-in' && q.status !== 'failed') return false;
    this.quests.splice(this.quests.indexOf(q), 1);
    this.byId.delete(id);
    this.lastWholeRemaining.delete(id);
    this.refreshTracker();
    return true;
  }

  /**
   * Timed-quests wave: re-accept a FAILED timed quest. The countdown
   * restarts from the full limit and objective progress resets to
   * zero — the retry is a fresh attempt, never a resume. Returns false
   * for unknown ids, non-timed defs, and any status other than
   * 'failed': story/side/radiant quests are untouched by this method,
   * and a failed quest grants no partial reward on either side of the
   * retry (expiry grants nothing; the retry must complete in time to
   * earn the scaled reward through the normal turn-in path).
   */
  reaccept(id: string): boolean {
    const q = this.byId.get(id);
    if (!q || q.def.timed === undefined || q.status !== 'failed') return false;
    q.status = 'active';
    q.progress = q.def.objectives.map(() => 0);
    q.elapsedSeconds = 0;
    this.lastWholeRemaining.delete(id);
    this.opts.toast(`Quest re-accepted: ${q.def.name} — ${formatTimedRemaining(q.def.timed.limitSeconds)} on the clock`);
    this.refreshTracker();
    return true;
  }

  /**
   * Timed-quests wave: game-time seconds left on a timed quest's
   * countdown (limit minus elapsed, clamped at 0). Null for unknown
   * ids and non-timed defs. A failed quest reports 0; a quest that
   * has not started yet reports the full limit.
   */
  timeRemaining(id: string): number | null {
    const q = this.byId.get(id);
    if (!q || !q.def.timed) return null;
    return Math.max(0, q.def.timed.limitSeconds - q.elapsedSeconds);
  }

  /** Timed-quests wave: game-time seconds already spent on a timed quest (0 for unknown/non-timed). */
  elapsedOf(id: string): number {
    const q = this.byId.get(id);
    if (!q || !q.def.timed) return 0;
    return q.elapsedSeconds;
  }

  /**
   * Radiant-quests wave: drop a radiant def from the roster. Only
   * radiant defs in 'available', 'turned-in', or 'unknown' states are
   * removable this way — an active/complete radiant quest must go
   * through abandon()/turnIn() so progress is never silently discarded.
   * Unknown ids and non-radiant defs are no-ops. The board calls this
   * when it re-rolls a slot (turned-in or stale def out, fresh offer in).
   */
  removeRadiantDef(id: string): boolean {
    const q = this.byId.get(id);
    if (!q || q.def.radiant !== true) return false;
    if (q.status !== 'available' && q.status !== 'turned-in') return false;
    this.quests.splice(this.quests.indexOf(q), 1);
    this.byId.delete(id);
    this.refreshTracker();
    return true;
  }

  /**
   * Radiant-quests wave: abandon an ACTIVE radiant quest. The def leaves
   * the roster entirely (progress discarded — the board re-rolls the
   * slot deterministically, so the player is never left with a dead
   * slot). Timed-quests wave: the same rule covers ACTIVE timed quests
   * (their countdown is discarded with the def). Returns false for
   * unknown ids, non-radiant/non-timed defs, and non-active statuses:
   * story/side quests can never be abandoned, so their lifecycle is
   * exactly unchanged by this method's existence.
   */
  abandon(id: string): boolean {
    const q = this.byId.get(id);
    if (!q || (q.def.radiant !== true && q.def.timed === undefined) || q.status !== 'active') return false;
    this.quests.splice(this.quests.indexOf(q), 1);
    this.byId.delete(id);
    this.lastWholeRemaining.delete(id);
    this.opts.toast(`Quest abandoned: ${q.def.name}`);
    this.refreshTracker();
    return true;
  }

  /** Status of a quest ('unknown' when the id is not in this pool). */
  statusOf(id: string): QuestStatus | 'unknown' {
    return this.byId.get(id)?.status ?? 'unknown';
  }

  /** Objective progress counts for a quest (empty array when unknown). */
  progressOf(id: string): number[] {
    return [...(this.byId.get(id)?.progress ?? [])];
  }

  private transitions(): number {
    try {
      return this.opts.getTransitions?.() ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Per-frame: explore objectives. 'portals' reads the transition counter;
   * 'maps' / 'biomes' (side-quests wave) sample the current map coordinate
   * and derive the biome — each distinct map/biome counts once. The home
   * map is seeded on the first update (counts as the first visited map).
   */
  update(_dt: number): void {
    const coord = this.opts.getCurrentMap?.() ?? null;
    if (coord && (coord.mx !== this.lastMx || coord.my !== this.lastMy)) {
      this.lastMx = coord.mx;
      this.lastMy = coord.my;
      const key = `${coord.mx},${coord.my}`;
      if (!this.visitedMaps.has(key)) {
        this.visitedMaps.add(key);
        this.advance('explore', 'maps', 1);
      }
      const ws = this.opts.worldSeed;
      if (typeof ws === 'number' && Number.isFinite(ws)) {
        const biome = deriveMapBiome(ws, coord.mx, coord.my);
        if (!this.visitedBiomes.has(biome)) {
          this.visitedBiomes.add(biome);
          this.advance('explore', 'biomes', 1);
        }
      }
    }
    const t = this.transitions();
    if (t > this.lastTransitions) {
      const d = t - this.lastTransitions;
      this.lastTransitions = t;
      this.advance('explore', 'portals', d);
    } else {
      this.lastTransitions = t;
    }
    this.tickTimedQuests(_dt);
  }

  /**
   * Timed-quests wave: the game-time countdown. Runs AFTER the explore
   * advances above, so a quest completed by a portal crossing in this
   * same update is 'complete' and its timer stops instead of failing.
   * Only 'active' timed quests consume game-time; dt is the frame
   * loop's game-time step (never a wall-clock sample), so the timer
   * pauses whenever update() is not called (pause, loading, portal
   * transition) and preserves exactly across portal travel via the
   * snapshot/restore pair. Expiry flips the quest to 'failed' with no
   * partial reward — the board/dialogue re-accept path (reaccept())
   * is the only way back in.
   */
  private tickTimedQuests(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const expired: QuestRuntime[] = [];
    for (const q of [...this.quests]) {
      if (q.status !== 'active' || !q.def.timed) continue;
      q.elapsedSeconds += step;
      if (q.elapsedSeconds >= q.def.timed.limitSeconds) expired.push(q);
    }
    for (const q of expired) {
      q.status = 'failed';
      this.lastWholeRemaining.delete(q.def.id);
      this.opts.toast(`Quest failed: ${q.def.name} — time ran out`);
    }
    // Countdown display: refresh the tracker only when a whole second
    // ticks over for a displayed timed quest (event-driven, not
    // per-frame). Expiry always refreshes (the failed quest leaves the
    // tracker and the board/dialogue re-accept surfaces appear).
    let secondChanged = false;
    for (const q of this.quests) {
      if (q.status !== 'active' || !q.def.timed) continue;
      const whole = Math.max(0, Math.ceil(q.def.timed.limitSeconds - q.elapsedSeconds));
      if (this.lastWholeRemaining.get(q.def.id) !== whole) {
        this.lastWholeRemaining.set(q.def.id, whole);
        secondChanged = true;
      }
    }
    if (expired.length > 0 || secondChanged) this.refreshTracker();
  }

  /** Current standing for a faction (opts.standingOf, or 0 when unwired). */
  standingOf(factionId: string): number {
    try {
      const v = this.opts.standingOf?.(factionId) ?? 0;
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }

  /** True when a def's standing gate (if any) is satisfied right now. */
  standingSatisfied(def: QuestDef): boolean {
    const g = def.minStanding;
    if (!g) return true;
    return this.standingOf(g.factionId) >= g.min;
  }

  /**
   * factions-reputation wave: demote gated-and-unmet quests that are
   * still offerable (available/locked) to locked. Never touches active /
   * complete / turned-in quests — the gate is accept-path only.
   */
  applyStandingGates(): void {
    for (const q of this.quests) {
      if ((q.status === 'available' || q.status === 'locked') && !this.standingSatisfied(q.def)) {
        q.status = 'locked';
      }
    }
  }

  /**
   * factions-reputation wave: unlock gated quests whose prerequisites
   * AND standing gate are now satisfied. The blueprint calls this from
   * the standings onChange hook; it is a no-op when nothing changed.
   */
  refreshStandingGates(): void {
    let changed = false;
    for (const q of this.quests) {
      if (q.status !== 'locked') continue;
      if (!this.requiresSatisfied(q.def) || !this.standingSatisfied(q.def)) continue;
      q.status = 'available';
      changed = true;
      this.opts.toast(`New quest available: ${q.def.name}`);
      if (this.autoAccept) this.accept(q.def.id);
    }
    if (changed) this.refreshTracker();
  }

  /** Accept an available quest. Returns false when not acceptable. */
  accept(id: string): boolean {
    const q = this.byId.get(id);
    if (!q || q.status !== 'available') return false;
    // factions-reputation wave: the accept path re-checks the gate, so
    // a standing drop after unlock cannot sneak a gated quest through.
    if (!this.standingSatisfied(q.def)) {
      q.status = 'locked';
      this.opts.toast(`Requires standing: ${q.def.minStanding?.factionId} ${q.def.minStanding?.min}`);
      this.refreshTracker();
      return false;
    }
    q.status = 'active';
    this.opts.toast(`Quest accepted: ${q.def.name}`);
    this.refreshTracker();
    return true;
  }

  /**
   * Turn in a completed quest: grants XP + items, marks turned-in, unlocks
   * the next quest in the line. Returns false when not turn-in-able.
   */
  turnIn(id: string): boolean {
    const q = this.byId.get(id);
    if (!q || q.status !== 'complete') return false;
    // XP first (mirrors the kill-XP-before-progress ordering rule: rewards
    // land before the quest leaves the tracker).
    const prog = this.opts.progression;
    if (prog && q.def.rewards.xp > 0) {
      // progression-curve: quest turn-ins ride the one additive XP path;
      // the gain flows to the blueprint's level-up modal + stat growth.
      const r = prog.addXpEx(q.def.rewards.xp);
      if (r.leveled) this.opts.onLevelUp?.(r.gain ?? undefined);
    }
    // Items: only ids with a real def — never grant blind. The curated
    // items land first, then the small seeded bonus-material line (same
    // skip-when-missing-def honesty).
    const table = this.opts.defsTable();
    const inv = this.opts.inventory();
    for (const item of q.def.rewards.items) {
      if (!table[item.id]) continue;
      inv?.add(item.id, item.count);
    }
    for (const item of q.def.rewards.bonus ?? []) {
      if (!table[item.id]) continue;
      inv?.add(item.id, item.count);
    }
    q.status = 'turned-in';
    this.opts.toast(`Quest complete: ${q.def.name}`);
    // factions-reputation wave: the standing reward lands here, after
    // the quest's own rewards and status flip. The hook may unlock
    // gated quests synchronously (via the blueprint's onChange ->
    // refreshStandingGates); the unlock loop below then skips them
    // because they are already available.
    try { this.opts.onQuestTurnedIn?.(q.def); } catch (e) { console.warn('[quests] onQuestTurnedIn threw', e); }
    // unlock the next link in the line (standing gates respected: a
    // gated quest whose gate is unmet stays locked until
    // refreshStandingGates() runs on a standings change)
    for (const next of this.quests) {
      if (next.status === 'locked' && this.requiresSatisfied(next.def) && this.standingSatisfied(next.def)) {
        next.status = 'available';
        this.opts.toast(`New quest available: ${next.def.name}`);
        if (this.autoAccept) this.accept(next.def.id);
      }
    }
    this.refreshTracker();
    return true;
  }

  /** True when every prerequisite quest is turned in. */
  requiresSatisfied(def: QuestDef): boolean {
    return (def.requiresQuests ?? []).every((qid) => this.byId.get(qid)?.status === 'turned-in');
  }

  /**
   * Quest actions a villager of the given role can offer — drives both the
   * dialogue buttons and the requires/produces stamping on interactables.
   */
  actionsForNpc(role: string): NpcQuestActions {
    const giverMatch = (d: QuestDef) => d.giver === 'any' || d.giver === role;
    return {
      accept: this.quests.filter((q) => q.status === 'available' && giverMatch(q.def)).map((q) => q.def),
      turnIn: this.quests.filter((q) => q.status === 'complete' && giverMatch(q.def)).map((q) => q.def),
      locked: this.quests.filter((q) => q.status === 'locked' && giverMatch(q.def)).map((q) => q.def),
      failed: this.quests.filter((q) => q.status === 'failed' && q.def.timed !== undefined && giverMatch(q.def)).map((q) => q.def),
    };
  }

  // -- quest events (the data-driven hook table: kind -> event method) --

  /** Enemy killed (blueprint onDeath calls this with e.spec.kind). */
  onKill(kind: string): void {
    this.advance('kill', kind, 1);
  }

  /** Materials harvested (GatheringManager onHarvested). */
  onHarvest(materialId: string, count: number): void {
    this.advance('gather', materialId, count);
    this.advance('gather', 'any', count);
  }

  /** Recipe crafted (CraftingPanel onCrafted). */
  onCraft(recipeId: string): void {
    this.advance('craft', recipeId, 1);
  }

  /** Dialogue opened with an NPC (QuestTalkSession). */
  onTalk(role: string): void {
    this.advance('talk', role, 1);
    this.advance('talk', 'any', 1);
  }

  private advance(kind: QuestObjectiveKind, target: string, n: number): void {
    if (n <= 0) return;
    for (const q of this.quests) {
      if (q.status !== 'active') continue;
      let changed = false;
      q.def.objectives.forEach((o, i) => {
        if (o.kind !== kind) return;
        if (o.target !== target && o.target !== 'any') return;
        const before = q.progress[i];
        q.progress[i] = Math.min(o.count, before + n);
        if (q.progress[i] !== before) changed = true;
      });
      if (!changed) continue;
      const done = q.def.objectives.every((o, i) => q.progress[i] >= o.count);
      if (done) this.completeQuest(q);
      else this.refreshTracker();
    }
  }

  private completeQuest(q: QuestRuntime): void {
    q.status = 'complete';
    if (this.autoAccept) {
      // No villagers in this genre: turn in immediately (rewards granted now).
      this.refreshTracker();
      this.turnIn(q.def.id);
      return;
    }
    this.opts.toast(`Objective complete: ${q.def.name} — return to a villager`);
    this.refreshTracker();
  }

  // -- portal persistence (player-scoped, mirrors Progression) --

  /** Freeze quest state for a portal transition / rebuild. Pure data copy. */
  portalSnapshot(): QuestPortalSnapshot {
    const states: QuestPortalSnapshot['states'] = {};
    for (const q of this.quests) {
      // timed-quests wave: the countdown elapsed rides the snapshot so
      // portal travel preserves the timer exactly (no wall-clock is
      // involved anywhere, so the transition itself consumes nothing
      // beyond what update() is called with while playing).
      states[q.def.id] = {
        status: q.status,
        progress: [...q.progress],
        ...(q.def.timed !== undefined ? { elapsed: q.elapsedSeconds } : {}),
      };
    }
    return {
      version: 1,
      states,
      visited: { maps: [...this.visitedMaps], biomes: [...this.visitedBiomes] },
    };
  }

  /**
   * Restore a portalSnapshot(). Defensive: unknown ids are dropped, corrupt
   * statuses clamp to 'locked', progress clamps to [0, objective count],
   * timed elapsed clamps to [0, limit] (a quest restored at its limit
   * fails on the next update tick, honestly), visited sets accept only
   * string arrays (re-visits re-count honestly).
   */
  portalRestore(snap: QuestPortalSnapshot | null | undefined): void {
    if (!snap || snap.version !== 1 || !snap.states || typeof snap.states !== 'object') return;
    const valid: QuestStatus[] = ['locked', 'available', 'active', 'complete', 'turned-in', 'failed'];
    for (const q of this.quests) {
      const s = snap.states[q.def.id];
      if (!s) continue;
      q.status = valid.includes(s.status) ? s.status : 'locked';
      q.progress = q.def.objectives.map((o, i) => {
        const v = s.progress?.[i];
        return Number.isFinite(v) ? Math.max(0, Math.min(o.count, Math.floor(v as number))) : 0;
      });
      if (q.def.timed !== undefined) {
        const e = s.elapsed;
        q.elapsedSeconds = Number.isFinite(e)
          ? Math.max(0, Math.min(q.def.timed.limitSeconds, e as number))
          : 0;
        this.lastWholeRemaining.delete(q.def.id);
      } else {
        q.elapsedSeconds = 0;
      }
    }
    this.visitedMaps.clear();
    this.visitedBiomes.clear();
    const v = snap.visited;
    if (v && typeof v === 'object') {
      const maps = Array.isArray(v.maps) ? v.maps : [];
      const biomes = Array.isArray(v.biomes) ? v.biomes : [];
      for (const m of maps) if (typeof m === 'string') this.visitedMaps.add(m);
      for (const b of biomes) if (typeof b === 'string') this.visitedBiomes.add(b);
    }
    this.refreshTracker();
  }

  // -- tracker --

  private snapshot(): QuestTrackerQuest[] {
    const out: QuestTrackerQuest[] = [];
    for (const q of this.quests) {
      if (q.status !== 'active' && q.status !== 'complete') continue;
      const lines = q.def.objectives.map((o, i) => {
        const p = Math.min(q.progress[i], o.count);
        const mark = p >= o.count ? '✓' : '•';
        return `${mark} ${o.desc} (${p}/${o.count})`;
      });
      if (q.status === 'complete') lines.push('✓ Complete — turn it in');
      // timed-quests wave: the game-time countdown rides the tracker as
      // one more event-driven line (refreshed only on whole-second ticks
      // and state changes — see tickTimedQuests). Failed quests never
      // reach the tracker (the board/dialogue re-accept surfaces own
      // that state), and turned-in quests are gone from it.
      if (q.status === 'active' && q.def.timed !== undefined) {
        lines.push(`⏱ ${formatTimedRemaining(q.def.timed.limitSeconds - q.elapsedSeconds)} left`);
      }
      out.push({ name: q.def.name, status: q.status, lines });
    }
    return out;
  }

  private refreshTracker(): void {
    this.opts.tracker?.render(this.snapshot());
    this.opts.onQuestsChanged?.();
  }
}
