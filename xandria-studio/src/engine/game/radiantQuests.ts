/**
 * Radiant quests (upgrade loop: radiant-quests wave) — endless repeatable
 * quests built on the story/side quest system (engine/game/quests.ts).
 *
 * Design (brief):
 *   (1) Radiant quest templates — fetch, hunt, craft, explore, escort-lite —
 *       parameterized by biome and tier, data-driven in ONE table below
 *       (RADIANT_TEMPLATES). No new objective kinds: every template maps
 *       onto an existing QuestObjectiveKind, so the quest lifecycle,
 *       the QuestManager event hooks, and NPC behavior contracts are
 *       untouched.
 *         fetch   -> gather (a biome-flavored material; gather targets
 *                    ride the existing gathering-node palettes, so only
 *                    the three harvestable materials are used)
 *         hunt    -> kill (a seeded enemy kind from the spec)
 *         craft   -> craft (a seeded recipe from the recipe pool)
 *         explore -> explore/portals (portal crossings)
 *         escort  -> explore/maps, "escort-lite": the traveler is abstract
 *                    (no new NPC, no new behavior contract) — escorting
 *                    means walking them through a portal to a new map,
 *                    which the manager's existing maps objective tracks.
 *   (2) Radiant quest generator — seeded per (player level, map seed,
 *       quest count): the base stream is Rng(mapSeed ^ RADIANT_SALT) and
 *       the same (level, map seed, count) reproduces the identical offer
 *       set (unit-tested + e2e-replicated). Tier derives from player
 *       level and scales objective counts and rewards; it never changes
 *       which stream an offer comes from.
 *   (3) Radiant board UI — RadiantBoard (this file) owns 3 rotating
 *       offer slots over the live QuestManager; RadiantBoardPanel
 *       (engine/ui/RadiantBoardPanel.ts) renders them. Accept / abandon /
 *       turn-in all call the manager's EXISTING methods; abandon and
 *       turn-in re-roll the slot deterministically from the sequence
 *       (radiantOfferAt), so the board never runs dry.
 *   (4) Completion feeds the existing quest-complete hooks unchanged:
 *       turn-in grants XP via Progression.addXpEx, items via Inventory,
 *       the standing hook (onQuestTurnedIn), and the achievements
 *       observer all run because a radiant quest is a plain QuestDef
 *       with radiant: true — the manager makes no distinction at grant
 *       time.
 *
 * Determinism: seeded RNG only — never Math.random/Date.now for gameplay.
 * A radiant def never chains (requiresQuests forbidden — enforced by
 * registerRadiantDefs via validateQuestDef + the board's own check) and
 * never carries a standing gate, so the board's remove/replace cycle
 * can never strand a story/side quest.
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
import { questBonusItem, QR_CRAFT, QR_GEAR, QR_MATS } from './questRewards';
import type { QuestDef, QuestManager, QuestObjectiveDef } from './quests';

/** Salt for the radiant-offer stream — distinct from QUEST_SALT, SIDE_QUEST_SALT, and every other wave's salt. */
export const RADIANT_SALT = 0x52414421; // 'RAD!'

export type RadiantKind = 'fetch' | 'hunt' | 'craft' | 'explore' | 'escort';

/** Player-level -> radiant tier bands (documented, unit-tested). */
export function radiantTierForLevel(level: number): number {
  if (!Number.isFinite(level) || level < 1) return 1;
  if (level <= 4) return 1;
  if (level <= 9) return 2;
  if (level <= 19) return 3;
  if (level <= 34) return 4;
  return 5;
}

/** Default board size: the brief's 3 rotating offers. Authorable via custom.quests.radiantCount (1..5). */
export function resolveRadiantCount(spec: GameSpec): number {
  const authored = spec.custom?.quests?.radiantCount;
  if (typeof authored === 'number' && Number.isFinite(authored)) {
    return Math.max(1, Math.min(5, Math.floor(authored)));
  }
  return 3;
}

/** Biome -> harvestable material flavor. Only the three node materials are used, so a fetch quest is always completable. */
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

/** Escort-lite traveler names — picked by the seeded stream, never random. */
const ESCORT_NAMES = ['Mara', 'Joren', 'Pip', 'Sable', 'Tomas', 'Wren', 'Kess', 'Bram'] as const;

