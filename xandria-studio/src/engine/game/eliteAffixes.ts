/**
 * UPGRADE LOOP (elite-affixes phase): seeded elite enemy affixes.
 *
 * An elite is a normal enemy carrying 1-2 affixes from the single
 * ELITE_AFFIX_DEFS table below — all tuning lives there, nowhere else.
 * Affixes are ADDITIVE on top of the enemy-scaling level band, the
 * difficulty multiplier and the NG+ multiplier (spawnOne applies them
 * last, on a scaled copy — the authored spec is never mutated), and they
 * change no NPC/enemy public behavior contract: no new attack shapes, no
 * new movement modes, no loot-table changes. The loot ladder is untouched:
 * affixed elites keep exactly the kill economy they already had (brutes
 * keep the pre-existing economy.ts "elite" scrap line and the
 * enchantments elite-table entries — this phase adds no drop).
 *
 * Determinism: the elite roll is a pure function of (spawnSeed,
 * eliteChance). spawnSeed is the per-enemy seed EnemyManager already
 * derives as a pure function of mapSeed (+ spawn index), so the same
 * (mapSeed, spawn, eliteChance) -> the identical affix set. The roll
 * draws from its OWN stream, `new Rng((spawnSeed ^ ELITE_SALT) >>> 0)`,
 * in a fixed draw order (elite? -> count -> picks) — it never touches
 * the roster stream, the scaling-variance stream, the loot stream, or
 * engine.rng / Math.random / Date.now.
 *
 * Default eliteChance is 0: with the default, spawnOne is byte-identical
 * to before this phase (no roll draws consumed, no affixes, no marker).
 * Blueprints wire eliteChance from spec.custom.eliteAffixes.chance
 * (resolveEliteChance, config-only, never touches the seed); Studio can
 * raise it later without a code change.
 *
 * Affix mechanics (all implemented in EnemyAI, all additive):
 * - swift:    speed x1.5 (spec.speed on the scaled copy).
 * - armored:  health x1.5 AND damage taken x0.6 (Enemy.damageTakenMult).
 * - vampiric: damage x1.25 AND heals 20% of damage dealt on every
 *             successful attack execution (melee hit + projectile launch
 *             branches in Enemy.update — the heal is capped at maxHealth).
 * - volatile: damage x1.4 AND detonates on death: if the killing blow was
 *             struck from within VOLATILE_RADIUS of the death site, the
 *             player takes 50% of the enemy's damage through the existing
 *             onPlayerHit channel (Enemy.lastDamageFrom, set in damage()).
 * - shielded: a shield pool of 50% of maxHealth that absorbs damage
 *             before health (Enemy.shield, consumed in damage()).
 *
 * Visual marker: there is no floating-nameplate system in this codebase,
 * so this phase invents none. The shipped marker reuses the existing
 * render path only: Enemy.applyEliteMarker() tints the rig through the
 * existing applyGlow() emissive path (gold #ffd700), plus the data label
 * Enemy.eliteLabel ("⚡ Swift · 🩸 Vampiric") exposed through the
 * enemyTest seam and the bestiary codex. On the instanced portal path
 * the gold emissive becomes one extra canonical bucket per geometry
 * (emissive is part of the instancer bucket key) — bounded per geometry,
 * never per enemy; the perf e2e measures the delta.
 */
import { Rng } from '../core/Rng';

/** Salt mixed into the per-enemy spawn seed for the elite roll stream. */
export const ELITE_SALT = 0xe11e7e;

/** Gold tint for the elite marker (existing applyGlow emissive path). */
export const ELITE_MARKER_COLOR = '#ffd700';

/** Volatile detonation radius (metres from the death site). */
export const VOLATILE_RADIUS = 6;

/** Volatile detonation damage, as a fraction of the enemy's damage. */
export const VOLATILE_DAMAGE_FRAC = 0.5;

/** Chance a rolled elite carries 2 affixes instead of 1. */
export const ELITE_DOUBLE_CHANCE = 0.35;

export type EliteAffixId = 'swift' | 'armored' | 'vampiric' | 'volatile' | 'shielded';

