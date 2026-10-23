/**
 * Bestiary / enemy codex wave: data-driven enemy registry + kill tracking
 * + unlock tiers, rendered by the bestiary UI panel.
 *
 * DESIGN
 * - The registry is presentation metadata over EXISTING enemy defs: the
 *   five combat EnemyKinds from spec/schema.ts (ENEMY_KINDS minus 'racer',
 *   which is an objective type, not a spawned foe) plus a 'boss' entry for
 *   boss-objective kills. No new art, no enemy behavior changes.
 * - Kill observation is the existing `onKill` hook (engine.hooks.tap) —
 *   observe-only; the Enemy/EnemyManager public contracts are untouched.
 * - Tiers: SEEN (1 kill) / STUDIED / MASTERED at kill counts from a tuning
 *   table (defaults 1/10/50, overridable via spec.custom.bestiary).
 * - The manager is blueprint-owned (the SkillSystem/Progression model):
 *   it rides the live blueprint object across portal transitions, so it is
 *   deliberately NOT a MapLocalEntitySystem. portalSnapshot/portalRestore
 *   exist for the PORTALS-D seam and are unit-tested.
 * - Cross-run store: ProfileData.bestiaryKills (Record<entryId, kills>),
 *   persisted on every kill (player-paced; the write is a tiny JSON blob).
 *
 * DETERMINISM: no RNG anywhere in this module. Counts derive only from
 * kill events; tiers derive only from counts and the tuning table.
 *
 * WEAKNESS LINES: authored field-notes, but every claim is grounded in a
 * real behavior param from engine/game/EnemyAI.ts (cited inline). They are
 * hunter's-notes flavor, not combat rebalances.
 */
import type { Engine } from '../Engine';
import type { EnemyKind } from '@spec';
import type { Enemy } from './EnemyAI';
import { BOSS_DEFS } from './bosses';
import { loadProfile, saveProfile } from './Profile';

/** Registry entry ids: the combat kinds + the boss aggregator. */
export const BESTIARY_BOSS_ID = 'boss';
export const BESTIARY_ENTRY_IDS = [
  'walker',
  'brute',
  'drone',
  'flyer',
  'turret',
  BESTIARY_BOSS_ID,
] as const;
export type BestiaryEntryId = (typeof BESTIARY_ENTRY_IDS)[number] | string;

/** Tier index: 0 = locked, 1 = seen, 2 = studied, 3 = mastered. */
export const BESTIARY_TIER_NAMES = ['LOCKED', 'SEEN', 'STUDIED', 'MASTERED'] as const;

/** Default tier thresholds (kill counts). seen is always 1 by design. */
export const BESTIARY_TIER_THRESHOLDS = { seen: 1, studied: 10, mastered: 50 } as const;

export interface BestiaryEntryDef {
  /** registry id (enemy kind, or 'boss') */
  id: string;
  /** display name shown once unlocked */
  name: string;
  /** short flavor epithet */
  epithet: string;
  /** hunter's-notes lore (1–2 lines) */
  lore: string;
  /** weakness lines — each grounded in a real EnemyAI behavior param */
  weaknesses: readonly string[];
  /** which schematic silhouette the panel draws (no new art) */
  silhouette: 'walker' | 'brute' | 'drone' | 'flyer' | 'turret' | 'boss';
}

function bossNames(): string {
  return Object.values(BOSS_DEFS)
    .map((d) => d.name)
    .join(' / ');
}

/**
 * The presentation registry. Kinds come from the existing enemy defs;
 * names/lore/weaknesses are the codex's authored layer (data-driven —
 * the panel renders these verbatim).
 */