interface RadiantBuildCtx {
  rng: Rng;
  spec: GameSpec;
  recipePool: CraftingRecipe[];
  enemyKinds: string[];
  crafting: boolean;
  portals: boolean;
  tier: number;
  mapSeed: number;
}

interface RadiantTemplate {
  kind: RadiantKind;
  slug: string;
  /** Base XP before tier scaling: xp = baseXp + 20 * (tier - 1). */
  baseXp: number;
  available: (ctx: RadiantBuildCtx) => boolean;
  build: (ctx: RadiantBuildCtx, id: string) => QuestDef;
}

function radiantRewards(ctx: RadiantBuildCtx, slug: string, baseXp: number, items: { id: string; count: number }[]): QuestDef['rewards'] {
  return {
    xp: baseXp + 20 * (ctx.tier - 1),
    items,
    // The existing curated-reward bonus line, reused verbatim: one small
    // seeded material, pure function of (map seed, slug) — replicable
    // without replaying the offer stream.
    bonus: [questBonusItem(ctx.mapSeed, slug)],
  };
}

/**
 * THE data-driven radiant table — one entry per kind. Every entry is
 * parameterized by biome (rng-picked per offer) and tier (objective
 * counts + reward XP scale). Adding a new radiant kind = one entry here
 * plus one line in the reward scaler; no dispatch changes anywhere.
 */
export const RADIANT_TEMPLATES: RadiantTemplate[] = [
  {
    kind: 'fetch',
    slug: 'radiant_fetch',
    baseXp: 50,
    available: (ctx) => ctx.crafting,
    build: (ctx, id) => {
      const biome = ctx.rng.pick(BIOME_IDS);
      const material = BIOME_MATERIAL[biome];
      const count = 3 + ctx.tier + ctx.rng.int(0, 2);
      return {
        id, name: `${BIOME_LABEL[biome]} Requisition`, giver: 'villager', radiant: true,
        brief: `The ${BIOME_LABEL[biome].toLowerCase()} outpost is short on supplies. Bring ${count} ${MATERIAL_LABEL[material]} and the quartermaster will pay.`,
        objectives: [{ id: 'obj-fetch', kind: 'gather', desc: `Fetch ${count} ${MATERIAL_LABEL[material]}`, target: material, count }],
        rewards: radiantRewards(ctx, 'radiant_fetch', 50, [{ id: material, count: 1 + ctx.tier }]),
      };
    },
  },
  {
    kind: 'hunt',
    slug: 'radiant_hunt',
    baseXp: 70,
    available: (ctx) => ctx.enemyKinds.length > 0,
    build: (ctx, id) => {
      const kind = ctx.rng.pick(ctx.enemyKinds);
      const count = 3 + ctx.tier + ctx.rng.int(0, 2);
      return {
        id, name: `Cull the ${kind}s`, giver: 'villager', radiant: true,
        brief: `The ${kind}s are pressing the perimeter again. Thin them out and report back.`,
        objectives: [{ id: 'obj-hunt', kind: 'kill', desc: `Defeat ${count} ${kind}s`, target: kind, count }],
        rewards: radiantRewards(ctx, 'radiant_hunt', 70, [{ id: QR_MATS.beastHide, count: ctx.tier }]),
      };
    },
  },
  {
    kind: 'craft',
    slug: 'radiant_craft',
    baseXp: 60,
    available: (ctx) => ctx.crafting && ctx.recipePool.length > 0,
    build: (ctx, id) => {
      const candidates = ctx.recipePool.filter((r) => !r.stationId);
      const recipe = candidates.length > 0 ? ctx.rng.pick(candidates) : ctx.rng.pick(ctx.recipePool);
      const count = ctx.tier >= 4 ? 2 : 1;
      return {
        id, name: `Commission: ${recipe.name}`, giver: 'villager', radiant: true,
        brief: `A client wants ${count === 1 ? 'a' : count} ${recipe.name} — steady hands, honest work, paid on delivery.`,
        objectives: [{ id: 'obj-craft', kind: 'craft', desc: `Craft ${recipe.name}${count > 1 ? ` ×${count}` : ''}`, target: recipe.id, count }],
        rewards: radiantRewards(ctx, 'radiant_craft', 60, [{ id: QR_CRAFT.fieldKit, count: ctx.tier >= 3 ? 2 : 1 }]),
      };
    },
  },
  {
    kind: 'explore',
    slug: 'radiant_explore',
    baseXp: 60,
    available: (ctx) => ctx.portals,
    build: (ctx, id) => {
      const count = 1 + (ctx.tier >= 3 ? 1 : 0);
      return {
        id, name: 'Wayfinder Duty', giver: 'villager', radiant: true,
        brief: 'The portal routes need walking. Pass through and confirm the far side is still standing.',
        objectives: [{ id: 'obj-explore', kind: 'explore', desc: count === 1 ? 'Pass through a portal' : `Pass through ${count} portals`, target: 'portals', count }],
        rewards: radiantRewards(ctx, 'radiant_explore', 60, [{ id: QR_CRAFT.scrapBuckler, count: 1 }]),
      };
    },
  },
  {
    kind: 'escort',
    slug: 'radiant_escort',
    baseXp: 80,
    available: (ctx) => ctx.portals,
    build: (ctx, id) => {
      const name = ctx.rng.pick(ESCORT_NAMES);
      const biome = ctx.rng.pick(BIOME_IDS);
      return {
        id, name: `Escort ${name}`, giver: 'villager', radiant: true,
        brief: `${name} needs a guide to the ${BIOME_LABEL[biome].toLowerCase()} side. Walk them through a portal — escort-lite: they follow your lead, no new NPC is spawned.`,
        objectives: [{ id: 'obj-escort', kind: 'explore', desc: `Escort ${name} through a portal to a new map`, target: 'maps', count: 1 }],
        rewards: radiantRewards(ctx, 'radiant_escort', 80, [{ id: QR_GEAR.surgeTonic, count: ctx.tier >= 3 ? 2 : 1 }]),
      };
    },
  },
];

