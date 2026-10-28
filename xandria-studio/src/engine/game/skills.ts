/**
 * Skills wave: data-driven skill system + per-skill XP/rank progression.
 *
 * Three skills (foraging / smithing / alchemy), each with ranks 1..3
 * earned from gameplay events — harvesting gathering nodes and completing
 * crafts. Ranks have real effects:
 *   - foraging: +materials per harvest (deterministic flat bonus)
 *   - smithing / alchemy: unlock skill-gated recipes + faster craft queues
 *
 * DETERMINISM: no RNG anywhere in this module. XP comes only from
 * gameplay events with fixed per-event values; ranks derive from the
 * fixed xpThresholds table. Seeded randomness is never needed.
 *
 * The SkillSystem is blueprint-owned (like Progression) and rides on the
 * live blueprint object across portal transitions — blueprints are not
 * rebuilt on map switches, so skill XP persists. portalSnapshot /
 * portalRestore exist for the PortalState seam (same PORTALS-D pattern as
 * Progression.portalSnapshot) and are unit-tested.
 *
 * NPC/enemy behavior contracts are untouched.
 */
import type { Engine } from '../Engine';
import type { GameSpec } from '@spec';
import { STATION_ALCHEMY } from './crafting';

/** Stable skill ids — the skillId values recipes reference. */
export const SKILL_FORAGING = 'foraging';
export const SKILL_SMITHING = 'smithing';
export const SKILL_ALCHEMY = 'alchemy';
export const SKILL_IDS = [SKILL_FORAGING, SKILL_SMITHING, SKILL_ALCHEMY] as const;
export type SkillId = (typeof SKILL_IDS)[number];

/**
 * Data-driven skill definition. All tuning lives here — ranks, XP curve,
 * per-event XP values, and per-rank effect magnitudes. The UI renders
 * `effects` verbatim, so keep them honest about what the rank does.
 */
export interface SkillDef {
  id: SkillId;
  name: string;
  desc: string;
  /**
   * Cumulative XP thresholds for ranks 1..maxRank. [0] is always 0
   * (everyone starts at rank 1); length = maxRank.
   */
  xpThresholds: readonly number[];
  /** XP granted per harvest event (foraging). */
  xpPerHarvest?: number;
  /** XP granted per completed craft (smithing / alchemy). */
  xpPerCraft?: number;
  /** harvest yield bonus by rank index (rank - 1). */
  yieldBonus?: readonly number[];
  /** craft queue time multiplier by rank index (rank - 1). */
  craftTimeMult?: readonly number[];
  /** one honest effect line per rank (rank - 1), for the skills panel. */
  effects: readonly string[];
}

export const SKILL_DEFS: readonly SkillDef[] = [
  {
    id: SKILL_FORAGING,
    name: 'Foraging',
    desc: 'Reading the wilds — prying more from every node you harvest.',
    xpThresholds: [0, 60, 180],
    xpPerHarvest: 8,
    yieldBonus: [0, 1, 2],
    effects: [
      'Rank 1 — standard harvests.',
      'Rank 2 — +1 material on every harvest.',
      'Rank 3 — +2 materials on every harvest; wildcrafts the Wildheart Regalia.',
    ],
  },
  {
    id: SKILL_SMITHING,
    name: 'Smithing',
    desc: 'Metalwork at the workbench, anvil and forge. Unlocks advanced recipes; faster hands.',
    xpThresholds: [0, 80, 240],
    xpPerCraft: 12,
    craftTimeMult: [1, 0.9, 0.75],
    effects: [
      'Rank 1 — basic metalwork recipes.',
      'Rank 2 — advanced recipes (Iron Edge); crafting 10% faster.',
      'Rank 3 — master recipes (Starfall Warbrand, Dragonscale Aegis, Alloy Greaves); crafting 25% faster.',
    ],
  },
  {
    id: SKILL_ALCHEMY,
    name: 'Alchemy',
    desc: 'Brewing tonics and charges at the alchemy station.',
    xpThresholds: [0, 80, 240],
    xpPerCraft: 12,
    craftTimeMult: [1, 0.9, 0.75],
    effects: [
      'Rank 1 — basic brews.',
      'Rank 2 — advanced brews (Ember Tonic); brewing 10% faster.',
      'Rank 3 — master brews (Primordial Draught); brewing 25% faster.',
    ],
  },
];