export const BESTIARY_DEFS: readonly BestiaryEntryDef[] = [
  {
    id: 'walker',
    name: 'Ashen Walker',
    epithet: 'the ember-visored foot soldier',
    lore: 'The first thing the valley sends at you. Walks on two legs, swings what it carries, and never stops coming once it smells you.',
    weaknesses: [
      // EnemyAI.ts: melee attackR 2.2 for walker/brute — guns outrange it.
      'Melee reach is short (2.2m) — keep distance and let ranged fire do the work.',
      // aggroR 30 for non-turrets — the chase can be broken at range.
      'Breaks off the chase past ~30m; sprint to disengage.',
    ],
    silhouette: 'walker',
  },
  {
    id: 'brute',
    name: 'Bulwark Brute',
    epithet: 'the walking siege line',
    lore: 'Twice the walker and built like a door. Slow, deliberate, and it hits like a falling wall.',
    weaknesses: [
      // walker/brute share melee attackR 2.2; brutes are slower per EnemySpec.speed tuning.
      'Melee-only like the walker — kite it; it cannot close on a sprinting target.',
      'Wide frame, slow turn — circle-strafe and hit it from the flank.',
    ],
    silhouette: 'brute',
  },
  {
    id: 'drone',
    name: 'Cinder Drone',
    epithet: 'the humming harvester',
    lore: 'A machine core with rotors and a grudge. Hovers low, strafes, and pecks at you from angles walkers cannot reach.',
    weaknesses: [
      // hoverY ~3m for drones (EnemyAI.ts); ranged attackR 26.
      'Hovers ~3m up — projectile arcs land cleanly; melee cannot reach it.',
      'Fragile frame — one solid burst usually ends the argument.',
    ],
    silhouette: 'drone',
  },
  {
    id: 'flyer',
    name: 'Shrike Flyer',
    epithet: 'the sky’s punctuation',
    lore: 'Fast, loud, and rude. Dives from above and is gone before the echo fades.',
    weaknesses: [
      // hoverY ~4m for flyers; attackCd 1.6s (faster than walker 2.2s).
      'Attacks fast (1.6s cycle) but cannot take a hit — lead your shots, it commits to the dive.',
      'Hovers ~4m — same medicine as drones: guns, not fists.',
    ],
    silhouette: 'flyer',
  },
  {
    id: 'turret',
    name: 'Ember Turret',
    epithet: 'the patient gun',
    lore: 'Bolted down and proud of it. Sees farther than anything else in the valley and never blinks.',
    weaknesses: [
      // aggroR 42 for turrets (EnemyAI.ts) — the longest lane in the roster.
      'Stationary — flank it outside its 42m sight lane and it never knew you.',
      'Cannot reposition: cover is a hard counter, not a suggestion.',
    ],
    silhouette: 'turret',
  },
  {
    id: BESTIARY_BOSS_ID,
    name: 'Apex Foes',
    epithet: 'the named nightmares',
    lore: `Brutes the valley gave a name to: ${bossNames()}. Phased, telegraphed, and entirely uninterested in your plans.`,
    weaknesses: [
      // bosses.ts: phased telegraphed attacks with per-phase speed/damage mults.
      'Phased attacks are telegraphed — watch the wind-up, punish the recovery.',
      'Each phase hits harder than the last; end the fight before Desperate.',
    ],
    silhouette: 'boss',
  },
];

/** Tier thresholds for a spec: defaults, overridable via custom.bestiary. */
export interface BestiaryTiers {
  seen: number;
  studied: number;
  mastered: number;
}

/**
 * Config-only tuning: never touches the seed. `tierThresholds` may lower
 * (or raise) studied/mastered for testing or Studio pacing; seen is always
 * 1 (first kill unlocks the entry — the design's promise).
 */
export function resolveBestiaryTiers(spec: { custom?: { bestiary?: { tierThresholds?: { studied?: number; mastered?: number } } } }): BestiaryTiers {
  const raw = spec.custom?.bestiary?.tierThresholds;
  const clamp = (v: unknown, dflt: number): number => {
    const n = typeof v === 'number' && isFinite(v) ? Math.floor(v) : dflt;
    return Math.max(2, Math.min(10000, n));
  };
  return {
    seen: 1,
    studied: clamp(raw?.studied, BESTIARY_TIER_THRESHOLDS.studied),
    mastered: clamp(raw?.mastered, BESTIARY_TIER_THRESHOLDS.mastered),
  };
}

/** Master toggle (default true). Config-only — never touches the seed. */
export function resolveBestiaryEnabled(spec: { custom?: { bestiary?: { enabled?: boolean } } }): boolean {
  const v = spec.custom?.bestiary?.enabled;
  return v === undefined ? true : v !== false;
}

export interface BestiaryManagerOpts {
  enabled?: boolean;
  /** fires on first unlock and on every tier-up (blueprints toast + refresh the panel) */
  onUnlocked?: (def: BestiaryEntryDef, tier: number, kills: number) => void;
}

function sanitizeCounts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
  }
  return out;
}

/**
 * Tier for a kill count under the tuning table: 0 locked, 1 seen, 2
 * studied, 3 mastered. Pure — the panel and tests use this directly.
 */
export function tierForKills(kills: number, tiers: BestiaryTiers): number {
  if (kills >= tiers.mastered) return 3;
  if (kills >= tiers.studied) return 2;
  if (kills >= tiers.seen) return 1;
  return 0;
}

