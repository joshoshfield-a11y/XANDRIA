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
import { Structures } from '../engine/world/Structures';
import { Scatter } from '../engine/world/Scatter';
import { PlayerAvatar } from './common';

export function buildTopDown(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud, input } = engine;
  const rng = engine.rng.fork(404);
  const arenaR = Math.min(40, terrain.size / 2 - 10);

  const structures = new Structures(engine.physics, engine.mats);
  structures.arenaWalls(new THREE.Vector3(0, terrain.heightAt(0, 0), 0), arenaR, 4);
  structures.arenaCover(spec, terrain, 14, arenaR - 8, spec.meta.seed ^ 77);
  scene.add(structures.group);
  new Scatter(spec, terrain, engine.mats, engine.physics, scene, {
    exclusion: [{ x: 0, z: 0, r: arenaR + 6 }],
  });

  const projectiles = new Projectiles(engine, spec.theme.palette.accent);
  let avatar: PlayerAvatar;

  const enemies = new EnemyManager(engine, projectiles, {
    onPlayerHit: (dmg, from) => avatar.damage(dmg, from),
    onDeath: (e) => {
      engine.score += 100;
      hud.setScore(engine.score);
      objectives.addProgress(1);
      if (rng.chance(0.2)) pickups.spawn(rng.chance(0.5) ? 'health' : 'ammo', e.position.clone());
    },
  });

  avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(0, terrain.heightAt(0, 0) + 2, 0), enemies, projectiles);

  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
    if (p.kind === 'ammo') { avatar.addAmmo(30); engine.audio.play('pickup'); }
    if (p.kind === 'coin') { engine.score += 50; engine.audio.play('coin'); hud.setScore(engine.score); }
  };

  const objectives = new Objectives(engine, spec.objective);
  hud.setObjective(spec.meta.name.toUpperCase(), spec.objective.description);
  hud.setHint('WASD move · mouse aim · LMB fire · Esc pause');

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
    const cap = 9;
    const alive = enemies.aliveCount();
    const want = Math.min(cap - alive, totalNeeded - spawned);
    if (want <= 0) return;
    const kinds = spec.enemies.length ? spec.enemies : [{ kind: 'walker' as const, count: 1, health: 30, speed: 5, damage: 8, weapon: 'melee' as const }];
    for (let i = 0; i < want; i++) {
      const es = { ...kinds[spawned % kinds.length], count: 1 };
      enemies.spawnAll([es], () => spawnEdge(es.kind));
      spawned++;
    }
  };
  topUp();

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
    projectiles.update(dt);
    pickups.update(dt, pp);
    objectives.update(dt);
    topUp();

    if (pp.y < -40) avatar.damage(1000);
    camRig.update(dt, pp, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, pickups, objectives };
}
