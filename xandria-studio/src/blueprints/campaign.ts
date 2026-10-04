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
import type { Pickups } from '../engine/game/Pickups';
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

export type StageHandler = (finishedIndex: number, finished: ObjectiveStage) => void;

/**
 * Build an Objectives sequencer wired to chapter cards.
 * On each stage completion: banner "Chapter <roman>" + refresh the HUD
 * objective line to the new stage's description.
 */
export function makeCampaignObjectives(
  engine: Engine,
  spec: GameSpec,
  extra?: StageHandler,
  getLevel?: () => number,
): Objectives {
  const hud = engine.hud;
  const objectives = new Objectives(engine, spec.objective, (finishedIndex, finished) => {
    const next = spec.objective.stages?.[finishedIndex + 1];
    const label = `Chapter ${roman(finishedIndex + 2)}`;
    const body = next?.description ?? finished.description;
    hud.showCard(label, body);
    hud.setObjective(spec.meta.name.toUpperCase(), body);
    extra?.(finishedIndex, finished);
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

/** Collect the distinct shared materials used by one pickup mesh. */
function pickupMaterials(mesh: THREE.Object3D): THREE.Material[] {
  const mats: THREE.Material[] = [];
  mesh.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const list = Array.isArray(m.material) ? m.material : [m.material];
    for (const mm of list) {
      const mat = mm as THREE.Material | undefined;
      if (mat && !mats.includes(mat)) mats.push(mat);
    }
  });
  return mats;
}

/**
 * Pickup assets from the live pickup list — vanilla kinds (coin/health/ammo/
 * powerup) plus timed effect kinds (shield/rapid/score/magnet). Registers the
 * shared cached materials, so pickups dropped later in the run inherit
 * overrides automatically.
 */
export function registerPickupAssets(assets: AssetRegistry, pickups: Pickups): void {
  const seen = new Set<string>();
  for (const p of pickups.list) {
    const eff = effectOf(p);
    const id = eff ? `pickup.${eff === 'mult' ? 'score' : eff}` : `pickup.${p.kind}`;
    if (seen.has(id)) continue;
    seen.add(id);
    assets.register(id, { kind: 'pickup', materials: pickupMaterials(p.mesh) });
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