/**
 * BestiaryManager: blueprint-owned kill tracker. Taps the existing
 * onKill hook (observe-only — no Enemy/EnemyManager contract changes).
 * Bosses (Enemy.isBoss) count under the 'boss' entry only, never
 * double-counted under their base kind.
 */
export class BestiaryManager {
  private readonly counts = new Map<string, number>();
  private readonly tiers: BestiaryTiers;
  private readonly enabled_: boolean;
  private readonly onUnlocked?: BestiaryManagerOpts['onUnlocked'];
  private readonly untap: (() => void) | null;

  constructor(
    private readonly engine: Engine,
    opts: BestiaryManagerOpts = {},
  ) {
    this.tiers = resolveBestiaryTiers(engine.spec);
    this.enabled_ = opts.enabled ?? resolveBestiaryEnabled(engine.spec);
    this.onUnlocked = opts.onUnlocked;
    // Cross-run store: seed the live counts from the saved profile.
    const saved = sanitizeCounts(loadProfile().bestiaryKills);
    for (const [k, v] of Object.entries(saved)) this.counts.set(k, v);
    this.untap = this.enabled_
      ? engine.hooks.tap('onKill', ({ enemy }) => this.onKill(enemy))
      : null;
  }

  get enabled(): boolean {
    return this.enabled_;
  }

  /** The tier tuning this manager runs under (defaults or spec override). */
  get tierThresholds(): BestiaryTiers {
    return this.tiers;
  }

  /** Registry defs in display order; runtime-registered custom kinds append after. */
  defs(): readonly BestiaryEntryDef[] {
    return BESTIARY_DEFS;
  }

  defOf(id: string): BestiaryEntryDef | undefined {
    return BESTIARY_DEFS.find((d) => d.id === id);
  }

  countOf(id: string): number {
    return this.counts.get(id) ?? 0;
  }

  tierOf(id: string): number {
    return tierForKills(this.countOf(id), this.tiers);
  }

  /** kills remaining to the next tier; null at mastered or for unknown ids. */
  killsToNext(id: string): number | null {
    if (!this.defOf(id)) return null;
    const c = this.countOf(id);
    if (c >= this.tiers.mastered) return null;
    if (c >= this.tiers.studied) return this.tiers.mastered - c;
    return this.tiers.studied - c;
  }

  /**
   * Record a kill. Public so unit tests can drive it without an engine
   * hook round-trip; the hook path calls the same function. Returns the
   * tier transition (or null when disabled / no transition).
   */
  onKill(enemy: Pick<Enemy, 'isBoss'> & { spec: { kind: EnemyKind } }): { id: string; tier: number; kills: number } | null {
    if (!this.enabled_) return null;
    const id = enemy.isBoss ? BESTIARY_BOSS_ID : enemy.spec.kind;
    if (!this.defOf(id)) return null;
    const before = this.tierOf(id);
    const kills = this.countOf(id) + 1;
    this.counts.set(id, kills);
    const after = this.tierOf(id);
    // Persist on EVERY kill, not just tier transitions: a tier-up-only
    // write silently drops all kills since the last transition on reload
    // (e2e caught count 4 restoring as 3). Kills are player-paced events;
    // a small localStorage write per kill is negligible.
    this.persist();
    if (after > before) {
      this.onUnlocked?.(this.defOf(id)!, after, kills);
      return { id, tier: after, kills };
    }
    return null;
  }

  /** PORTALS-D: snapshot for the portal seam. Plain data, JSON-serializable. */
  portalSnapshot(): { counts: Record<string, number> } {
    return { counts: Object.fromEntries(this.counts) };
  }

  /**
   * PORTALS-D: restore a portalSnapshot(). Defensive: corrupt values are
   * dropped rather than throwing mid-transition; unknown ids are kept
   * (custom kinds may register later) but non-numeric counts are dropped.
   */
  portalRestore(s: { counts: Record<string, number> } | null | undefined): void {
    this.counts.clear();
    for (const [k, v] of Object.entries(sanitizeCounts(s?.counts))) this.counts.set(k, v);
  }

  dispose(): void {
    this.untap?.();
  }

  /** Persist the live counts to the cross-run profile (every kill). */
  private persist(): void {
    try {
      const p = loadProfile();
      p.bestiaryKills = Object.fromEntries(this.counts);
      saveProfile(p);
    } catch {
      /* storage unavailable — the live counts still apply this session */
    }
  }
}
