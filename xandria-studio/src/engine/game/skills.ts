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
      'Rank 3 — +2 materials on every harvest.',
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
      'Rank 3 — master recipes (Alloy Greaves); crafting 25% faster.',
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
      'Rank 3 — master brews; brewing 25% faster.',
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

  constructor(
    private readonly engine: Engine,
    opts: SkillSystemOpts = {},
  ) {
    const custom = engine.spec.custom?.skills;
    this.enabled_ = opts.enabled ?? custom?.enabled ?? true;
    this.xpMultiplier = sanitizeMult(opts.xpMultiplier ?? custom?.xpMultiplier);
    this.onRankUp = opts.onRankUp;
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

  /** Flat harvest-yield bonus from the foraging rank (deterministic). */
  harvestYieldBonus(): number {
    const def = this.defOf(SKILL_FORAGING) as SkillDef;
    const bonus = def.yieldBonus?.[this.rankOf(SKILL_FORAGING) - 1] ?? 0;
    return Math.max(0, Math.floor(bonus));
  }

  /** Craft-queue time multiplier for the skill behind a station (1 = no bonus). */
  craftTimeMult(stationId?: string): number {
    const skill = craftSkillForStation(stationId);
    const def = this.defOf(skill) as SkillDef;
    const mult = def.craftTimeMult?.[this.rankOf(skill) - 1] ?? 1;
    return Number.isFinite(mult) && mult > 0 ? mult : 1;
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
