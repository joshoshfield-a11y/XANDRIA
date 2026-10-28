/**
 * Timed quests (upgrade loop: timed-quests wave) — quests against a
 * game-time clock, built on the story/side/radiant quest system
 * (engine/game/quests.ts).
 *
 * Design (brief):
 *   (1) Timed-quest defs are data-driven in ONE table below
 *       (TIMED_TEMPLATES): four variants across the fetch / hunt /
 *       explore / craft archetypes. Each entry carries its time limit
 *       in GAME-TIME seconds, its fail outcome (always 'fail': no
 *       partial reward, re-accept from the board/giver), and its
 *       reward scale — all tuning lives in the table, nowhere else.
 *   (2) The countdown is driven ONLY by QuestManager.update(dt)
 *       accumulation (see quests.ts tickTimedQuests): seeded RNG only,
 *       never Math.random/Date.now, and no wall-clock sampling
 *       anywhere. The tracker shows the countdown as an event-driven
 *       line, refreshed at most once per whole second. Portal travel
 *       PRESERVES the timer: elapsed rides the portal snapshot, and
 *       time spent in transition/loading/pause (periods when update()
 *       is not called) consumes nothing.
 *   (3) On expiry the quest fails cleanly: status 'failed', no reward
 *       of any kind, progress discarded on re-accept, and the timed
 *       board keeps the failed slot visible with a Try again button
 *       (manager reaccept()) instead of orphaning the def. The
 *       villager dialogue shows the same path as a Retry button.
 *   (4) Completion inside the limit grants the SCALED reward through
 *       the existing turn-in path unchanged: the scale is applied at
 *       BUILD time (xp and item counts), so turnIn() grants the def's
 *       rewards through the curated-reward lines exactly as for any
 *       other quest. The small seeded bonus-material line is NOT
 *       scaled (it is the same independent stream radiant uses).
 *
 * No new objective kinds: every template maps onto an existing
 * QuestObjectiveKind, so the quest lifecycle and the NPC/enemy public
 * behavior contracts are untouched. A timed def never chains and never
 * carries a standing gate (enforced by registerTimedDefs).
 *
 * Determinism: seeded RNG only. The offer sequence replays exactly
 * like the radiant sequence (Rng(mapSeed ^ TIMED_QUEST_SALT), one
 * shuffle, offer k is the k-th build off the stream), so board
 * re-rolls are independently replicable.
 */
import { Rng } from '../core/Rng';
import type { GameSpec } from '@spec';
import { BIOME_IDS, type BiomeId } from '@spec';
import { portalsEnabled } from '@spec';
import {
  buildRecipePool,
  resolveCraftingEnabled,
  MAT_ORE,
  MAT_FIBER,
  MAT_SCRAP,
  type CraftingRecipe,
} from './crafting';
import { questBonusItem, QR_CRAFT, QR_MATS } from './questRewards';
import type { QuestDef, QuestManager } from './quests';

/** Salt for the timed-offer stream — distinct from QUEST_SALT, SIDE_QUEST_SALT, RADIANT_SALT, and every other wave's salt. */
export const TIMED_QUEST_SALT = 0x54494d45; // 'TIME'

export type TimedArchetype = 'fetch' | 'hunt' | 'explore' | 'craft';

/** Biome -> harvestable material flavor (same completable-only set radiant uses). */
const BIOME_MATERIAL: Record<BiomeId, string> = {
  plains: MAT_FIBER,
  forest: MAT_FIBER,
  'desert-canyon': MAT_SCRAP,
  snow: MAT_ORE,
  volcanic: MAT_ORE,
  coastline: MAT_SCRAP,
  caves: MAT_ORE,
};

const BIOME_LABEL: Record<BiomeId, string> = {
  plains: 'Plains',
  forest: 'Forest',
  'desert-canyon': 'Canyon',
  snow: 'Snowfields',
  volcanic: 'Ember Wastes',
  coastline: 'Coast',
  caves: 'Caves',
};

const MATERIAL_LABEL: Record<string, string> = {
  [MAT_ORE]: 'ore',
  [MAT_FIBER]: 'fiber',
  [MAT_SCRAP]: 'scrap',
};

interface TimedBuildCtx {
  rng: Rng;
  spec: GameSpec;
  recipePool: CraftingRecipe[];
  enemyKinds: string[];
  crafting: boolean;
  portals: boolean;
  mapSeed: number;
}