export interface EliteAffixDef {
  id: EliteAffixId;
  /** display name */
  name: string;
  /** glyph shown in labels and the bestiary codex */
  icon: string;
  /** codex effect line (plain language, matches the shipped mechanics) */
  effect: string;
  /** multiplier applied to the scaled spec.health */
  hpMult: number;
  /** multiplier applied to the scaled spec.damage */
  dmgMult: number;
  /** multiplier applied to the scaled spec.speed */
  speedMult: number;
  /** multiplier applied to the kill XP (on top of band/difficulty/NG+) */
  xpMult: number;
  /** multiplier applied to damage taken (1 = no reduction) */
  damageTakenMult: number;
  /** shield pool as a fraction of maxHealth (0 = no shield) */
  shieldFrac: number;
  /** fraction of damage dealt healed on attack (0 = no lifesteal) */
  lifestealFrac: number;
}

/**
 * The whole affix table. Design intent: every affix is a visible threat
 * change, not a stat fog — speed, armor, lifesteal, detonation and shield
 * each read differently in combat, and every one pays extra XP so elites
 * are worth hunting.
 */
export const ELITE_AFFIX_DEFS: readonly EliteAffixDef[] = [
  {
    id: 'swift', name: 'Swift', icon: '⚡',
    effect: 'Moves 50% faster — it closes distance before you can kite it.',
    hpMult: 1, dmgMult: 1, speedMult: 1.5, xpMult: 1.15,
    damageTakenMult: 1, shieldFrac: 0, lifestealFrac: 0,
  },
  {
    id: 'armored', name: 'Armored', icon: '🛡',
    effect: '50% more health and takes 40% less damage — bring sustained fire.',
    hpMult: 1.5, dmgMult: 1, speedMult: 1, xpMult: 1.25,
    damageTakenMult: 0.6, shieldFrac: 0, lifestealFrac: 0,
  },
  {
    id: 'vampiric', name: 'Vampiric', icon: '🩸',
    effect: 'Hits 25% harder and heals 20% of the damage it deals — end fights fast.',
    hpMult: 1.1, dmgMult: 1.25, speedMult: 1, xpMult: 1.3,
    damageTakenMult: 1, shieldFrac: 0, lifestealFrac: 0.2,
  },
  {
    id: 'volatile', name: 'Volatile', icon: '💥',
    effect: 'Hits 40% harder and detonates on death — keep your distance for the kill.',
    hpMult: 1, dmgMult: 1.4, speedMult: 1, xpMult: 1.25,
    damageTakenMult: 1, shieldFrac: 0, lifestealFrac: 0,
  },
  {
    id: 'shielded', name: 'Shielded', icon: '🔷',
    effect: 'Carries a shield pool equal to 50% of its health — burn the shield first.',
    hpMult: 1, dmgMult: 1, speedMult: 1, xpMult: 1.25,
    damageTakenMult: 1, shieldFrac: 0.5, lifestealFrac: 0,
  },
];

export function eliteAffixDef(id: EliteAffixId): EliteAffixDef {
  return ELITE_AFFIX_DEFS.find((d) => d.id === id)!;
}

/**
 * Elite chance from a spec: spec.custom.eliteAffixes.chance, clamped to
 * [0, 1]. Absent / non-numeric = 0 (identity: no elites, byte-identical
 * spawns). Config-only — never touches the seed.
 */