/** Rank derived from a def's xpThresholds: highest rank whose threshold is met. */
export function rankForXp(def: SkillDef, xp: number): number {
  let rank = 1;
  for (let i = 0; i < def.xpThresholds.length; i++) {
    if (xp >= def.xpThresholds[i]) rank = i + 1;
  }
  return rank;
}

// ---------------------------------------------------------------------------
// Skill synergies (upgrade loop): data-driven pair/triple rank passives.
//
// A synergy is ACTIVE exactly when every required skill is at or above
// its required rank. Synergies are pure functions of ranks — no separate
// unlock flags, no stored state — so they can never desync from ranks:
// drop below a required rank and the passive is gone; restore the ranks
// (portal snapshot, save/reload) and it returns. Evaluation runs AFTER
// rank computation and only ADDS to the rank-derived numbers:
//   harvest yield  = seeded base + foraging rank bonus + synergy bonus
//   craft time     = base seconds x rank multiplier x synergy multiplier
//   crit chance    = base + tier bonus + smithing-rank bonus + synergy bonus
//   crit multiplier= base + tier bonus + smithing-rank bonus + synergy bonus
// Skill gating, craft-check order, and XP math are untouched: a synergy
// never grants a rank, never unlocks a recipe, never changes XP gains.
// ---------------------------------------------------------------------------

export type SynergyEffectKind =
  | 'harvestYield'
  | 'craftTime'
  | 'critChance'
  | 'critMultiplier';

export interface SynergyRequirement {
  skill: SkillId;
  rank: number;
}

export interface SynergyDef {
  id: string;
  name: string;
  /** every requirement must hold for the synergy to be active */
  requires: readonly SynergyRequirement[];
  /** the single passive effect this synergy grants while active */
  effect: { kind: SynergyEffectKind; value: number };
  /** requirement text rendered verbatim by the SkillsPanel */
  requirementLine: string;
  /** effect text rendered verbatim by the SkillsPanel */
  effectLine: string;
}

/**
 * The whole synergy table — all tuning lives here. Six is the brief's
 * ceiling; five ship: two gathering/crafting passives, two combat
 * (crit) passives, and one triple-rank capstone. Effect values:
 * harvestYield adds flat materials; craftTime multiplies queue time;
 * critChance / critMultiplier add to the crit table's additive bonuses.
 */
export const SYNERGY_DEFS: readonly SynergyDef[] = [
  {
    id: 'field-smith',
    name: 'Field Smith',
    requires: [
      { skill: SKILL_FORAGING, rank: 2 },
      { skill: SKILL_SMITHING, rank: 2 },
    ],
    effect: { kind: 'harvestYield', value: 1 },
    requirementLine: 'Foraging 2 + Smithing 2',
    effectLine: '+1 material on every harvest',
  },
  {
    id: 'workshop-flow',
    name: 'Workshop Flow',
    requires: [
      { skill: SKILL_SMITHING, rank: 2 },
      { skill: SKILL_ALCHEMY, rank: 2 },
    ],
    effect: { kind: 'craftTime', value: 0.9 },
    requirementLine: 'Smithing 2 + Alchemy 2',
    effectLine: 'Crafting 10% faster',
  },
  {
    id: 'herbal-edge',
    name: 'Herbal Edge',
    requires: [
      { skill: SKILL_FORAGING, rank: 2 },
      { skill: SKILL_ALCHEMY, rank: 2 },
    ],
    effect: { kind: 'critChance', value: 0.02 },
    requirementLine: 'Foraging 2 + Alchemy 2',
    effectLine: '+2% crit chance',
  },
  {
    id: 'tempered-edge',
    name: 'Tempered Edge',
    requires: [
      { skill: SKILL_SMITHING, rank: 3 },
      { skill: SKILL_ALCHEMY, rank: 2 },
    ],
    effect: { kind: 'critMultiplier', value: 0.2 },
    requirementLine: 'Smithing 3 + Alchemy 2',
    effectLine: '+0.2 crit damage multiplier',
  },
  {
    id: 'grand-artisan',
    name: 'Grand Artisan',
    requires: [
      { skill: SKILL_FORAGING, rank: 3 },
      { skill: SKILL_SMITHING, rank: 3 },
      { skill: SKILL_ALCHEMY, rank: 3 },
    ],
    effect: { kind: 'craftTime', value: 0.85 },
    requirementLine: 'Foraging 3 + Smithing 3 + Alchemy 3',
    effectLine: 'Crafting 15% faster',
  },
];