interface TimedTemplate {
  slug: string;
  archetype: TimedArchetype;
  /** Game-time seconds on the clock (update(dt) accumulation only). */
  limitSeconds: number;
  /** Multiplier applied to the base XP and item counts at build time. */
  rewardScale: number;
  /** XP before scaling: granted xp = round(baseXp * rewardScale). */
  baseXp: number;
  available: (ctx: TimedBuildCtx) => boolean;
  build: (ctx: TimedBuildCtx, id: string) => QuestDef;
}

/**
 * Apply a template's reward scale at build time. XP rounds to the
 * nearest whole point; item counts round to the nearest whole item
 * (never below 1, so a scale can never zero out a reward line). The
 * bonus-material line is generated unscaled, exactly as radiant does.
 */
function timedRewards(
  ctx: TimedBuildCtx,
  slug: string,
  baseXp: number,
  scale: number,
  items: { id: string; count: number }[],
): QuestDef['rewards'] {
  return {
    xp: Math.round(baseXp * scale),
    items: items.map((r) => ({ id: r.id, count: Math.max(1, Math.round(r.count * scale)) })),
    bonus: [questBonusItem(ctx.mapSeed, slug)],
  };
}

/**
 * THE data-driven timed table — one entry per variant. Adding a new
 * timed variant = one entry here; no dispatch changes anywhere. Limits
 * are tuned so a focused player finishes with time to spare and a
 * dawdling one fails: fetch/hunt/craft are single-map work, explore
 * needs portal crossings.
 */
export const TIMED_TEMPLATES: TimedTemplate[] = [
  {
    slug: 'timed_fetch',
    archetype: 'fetch',
    limitSeconds: 240,
    rewardScale: 1.25,
    baseXp: 60,
    available: (ctx) => ctx.crafting,
    build: (ctx, id) => {
      const biome = ctx.rng.pick(BIOME_IDS);
      const material = BIOME_MATERIAL[biome];
      const count = 4 + ctx.rng.int(0, 2);
      return {
        id, name: `Rush Order: ${BIOME_LABEL[biome]} Supplies`, giver: 'villager',
        brief: `A caravan leaves soon and the ${BIOME_LABEL[biome].toLowerCase()} stores are short. ${count} ${MATERIAL_LABEL[material]} before the clock runs out — or not at all.`,
        objectives: [{ id: 'obj-fetch', kind: 'gather', desc: `Fetch ${count} ${MATERIAL_LABEL[material]} in time`, target: material, count }],
        rewards: timedRewards(ctx, 'timed_fetch', 60, 1.25, [{ id: material, count: 3 }]),
        timed: { limitSeconds: 240, rewardScale: 1.25 },
      };
    },
  },
  {
    slug: 'timed_hunt',
    archetype: 'hunt',
    limitSeconds: 300,
    rewardScale: 1.5,
    baseXp: 80,
    available: (ctx) => ctx.enemyKinds.length > 0,
    build: (ctx, id) => {
      const kind = ctx.rng.pick(ctx.enemyKinds);
      const count = 4 + ctx.rng.int(0, 2);
      return {
        id, name: `Cull Order: ${kind}s`, giver: 'villager',
        brief: `The ${kind}s are massing and the watch wants them thinned NOW. ${count} kills before the clock runs out — or not at all.`,
        objectives: [{ id: 'obj-hunt', kind: 'kill', desc: `Defeat ${count} ${kind}s in time`, target: kind, count }],
        rewards: timedRewards(ctx, 'timed_hunt', 80, 1.5, [{ id: QR_MATS.beastHide, count: 2 }]),
        timed: { limitSeconds: 300, rewardScale: 1.5 },
      };
    },
  },
  {
    slug: 'timed_explore',
    archetype: 'explore',
    limitSeconds: 360,
    rewardScale: 1.25,
    baseXp: 60,
    available: (ctx) => ctx.portals,
    build: (ctx, id) => {
      const count = 2;
      return {
        id, name: 'Courier Run', giver: 'villager',
        brief: 'A message has to reach the far side before the route closes. Two portal crossings, one clock — or not at all.',
        objectives: [{ id: 'obj-explore', kind: 'explore', desc: `Pass through ${count} portals in time`, target: 'portals', count }],
        rewards: timedRewards(ctx, 'timed_explore', 60, 1.25, [{ id: QR_CRAFT.scrapBuckler, count: 1 }]),
        timed: { limitSeconds: 360, rewardScale: 1.25 },
      };
    },
  },
  {
    slug: 'timed_craft',
    archetype: 'craft',
    limitSeconds: 300,
    rewardScale: 1.5,
    baseXp: 70,
    available: (ctx) => ctx.crafting && ctx.recipePool.length > 0,
    build: (ctx, id) => {
      const candidates = ctx.recipePool.filter((r) => !r.stationId);
      const recipe = candidates.length > 0 ? ctx.rng.pick(candidates) : ctx.rng.pick(ctx.recipePool);
      return {
        id, name: `Rush Commission: ${recipe.name}`, giver: 'villager',
        brief: `A client is waiting at the gate for ${recipe.name}. Make it before the clock runs out — or not at all.`,
        objectives: [{ id: 'obj-craft', kind: 'craft', desc: `Craft ${recipe.name} in time`, target: recipe.id, count: 1 }],
        rewards: timedRewards(ctx, 'timed_craft', 70, 1.5, [{ id: QR_CRAFT.fieldKit, count: 1 }]),
        timed: { limitSeconds: 300, rewardScale: 1.5 },
      };
    },
  },
];

