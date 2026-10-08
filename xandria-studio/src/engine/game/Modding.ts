/**
 * Modding — the formal hook/registry surface for developers building on top
 * of XANDRIA games. Everything here is additive: when no hooks are tapped and
 * no custom defs are registered, engine behavior is byte-identical.
 *
 *   engine.hooks.tap('onKill', ({ enemy }) => { ... });
 *   engine.hooks.registerEnemyKind('stalker', { base: 'walker', ... });
 *   engine.hooks.registerUpgrade({ id: 'vampire', name: '...', desc: '...', apply(prog, avatar) { ... } });
 *
 * Hook taps fire at the natural engine call sites (kills, pickups, stage
 * transitions, boss phases, level-ups, win/lose, per-tick). Custom enemy kinds
 * ride the normal spawn pipeline (EnemySpec.kind is cast to the custom id);
 * custom upgrades join the level-up choice pool and apply through the same
 * applyUpgrade() path as built-ins.
 *
 * Pre-boot registration (R2-M4, real-page wiring R3-M1): pages that inject
 * `window.__XANDRIA_SPEC__` validate the spec before any Engine exists. In a
 * real browser page the bundle is a deferred ES module, so the registration
 * API ships as a tiny inline classic <script> in player.html (ahead of the
 * bundle) that queues registrations on `window.__XANDRIA__._preBootKinds`;
 * the bundle drains the queue into the module-level registry at module load,
 * before boot() validates the injected spec. A modder's own classic <script>
 * automatically runs between the two (all classic scripts precede the
 * deferred bundle module):
 *   <script>__XANDRIA__.registerEnemyKind('stalker', { base: 'walker', name: 'Stalker' });</script>
 *   <script>window.__XANDRIA_SPEC__ = specWithStalkerKind;</script>
 * Exported standalone games carry the inline script automatically (they are
 * built from dist/player.html).
 */
import type * as THREE from 'three';
import type { Engine } from '../Engine';
import type { Enemy } from './EnemyAI';
import type { EnemyKind, ObjectiveStage } from '@spec';
import type { Pickup } from './Pickups';
import type { RunStats } from './HUD';
import type { Progression, UpgradeDef } from './Progression';
import type { PlayerAvatar } from '../../blueprints/common';

/** Payloads delivered to each hook tap. */
export interface HookPayloads {
  onKill: { enemy: Enemy };
  onPickup: { pickup: Pickup };
  onStageComplete: { index: number; stage: ObjectiveStage };
  onPhase: { enemy: Enemy; phase: number };
  onLevelUp: { level: number; progression: Progression };
  onWin: { stats: Partial<RunStats> };
  onLose: { reason: string; stats: Partial<RunStats> };
  onTick: { dt: number; t: number };
}

export type HookName = keyof HookPayloads;
export type HookFn<N extends HookName> = (payload: HookPayloads[N]) => void;

/**
 * A custom enemy kind. The body/rig/behavior are built from an engine base
 * kind, re-tinted, optionally re-scaled, with an optional per-tick behavior
 * overlay that runs after the base update().
 */
export interface CustomEnemyKindDef {
  /**
   * Engine base kind used for body, rig and default behavior. Must be one
   * of CUSTOM_ENEMY_BASES — the EnemyKind values with a real EnemyAI build
   * branch. 'racer' is in ENEMY_KINDS but has NO build branch (it is a
   * racing-mode vehicle role, not an AI body), so a kind based on it would
   * spawn with null body/rig: invisible, immobile, unhittable.
   * registerEnemyKind rejects unknown bases loudly (R2-N7).
   */
  base: EnemyKind;
  /** display name, used by banners/debug */
  name: string;
  /** re-tint; falls back to the base kind's colors */
  tint?: { shirt: string; pants: string; accent: string };
  /** uniform scale multiplier for body + rig */
  scale?: number;
  /**
   * Per-tick overlay after the base update(). Use engine.rng (seeded) for any
   * simulation-affecting decisions — Math.random here breaks determinism.
   */
  update?: (enemy: Enemy, ctx: { dt: number; t: number; playerPos: THREE.Vector3 }) => void;
}

