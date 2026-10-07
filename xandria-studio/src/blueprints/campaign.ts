/**
 * Campaign-layer wiring shared by all genre blueprints.
 *
 * Quest chains (Objectives stage sequencer), intro/chapter story cards,
 * and the XP level-up flow (Progression + HUD modal). All helpers are
 * no-ops when the spec lacks the new fields, so legacy specs keep working.
 */
import type { Engine } from '../engine/Engine';
import type { GameSpec, ObjectiveStage, ObjectiveType } from '@spec';
import * as THREE from 'three';
import { Objectives } from '../engine/game/Objectives';
import { Progression, type UpgradeDef, type UpgradeId } from '../engine/game/Progression';
import { AssetRegistry, rigsOfKind } from '../engine/game/Assets';
import type { EnemyManager } from '../engine/game/EnemyAI';
import type { Pickups, Pickup } from '../engine/game/Pickups';
import type { PlayerAvatar } from './common';
import { effectOf } from './fx';
import type { VariantDirector, EnemyVariant } from './enemies';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
export const roman = (n: number): string => ROMAN[n - 1] ?? String(n);

/** Intro story card (non-blocking, auto-dismisses). Guard: narrative is optional. */
export function showIntroCard(engine: Engine, spec: GameSpec): void {
  const premise = spec.narrative?.premise;
  if (premise) {
    // fire-and-forget: showCard never pauses, so boot flow is unaffected
    void engine.hud.showCard(spec.meta.name, premise);
  }
}

export type StageHandler = (
  finishedIndex: number,
  finished: ObjectiveStage,
  /** The stage that runs next, or null when the campaign ends here. */
  next: ObjectiveStage | null,
) => void;

/**
 * Build an Objectives sequencer wired to chapter cards.
 * On each stage completion: banner "Chapter <roman>" + refresh the HUD
 * objective line to the new stage's description. Chapter numbers count
 * chapters cleared (branch-aware), not array position.
 */
export function makeCampaignObjectives(
  engine: Engine,
  spec: GameSpec,
  extra?: StageHandler,
  getLevel?: () => number,
): Objectives {
  const hud = engine.hud;
  let chapterNo = 1;
  const objectives = new Objectives(engine, spec.objective, (finishedIndex, finished, next) => {
    chapterNo++;
    const label = `Chapter ${roman(chapterNo)}`;
    const body = next?.description ?? finished.description;
    hud.showCard(label, body);
    hud.setObjective(spec.meta.name.toUpperCase(), body);
    extra?.(finishedIndex, finished, next);
  }, getLevel);
  const first = spec.objective.stages?.[0];
  hud.setObjective(spec.meta.name.toUpperCase(), first?.description ?? spec.objective.description);
  return objectives;
}

/**
 * Level-up flow for humanoid blueprints (PlayerAvatar present).
 * Returns a `notifyLevelUp()` function: call it whenever Progression.onKill()
 * or onPickup() returns true. Modals are queued so rapid multi-level-ups
 * each get their own choice screen. 'dash' is filtered out (no mutable hook
 * on CharacterController); speed upgrades scale spec.player.speed, which the
 * controller reads per-frame.
 */
export function makeLevelUpFlow(
  engine: Engine,
  spec: GameSpec,
  prog: Progression,
  avatar: PlayerAvatar,
): () => void {
  let chain: Promise<void> = Promise.resolve();
  return () => {
    chain = chain.then(async () => {
      const all = prog.getUpgradeChoices();
      const usable = all.filter((c: UpgradeDef) => c.id !== 'dash');
      const id = (await engine.hud.showLevelUp(usable.length ? usable : all)) as UpgradeId;
      prog.applyUpgrade(id, avatar);
      if (id === 'speed') spec.player.speed *= 1.12; // == speedMult() for one stack, compounds
    });
  };
}

/** XP for a kill; triggers the level-up queue when a level is gained. */
export function grantKillXp(prog: Progression, notifyLevelUp: () => void): void {
  if (prog.onKill()) notifyLevelUp();
}

/** XP for a pickup; triggers the level-up queue when a level is gained. */
export function grantPickupXp(prog: Progression, notifyLevelUp: () => void): void {
  if (prog.onPickup()) notifyLevelUp();
}

/** Boss-phase banner shared by all combat blueprints. */
export function bossPhaseBanner(engine: Engine, phase: number): void {
  engine.hud.showCard(
    'THE WARDEN ENRAGES',
    phase >= 2 ? 'It fights with desperate fury — finish it!' : 'Its attacks quicken. Watch the tells!',
  );
  engine.audio.play('alarm');
}