/** Eligible templates for a spec (availability only — no rng consumed here). */
export function eligibleTimedTemplates(spec: GameSpec): TimedTemplate[] {
  const probe: TimedBuildCtx = {
    rng: new Rng(1),
    spec,
    recipePool: buildRecipePool(spec),
    enemyKinds: (spec.enemies ?? []).map((e) => e.kind),
    crafting: resolveCraftingEnabled(spec),
    portals: portalsEnabled(spec),
    mapSeed: spec.meta.seed,
  };
  return TIMED_TEMPLATES.filter((t) => t.available(probe));
}

/** Default board size: 3 of the 4 variants on show (the 4th cycles in on re-rolls). Authorable via custom.quests.timedCount (1..4). */
export function resolveTimedCount(spec: GameSpec): number {
  const authored = spec.custom?.quests?.timedCount;
  if (typeof authored === 'number' && Number.isFinite(authored)) {
    return Math.max(1, Math.min(4, Math.floor(authored)));
  }
  return 3;
}

interface TimedOfferCtx {
  mapSeed: number;
  count?: number;
}

function buildOfferFromStream(
  rng: Rng,
  ordered: TimedTemplate[],
  spec: GameSpec,
  mapSeed: number,
  seq: number,
): QuestDef {
  const template = ordered[seq % ordered.length];
  const ctx: TimedBuildCtx = {
    rng,
    spec,
    recipePool: buildRecipePool(spec),
    enemyKinds: (spec.enemies ?? []).map((e) => e.kind),
    crafting: resolveCraftingEnabled(spec),
    portals: portalsEnabled(spec),
    mapSeed,
  };
  return template.build(ctx, `quest_timed_${seq}_${template.slug}`);
}

/**
 * A deterministic offer sequence for one (spec, mapSeed): the base
 * stream is Rng(mapSeed ^ TIMED_QUEST_SALT), the template order is
 * that stream's first shuffle, and offer k is the k-th build off the
 * stream. Every consumer (board, tests, e2e replication) replays this
 * same sequence, so offer k is identical wherever it is generated.
 */
export function makeTimedSequence(spec: GameSpec, opts: TimedOfferCtx): { next: () => QuestDef | null } {
  const rng = new Rng((opts.mapSeed ^ TIMED_QUEST_SALT) >>> 0);
  const eligible = eligibleTimedTemplates(spec);
  const ordered = rng.shuffle([...eligible]);
  let seq = 0;
  return {
    next: () => {
      if (ordered.length === 0) return null;
      const def = buildOfferFromStream(rng, ordered, spec, opts.mapSeed, seq);
      seq += 1;
      return def;
    },
  };
}

/**
 * Pure offer set: the first `count` offers of the sequence for a
 * mapSeed. Same inputs -> identical set (ids, names, objectives,
 * targets, counts, rewards, timed limits/scales) — the determinism
 * contract. A count past the eligible-variant count cycles the
 * shuffled order again; the first N offers always cover distinct
 * archetypes while N <= eligible variants.
 */