/**
 * A custom upgrade. Joins the level-up choice pool (3 distinct choices per
 * level-up, drawn from built-ins + customs via engine.rng) and applies through
 * Progression.applyUpgrade() like a built-in.
 */
export interface CustomUpgradeDef {
  /**
   * Unique id for the choice pool. Not checked against built-in ids — if it
   * collides with one ('damage' | 'maxhp' | 'speed' | 'firerate' | 'magnet'
   * | 'dash'), the built-in wins at apply time (Progression.applyUpgrade's
   * switch handles built-ins before customs), so the custom apply() would
   * never run. Use an id no built-in uses.
   */
  id: string;
  name: string;
  desc: string;
  /** apply the upgrade; mirror built-in conventions (counts + *Mult accessors) */
  apply: (prog: Progression, avatar: PlayerAvatar) => void;
}

/**
 * Legal `base` values for registerEnemyKind: the EnemyKind values with a
 * real EnemyAI build branch (body + rig + behavior) — see the constructor
 * in engine/game/EnemyAI.ts ('walker'/'brute' capsule+humanoid,
 * 'drone'/'flyer' sphere+drone, 'turret' cylinder+turret). 'racer' is
 * deliberately excluded: it is in ENEMY_KINDS but has no build branch, so
 * a custom kind based on it would spawn with null body/rig — a silent
 * ghost enemy (R2-N7). Keep in sync with EnemyAI's constructor branches.
 */
export const CUSTOM_ENEMY_BASES = ['walker', 'drone', 'turret', 'brute', 'flyer'] as const;
export type CustomEnemyBase = (typeof CUSTOM_ENEMY_BASES)[number];

/**
 * Module-level pre-boot enemy-kind registry (R2-M4). `resolveSpec()` in the
 * player bootstrap validates an injected `window.__XANDRIA_SPEC__` BEFORE any
 * Engine exists, so per-engine registrations can't be visible there. Kinds
 * registered here — via `registerPreBootEnemyKind`, exposed pre-boot as
 * `window.__XANDRIA__.registerEnemyKind` — are passed to `validateSpec` at
 * resolve time, and every Modding instance merges them at construction so
 * EnemyAI can build them. Deliberately separate from the per-engine map:
 * instance `registerEnemyKind` stays per-engine (re-registering the same id
 * on a fresh engine after restart must not throw).
 */
const preBootEnemyKinds = new Map<string, CustomEnemyKindDef>();

/** Shared def validation for both registration paths (R2-N7). */
function assertValidEnemyKindDef(id: string, def: CustomEnemyKindDef): void {
  if (!def || typeof def !== 'object')
    throw new Error(`registerEnemyKind("${id}"): def must be an object`);
  const base = (def as CustomEnemyKindDef).base as string;
  if (!(CUSTOM_ENEMY_BASES as readonly string[]).includes(base)) {
    throw new Error(
      `registerEnemyKind("${id}"): unknown base "${String(base)}" — base must be one of ` +
      `${CUSTOM_ENEMY_BASES.join('|')} (EnemyKind values with an EnemyAI build branch; ` +
      `"racer" has none and would spawn a null body/rig ghost)`,
    );
  }
}

/**
 * Register a custom enemy kind before boot (R2-M4; real-page wiring R3-M1).
 * Same validation as the instance method. In a real page, register from a
 * classic <script> placed after the inline pre-boot script in player.html
 * (or in an exported standalone game, which carries it automatically), then
 * inject the spec:
 *   __XANDRIA__.registerEnemyKind('stalker', { base: 'walker', name: 'Stalker' });
 *   window.__XANDRIA_SPEC__ = spec; // enemies may use kind: 'stalker'
 */
export function registerPreBootEnemyKind(id: string, def: CustomEnemyKindDef): void {
  assertValidEnemyKindDef(id, def);
  if (preBootEnemyKinds.has(id)) throw new Error(`enemy kind "${id}" already registered`);
  preBootEnemyKinds.set(id, def);
}