/** True when this spec has any boss stage (quest chain or legacy). */
export function hasBossStage(spec: GameSpec): boolean {
  if (spec.objective.type === 'boss') return true;
  return !!spec.objective.stages?.some((s: ObjectiveStage) => s.type === 'boss');
}

/**
 * True when the run needs a reach goal flag: legacy 'reach' objective, or any
 * 'reach' stage inside a quest chain. (B2 — gating the flag on the legacy
 * type alone left staged beacon stages with goalPos === null, unwinnable.)
 */
export function needsReachGoal(spec: GameSpec): boolean {
  if (spec.objective.type === 'reach') return true;
  return spec.objective.stages?.some((s) => s.type === 'reach') ?? false;
}

/**
 * Brutes the current stage still needs spawned. Boss stages (e.g. the
 * fps-arena 'ruin' branch) require their quota spawned during the stage
 * itself — a brute spent on an earlier stage doesn't count. Returns 0 when
 * the stage isn't a boss stage, is already satisfied (choice modal open), or
 * a brute is already alive. (M4)
 */
export function bossQuotaDeficit(
  stage: ObjectiveStage | undefined,
  progress: number,
  brutesSpawnedForStage: number,
  aliveBrutes: number,
): number {
  if (!stage || stage.type !== 'boss') return 0;
  if (progress >= stage.count) return 0;
  if (aliveBrutes > 0) return 0;
  return Math.max(0, stage.count - brutesSpawnedForStage);
}

/** ObjectiveType import re-export for blueprint convenience. */
export type { ObjectiveType };

// ---------------------------------------------------------------------------
// Asset registry (reskin layer) — shared registration helpers.
// Each blueprint creates its AssetRegistry, registers what it builds with the
// helpers below, then calls assets.applyOverrides(spec) after construction
// (and again after any dynamic wave spawn so new waves are reskinned too).
// ---------------------------------------------------------------------------

/** Engine-level world assets: sky rig, terrain mesh, scene fog. */
export function registerWorldAssets(assets: AssetRegistry, engine: Engine): void {
  assets.register('world.sky', { kind: 'world', roots: [engine.sky.group] });
  if (engine.terrain) assets.register('world.ground', { kind: 'world', roots: [engine.terrain.mesh] });
  if (engine.scene.fog) assets.register('world.fog', { kind: 'world', fog: engine.scene.fog as THREE.Fog });
}

/**
 * Pickup assets from the live pickup list — vanilla kinds (coin/health/ammo/
 * powerup) plus timed effect kinds (shield/rapid/score/magnet).
 *
 * Registered as dynamic live roots (re-resolved on every applyOverrides, so
 * pickups dropped mid-run are reskinned too). The roots path swaps each
 * mesh's material for a per-entry clone, so MaterialLibrary-cached shared
 * materials are never mutated — no cross-asset recolor (M6).
 */
export function registerPickupAssets(assets: AssetRegistry, pickups: Pickups): void {
  const seen = new Set<string>();
  const idOf = (p: Pickup): string => {
    const eff = effectOf(p);
    return eff ? `pickup.${eff === 'mult' ? 'score' : eff}` : `pickup.${p.kind}`;
  };
  for (const p of pickups.list) {
    const id = idOf(p);
    if (seen.has(id)) continue;
    seen.add(id);
    assets.register(id, {
      kind: 'pickup',
      roots: () => pickups.list.filter((q) => !q.taken && idOf(q) === id).map((q) => q.mesh),
    });
  }
}

/**
 * Enemy kind assets with dynamic roots: the provider re-resolves live rigs,
 * so calling assets.applyOverrides(spec) after a wave spawn reskins the new
 * wave too. Also mirrors brute rigs as boss.body and registers per-variant
 * rig providers when a VariantDirector is present.
 */
export function registerEnemyAssets(
  assets: AssetRegistry,
  enemies: EnemyManager,
  kinds: string[],
  variants?: VariantDirector,
): void {
  for (const kind of kinds) {
    assets.register(`enemy.${kind}`, { kind: 'enemy', roots: () => rigsOfKind(enemies, kind) });
  }
  if (kinds.includes('brute')) {
    assets.register('boss.body', { kind: 'boss', roots: () => rigsOfKind(enemies, 'brute') });
  }
  if (variants) {
    const all: EnemyVariant[] = ['charger', 'sniper', 'splitter', 'caster', 'shielded', 'skyray', 'spikeball', 'mini'];
    for (const v of all) {
      assets.register(`enemy.${v}`, {
        kind: 'enemy',
        roots: () => {
          const out: THREE.Object3D[] = [];
          for (const e of enemies.enemies) {
            if (e.alive && e.rig && variants.getVariant(e) === v) out.push(e.rig.group);
          }
          return out;
        },
      });
    }
  }
}