export function buildTimedOffers(spec: GameSpec, opts: TimedOfferCtx): QuestDef[] {
  const count = opts.count ?? 3;
  const seq = makeTimedSequence(spec, opts);
  const out: QuestDef[] = [];
  for (let i = 0; i < count; i++) {
    const def = seq.next();
    if (!def) break;
    out.push(def);
  }
  return out;
}

/**
 * Pure single-offer replication: offer `index` of the sequence for a
 * mapSeed. The board's re-rolls are exactly this function at the
 * board's running sequence index, so an abandoned/turned-in slot's
 * replacement is independently replicable (the e2e asserts this).
 */
export function timedOfferAt(spec: GameSpec, opts: TimedOfferCtx & { index: number }): QuestDef | null {
  const seq = makeTimedSequence(spec, opts);
  let def: QuestDef | null = null;
  for (let i = 0; i <= opts.index; i++) {
    def = seq.next();
    if (!def) return null;
  }
  return def;
}

// ---------------------------------------------------------------------------
// TimedBoard — the rotating timed-offer board over a live QuestManager
// ---------------------------------------------------------------------------

export interface TimedBoardOpts {
  manager: QuestManager;
  spec: GameSpec;
  /** Board size (default resolveTimedCount(spec), i.e. 3). */
  count?: number;
  /** Live map seed (portal world seed, falling back to spec.meta.seed). */
  getMapSeed: () => number;
  /** Fired after any slot change (accept/abandon/turn-in/re-accept/re-roll) so the panel re-renders. */
  onChanged?: () => void;
}

export interface TimedSlot {
  /** The slot's current def (registered in the manager). */
  def: QuestDef;
  /** Live manager status for the def. */
  status: ReturnType<QuestManager['statusOf']>;
  /** Game-time seconds left on the countdown (null for non-timed defs — never happens for board slots). */
  remainingSeconds: number | null;
}

/**
 * Owns N rotating slots. Invariants (mirroring RadiantBoard, with the
 * timed fail rule added):
 * - Every slot def is registered in the manager (available / active /
 *   complete / failed) or the slot is empty (only when no variants are
 *   eligible).
 * - Accept keeps the def in its slot (status flips to active — the
 *   countdown starts on accept, from the full limit).
 * - Abandon (active only, via the manager's timed-scoped abandon)
 *   removes the def and re-rolls the slot from the deterministic
 *   sequence — the replacement is timedOfferAt(nextSeq++).
 * - Turn-in (complete only) uses the manager's existing turnIn, then
 *   sync() replaces the turned-in slot the same way.
 * - FAIL is not a removal: a failed slot STAYS visible with a Try
 *   again button (reaccept) so the player can restart the clock from
 *   the board. sync() replaces only turned-in / unknown slots — a
 *   failed def is never orphaned by a sync, and abandoning a failed
 *   slot is impossible (abandon is active-only); the player either
 *   retries it or leaves it, and it re-rolls when next replaced via
 *   the normal turn-in/unknown path after a retry.
 * - sync() also replaces slots whose defs left the roster some other
 *   way (unknown after a restore) with deterministic re-rolls.
 */
export class TimedBoard {
  private readonly slots: QuestDef[] = [];
  private nextSeq = 0;
  /**
   * Re-entrancy guard for sync() (the radiant board's 2026-10-25 bug,
   * caught by its e2e): manager calls fire refreshTracker ->
   * onQuestsChanged -> board.sync() WHILE the board method is still
   * mid-replacement. While the guard is set, sync() is a no-op; the
   * owning method performs its own replacement.
   */
  private syncing = false;
  readonly slotCount: number;

  constructor(private readonly opts: TimedBoardOpts) {
    this.slotCount = Math.min(opts.count ?? resolveTimedCount(opts.spec), eligibleTimedTemplates(opts.spec).length);
    for (let i = 0; i < this.slotCount; i++) {
      const def = this.nextOffer();
      if (!def) break;
      this.opts.manager.registerTimedDefs([def]);
      this.slots.push(def);
    }
  }

  private mapSeed(): number {
    try {
      return this.opts.getMapSeed();
    } catch {
      return this.opts.spec.meta.seed;
    }
  }