/** Eligible templates for a spec (availability only — no rng consumed here). */
export function eligibleRadiantTemplates(spec: GameSpec): RadiantTemplate[] {
  const probe: RadiantBuildCtx = {
    rng: new Rng(1),
    spec,
    recipePool: buildRecipePool(spec),
    enemyKinds: (spec.enemies ?? []).map((e) => e.kind),
    crafting: resolveCraftingEnabled(spec),
    portals: portalsEnabled(spec),
    tier: 1,
    mapSeed: spec.meta.seed,
  };
  return RADIANT_TEMPLATES.filter((t) => t.available(probe));
}

interface RadiantOfferCtx {
  playerLevel: number;
  mapSeed: number;
  count?: number;
}

/**
 * Build one offer from a live rng stream. The template order is shuffled
 * ONCE per sequence (see makeRadiantSequence) so the first N offers of a
 * board always cover distinct kinds when enough kinds are eligible.
 */
function buildOfferFromStream(
  rng: Rng,
  ordered: RadiantTemplate[],
  spec: GameSpec,
  tier: number,
  mapSeed: number,
  seq: number,
): QuestDef {
  const template = ordered[seq % ordered.length];
  const ctx: RadiantBuildCtx = {
    rng,
    spec,
    recipePool: buildRecipePool(spec),
    enemyKinds: (spec.enemies ?? []).map((e) => e.kind),
    crafting: resolveCraftingEnabled(spec),
    portals: portalsEnabled(spec),
    tier,
    mapSeed,
  };
  return template.build(ctx, `quest_radiant_${seq}_${template.slug}`);
}

/**
 * A deterministic offer sequence for one (spec, level, mapSeed): the base
 * stream is Rng(mapSeed ^ RADIANT_SALT), the template order is that
 * stream's first shuffle, and offer k is the k-th build off the stream.
 * Every consumer (board, tests, e2e replication) replays this same
 * sequence, so offer k is identical wherever it is generated.
 */
export function makeRadiantSequence(spec: GameSpec, opts: RadiantOfferCtx): { next: () => QuestDef | null } {
  const tier = radiantTierForLevel(opts.playerLevel);
  const rng = new Rng((opts.mapSeed ^ RADIANT_SALT) >>> 0);
  const eligible = eligibleRadiantTemplates(spec);
  const ordered = rng.shuffle([...eligible]);
  let seq = 0;
  return {
    next: () => {
      if (ordered.length === 0) return null;
      const def = buildOfferFromStream(rng, ordered, spec, tier, opts.mapSeed, seq);
      seq += 1;
      return def;
    },
  };
}