/** True when every required skill is at or above its required rank. */
export function synergyIsActive(
  def: SynergyDef,
  rankOf: (skillId: string) => number,
): boolean {
  return def.requires.every((r) => rankOf(r.skill) >= r.rank);
}

/** The currently active synergies, in table order. Pure function of ranks. */
export function evaluateSynergies(
  rankOf: (skillId: string) => number,
): SynergyDef[] {
  return SYNERGY_DEFS.filter((d) => synergyIsActive(d, rankOf));
}

// ---------------------------------------------------------------------------
// Save/reload persistence (upgrade loop, synergies phase).
//
// Skill XP itself is the persisted state; synergies derive from ranks,
// so persisting XP persists synergies with no second source of truth.
// Keyed by spec seed (the factions wave's localStorage pattern): the
// same seed reloads with its ranks intact; a different seed starts
// fresh. Guarded like Profile's storage — any failure degrades to a
// no-op, never a crash. Opt-in via SkillSystemOpts.persist (blueprints
// pass it; unit tests default to off, so no test writes storage).
// ---------------------------------------------------------------------------

export const SKILL_XP_STORAGE_KEY_PREFIX = 'xandria.skills.v1';

export function skillXpStorageKey(seed: number): string {
  return `${SKILL_XP_STORAGE_KEY_PREFIX}:${seed >>> 0}`;
}

/** Load persisted per-skill XP for a seed; null when absent or invalid. */
export function loadPersistedSkillXp(
  seed: number,
): { xp: Record<string, number> } | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null;
    const raw = globalThis.localStorage.getItem(skillXpStorageKey(seed));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{
      version: number;
      xp: Record<string, unknown>;
    }>;
    if (parsed?.version !== 1 || !parsed.xp || typeof parsed.xp !== 'object') {
      return null;
    }
    return { xp: parsed.xp as Record<string, number> };
  } catch {
    return null;
  }
}

/** Persist per-skill XP for a seed; any failure is silently a no-op. */
export function savePersistedSkillXp(
  seed: number,
  snap: { xp: Record<string, number> },
): void {
  try {
    if (typeof globalThis.localStorage === 'undefined') return;
    globalThis.localStorage.setItem(
      skillXpStorageKey(seed),
      JSON.stringify({ version: 1, xp: snap.xp }),
    );
  } catch {
    /* storage unavailable — ranks still live in memory this session */
  }
}

/**
 * Minimal surface checkCraft() needs for skillId-gated recipes. The full
 * SkillSystem satisfies it; unit tests use small stubs.
 */
export interface SkillsLike {
  /** current rank of a skill id; unknown ids are rank 0 (gates fail closed) */
  rankOf(skillId: string): number;
  /** display name for a skill id (falls back to the id) */
  skillName(skillId: string): string;
}

/** Which skill a completed craft feeds: alchemy at the alchemy station, smithing everywhere else. */
export function craftSkillForStation(stationId?: string): SkillId {
  return stationId === STATION_ALCHEMY ? SKILL_ALCHEMY : SKILL_SMITHING;
}

export interface SkillSystemOpts {
  enabled?: boolean;
  xpMultiplier?: number;
  /** fired once per rank gained (blueprints toast + play the levelup cue) */
  onRankUp?: (def: SkillDef, rank: number) => void;
  /**
   * Persist per-skill XP to guarded per-seed localStorage (the
   * save/reload leg for ranks — and, derivatively, synergies).
   * Default false; blueprints opt in. Never writes when disabled.
   */
  persist?: boolean;
}

export interface SkillXpResult {
  leveled: boolean;
  /** rank after the gain */
  rank: number;
}

function sanitizeMult(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(10, n);
}

export class SkillSystem implements SkillsLike {
  private readonly xp = new Map<SkillId, number>();
  private readonly enabled_: boolean;
  private readonly xpMultiplier: number;
  private readonly onRankUp?: (def: SkillDef, rank: number) => void;
  private readonly persist_: boolean;
  private readonly seed_: number | undefined;