  private nextOffer(): QuestDef | null {
    const def = timedOfferAt(this.opts.spec, { mapSeed: this.mapSeed(), index: this.nextSeq });
    this.nextSeq += 1;
    return def;
  }

  /** Current slots with live manager statuses and countdowns (a snapshot, not a copy of the defs). */
  getSlots(): TimedSlot[] {
    return this.slots.map((def) => ({
      def,
      status: this.opts.manager.statusOf(def.id),
      remainingSeconds: this.opts.manager.timeRemaining(def.id),
    }));
  }

  /** Sequence position of the next re-roll (test seam: e2e replicates replacements from this). */
  get nextSequenceIndex(): number {
    return this.nextSeq;
  }

  /** Accept an offered quest (slot must hold an available def). The countdown starts now. */
  accept(slotIndex: number): boolean {
    const def = this.slots[slotIndex];
    if (!def) return false;
    const ok = this.opts.manager.accept(def.id);
    if (ok) this.opts.onChanged?.();
    return ok;
  }

  /**
   * Abandon an active timed quest in a slot and deterministically
   * re-roll that slot. Returns false unless the slot holds an active
   * timed quest (the manager enforces the timed-only rule).
   */
  abandon(slotIndex: number): boolean {
    const def = this.slots[slotIndex];
    if (!def) return false;
    this.syncing = true;
    try {
      if (!this.opts.manager.abandon(def.id)) return false;
      const replacement = this.nextOffer();
      if (replacement) {
        this.opts.manager.registerTimedDefs([replacement]);
        this.slots[slotIndex] = replacement;
      } else {
        this.slots.splice(slotIndex, 1);
      }
    } finally {
      this.syncing = false;
    }
    this.opts.onChanged?.();
    return true;
  }

  /** Turn in a completed timed quest in a slot (existing manager path), then re-roll the slot. */
  turnIn(slotIndex: number): boolean {
    const def = this.slots[slotIndex];
    if (!def) return false;
    this.syncing = true;
    let ok: boolean;
    try {
      ok = this.opts.manager.turnIn(def.id);
    } finally {
      this.syncing = false;
    }
    if (!ok) return false;
    this.sync();
    this.opts.onChanged?.();
    return true;
  }

  /**
   * Retry a failed timed quest in a slot: the manager restarts its
   * countdown from the full limit and resets its progress, and the
   * slot keeps the same def (no re-roll — the retry IS the same
   * quest, restarted). Returns false unless the slot holds a failed
   * timed quest.
   */
  reaccept(slotIndex: number): boolean {
    const def = this.slots[slotIndex];
    if (!def) return false;
    const ok = this.opts.manager.reaccept(def.id);
    if (ok) this.opts.onChanged?.();
    return ok;
  }

  /**
   * Replace slots whose defs left the board's live set (turned-in via
   * the villager dialogue, or unknown after a restore) with
   * deterministic re-rolls. Failed slots are deliberately NOT
   * replaced here — the player retries them from the board. Called
   * after turn-ins and by the panel on open.
   */
  sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      let changed = false;
      for (let i = 0; i < this.slots.length; i++) {
        const def = this.slots[i];
        const status = this.opts.manager.statusOf(def.id);
        if (status === 'turned-in' || status === 'unknown') {
          this.opts.manager.removeTimedDef(def.id);
          const replacement = this.nextOffer();
          if (replacement) {
            this.opts.manager.registerTimedDefs([replacement]);
            this.slots[i] = replacement;
          } else {
            this.slots.splice(i, 1);
            i -= 1;
          }
          changed = true;
        }
      }
      if (changed) this.opts.onChanged?.();
    } finally {
      this.syncing = false;
    }
  }
}

/** Validate a timed def the way the board needs it: timed countdown set, no chain, no standing gate. */
export function validateTimedDef(def: QuestDef): string[] {
  const errs: string[] = [];
  if (def.timed === undefined) errs.push(`timed quest ${def.id}: timed countdown must be set`);
  if (def.radiant === true) errs.push(`timed quest ${def.id}: timed quests must never be radiant`);
  if (def.requiresQuests && def.requiresQuests.length > 0)
    errs.push(`timed quest ${def.id}: timed quests must never chain (requiresQuests forbidden)`);
  if (def.minStanding !== undefined)
    errs.push(`timed quest ${def.id}: timed quests must never carry a standing gate`);
  return errs;
}
