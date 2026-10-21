/**
 * SURVIVOR — horde-survivor auto-shooter: WASD moves, the weapon auto-fires at
 * the nearest enemy. Kills drop XP gems (coin pickups); leveling up opens the
 * upgrade modal. Survive the timed chapters, then slay the swarm alpha.
 *
 * Composes the proven top-down combat stack (EnemyManager + Projectiles +
 * Pickups + Objectives + Progression + VariantDirector) with an auto-fire
 * driver instead of pointer aim. Deterministic: spawns use engine.rng forks.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { EnemyManager } from '../engine/game/EnemyAI';
import { NpcInstancer } from '../engine/game/npcInstancing';
import { Projectiles } from '../engine/game/Projectiles';
import { Pickups } from '../engine/game/Pickups';
import { Progression } from '../engine/game/Progression';
import type { LevelGain } from '../engine/game/progressionCurve';
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
import { VariantDirector, planSpawns, isBossStageActive, ARENA_VARIANTS } from './enemies';
import { ChapterDresser } from './dressing';
import { Structures } from '../engine/world/Structures';
import { Scatter } from '../engine/world/Scatter';
import { attachLightShafts } from '../engine/gfx/LightShafts';
import { scatterAmberGlow } from '../engine/gfx/AmberGlow';
import { PlayerAvatar } from './common';

export function buildSurvivor(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud, input } = engine;
  const rng = engine.rng.fork(707);
  const arenaR = Math.min(48, terrain.size / 2 - 10);
  const sv = (spec.custom as any)?.survivor ?? {};
  const fireInterval = typeof sv.fireInterval === 'number' ? sv.fireInterval : 0.55;

  snapshotLoadoutBase(spec);
  engine.assetBridge.dispose();

  const prog = new Progression(engine);
  let notifyLevelUp: (gain?: LevelGain) => void = () => {};
  const dresser = new ChapterDresser(engine);

  const assets = new AssetRegistry();
  registerWorldAssets(assets, engine);

  const structures = new Structures(engine.physics, engine.mats);
  structures.arenaWalls(new THREE.Vector3(0, terrain.heightAt(0, 0), 0), arenaR, 4);
  structures.arenaCover(spec, terrain, 14, arenaR - 8, spec.meta.seed ^ 77);
  scene.add(structures.group);
  const landmarks = structures.landmarks(spec, terrain, scene, spec.meta.seed, {
    exclusion: [{ x: 0, z: 0, r: arenaR + 6 }], quality: engine.effectiveQuality(),
    maxRealLights: engine.tiers.flags.maxRealLights,
  });
  const scatter = new Scatter(spec, terrain, engine.mats, engine.physics, scene, {
    exclusion: [{ x: 0, z: 0, r: arenaR + 6 }],
    heroExclusion: [{ x: 0, z: 0, r: 8 }],
    engine,
    quality: engine.effectiveQuality(),
    densityMul: engine.tiers.flags.densityMul,
    windMul: engine.tiers.flags.windMul,
    heroSpots: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
  });
  structures.structureSets(spec, terrain, scene, spec.meta.seed, {
    exclusion: [{ x: 0, z: 0, r: arenaR + 6 }], quality: engine.effectiveQuality(),
    densityMul: engine.tiers.flags.densityMul,
    structureShadows: engine.tiers.flags.structureShadows,
  });
  scatterAmberGlow(scene, rng.fork(0xe9a1), {
    mats: engine.mats,
    groundY: (x, z) => terrain.heightAt(x, z),
    half: terrain.size / 2 - 10,
    exclusion: [{ x: 0, z: 0, r: arenaR + 6 }],
    quality: engine.effectiveQuality(),
  });
  terrain.setWaterSun(
    engine.sky.sun.position.clone().sub(engine.sky.sun.target.position).normalize(),
    spec.theme.timeOfDay === 'dusk' || spec.theme.timeOfDay === 'dawn' ? '#ffb46b' : '#cfe8ff',
  );
  attachLightShafts(engine);

  const projectiles = new Projectiles(engine, spec.theme.palette.accent);
  let combatT = 0;
  const combatPulse = () => { combatT = 1; };

  const enemies = new EnemyManager(engine, projectiles, {
    onPlayerHit: (dmg, from) => { avatar.damage(dmg, from); camRig.shake(0.55); combatPulse(); },
    onDeath: (e) => {
      variants.onEnemyDeath(e);
      engine.score += 100;
      hud.setScore(engine.score);
      // XP gems: every other kill drops a coin the magnet pulls in
      if (rng.chance(0.55)) pickups.spawn('coin', e.position.clone().add(new THREE.Vector3(0, 0.8, 0)));
      else if (rng.chance(0.12)) pickups.spawn('health', e.position.clone());
      grantKillXp(prog, notifyLevelUp, e.xpMult);
      objectives.addProgress(1, 'kill');
      combatPulse();
    },
    onPhase: (e, phase) => { bossPhaseBanner(engine, phase); combatPulse(); },
  }, {
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
  });
  const variants = new VariantDirector(engine, enemies, projectiles);

  const avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(0, terrain.heightAt(0, 0) + 2, 0), enemies, projectiles);
  assets.register('player.body', { kind: 'player', roots: [avatar.ctrl.rig.group] });
  notifyLevelUp = makeLevelUpFlow(engine, spec, prog, avatar);

  // friendly projectiles damage enemies (scaled by damage upgrades)
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
    if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
    if (p.kind === 'ammo') { avatar.addAmmo(30); engine.audio.play('pickup'); }
    if (p.kind === 'coin') {
      engine.score += 50;
      hud.setScore(engine.score);
      engine.audio.play('coin');
      grantPickupXp(prog, notifyLevelUp); // coins ARE the XP gems here
    }
  };
  pickups.scatterTerrain({ coin: 24, health: 4, ammo: 0, powerup: 0 }, (x, z) => terrain.heightAt(x, z), arenaR - 10, spec.meta.seed ^ 0x5eed, [{ x: 0, z: 0, r: 8 }]);

  const objectives = makeCampaignObjectives(engine, spec, undefined, () => prog.level);
  hud.setHint(isTouchDevice()
    ? 'Left stick move · weapon auto-fires · grab gems to level up'
    : 'WASD move · weapon auto-fires · grab gems to level up · Esc pause');

  const camRig = makeCameraRig('top-down', engine.camera, input, (x, z) => terrain.heightAt(x, z),
    { physics: engine.physics, skipBody: avatar.ctrl.body });

  // continuous wave director: escalating pressure until the alpha stage
  const kinds = spec.enemies.length ? spec.enemies : [{ kind: 'walker' as const, count: 1, health: 30, speed: 5, damage: 8, weapon: 'melee' as const }];
  const spawnEdge = () => {
    const a = rng.range(0, Math.PI * 2);
    const pos = new THREE.Vector3(Math.cos(a) * (arenaR - 3), 0, Math.sin(a) * (arenaR - 3));
    pos.y = terrain.heightAt(pos.x, pos.z) + 1.2;
    return pos;
  };
  let alphaSpawned = false;
  const topUp = () => {
    if (isBossStageActive(spec, objectives)) {
      // the swarm parts for the alpha — one brute, no more trickle
      if (!alphaSpawned) {
        alphaSpawned = true;
        const brute = kinds.find((k) => k.kind === 'brute') ?? kinds[0];
        const planned = planSpawns([{ ...brute, count: 1 }], rng, objectives.stagesCleared, ARENA_VARIANTS)[0];
        const before = enemies.enemies.length;
        enemies.spawnAll([planned.spec], () => spawnEdge());
        const e = enemies.enemies[before];
        if (e) { variants.register(e, planned.variant); variants.decorate(e, planned.variant); }
        assets.applyOverrides(spec);
      }
      return;
    }
    const minutes = engine.time / 60;
    const cap = Math.round(8 + minutes * 3 + objectives.stagesCleared * 2);
    const alive = enemies.aliveCount();
    const want = Math.min(cap - alive, 6);
    if (want <= 0) return;
    const pool = kinds.filter((k) => k.kind !== 'brute');
    for (let i = 0; i < want; i++) {
      const planned = planSpawns([{ ...pool[i % pool.length], count: 1 }], rng, objectives.stagesCleared, ARENA_VARIANTS)[0];
      const before = enemies.enemies.length;
      enemies.spawnAll([planned.spec], () => spawnEdge());
      const e = enemies.enemies[before];
      if (e) { variants.register(e, planned.variant); variants.decorate(e, planned.variant); }
    }
    assets.applyOverrides(spec);
  };
  topUp();

  registerEnemyAssets(assets, enemies, ['walker', 'drone', 'brute'], variants);
  registerPickupAssets(assets, pickups);
  assets.register('weapon.projectile', { kind: 'weapon', materials: [engine.mats.glow(spec.theme.palette.accent, 2.5)] });
  assets.register('world.arena', { kind: 'world', roots: [structures.group] });
  assets.applyOverrides(spec);
  const tracerMat = assets.currentMaterial('weapon.projectile');
  if (tracerMat) projectiles.setTracerMaterial(tracerMat);

  dresser.dress(spec, 0, rng.fork(5000), { cx: 0, cz: 0, half: arenaR - 8, yAt: (x, z) => terrain.heightAt(x, z) });
  let lastStage = 0;
  let fireT = 0;
  const tmpV = new THREE.Vector3();

  engine.onUpdate((dt) => {
    const t = engine.time;
    avatar.ctrl.camYaw = camRig.yaw;
    avatar.update(dt, t);

    // auto-fire: nearest living enemy inside 22m
    fireT -= dt;
    if (fireT <= 0 && engine.state === 'playing') {
      fireT = fireInterval;
      const pp = avatar.ctrl.position;
      const target = enemies.nearest(pp, 22);
      if (target) {
        tmpV.copy(target.position).sub(pp).setY(0).normalize();
        avatar.ctrl.yaw = Math.atan2(tmpV.x, tmpV.z) - Math.PI;
        avatar.ctrl.rig.group.rotation.y = avatar.ctrl.yaw + Math.PI;
        avatar.shoot(tmpV, pp.clone().add(new THREE.Vector3(0, 1.1, 0)));
      }
      // survivor casters regenerate bolts — the run never soft-locks on ammo
      if (avatar.ammo !== Infinity && avatar.ammo < 30) avatar.addAmmo(60);
    }

    const inst = NpcInstancer.for(engine);
    inst.beginFrame(dt);
    enemies.update(dt, avatar.ctrl.position, t);
    inst.endFrame();
    variants.update(dt, avatar.ctrl.position, t);
    projectiles.update(dt);
    pickups.update(dt, avatar.ctrl.position, 2.6 * prog.magnetMult());
    objectives.update(dt);
    topUp();

    const stageIdx = objectives.currentStageIndex;
    if (stageIdx !== lastStage) {
      lastStage = stageIdx;
      dresser.dress(spec, stageIdx, rng.fork(5000 + stageIdx), { cx: 0, cz: 0, half: arenaR - 8, yAt: (x, z) => terrain.heightAt(x, z) });
      variants.applyStageScaling(objectives.stagesCleared);
      variants.notifyStage(stageIdx, isBossStageActive(spec, objectives));
    }

    combatT = Math.max(0, combatT - dt * 0.25);
    engine.audio.setIntensity(0.35 + combatT * 0.6);
    variants.updateBossBar(isBossStageActive(spec, objectives));

    if (avatar.ctrl.position.y < -40) { avatar.damage(1000); camRig.shake(0.8); }
    camRig.update(dt, avatar.ctrl.position, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, pickups, objectives, assets, prog };
}
