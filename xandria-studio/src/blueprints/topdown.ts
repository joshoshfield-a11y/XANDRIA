/**
 * TOP-DOWN SHOOTER — twin-stick style: WASD moves, mouse aims at ground plane, LMB fires.
 * Waves of walkers/drones spawn at arena edge; survive / eliminate quota.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { EnemyManager } from '../engine/game/EnemyAI';
import { Projectiles } from '../engine/game/Projectiles';
import { Pickups } from '../engine/game/Pickups';
import { Objectives } from '../engine/game/Objectives';
import { Progression } from '../engine/game/Progression';
import {
  makeCampaignObjectives,
  makeLevelUpFlow,
  grantKillXp,
  grantPickupXp,
  bossPhaseBanner,
  registerWorldAssets,
  registerPickupAssets,
  registerEnemyAssets,
} from './campaign';
import { AssetRegistry } from '../engine/game/Assets';
import { snapshotLoadoutBase } from '../engine/game/Profile';
import { isTouchDevice } from '../engine/game/TouchControls';
import {
  VariantDirector,
  planSpawns,
  isBossStageActive,
  ARENA_VARIANTS,
} from './enemies';
import {
  EffectState,
  EffectHud,
  scatterEffects,
  spawnEffectPickup,
  applyPickupEffect,
  effectOf,
  wrapShieldDamage,
} from './fx';
import { ChapterDresser } from './dressing';
import { Structures } from '../engine/world/Structures';
import { Scatter } from '../engine/world/Scatter';
import { PlayerAvatar } from './common';

export function buildTopDown(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud, input } = engine;
  const rng = engine.rng.fork(404);
  const arenaR = Math.min(40, terrain.size / 2 - 10);

  // M2: snapshot the pristine run config before any run-time mutation.
  snapshotLoadoutBase(spec);
  // M7: drop stale asset-bridge roots left by the previous run (no-op at boot).
  engine.assetBridge.dispose();

  // campaign layer: XP progression (the intro card is shown by Engine.beginPlay)
  const prog = new Progression(engine);
  let notifyLevelUp: () => void = () => {};
  // content depth: enemy variants, timed pickup effects, chapter dressing
  const fx = new EffectState();
  const fxHud = new EffectHud();
  const dresser = new ChapterDresser(engine);

  // asset registry (reskin layer): world assets first, the rest after spawns
  const assets = new AssetRegistry();
  registerWorldAssets(assets, engine);

  const structures = new Structures(engine.physics, engine.mats);
  structures.arenaWalls(new THREE.Vector3(0, terrain.heightAt(0, 0), 0), arenaR, 4);
  structures.arenaCover(spec, terrain, 14, arenaR - 8, spec.meta.seed ^ 77);
  scene.add(structures.group);
  new Scatter(spec, terrain, engine.mats, engine.physics, scene, {
    exclusion: [{ x: 0, z: 0, r: arenaR + 6 }],
    engine,
  });

  const projectiles = new Projectiles(engine, spec.theme.palette.accent);
  let avatar: PlayerAvatar;

  // FIX 5: combat music intensity — pulsed up by combat events, decays to baseline
  let combatT = 0;
  const combatPulse = () => { combatT = 1; };

  const enemies = new EnemyManager(engine, projectiles, {
    onPlayerHit: (dmg, from) => { avatar.damage(dmg, from); camRig.shake(0.55); combatPulse(); },
    onDeath: (e) => {
      variants.onEnemyDeath(e); // splitter minis + visual cleanup first
      engine.score += Math.round(100 * fx.scoreMult());
      hud.setScore(engine.score);
      // N6: grant XP before recording the kill — addProgress may end the run
      // (engine.win), and the level-up modal must never open over the end screen
      grantKillXp(prog, notifyLevelUp);
      objectives.addProgress(1, 'kill'); // M5: kills only count toward kill stages
      combatPulse();
      const d = e.position.distanceTo(avatar.ctrl.position);
      if (d < 14) camRig.shake(0.6 * (1 - d / 14));
      if (rng.chance(0.2)) pickups.spawn(rng.chance(0.5) ? 'health' : 'ammo', e.position.clone());
      else if (rng.chance(0.1)) {
        const kinds = ['shield', 'rapid', 'mult', 'magnet'] as const;
        spawnEffectPickup(pickups, engine, kinds[rng.int(0, 3)], e.position.clone().add(new THREE.Vector3(0, 0.8, 0)));
      }
    },
    onPhase: (e, phase) => { bossPhaseBanner(engine, phase); combatPulse(); },
  });
  // enemy variants: chargers, snipers, splitters layered over the base kinds
  const variants = new VariantDirector(engine, enemies, projectiles);

  avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(0, terrain.heightAt(0, 0) + 2, 0), enemies, projectiles);
  assets.register('player.body', { kind: 'player', roots: [avatar.ctrl.rig.group] });
  notifyLevelUp = makeLevelUpFlow(engine, spec, prog, avatar);
  wrapShieldDamage(engine, avatar, fx); // aegis shield pickup absorbs damage

  // FIX 1: wire projectile impacts to damage (guns dealt zero damage — onHit was never assigned).
  // Campaign: projectile damage scales with the damage upgrade multiplier.
  projectiles.onHit = (p, hitBody, point) => {
    if (p.friendly) {
      const target = enemies.enemies.find((e) => e.alive && e.body === hitBody);
      if (target) { target.damage(p.damage * prog.damageMult(), point); combatPulse(); }
    } else if (hitBody === avatar.ctrl.body) {
      avatar.damage(p.damage, point);
    }
  };

  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    const eff = effectOf(p);
    if (eff) {
      applyPickupEffect(engine, fx, avatar, spec, eff);
    } else {
      if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
      if (p.kind === 'ammo') { avatar.addAmmo(30); engine.audio.play('pickup'); }
      if (p.kind === 'coin') { engine.score += Math.round(50 * fx.scoreMult()); engine.audio.play('coin'); hud.setScore(engine.score); objectives.addProgress(1, 'collect'); }
    }
    grantPickupXp(prog, notifyLevelUp);
  };
  // timed effect pickups scattered away from the spawn clearing
  scatterEffects(pickups, engine, rng.fork(912), (x, z) => terrain.heightAt(x, z), arenaR - 8,
    ['shield', 'rapid', 'mult', 'magnet'], [{ x: 0, z: 0, r: 8 }]);

  const objectives = makeCampaignObjectives(engine, spec, undefined, () => prog.level);
  // N1: touch-aware hint bar (right stick aims on touch)
  hud.setHint(isTouchDevice()
    ? 'Left stick move · right stick aim (auto-fire)'
    : 'WASD move · mouse aim · LMB fire · Esc pause');

  const camRig = makeCameraRig('top-down', engine.camera, input, (x, z) => terrain.heightAt(x, z));

  // aim: ray from camera through pointer onto the player-height plane
  const aimPoint = new THREE.Vector3(1, 0, 0);
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // wave management
  const totalNeeded = spec.objective.type === 'eliminate' ? spec.objective.count : spec.enemies.reduce((n, e) => n + e.count, 0);
  let spawned = 0;
  const spawnEdge = (kind: string) => {
    const a = rng.range(0, Math.PI * 2);
    const pos = new THREE.Vector3(Math.cos(a) * (arenaR - 3), 0, Math.sin(a) * (arenaR - 3));
    pos.y = terrain.heightAt(pos.x, pos.z) + 1.2;
    return pos;
  };
  const topUp = () => {
    // difficulty ramp: later chapters raise the alive cap + field scaled variants
    const stage = objectives.currentStageIndex;
    const cap = 9 + stage;
    const alive = enemies.aliveCount();
    const want = Math.min(cap - alive, totalNeeded - spawned);
    if (want <= 0) return;
    const kinds = spec.enemies.length ? spec.enemies : [{ kind: 'walker' as const, count: 1, health: 30, speed: 5, damage: 8, weapon: 'melee' as const }];
    for (let i = 0; i < want; i++) {
      const planned = planSpawns([{ ...kinds[spawned % kinds.length], count: 1 }], rng, stage, ARENA_VARIANTS)[0];
      const before = enemies.enemies.length;
      enemies.spawnAll([planned.spec], () => spawnEdge(planned.spec.kind));
      const e = enemies.enemies[before];
      if (e) { variants.register(e, planned.variant); variants.decorate(e, planned.variant); }
      spawned++;
    }
    assets.applyOverrides(spec); // reskin the new wave
  };
  topUp();

  // asset registration: enemies (dynamic roots), pickups, projectiles, arena
  registerEnemyAssets(assets, enemies, ['walker', 'drone', 'brute', 'turret'], variants);
  registerPickupAssets(assets, pickups);
  assets.register('weapon.projectile', { kind: 'weapon', materials: [engine.mats.glow(spec.theme.palette.accent, 2.5)] });
  assets.register('world.arena', { kind: 'world', roots: [structures.group] });
  assets.applyOverrides(spec);
  // M6: wire the (cloned, never the shared cache entry) tracer material into
  // the projectile pool so the override actually reaches pixels
  const tracerMat = assets.currentMaterial('weapon.projectile');
  if (tracerMat) projectiles.setTracerMaterial(tracerMat);

  // chapter-0 arena dressing
  dresser.dress(spec, 0, rng.fork(5000), { cx: 0, cz: 0, half: arenaR - 8, yAt: (x, z) => terrain.heightAt(x, z) });
  let lastStage = 0;

  engine.onUpdate((dt) => {
    const t = engine.time;
    avatar.ctrl.camYaw = camRig.yaw; // top-down: fixed orientation, movement axes still map cleanly
    avatar.update(dt, t);

    // aim at pointer
    const pp = avatar.ctrl.position;
    groundPlane.constant = -(pp.y + 0.9);
    raycaster.setFromCamera(new THREE.Vector2(input.pointer.x, input.pointer.y), engine.camera);
    const hit = raycaster.ray.intersectPlane(groundPlane, aimPoint);
    let aimDir = new THREE.Vector3(1, 0, 0);
    if (hit) {
      aimDir = aimPoint.clone().sub(pp).setY(0);
      if (aimDir.lengthSq() > 0.01) {
        aimDir.normalize();
        avatar.ctrl.yaw = Math.atan2(aimDir.x, aimDir.z) - Math.PI; // face cursor
        avatar.ctrl.rig.group.rotation.y = avatar.ctrl.yaw + Math.PI;
      }
    }
    if ((input.pressed('attack') || input.justPressed('attack')) && engine.state === 'playing') {
      avatar.shoot(aimDir.clone(), pp.clone().add(new THREE.Vector3(0, 1.1, 0)));
    }

    enemies.update(dt, pp, t);
    variants.update(dt, pp, t);
    projectiles.update(dt);
    pickups.update(dt, pp, 2.6 * prog.magnetMult() * fx.magnetMult());
    objectives.update(dt);
    topUp();
    fx.tick(dt, spec);
    fxHud.update(fx, t);

    // chapter transitions: fresh dressing, difficulty ramp, boss intro
    const stageIdx = objectives.currentStageIndex;
    if (stageIdx !== lastStage) {
      lastStage = stageIdx;
      dresser.dress(spec, stageIdx, rng.fork(5000 + stageIdx), { cx: 0, cz: 0, half: arenaR - 8, yAt: (x, z) => terrain.heightAt(x, z) });
      // R4-N1: difficulty keys off chapters cleared (branch-aware), not the quest-graph array index.
      variants.applyStageScaling(objectives.stagesCleared);
      variants.notifyStage(stageIdx, isBossStageActive(spec, objectives));
    }

    // FIX 5: combat intensity decays to baseline; boss bar during boss fights
    combatT = Math.max(0, combatT - dt * 0.25);
    engine.audio.setIntensity(0.35 + combatT * 0.6);
    variants.updateBossBar(spec.objective.type === 'boss' || isBossStageActive(spec, objectives));

    if (pp.y < -40) { avatar.damage(1000); camRig.shake(0.8); }
    camRig.update(dt, pp, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, pickups, objectives, assets };
}
