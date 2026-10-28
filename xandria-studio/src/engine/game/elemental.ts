/**
 * ELEMENTAL DAMAGE TYPES (upgrade loop): data-driven damage types and
 * enemy resistances/vulnerabilities, on top of the crit / set-bonus /
 * enchantment damage path. No enemy or NPC public behavior contract
 * changes; the loot ladder is untouched.
 *
 * CONTENT
 * - ELEMENTAL_TABLE — THE damage-type table. Four types (physical, fire,
 *   frost, shock); every type carries its display label, its base color
 *   (used by the bestiary codex resistance rows and the inventory HUD
 *   damage-type row — never by the floating-text theme, which owns its
 *   own colors via accessibility roles), and its STATUS HOOK name.
 * - ENEMY_RESISTANCES — THE resistance table. One multiplier per
 *   (enemy kind, damage type), keyed by kind plus a 'boss' row for
 *   boss-objective brutes. Multipliers are dyadic (0.5 / 0.75 / 1.0 /
 *   1.25 / 1.5) so the rounding in applyElemental is exact, never float
 *   dust at a boundary.
 *
 * STAT-MATH ORDER (disclosed, pinned by unit + e2e test):
 *   1. base damage (weapon / ability def / projectile def)
 *   2. damageMult() — Progression × BlueprintItemKit.damageMult(), i.e.
 *      equippedStats() + setBonusStats() + enchantStats() (the
 *      enchant/set order from those waves is unchanged)
 *   3. seeded damage variance (abilities: uniform[0.9, 1.1]; melee /
 *      projectiles: the caller's existing value, variance already
 *      folded in by its own path)
 *   4. crit (CRIT_TABLE) — multiplies the already-computed value once;
 *      a non-crit is bit-identical to the pre-crit formula
 *   5. ELEMENTAL resistance — applyElemental() multiplies the
 *      crit-applied value by the target kind's table multiplier and
 *      rounds once. Physical is 1.0 for EVERY kind, so untyped callers
 *      (companions, deployables, MeleeCombat, debug damage) that pass
 *      no type are bit-identical to before this phase.
 *   6. Enemy.damage() internals, unchanged: shield-pool absorb first,
 *      then the elite damageTakenMult (armored 0.6) on what gets
 *      through, then health, knockback, boss-phase checks.
 * The elemental step lives in Enemy.damage() (the single funnel every
 * damage-to-enemy path already uses) so the displayed floating number
 * — spawned by each caller from the value damage() returns — always
 * equals the amount that entered damage(). Callers that ignore the
 * return value (companions etc.) are unaffected: the health math is
 * the same either way.
 *
 * STATUS HOOKS: each non-physical type names the hook a future status
 * wave will consume ('burn' / 'chill' / 'stun'). This phase applies NO
 * status effect — no DoT, no slow, no stun — and no enemy behavior
 * changes. The runtime seam is the observe-only `onElementalHit` hook
 * (see Modding.ts HookPayloads): Enemy.damage() emits it on every hit
 * with { enemy, type, amount, multiplier }; zero taps = no-op, so the
 * hook costs nothing in the normal flow and a future status wave taps
 * it instead of touching damage math. statusHook is null for physical.
 *
 * TYPE ASSIGNMENT (data-driven, never RNG):
 * - Melee / projectiles: the equipped weapon enchant's damageType
 *   (outgoingDamageType below — weapon slot only; an accessory enchant
 *   never sets the outgoing type), default 'physical'.
 * - Abilities: the AbilityDef.damageType field (dash-strike physical,
 *   shockwave-slam shock, mend null = no damage).
 * - Enchantments: EnchantDef.damageType (ench_sharp physical,
 *   ench_deadly shock, ench_starlit frost; defensive enchants carry no
 *   type). See enchantments.ts.
 *
 * DETERMINISM: no RNG anywhere in this module. Type assignment is pure
 * data; resistance lookup is pure data. Seeded variance still comes
 * from the callers' existing streams (crit/ability salts), untouched.
 *
 * DEFAULTS: unknown / custom kinds (including 'racer', which has no
 * spawn branch) resolve to 1.0 for every type — a custom kind is never
 * silently resistant or vulnerable. Bosses resolve to the 'boss' row
 * (Enemy.damage() passes isBoss); the bestiary 'boss' aggregator entry
 * renders the same row.
 */
import type { EquipSlot } from '@spec';
import { enchantDef } from './enchantments';

