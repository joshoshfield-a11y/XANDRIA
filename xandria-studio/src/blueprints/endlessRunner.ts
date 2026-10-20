/**
 * ENDLESS RUNNER — auto-run gauntlet: the character sprints forward on their
 * own (the blueprint holds 'forward' down; real input still merges), the
 * player steers with A/D, jumps (double-jump) over low bars and dodges around
 * barrier blocks. Glowing obstacles are seeded deterministically along the
 * track; coins line the racing line. Reach the far gate to win.
 *
 * Chase camera eases toward the velocity heading, so the camera trails the
 * runner down the track. Winnable by construction: the gate sits at
 * custom.runner.targetDistance inside the world bounds.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { NpcInstancer } from '../engine/game/npcInstancing';
import { Pickups } from '../engine/game/Pickups';
import { makeCampaignObjectives, registerWorldAssets } from './campaign';
import { AssetRegistry } from '../engine/game/Assets';
import { snapshotLoadoutBase } from '../engine/game/Profile';
import { isTouchDevice } from '../engine/game/TouchControls';
import { ChapterDresser } from './dressing';
import { Structures } from '../engine/world/Structures';
import { Scatter } from '../engine/world/Scatter';
import { attachLightShafts } from '../engine/gfx/LightShafts';
import { scatterAmberGlow } from '../engine/gfx/AmberGlow';
import { makeGoalFlag } from '../engine/gfx/Characters';
import { PlayerAvatar } from './common';

interface Obstacle {
  mesh: THREE.Group;
  min: THREE.Vector3;
  max: THREE.Vector3;
  kind: 'block' | 'lowbar';
}

export function buildEndlessRunner(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud, input } = engine;
  const rng = engine.rng.fork(31337);
  const rn = (spec.custom as any)?.runner ?? {};
  const target = typeof rn.targetDistance === 'number' ? rn.targetDistance : 200;
  const gap = typeof rn.obstacleGap === 'number' ? rn.obstacleGap : 26;
  const half = terrain.size / 2 - 12;

  snapshotLoadoutBase(spec);
  engine.assetBridge.dispose();

  const dresser = new ChapterDresser(engine);
  const assets = new AssetRegistry();
  registerWorldAssets(assets, engine);

  const structures = new Structures(engine.physics, engine.mats);
  structures.arenaWalls(new THREE.Vector3(0, terrain.heightAt(0, 0), 0), half + 8, 5);
  scene.add(structures.group);
  const landmarks = structures.landmarks(spec, terrain, scene, spec.meta.seed, {
    exclusion: [{ x: 0, z: 0, r: 30 }], quality: engine.effectiveQuality(),
    maxRealLights: engine.tiers.flags.maxRealLights,
  });
  const scatter = new Scatter(spec, terrain, engine.mats, engine.physics, scene, {
    exclusion: [{ x: 0, z: 20, r: 26 }, { x: 0, z: -target, r: 26 }],
    heroExclusion: [{ x: 0, z: 20, r: 26 }],
    engine,
    quality: engine.effectiveQuality(),
    densityMul: engine.tiers.flags.densityMul,
    windMul: engine.tiers.flags.windMul,
    heroSpots: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
  });
  scatterAmberGlow(scene, rng.fork(0xe9a1), {
    mats: engine.mats,
    groundY: (x, z) => terrain.heightAt(x, z),
    half,
    exclusion: [{ x: 0, z: 0, r: 30 }],
    quality: engine.effectiveQuality(),
  });
  attachLightShafts(engine);

  // the track: from z=+10 (spawn) to z=-target (far gate), x in [-16, 16]
  const trackHalfW = 16;
  const obstacles: Obstacle[] = [];
  const blockMat = engine.mats.flat('#3a2a3a', { emissive: '#ff3fd8', emissiveIntensity: 0.55 });
  const barMat = engine.mats.flat('#2a3a4a', { emissive: '#3fd8ff', emissiveIntensity: 0.55 });
  const addObstacle = (kind: 'block' | 'lowbar', x: number, z: number, w: number) => {
    const y = terrain.heightAt(x, z);
    const group = new THREE.Group();
    let min: THREE.Vector3, max: THREE.Vector3;
    if (kind === 'block') {
      // tall barrier: dodge sideways (A/D)
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 5, 1.2), blockMat);
      m.position.y = 2.5;
      group.add(m);
      min = new THREE.Vector3(x - w / 2, y, z - 0.6);
      max = new THREE.Vector3(x + w / 2, y + 5, z + 0.6);
    } else {
      // low bar: jump (double-jump clears it)
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1, 1.2), barMat);
      m.position.y = 0.55;
      group.add(m);
      // posts
      for (const px of [-w / 2, w / 2]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.1, 0.5), barMat);
        post.position.set(px, 0.55, 0);
        group.add(post);
      }
      min = new THREE.Vector3(x - w / 2, y, z - 0.6);
      max = new THREE.Vector3(x + w / 2, y + 1.1, z + 0.6);
    }
    group.position.set(x, y, z);
    scene.add(group);
    obstacles.push({ mesh: group, min, max, kind });
  };
  for (let z = -18; z > -target + 12; z -= gap) {
    const kind = rng.chance(0.5) ? 'block' : 'lowbar';
    const w = kind === 'block' ? rng.range(5, 9) : rng.range(8, 14);
    const x = rng.range(-trackHalfW + w / 2, trackHalfW - w / 2);
    addObstacle(kind, x, z + rng.range(-4, 4), w);
    // a coin trail over / beside each obstacle rewards the dodge
    // (spawned below through the Pickups manager)
  }

  // finish gate
  const goal = makeGoalFlag(engine.mats, spec.theme.palette.accent);
  goal.position.set(0, terrain.heightAt(0, -target), -target);
  scene.add(goal);
  assets.register('world.goal', { kind: 'world', roots: [goal] });

  // avatar never fights here — pass null managers like the racing blueprint
  // does for its vehicle-only setup
  const avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(0, terrain.heightAt(0, 10) + 2, 10), null, null);
  assets.register('player.body', { kind: 'player', roots: [avatar.ctrl.rig.group] });

  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    if (p.kind === 'coin') {
      engine.score += 50;
      hud.setScore(engine.score);
      engine.audio.play('coin');
    }
    if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
  };
  // coin lines down the track's racing line
  {
    const prng = engine.rng.fork(0xc01);
    for (let z = -8; z > -target; z -= 7) {
      const x = Math.sin(z * 0.11) * 8;
      pickups.spawn('coin', new THREE.Vector3(x, terrain.heightAt(x, z) + 1.1, z));
    }
    for (let i = 0; i < 4; i++) {
      const x = prng.range(-12, 12), z = prng.range(-target + 20, -30);
      pickups.spawn('health', new THREE.Vector3(x, terrain.heightAt(x, z) + 1.1, z));
    }
  }

  const objectives = makeCampaignObjectives(engine, spec);
  hud.setObjective('SPRINT THE GAUNTLET', `Reach the far gate — 0m / ${target}m`);
  hud.setHint(isTouchDevice()
    ? 'Auto-run · left stick steers · JUMP to leap bars'
    : 'Auto-run · A/D steer · Space jump (x2) · Shift dash · Esc pause');

  const camRig = makeCameraRig('chase', engine.camera, input, (x, z) => terrain.heightAt(x, z),
    { physics: engine.physics, skipBody: avatar.ctrl.body });

  dresser.dress(spec, 0, rng.fork(5000), { cx: 0, cz: -target / 2, half: target / 2, yAt: (x, z) => terrain.heightAt(x, z) });
  assets.register('world.arena', { kind: 'world', roots: [structures.group] });
  assets.applyOverrides(spec);

  const pp = new THREE.Vector3();
  let distShown = 0;
  let finished = false;

  engine.onUpdate((dt) => {
    // the runner never stops: hold forward (real input merges on top)
    if (engine.state === 'playing' && !finished) input.inject(['forward']);
    avatar.update(dt, engine.time);
    pp.copy(avatar.ctrl.position);

    // obstacle hits: AABB vs the capsule, with the avatar's own iframes
    // preventing multi-hits off a single barrier
    for (const o of obstacles) {
      if (pp.x > o.min.x - 0.5 && pp.x < o.max.x + 0.5
        && pp.z > o.min.z - 0.5 && pp.z < o.max.z + 0.5
        && pp.y < o.max.y && pp.y + 1.8 > o.min.y) {
        avatar.damage(25, new THREE.Vector3(o.min.x, pp.y, o.min.z));
        camRig.shake(0.6);
        engine.audio.play('hit');
        // shove back so the runner doesn't grind inside the barrier
        avatar.ctrl.teleport(new THREE.Vector3(pp.x, pp.y + 0.5, pp.z + 2.5));
        break;
      }
    }

    const inst = NpcInstancer.for(engine);
    inst.beginFrame(dt);
    inst.endFrame();
    pickups.update(dt, pp, 3.2);
    objectives.update(dt);

    const dist = Math.max(0, Math.min(target, 10 - pp.z));
    if (Math.abs(dist - distShown) > 2) {
      distShown = dist;
      hud.setObjective('SPRINT THE GAUNTLET', `Reach the far gate — ${Math.round(dist)}m / ${target}m`);
    }
    if (!finished && pp.distanceTo(goal.position) < 5) {
      finished = true;
      input.inject([]);
      objectives.reachedGoal();
      engine.audio.play('checkpoint');
    }

    engine.audio.setIntensity(0.55);
    if (pp.y < -40) { avatar.damage(1000); camRig.shake(0.8); }
    camRig.update(dt, pp, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, pickups, objectives, assets, obstacles, get distance() { return Math.max(0, 10 - pp.z); } };
}