/**
 * Pure offer set: the first `count` offers of the sequence for
 * (playerLevel, mapSeed). Same inputs -> identical set (ids, names,
 * objectives, targets, counts, rewards) — the brief's determinism
 * contract. A count past the eligible-kind count cycles the shuffled
 * order again (the board is endless); the first N offers of a board
 * always cover distinct kinds while N <= eligible kinds.
 */
export function buildRadiantOffers(spec: GameSpec, opts: RadiantOfferCtx): QuestDef[] {
  const count = opts.count ?? 3;
  const seq = makeRadiantSequence(spec, opts);
  const out: QuestDef[] = [];
  for (let i = 0; i < count; i++) {
    const def = seq.next();
    if (!def) break;
    out.push(def);
  }
  return out;
}

/**
 * Pure single-offer replication: offer `index` of the sequence for
 * (playerLevel, mapSeed). The board's re-rolls are exactly this function
 * at the board's running sequence index, so an abandoned/turned-in slot's
 * replacement is independently replicable (the e2e asserts this).
 */
export function radiantOfferAt(spec: GameSpec, opts: RadiantOfferCtx & { index: number }): QuestDef | null {
  const seq = makeRadiantSequence(spec, opts);
  let def: QuestDef | null = null;
  for (let i = 0; i <= opts.index; i++) {
    def = seq.next();
    if (!def) return null;
  }
  return def;
}

// ---------------------------------------------------------------------------
// RadiantBoard — the rotating offer board over a live QuestManager
// ---------------------------------------------------------------------------

export interface RadiantBoardOpts {
  manager: QuestManager;
  spec: GameSpec;
  /** Board size (default resolveRadiantCount(spec), i.e. 3). */
  count?: number;
  /** Live player level (Progression.level at call time). */
  getPlayerLevel: () => number;
  /** Live map seed (portal world seed, falling back to spec.meta.seed). */
  getMapSeed: () => number;
  /** Fired after any slot change (accept/abandon/turn-in/re-roll) so the panel re-renders. */
  onChanged?: () => void;
}

export interface RadiantSlot {
  /** The slot's current def (registered in the manager). */
  def: QuestDef;
  /** Live manager status for the def. */
  status: QuestManager['statusOf'] extends (id: string) => infer R ? R : never;
}

/**
 * Owns N rotating slots. Invariants:
 * - Every slot def is registered in the manager (available / active /
 *   complete) or the slot is empty (only when no kinds are eligible).
 * - Accept keeps the def in its slot (status flips to active in the
 *   manager — the panel then shows Abandon / progress).
 * - Abandon (active only, via the manager's radiant-scoped abandon)
 *   removes the def and re-rolls the slot from the deterministic
 *   sequence — the replacement is radiantOfferAt(nextSeq++).
 * - Turn-in (complete only) uses the manager's existing turnIn, then
 *   sync() replaces the turned-in slot the same way.
 * - syncTier() re-rolls ONLY still-available offer slots when the
 *   player's tier changed since the offers were generated — accepted
 *   quests are never re-rolled out from under the player.
 */
export class RadiantBoard {
  private readonly slots: QuestDef[] = [];
  private nextSeq = 0;
  private lastOfferTier: number;
  /**
   * Re-entrancy guard for sync() (2026-10-25 bug, caught by the radiant
   * e2e): manager calls (abandon/turnIn/remove) fire refreshTracker ->
   * onQuestsChanged -> board.sync() WHILE the board method is still
   * mid-replacement. Without the guard, abandon replaced its slot twice
   * (sync's index-3 offer, then abandon's own index-4 offer) and left
   * the index-3 def orphaned in the manager. While the guard is set,
   * sync() is a no-op; the owning method performs its own replacement.
   */
  private syncing = false;
  readonly slotCount: number;

  constructor(private readonly opts: RadiantBoardOpts) {
    this.slotCount = Math.min(opts.count ?? resolveRadiantCount(opts.spec), eligibleRadiantTemplates(opts.spec).length);
    this.lastOfferTier = radiantTierForLevel(this.level());
    for (let i = 0; i < this.slotCount; i++) {
      const def = this.nextOffer();
      if (!def) break;
      this.opts.manager.registerRadiantDefs([def]);
      this.slots.push(def);
    }
  }