/** Ids of pre-boot-registered custom enemy kinds, for `validateSpec` opts. */
export function preBootEnemyKindIds(): Iterable<string> {
  return preBootEnemyKinds.keys();
}

export class Modding {
  private taps = new Map<HookName, Set<HookFn<HookName>>>();
  /** custom enemy kinds, keyed by the kind id used in EnemySpec.kind */
  readonly enemyKinds = new Map<string, CustomEnemyKindDef>();
  /** custom upgrades, joined into the level-up pool */
  readonly upgrades = new Map<string, CustomUpgradeDef>();

  constructor(private engine: Engine) {
    // Pick up kinds registered pre-boot (R2-M4) so EnemyAI can build them.
    for (const [id, def] of preBootEnemyKinds) this.enemyKinds.set(id, def);
  }

  /** Subscribe to a hook. Returns an untap function. */
  tap<N extends HookName>(name: N, fn: HookFn<N>): () => void {
    let set = this.taps.get(name);
    if (!set) this.taps.set(name, (set = new Set()));
    const wrapped = fn as HookFn<HookName>;
    set.add(wrapped);
    return () => { set!.delete(wrapped); };
  }

  /** Fire a hook (engine-internal; safe to call with zero taps). */
  emit<N extends HookName>(name: N, payload: HookPayloads[N]): void {
    const set = this.taps.get(name);
    if (!set) return;
    for (const fn of [...set]) (fn as HookFn<N>)(payload);
  }

  /** Number of taps on a hook (useful in tests/debug). */
  tapCount(name: HookName): number {
    return this.taps.get(name)?.size ?? 0;
  }

  /**
   * Register a custom enemy kind. Spawn it by casting the kind id into
   * EnemySpec.kind, e.g. `{ kind: 'stalker' as EnemyKind, ... }`.
   * Throws on duplicate registration, on a non-object def, and on an
   * unknown `base` (R2-N7): the base must be one of CUSTOM_ENEMY_BASES —
   * 'racer' and other values have no EnemyAI build branch and would spawn
   * a null body/rig ghost, so they are rejected here instead of failing
   * silently at spawn time.
   *
   * Note: this is per-engine. It does NOT publish to the pre-boot registry —
   * specs validated before boot (injected `window.__XANDRIA_SPEC__`) only see
   * kinds registered via `registerPreBootEnemyKind` / the pre-boot
   * `__XANDRIA__.registerEnemyKind` API (R2-M4). Keeping the two registries
   * separate preserves per-engine isolation (re-registering the same id on a
   * fresh engine after restart must not throw).
   */
  registerEnemyKind(id: string, def: CustomEnemyKindDef): void {
    assertValidEnemyKindDef(id, def);
    if (this.enemyKinds.has(id)) throw new Error(`enemy kind "${id}" already registered`);
    this.enemyKinds.set(id, def);
  }

  /**
   * Register a custom upgrade. It joins the level-up choice pool immediately
   * and applies through Progression.applyUpgrade(id, avatar).
   * Throws on duplicate registration, on a non-object def, and when `apply`
   * is not a function (R2-N8) — Progression.applyUpgrade calls it directly,
   * so a missing apply would TypeError at apply time; reject it here.
   * Note: unlike the old doc claim, a custom id that collides with a
   * built-in id is NOT rejected — the built-in's apply path wins (see
   * CustomUpgradeDef.id), so register a unique id.
   */
  registerUpgrade(def: CustomUpgradeDef): void {
    if (!def || typeof def !== 'object')
      throw new Error('registerUpgrade: def must be an object');
    const d = def as CustomUpgradeDef;
    if (typeof d.apply !== 'function')
      throw new Error(`registerUpgrade("${String(d.id)}"): apply must be a function — got ${typeof d.apply}`);
    if (this.upgrades.has(d.id)) throw new Error(`upgrade "${d.id}" already registered`);
    this.upgrades.set(d.id, def);
  }

  /** Custom upgrade defs as UpgradeDef[] for the choice pool. */
  customUpgradeDefs(): UpgradeDef[] {
    return [...this.upgrades.values()].map((d) => ({ id: d.id, name: d.name, desc: d.desc }));
  }
}