  constructor(
    private readonly engine: Engine,
    opts: SkillSystemOpts = {},
  ) {
    const custom = engine.spec.custom?.skills;
    this.enabled_ = opts.enabled ?? custom?.enabled ?? true;
    this.xpMultiplier = sanitizeMult(opts.xpMultiplier ?? custom?.xpMultiplier);
    this.onRankUp = opts.onRankUp;
    this.persist_ = opts.persist ?? false;
    const seed = engine.spec.meta?.seed;
    this.seed_ = typeof seed === 'number' && Number.isFinite(seed) ? seed : undefined;
    // Save/reload leg: restore persisted ranks (clamped by portalRestore).
    // Synergies need no restore of their own — they derive from ranks.
    if (this.persist_ && this.enabled_ && this.seed_ !== undefined) {
      const saved = loadPersistedSkillXp(this.seed_);
      if (saved) this.portalRestore(saved);
    }
  }

  get enabled(): boolean {
    return this.enabled_;
  }

  defs(): readonly SkillDef[] {
    return SKILL_DEFS;
  }

  defOf(id: string): SkillDef | undefined {
    return SKILL_DEFS.find((d) => d.id === id);
  }

  /** Current rank (1..maxRank); unknown skill ids are rank 0 so gates fail closed. */
  rankOf(skillId: string): number {
    const def = this.defOf(skillId);
    if (!def) return 0;
    return rankForXp(def, this.xp.get(def.id) ?? 0);
  }

  skillName(skillId: string): string {
    return this.defOf(skillId)?.name ?? skillId;
  }

  xpOf(skillId: string): number {
    const def = this.defOf(skillId);
    return def ? (this.xp.get(def.id) ?? 0) : 0;
  }

  /** XP still needed to reach the next rank; null at max rank or unknown id. */
  xpForNextRank(skillId: string): number | null {
    const def = this.defOf(skillId);
    if (!def) return null;
    const cur = this.xp.get(def.id) ?? 0;
    const rank = rankForXp(def, cur);
    if (rank >= def.xpThresholds.length) return null;
    return def.xpThresholds[rank] - cur;
  }

  /** 0..1 progress through the current rank segment (1 at max rank). */
  progressToNext(skillId: string): number {
    const def = this.defOf(skillId);
    if (!def) return 0;
    const cur = this.xp.get(def.id) ?? 0;
    const rank = rankForXp(def, cur);
    if (rank >= def.xpThresholds.length) return 1;
    const lo = def.xpThresholds[rank - 1];
    const hi = def.xpThresholds[rank];
    if (hi <= lo) return 1;
    return Math.min(1, Math.max(0, (cur - lo) / (hi - lo)));
  }

  /**
   * Add XP to a skill; fires onRankUp once per rank gained. No-ops when
   * disabled, for unknown ids, or for non-positive amounts. Deterministic:
   * pure function of (current xp, amount, multiplier) — no RNG.
   */
  addXp(skillId: string, amount: number): SkillXpResult {
    const def = this.defOf(skillId);
    if (!this.enabled_ || !def || !(amount > 0)) {
      return { leveled: false, rank: this.rankOf(skillId) };
    }
    const before = rankForXp(def, this.xp.get(def.id) ?? 0);
    const gain = amount * this.xpMultiplier;
    this.xp.set(def.id, (this.xp.get(def.id) ?? 0) + gain);
    this.persistNow();
    const after = rankForXp(def, this.xp.get(def.id) ?? 0);
    const leveled = after > before;
    if (leveled) {
      this.engine.audio?.play('levelup');
      for (let r = before + 1; r <= after; r++) this.onRankUp?.(def, r);
    }
    return { leveled, rank: after };
  }

  /** Harvest event: foraging XP. */
  onHarvest(): SkillXpResult {
    const def = this.defOf(SKILL_FORAGING);
    return this.addXp(SKILL_FORAGING, def?.xpPerHarvest ?? 0);
  }

  /** Completed-craft event: alchemy XP at the alchemy station, smithing elsewhere. */
  onCraft(stationId?: string): SkillXpResult {
    const skill = craftSkillForStation(stationId);
    const def = this.defOf(skill);
    return this.addXp(skill, def?.xpPerCraft ?? 0);
  }

  /** Flat harvest-yield bonus: foraging rank bonus + synergy bonus, added after rank computation. */
  harvestYieldBonus(): number {
    const def = this.defOf(SKILL_FORAGING) as SkillDef;
    const bonus = def.yieldBonus?.[this.rankOf(SKILL_FORAGING) - 1] ?? 0;
    return Math.max(0, Math.floor(bonus)) + this.synergyHarvestYieldBonus();
  }