/** The four damage types. 'physical' is the default everywhere. */
export type DamageType = 'physical' | 'fire' | 'frost' | 'shock';

export const DAMAGE_TYPES: readonly DamageType[] = ['physical', 'fire', 'frost', 'shock'];

/** One damage type — label, base color, and the future status hook. */
export interface ElementalTypeDef {
  id: DamageType;
  /** display label, rendered verbatim by the codex / HUD */
  label: string;
  /** base color (codex resistance rows, HUD damage-type row) */
  color: string;
  /**
   * Reserved status-effect hook name for a future status wave, or null.
   * This phase never applies a status effect; see the module header.
   */
  statusHook: 'burn' | 'chill' | 'stun' | null;
  /** one-line flavor, rendered by the codex resistance section header */
  blurb: string;
}

/**
 * THE damage-type table. Every type's presentation + status hook lives
 * here and nowhere else.
 */
export const ELEMENTAL_TABLE: Record<DamageType, ElementalTypeDef> = {
  physical: {
    id: 'physical',
    label: 'Physical',
    color: '#e8ecf1',
    statusHook: null,
    blurb: 'Plain force — no foe resists or fears it.',
  },
  fire: {
    id: 'fire',
    label: 'Fire',
    color: '#ff6a3d',
    statusHook: 'burn',
    blurb: 'Ember-hot. Ashen foes shrug it off; light frames catch.',
  },
  frost: {
    id: 'frost',
    label: 'Frost',
    color: '#7af7ff',
    statusHook: 'chill',
    blurb: 'Bitter cold. Cracks ember armor; machines barely notice.',
  },
  shock: {
    id: 'shock',
    label: 'Shock',
    color: '#ffd23d',
    statusHook: 'stun',
    blurb: 'Arcing current. Shorts machines and turrets outright.',
  },
};

/** Lookup by id (undefined for unknown ids). */
export function elementalDef(type: string): ElementalTypeDef | undefined {
  return (ELEMENTAL_TABLE as Record<string, ElementalTypeDef>)[type];
}

/** True when the value is one of the four known damage types. */
export function isDamageType(value: unknown): value is DamageType {
  return typeof value === 'string' && value in ELEMENTAL_TABLE;
}

/** Normalize an unknown caller value to a known type (default physical). */
export function normalizeDamageType(value: unknown): DamageType {
  return isDamageType(value) ? value : 'physical';
}

/**
 * THE resistance table: multiplier per (enemy kind, damage type).
 * Rows are keyed by the EnemyAI build kind ('walker' | 'brute' |
 * 'drone' | 'flyer' | 'turret') plus 'boss' for boss-objective brutes.
 * Grounded in the bestiary field notes: ember-visored walkers/brutes
 * resist fire and crack under frost; drones/turrets are machines that
 * short out under shock; flyers are light frames that catch fire.
 * Physical is 1.0 in every row by design (see the module header).
 */
export const ENEMY_RESISTANCES: Record<string, Record<DamageType, number>> = {
  walker: { physical: 1, fire: 0.75, frost: 1.5, shock: 1 },
  brute: { physical: 1, fire: 0.5, frost: 1.25, shock: 1 },
  drone: { physical: 1, fire: 1.25, frost: 0.75, shock: 1.5 },
  flyer: { physical: 1, fire: 1.5, frost: 1, shock: 1.25 },
  turret: { physical: 1, fire: 0.5, frost: 1, shock: 1.5 },
  boss: { physical: 1, fire: 0.75, frost: 1.25, shock: 0.75 },
};

/** Resistance row id for a boss-objective enemy. */
export const ELEMENTAL_BOSS_ROW = 'boss';

/**
 * Pure: the table multiplier for a kind + type. Unknown kinds (custom
 * kinds, 'racer') and unknown types resolve to 1.0 — never silently
 * resistant or vulnerable. Bosses read the 'boss' row.
 */
export function resistanceFor(kind: string, type: DamageType, isBoss = false): number {
  const row = ENEMY_RESISTANCES[isBoss ? ELEMENTAL_BOSS_ROW : kind];
  const mult = row?.[type];
  return typeof mult === 'number' && Number.isFinite(mult) && mult >= 0 ? mult : 1;
}

/** Alias naming the step in the disclosed stat-math order. */
export function elementalMultiplierFor(kind: string, type: DamageType, isBoss = false): number {
  return resistanceFor(kind, type, isBoss);
}

