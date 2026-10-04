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
  /** engine base kind used for body, rig and default behavior */
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
  /** unique id (must not collide with built-in ids) */
  id: string;
  name: string;
  desc: string;
  /** apply the upgrade; mirror built-in conventions (counts + *Mult accessors) */
  apply: (prog: Progression, avatar: PlayerAvatar) => void;
}

export class Modding {
  private taps = new Map<HookName, Set<HookFn<HookName>>>();
  /** custom enemy kinds, keyed by the kind id used in EnemySpec.kind */
  readonly enemyKinds = new Map<string, CustomEnemyKindDef>();
  /** custom upgrades, joined into the level-up pool */
  readonly upgrades = new Map<string, CustomUpgradeDef>();

  constructor(private engine: Engine) {}

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
   * Throws on duplicate registration.
   */
  registerEnemyKind(id: string, def: CustomEnemyKindDef): void {
    if (this.enemyKinds.has(id)) throw new Error(`enemy kind "${id}" already registered`);
    this.enemyKinds.set(id, def);
  }

  /**
   * Register a custom upgrade. It joins the level-up choice pool immediately
   * and applies through Progression.applyUpgrade(id, avatar).
   * Throws on duplicate registration or id collision with built-ins.
   */
  registerUpgrade(def: CustomUpgradeDef): void {
    if (this.upgrades.has(def.id)) throw new Error(`upgrade "${def.id}" already registered`);
    this.upgrades.set(def.id, def);
  }

  /** Custom upgrade defs as UpgradeDef[] for the choice pool. */
  customUpgradeDefs(): UpgradeDef[] {
    return [...this.upgrades.values()].map((d) => ({ id: d.id, name: d.name, desc: d.desc }));
  }
}