  /** Craft-queue time multiplier: rank multiplier x synergy multiplier (1 = no bonus). */
  craftTimeMult(stationId?: string): number {
    const skill = craftSkillForStation(stationId);
    const def = this.defOf(skill) as SkillDef;
    const mult = def.craftTimeMult?.[this.rankOf(skill) - 1] ?? 1;
    const rankMult = Number.isFinite(mult) && mult > 0 ? mult : 1;
    const synergyMult = this.synergyCraftTimeMult();
    const total = rankMult * synergyMult;
    return Number.isFinite(total) && total > 0 ? total : 1;
  }

  // ------------------------------------------------------------ synergies

  /** Currently active synergies, in table order; none when disabled. */
  activeSynergies(): SynergyDef[] {
    if (!this.enabled_) return [];
    return evaluateSynergies((id) => this.rankOf(id));
  }

  /** Flat extra harvest materials from active synergies (additive). */
  synergyHarvestYieldBonus(): number {
    let total = 0;
    for (const def of this.activeSynergies()) {
      if (def.effect.kind === 'harvestYield') total += def.effect.value;
    }
    return Math.max(0, Math.floor(total));
  }

  /** Craft-time multiplier from active synergies (multiplicative, 1 = none). */
  synergyCraftTimeMult(): number {
    let total = 1;
    for (const def of this.activeSynergies()) {
      if (def.effect.kind === 'craftTime') total *= def.effect.value;
    }
    return Number.isFinite(total) && total > 0 ? total : 1;
  }

  /** Crit bonuses from active synergies (additive, applied after the crit table's own bonuses). */
  synergyCritBonuses(): { chanceBonus: number; multiplierBonus: number } {
    let chanceBonus = 0;
    let multiplierBonus = 0;
    for (const def of this.activeSynergies()) {
      if (def.effect.kind === 'critChance') chanceBonus += def.effect.value;
      if (def.effect.kind === 'critMultiplier') multiplierBonus += def.effect.value;
    }
    return { chanceBonus, multiplierBonus };
  }

  /** Write the current XP snapshot to per-seed storage (opt-in, guarded). */
  private persistNow(): void {
    if (!this.persist_ || !this.enabled_ || this.seed_ === undefined) return;
    savePersistedSkillXp(this.seed_, this.portalSnapshot());
  }

  /**
   * PORTALS-D: snapshot per-skill XP for portal transitions. Plain data —
   * JSON-serializable. (Live objects persist across transitions today, so
   * this rides the PortalState seam for future blueprint rebuilds.)
   */
  portalSnapshot(): { xp: Record<string, number> } {
    return { xp: Object.fromEntries(this.xp) };
  }

  /**
   * PORTALS-D: restore a portalSnapshot(). Defensive: corrupt values clamp
   * to sane floors rather than throwing mid-transition; unknown skill ids
   * are dropped.
   */
  portalRestore(s: { xp: Record<string, number> } | null | undefined): void {
    this.xp.clear();
    const raw = s?.xp;
    if (!raw || typeof raw !== 'object') return;
    for (const [id, v] of Object.entries(raw)) {
      if (this.defOf(id) && Number.isFinite(v) && (v as number) > 0) {
        this.xp.set(id as SkillId, v as number);
      }
    }
    // Restored ranks are the persisted truth for the next reload too:
    // synergies follow ranks, so persisting here keeps reload == portal.
    this.persistNow();
  }
}

// ---------------------------------------------------------------------------
// Studio-facing resolvers (mirror the enemyTuning / crafting pattern)
// ---------------------------------------------------------------------------

export const DEFAULT_SKILLS_ENABLED = true;
export const DEFAULT_SKILLS_XP_MULTIPLIER = 1;

/** Master skills toggle (default true). */
export function resolveSkillsEnabled(spec: GameSpec): boolean {
  const v = spec.custom?.skills?.enabled;
  return v === undefined ? DEFAULT_SKILLS_ENABLED : v !== false;
}

/** XP gain multiplier (default 1; sanitized to a sane range). */
export function resolveSkillsXpMultiplier(spec: GameSpec): number {
  return sanitizeMult(spec.custom?.skills?.xpMultiplier);
}