/**
 * Pure: apply the elemental step (order step 5). Multiplies the
 * already crit-applied value by the kind's table multiplier and rounds
 * once. Physical (and any unknown kind/type) returns the input
 * bit-identical.
 */
export function applyElemental(
  amount: number,
  kind: string,
  type: DamageType,
  isBoss = false,
): number {
  const mult = resistanceFor(kind, type, isBoss);
  return mult === 1 ? amount : Math.round(amount * mult);
}

/**
 * The floating-text value for a hit: the crit-applied amount run
 * through the elemental step, computed caller-side from the target's
 * build kind. Caller-side by design: the shielded-variant wrapper
 * scales the amount BEFORE Enemy.damage(), and that reduction is
 * HP-only — the number main always showed was the caller's value, and
 * this preserves it exactly (a shielded front hit shows the crit value,
 * not the reduced one). When the kind is unknown (test fakes), the
 * caller-supplied fallback (damage()'s return, or the raw amount) is
 * used instead, so fakes never need a kind.
 */
export function displayedDamage(
  amount: number,
  kind: string | undefined,
  type: DamageType,
  fallback: number,
): number {
  return kind ? applyElemental(amount, kind, type) : fallback;
}

// ---------------------------------------------------------------------------
// Codex / HUD presentation (observe-only — the panel renders these verbatim)
// ---------------------------------------------------------------------------

export type ResistanceVerdict = 'vulnerable' | 'resistant' | 'normal';

/** One codex resistance line: type, multiplier, verdict, display color. */
export interface ResistanceLine {
  type: DamageType;
  label: string;
  multiplier: number;
  verdict: ResistanceVerdict;
  color: string;
  /** rendered line, e.g. "Fire ×1.5 — vulnerable" */
  text: string;
}

function verdictFor(mult: number): ResistanceVerdict {
  if (mult > 1) return 'vulnerable';
  if (mult < 1) return 'resistant';
  return 'normal';
}

/**
 * Pure: the four resistance lines for a kind (boss row when isBoss),
 * in DAMAGE_TYPES order. The bestiary panel renders these verbatim for
 * unlocked entries; the values are the SAME table Enemy.damage() uses,
 * so the codex can never lie about resistances.
 */
export function resistanceLines(kind: string, isBoss = false): ResistanceLine[] {
  return DAMAGE_TYPES.map((type) => {
    const def = ELEMENTAL_TABLE[type];
    const multiplier = resistanceFor(kind, type, isBoss);
    const verdict = verdictFor(multiplier);
    return {
      type,
      label: def.label,
      multiplier,
      verdict,
      color: def.color,
      text: `${def.label} ×${multiplier} — ${verdict}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Outgoing type resolution (enchantments -> weapon damage type)
// ---------------------------------------------------------------------------

/**
 * The outgoing damage type for a loadout: the WEAPON-slot enchant's
 * damageType when the enchanted weapon carries one, else 'physical'.
 * Only the weapon slot counts — an accessory enchant (e.g. Starlit Edge
 * on an accessory) grants its stats but never sets the outgoing type,
 * and a weapon enchant without a type (defensive enchants cannot be
 * applied to weapons) falls back to physical. Pure function of
 * (equipped slots, per-id enchant state) — the same inputs
 * computeEnchantStats reads. Never throws.
 */
export function outgoingDamageType(
  equipped: Partial<Record<EquipSlot, string>>,
  enchants: ReadonlyMap<string, string>,
): DamageType {
  const weaponId = equipped.weapon;
  if (typeof weaponId !== 'string') return 'physical';
  const enchantId = enchants.get(weaponId);
  if (!enchantId) return 'physical';
  const def = enchantDef(enchantId);
  return def?.damageType ?? 'physical';
}

/** Detail for HUD display: the outgoing type + the enchant that set it. */
export function outgoingDamageTypeDetail(
  equipped: Partial<Record<EquipSlot, string>>,
  enchants: ReadonlyMap<string, string>,
): { type: DamageType; enchantId: string | null } {
  const weaponId = equipped.weapon;
  if (typeof weaponId !== 'string') return { type: 'physical', enchantId: null };
  const enchantId = enchants.get(weaponId);
  if (!enchantId) return { type: 'physical', enchantId: null };
  const def = enchantDef(enchantId);
  if (!def?.damageType) return { type: 'physical', enchantId: null };
  return { type: def.damageType, enchantId: def.id };
}
