/**
 * PLATFORMER — side-scroll 3D: floating platform course over a hazard floor, coins on arcs,
 * patrolling walkers, double-jump/dash moveset, goal flag at the summit.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { EnemyManager } from '../engine/game/EnemyAI';
import { Pickups } from '../engine/game/Pickups';
import { Objectives } from '../engine/game/Objectives';
import { Structures } from '../engine/world/Structures';
import { makeGoalFlag } from '../engine/gfx/Characters';
import { PlayerAvatar } from './common';
import { Rng } from '../engine/core/Rng';

export function buildPlatformer(engine: Engine, spec: GameSpec) {
  const { scene, hud, terrain } = engine;
  const rng = new Rng(spec.meta.seed ^ 0x4a7f);

  // world = mostly visual; course floats above a hazard
  const startY = Math.max(3, terrain.heightAt(-terrain.size / 2 + 14, 0) + 3);
  const start = new THREE.Vector3(-terrain.size / 2 + 14, startY, 0);
  const dir = new THREE.Vector3(1, 0, 0.08);

  const structures = new Structures(engine.physics, engine.mats);
  const difficulty = spec.rules.difficulty;
  const gapBoost = difficulty === 'hard' ? 1.2 : difficulty === 'easy' ? 0.8 : 1;
  const platforms = structures.platforms(spec.meta.seed, 26, start, dir, {
    gapMin: 3.2 * gapBoost,
    gapMax: 5.2 * gapBoost,
    sizeMin: difficulty === 'hard' ? 2.2 : 2.8,
    sizeMax: 4.6,
    riseMax: difficulty === 'easy' ? 1.1 : 1.7,
  });
  scene.add(structures.group);

  // hazard floor: lava/void plane far below
  const hazardY = startY - 22;
  const hazard = new THREE.Mesh(
    new THREE.PlaneGeometry(terrain.size * 2, terrain.size * 2),
    engine.mats.standard('lava', spec.theme.environment === 'volcanic' ? '#ff4a1f' : '#1a0f2e', {
      emissive: spec.theme.environment === 'volcanic' ? '#ff3300' : '#6a3fd8',
      emissiveIntensity: 0.9,
    }),
  );
  hazard.rotation.x = -Math.PI / 2;
  hazard.position.y = hazardY;
  scene.add(hazard);
  const hazardLight = new THREE.PointLight(spec.theme.environment === 'volcanic' ? '#ff5a2f' : '#7a4fe8', 1.4, 90);
  hazardLight.position.set(start.x + 40, hazardY + 8, 0);
  scene.add(hazardLight);

  // goal at final platform
  const last = platforms[platforms.length - 1];
  const goal = makeGoalFlag(engine.mats, spec.theme.palette.accent);
  goal.position.copy(last.pos);
  scene.add(goal);

  // player
  const projectiles = null;
  let avatar: PlayerAvatar;
  const enemies = new EnemyManager(engine, null, {
    onPlayerHit: (dmg, from) => avatar.damage(dmg, from),
    onDeath: (e) => { engine.score += 100; hud.setScore(engine.score); },
  });
  avatar = new PlayerAvatar(engine, spec, start.clone().add(new THREE.Vector3(0, 2, 0)), enemies, projectiles);

  // walkers patrol the bigger platforms
  const patrolPlatforms = platforms.filter((p, i) => i > 2 && i < platforms.length - 2 && p.size.x > 3.4);
  const walkers = spec.enemies.filter((e) => e.kind === 'walker');
  const nEnemies = Math.min(patrolPlatforms.length, walkers.reduce((n, e) => n + e.count, 0) || 4);
  for (let i = 0; i < nEnemies; i++) {
    const p = patrolPlatforms[Math.floor((i / nEnemies) * patrolPlatforms.length)];
    enemies.spawnAll([{ kind: 'walker', count: 1, health: 25, speed: 2.5, damage: 10, weapon: 'melee' }], () => p.pos.clone().add(new THREE.Vector3(0, 1, 0)));
  }

  // coins along jump arcs between platforms
  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    if (p.kind === 'coin') {
      engine.score += 50;
      engine.audio.play('coin');
      hud.setScore(engine.score);
      if (spec.objective.type === 'collect') objectives.addProgress(1);
    }
    if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
  };
  for (let i = 0; i < platforms.length - 1; i++) {
    const a = platforms[i].pos, b = platforms[i + 1].pos;
    const n = Math.max(2, Math.floor(a.distanceTo(b) / 1.6));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const p = a.clone().lerp(b, t);
      p.y += Math.sin(t * Math.PI) * 1.6 + 0.8; // arc
      pickups.spawn('coin', p);
    }
  }
  // health mid-course
  const mid = platforms[Math.floor(platforms.length / 2)];
  pickups.spawn('health', mid.pos.clone().add(new THREE.Vector3(0, 1.2, 0)));

  const objectives = new Objectives(engine, spec.objective.type === 'collect'
    ? { ...spec.objective, count: Math.min(spec.objective.count || 20, pickups.remaining('coin')) }
    : spec.objective);
  hud.setObjective(spec.meta.name.toUpperCase(), spec.objective.type === 'collect' ? 'Collect the coins, reach the flag' : 'Reach the flag');
  hud.setHint('A/D move · Space jump (x2) · Shift dash · reach the flag');

  const camRig = makeCameraRig('side', engine.camera, engine.input);

  engine.onUpdate((dt) => {
    const t = engine.time;
    // side camera: yaw locked so A/D map to world x
    avatar.ctrl.camYaw = -Math.PI / 2;
    avatar.update(dt, t);
    enemies.update(dt, avatar.ctrl.position, t);
    pickups.update(dt, avatar.ctrl.position);
    objectives.update(dt);

    const pp = avatar.ctrl.position;
    if (pp.y < hazardY + 2) {
      avatar.damage(34);
      // bounce back to last platform
      let best = platforms[0].pos, bd = Infinity;
      for (const p of platforms) {
        if (p.pos.y > pp.y) continue;
        const d = Math.abs(p.pos.x - pp.x);
        if (d < bd) { bd = d; best = p.pos; }
      }
      avatar.ctrl.teleport(best.clone().add(new THREE.Vector3(0, 2, 0)));
      engine.audio.play('hurt');
    }
    if (pp.distanceTo(goal.position) < 3) objectives.reachedGoal();

    camRig.update(dt, pp, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, pickups, objectives };
}