export function resolveEliteChance(spec: { custom?: { eliteAffixes?: { chance?: number } } }): number {
  const raw = spec?.custom?.eliteAffixes?.chance;
  if (typeof raw !== 'number' || !isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
}

export interface EliteRoll {
  isElite: boolean;
  /** affix ids in table order (deterministic display order) */
  affixes: EliteAffixId[];
}

/**
 * The seeded elite roll. Pure + deterministic: same (spawnSeed,
 * eliteChance) -> same roll. Fixed draw order on one stream:
 * elite? -> double? -> first pick -> (second pick, distinct).
 * eliteChance <= 0 short-circuits before any draw (identity path).
 */
export function rollEliteAffixes(spawnSeed: number, eliteChance: number): EliteRoll {
  const chance = typeof eliteChance === 'number' && isFinite(eliteChance)
    ? Math.max(0, Math.min(1, eliteChance)) : 0;
  if (chance <= 0) return { isElite: false, affixes: [] };
  const rng = new Rng(((spawnSeed ^ ELITE_SALT) >>> 0));
  if (!rng.chance(chance)) return { isElite: false, affixes: [] };
  const double = rng.chance(ELITE_DOUBLE_CHANCE);
  const first = rng.int(0, ELITE_AFFIX_DEFS.length - 1);
  const affixes: EliteAffixId[] = [ELITE_AFFIX_DEFS[first].id];
  if (double) {
    // Distinct second pick: draw an index into the remaining defs.
    const rest = ELITE_AFFIX_DEFS.filter((_, i) => i !== first);
    affixes.push(rest[rng.int(0, rest.length - 1)].id);
  }
  // Table order for display stability (the roll order is draw order;
  // labels and codex always read table order).
  affixes.sort((a, b) =>
    ELITE_AFFIX_DEFS.findIndex((d) => d.id === a) - ELITE_AFFIX_DEFS.findIndex((d) => d.id === b));
  return { isElite: true, affixes };
}

export interface EliteMods {
  hpMult: number;
  dmgMult: number;
  speedMult: number;
  xpMult: number;
  damageTakenMult: number;
  shieldFrac: number;
  lifestealFrac: number;
  volatile: boolean;
}

/** Identity mods (no affixes): every multiplier 1, no mechanics. */
export const IDENTITY_ELITE_MODS: EliteMods = {
  hpMult: 1, dmgMult: 1, speedMult: 1, xpMult: 1,
  damageTakenMult: 1, shieldFrac: 0, lifestealFrac: 0, volatile: false,
};

/**
 * Combined mods for an affix set. Multipliers stack multiplicatively;
 * shieldFrac / lifestealFrac take the max (two affixes never both set
 * them today, but max keeps a future combo sane); volatile is OR.
 * Pure — no RNG.
 */
export function eliteModsFor(affixes: readonly EliteAffixId[]): EliteMods {
  const out: EliteMods = { ...IDENTITY_ELITE_MODS };
  for (const id of affixes) {
    const d = eliteAffixDef(id);
    out.hpMult *= d.hpMult;
    out.dmgMult *= d.dmgMult;
    out.speedMult *= d.speedMult;
    out.xpMult *= d.xpMult;
    out.damageTakenMult *= d.damageTakenMult;
    out.shieldFrac = Math.max(out.shieldFrac, d.shieldFrac);
    out.lifestealFrac = Math.max(out.lifestealFrac, d.lifestealFrac);
    if (id === 'volatile') out.volatile = true;
  }
  return out;
}

export interface AffixedStats {
  health: number;
  damage: number;
  speed: number;
  xpMult: number;
  mods: EliteMods;
}

/**
 * Apply an affix set to already-scaled (band/difficulty/NG+) stats.
 * Pure — the caller passes the scaled numbers and gets affixed numbers
 * back; nothing here mutates a spec object.
 */
export function applyEliteAffixes(
  health: number,
  damage: number,
  speed: number,
  xpMult: number,
  affixes: readonly EliteAffixId[],
): AffixedStats {
  const mods = eliteModsFor(affixes);
  return {
    health: health * mods.hpMult,
    damage: damage * mods.dmgMult,
    speed: speed * mods.speedMult,
    xpMult: xpMult * mods.xpMult,
    mods,
  };
}

/** Display label for an elite: "⚡ Swift · 🩸 Vampiric" ('' when none). */
export function eliteLabel(affixes: readonly EliteAffixId[]): string {
  const order = (id: EliteAffixId) => ELITE_AFFIX_DEFS.findIndex((d) => d.id === id);
  return [...affixes].sort((a, b) => order(a) - order(b)).map((id) => {
    const d = eliteAffixDef(id);
    return `${d.icon} ${d.name}`;
  }).join(' · ');
}

/** Codex lines for the bestiary panel (observe-only presentation data). */
export function eliteCodexLines(): { id: EliteAffixId; icon: string; name: string; effect: string }[] {
  return ELITE_AFFIX_DEFS.map((d) => ({ id: d.id, icon: d.icon, name: d.name, effect: d.effect }));
}