  private level(): number {
    try {
      return this.opts.getPlayerLevel();
    } catch {
      return 1;
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
    const def = radiantOfferAt(this.opts.spec, {
      playerLevel: this.level(),
      mapSeed: this.mapSeed(),
      index: this.nextSeq,
    });
    this.nextSeq += 1;
    return def;
  }

  /** Current slots with live manager statuses (a snapshot, not a copy of the defs). */
  getSlots(): RadiantSlot[] {
    return this.slots.map((def) => ({ def, status: this.opts.manager.statusOf(def.id) }));
  }

  /** Sequence position of the next re-roll (test seam: e2e replicates replacements from this). */
  get nextSequenceIndex(): number {
    return this.nextSeq;
  }

  /** Accept an offered quest (slot must hold an available def). */
  accept(slotIndex: number): boolean {
    const def = this.slots[slotIndex];
    if (!def) return false;
    const ok = this.opts.manager.accept(def.id);
    if (ok) this.opts.onChanged?.();
    return ok;
  }

  /**
   * Abandon an active radiant quest in a slot and deterministically
   * re-roll that slot. Returns false unless the slot holds an active
   * radiant quest (the manager enforces the radiant-only rule).
   */
  abandon(slotIndex: number): boolean {
    const def = this.slots[slotIndex];
    if (!def) return false;
    // Guarded across the WHOLE replacement, not just the manager call:
    // manager.abandon fires onQuestsChanged -> sync(), and so does the
    // registerRadiantDefs below — either one would replace this slot
    // before the assignment below runs (double-roll + orphan). The
    // guard stays up until slots[slotIndex] holds the replacement.
    this.syncing = true;
    try {
      if (!this.opts.manager.abandon(def.id)) return false;
      const replacement = this.nextOffer();
      if (replacement) {
        this.opts.manager.registerRadiantDefs([replacement]);
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

  /** Turn in a completed radiant quest in a slot (existing manager path), then re-roll the slot. */
  turnIn(slotIndex: number): boolean {
    const def = this.slots[slotIndex];
    if (!def) return false;
    // Same guard as abandon: the manager turn-in fires onQuestsChanged
    // -> sync(), which must not replace the slot before this method's
    // own post-turn-in sync() runs (that sync is the single replacement).
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
   * Replace slots whose defs left the board's live set (turned-in via the
   * villager dialogue, or unknown after a restore) with deterministic
   * re-rolls. Called after turn-ins and by the panel on open.
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
          this.opts.manager.removeRadiantDef(def.id);
          const replacement = this.nextOffer();
          if (replacement) {
            this.opts.manager.registerRadiantDefs([replacement]);
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

  /**
   * Re-roll still-available offer slots when the player's tier moved
   * since the offers were generated. Active/complete slots are never
   * touched. No-op when the tier is unchanged (opening the panel twice
   * does not reshuffle the board).
   */
  syncTier(): void {
    const tier = radiantTierForLevel(this.level());
    if (tier === this.lastOfferTier) return;
    this.lastOfferTier = tier;
    // Same guard as abandon: remove/register fire onQuestsChanged ->
    // sync(), which would replace a slot mid-loop (the removed def
    // reads 'unknown' until its replacement is assigned).
    this.syncing = true;
    try {
      let changed = false;
      for (let i = 0; i < this.slots.length; i++) {
        const def = this.slots[i];
        if (this.opts.manager.statusOf(def.id) !== 'available') continue;
        this.opts.manager.removeRadiantDef(def.id);
        const replacement = this.nextOffer();
        if (replacement) {
          this.opts.manager.registerRadiantDefs([replacement]);
          this.slots[i] = replacement;
          changed = true;
        }
      }
      if (changed) this.opts.onChanged?.();
    } finally {
      this.syncing = false;
    }
  }
}

/** Validate a radiant def the way the board needs it: radiant flag set, no chain, no standing gate. */
export function validateRadiantDef(def: QuestDef): string[] {
  const errs: string[] = [];
  if (def.radiant !== true) errs.push(`radiant quest ${def.id}: radiant flag must be true`);
  if (def.requiresQuests && def.requiresQuests.length > 0)
    errs.push(`radiant quest ${def.id}: radiant quests must never chain (requiresQuests forbidden)`);
  if (def.minStanding !== undefined)
    errs.push(`radiant quest ${def.id}: radiant quests must never carry a standing gate`);
  return errs;
}
