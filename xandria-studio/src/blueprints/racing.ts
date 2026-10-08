/**
 * RACING — closed-loop track on themed terrain, checkpoint gates, 3 AI racers with
 * rubber-banding, boost pads, lap timing, drift + boost player vehicle.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { VehicleController } from '../engine/game/VehicleController';
import { Structures } from '../engine/world/Structures';
import { Scatter } from '../engine/world/Scatter';
import { Objectives } from '../engine/game/Objectives';
import { Progression } from '../engine/game/Progression';
import {
  makeCampaignObjectives,
  roman,
  registerWorldAssets,
  registerPickupAssets,
} from './campaign';
import { AssetRegistry } from '../engine/game/Assets';
import { snapshotLoadoutBase } from '../engine/game/Profile';
import { isTouchDevice } from '../engine/game/TouchControls';
import {
  EffectState,
  EffectHud,
  spawnEffectPickup,
  applyPickupEffect,
  effectOf,
} from './fx';
import { dressRacing } from './dressing';
import { makeCar } from '../engine/gfx/Characters';
import { Rng } from '../engine/core/Rng';
import { toV3 } from '../engine/core/Physics';
import { Pickups } from '../engine/game/Pickups';

interface AiCar {
  mesh: THREE.Group;
  wheels: THREE.Mesh[];
  t: number;          // curve param 0..1
  speed: number;
  lap: number;
  color: string;
}

/**
 * R2-M3: minimum credible lap time for a track of `trackLenM` meters.
 *
 * The old code used a fixed 10s wall-clock debounce against bad start/finish
 * wraps, which silently discarded legitimate sub-10s laps on short tracks (or
 * with a fast, upgraded car) — potentially unwinnable. A real lap cannot beat
 * trackLen / 70 (measured top speed 70.2 m/s with boost held), while spurious
 * wraps from nearestT jitter last a frame or two, so the threshold is set to
 * trackLen / 100 — a ~30% safety margin under the physical minimum — floored
 * at 2s to separate the two regimes.
 */
export function minLapTimeForTrack(trackLenM: number): number {
  const REF_SPEED = 50; // m/s — half of the effective divisor (see above); NOT a top-speed estimate
  return Math.max(2, (trackLenM / REF_SPEED) * 0.5);
}

export function buildRacing(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud, input } = engine;
  const rng = engine.rng.fork(303);

  // M2: snapshot the pristine run config before any run-time mutation.
  snapshotLoadoutBase(spec);
  // M7: drop stale asset-bridge roots left by the previous run (no-op at boot).
  engine.assetBridge.dispose();

  // campaign layer: XP progression (the intro card is shown by Engine.beginPlay)
  // Racing has no avatar/kills: XP comes from laps + checkpoints, and the
  // 'speed' upgrade auto-applies as faster boost-pad charging.
  const prog = new Progression(engine);
  // content depth: timed pickup effects + roadside dressing/crowd
  const fx = new EffectState();
  const fxHud = new EffectHud();
  const racingLevelUp = () => {
    // 'speed' ignores the avatar param (counts the stack only)
    prog.applyUpgrade('speed', undefined as unknown as Parameters<Progression['applyUpgrade']>[1]);
    hud.showCard('LEVEL UP', `Engine tuned — boost pads charge ${Math.round((prog.speedMult() - 1) * 100)}% faster`);
  };

  // asset registry (reskin layer): world assets first, the rest after the course is built
  const assets = new AssetRegistry();
  registerWorldAssets(assets, engine);

  const structures = new Structures(engine.physics, engine.mats);
  const track = structures.track(spec, terrain, spec.meta.seed);
  scene.add(structures.group);

  // roadside dressing: lamp posts, banner arches, grandstands + crowds
  const updateDressing = dressRacing(engine, track, rng.fork(777), spec, (x, z) => terrain.heightAt(x, z));

  // scatter away from the track
  const trackExclusion = track.waypoints.map((w) => ({ x: w.x, z: w.z, r: track.width * 1.2 }));
  const scatter = new Scatter(spec, terrain, engine.mats, engine.physics, scene, { exclusion: trackExclusion, engine });

  // player vehicle at start line, facing along track
  const car = new VehicleController(engine, track.startPos.clone().add(new THREE.Vector3(0, 1, 0)), track.startHeading, spec.theme.palette.primary);

  // AI opponents
  const aiCars: AiCar[] = [];
  const aiColors = ['#3f6fd8', '#e8a13c', '#4fbf67', '#c94fd8', '#e1e4e8'];
  const aiCount = Math.max(1, spec.enemies.find((e) => e.kind === 'racer')?.count ?? 3);
  for (let i = 0; i < aiCount; i++) {
    const c = makeCar(engine.mats, aiColors[i % aiColors.length], spec.meta.seed + i * 31, spec.custom?.forge);
    c.group.children.forEach((ch) => { ch.position.y -= 0.35; });
    scene.add(c.group);
    // stagger behind start
    const t = ((1 - (i + 1) * 0.006) % 1 + 1) % 1;
    aiCars.push({ mesh: c.group, wheels: c.wheels, t, speed: 0, lap: 1, color: aiColors[i % aiColors.length] });
  }

  // boost pads: glowing strips every ~8% of the track
  const pads: THREE.Vector3[] = [];
  const padMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(4, 0.15, 2.4), engine.mats.glow('#3fd8ff', 1.8), 12);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 12; i++) {
    const t = i / 12 + 0.04;
    const p = track.curve.getPointAt(t % 1);
    pads.push(p);
    m4.makeTranslation(p.x, p.y + 0.1, p.z);
    padMesh.setMatrixAt(i, m4);
  }
  padMesh.instanceMatrix.needsUpdate = true;
  scene.add(padMesh);

  // checkpoint gates (visual arcs at 25/50/75%)
  const gateMeshes: THREE.Object3D[] = [];
  const checkpoints = [0.25, 0.5, 0.75].map((t) => track.curve.getPointAt(t));
  for (const cp of checkpoints) {
    const gate = new THREE.Mesh(new THREE.TorusGeometry(track.width / 2 + 1, 0.22, 8, 24), engine.mats.glow(spec.theme.palette.accent, 1.5));
    gate.position.copy(cp).add(new THREE.Vector3(0, 4, 0));
    scene.add(gate);
    gateMeshes.push(gate);
  }

  // track pickups: overdrive (rapid boost charging) + score×2, collected by driving through
  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    const eff = effectOf(p);
    if (eff === 'rapid') {
      applyPickupEffect(engine, fx, null, spec, 'rapid', { name: 'OVERDRIVE', hint: 'boost charging doubled' });
    } else if (eff === 'mult') {
      applyPickupEffect(engine, fx, null, spec, 'mult');
    }
    if (prog.onPickup()) racingLevelUp();
  };
  for (const tt of [0.06, 0.31, 0.56, 0.81]) {
    const p = track.curve.getPointAt(tt);
    spawnEffectPickup(pickups, engine, tt < 0.5 ? 'rapid' : 'mult', p.clone().add(new THREE.Vector3(0, 1.6, 0)));
  }

  // asset registration: vehicles, gates, track, pickups
  assets.register('player.vehicle', { kind: 'vehicle', roots: [car.mesh] });
  assets.register('vehicle.ai', { kind: 'vehicle', roots: aiCars.map((a) => a.mesh) });
  assets.register('world.gate', { kind: 'world', roots: gateMeshes });
  assets.register('world.track', { kind: 'world', roots: [structures.group] });
  registerPickupAssets(assets, pickups);
  assets.applyOverrides(spec);

  // race state — laps from the quest stage when present, else legacy count.
  // Staged specs flow through untouched; legacy specs get the defensive race override.
  const raceStage = spec.objective.stages?.find((s) => s.type === 'race');
  const lapsNeeded = Math.max(1, raceStage?.count ?? spec.objective.count ?? 3);
  const objSpec = spec.objective.stages
    ? spec.objective
    : { ...spec.objective, type: 'race' as const, count: lapsNeeded };
  const objectives = makeCampaignObjectives(engine, { ...spec, objective: objSpec }, undefined, () => prog.level);
  // N1: touch-aware hint bar (gas is automatic on touch)
  hud.setHint(isTouchDevice()
    ? 'Left stick steer (gas auto) · BOOST boost · BRAKE brake · RESET reset'
    : 'W/S throttle · A/D steer · Space boost · Ctrl drift · R reset');
  hud.showBoostBar(true);

  // player progress tracking: nearest curve param
  let playerT = 0;
  let playerLap = 1;
  let lastT = 0;
  let raceTime = 0;
  let bestLap = Infinity;
  let lapStart = 0;
  // checkpoint XP: award once per gate per lap, in forward-crossing order
  const CP_T = [0.25, 0.5, 0.75];
  let nextCp = 0;
  const camRig = makeCameraRig('chase', engine.camera, input, (x, z) => terrain.heightAt(x, z));

  const samples = track.curve.getSpacedPoints(300);
  const nearestT = (p: THREE.Vector3): number => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < samples.length; i += 3) {
      const d = (samples[i].x - p.x) ** 2 + (samples[i].z - p.z) ** 2;
      if (d < bd) { bd = d; best = i / samples.length; }
    }
    return best;
  };

  const trackLenApprox = track.curve.getLength();
  // R2-M3: lap debounce scales with track length (see minLapTimeForTrack).
  const minLapTime = minLapTimeForTrack(trackLenApprox);

  engine.onUpdate((dt) => {
    raceTime += dt;
    car.update(dt, {
      axes: input.axes,
      boost: input.pressed('boost'),
      brake: input.pressed('brake'),
      reset: input.justPressed('reset'),
    });
    hud.setBoost(car.boost);
    engine.audio.setEngine(Math.min(1, car.speed / 34), true);

    // lap detection: param wraps past 0.98 → 0.02 near start
    playerT = nearestT(car.position);
    // checkpoint gates: forward crossing awards XP (once per gate per lap)
    while (nextCp < CP_T.length && lastT < CP_T[nextCp] && playerT >= CP_T[nextCp]) {
      hud.toast('CHECKPOINT');
      engine.audio.play('checkpoint');
      engine.score += Math.round(100 * fx.scoreMult());
      hud.setScore(engine.score);
      if (prog.onPickup()) racingLevelUp();
      nextCp++;
    }
    if (lastT > 0.92 && playerT < 0.08) {
      const lapTime = raceTime - lapStart;
      // R2-M3: track-length-aware debounce — the old fixed 10s gate silently
      // ate legitimate fast laps on short tracks. A discarded lap is never
      // silent: the player gets a toast saying it didn't count.
      if (lapTime >= minLapTime) { // debounce bad wraps
        if (lapTime < bestLap) bestLap = lapTime;
        engine.audio.play('checkpoint');
        hud.toast(playerLap >= lapsNeeded ? 'FINISH!' : `LAP ${playerLap + 1} — ${lapTime.toFixed(1)}s`);
        engine.score += Math.round(500 * fx.scoreMult());
        hud.setScore(engine.score);
        objectives.addProgress(1, 'lap'); // M5: laps only count toward race stages
        if (prog.onKill()) racingLevelUp(); // a lap is worth a kill's XP
        playerLap++;
        lapStart = raceTime;
        nextCp = 0;
      } else {
        hud.toast(`LAP ${lapTime.toFixed(1)}s — NOT COUNTED`);
      }
    }
    lastT = playerT;

    // boost pads (charge rate scales with the speed upgrade multiplier × overdrive)
    for (const pad of pads) {
      if (car.position.distanceToSquared(pad) < 9) {
        car.boost = Math.min(1, car.boost + dt * 1.4 * prog.speedMult() * fx.boostMult());
        if (engine.frame % 12 === 0) engine.particles.magic(car.position, '#3fd8ff', 4);
      }
    }

    pickups.update(dt, car.position, 3.5 * fx.magnetMult(), 2.2);
    fx.tick(dt, spec);
    fxHud.update(fx, raceTime);
    updateDressing(dt, raceTime);

    // AI follow the curve with rubber-banding (N4: wrap the delta — an AI just
    // across the start/finish line must not get a full-lap speed spike/drop)
    for (const ai of aiCars) {
      let gap = playerT - ai.t;
      gap -= Math.round(gap); // wrap to [-0.5, 0.5]
      const targetSpeed = 22 + gap * 8; // rubber band
      ai.speed = THREE.MathUtils.damp(ai.speed, Math.max(16, Math.min(30, targetSpeed)), 0.8, dt);
      ai.t = (ai.t + (ai.speed * dt) / trackLenApprox) % 1;
      const p = track.curve.getPointAt(ai.t);
      const tan = track.curve.getTangentAt(ai.t);
      const y = terrain.heightAt(p.x, p.z);
      ai.mesh.position.set(p.x, y + 0.35, p.z);
      ai.mesh.rotation.y = Math.atan2(-tan.x, -tan.z);
      for (const w of ai.wheels) w.rotation.x += (ai.speed / 0.38) * dt;
    }

    hud.setTimer(raceTime);
    hud.setProgress(`LAP ${Math.min(playerLap, lapsNeeded)} / ${lapsNeeded}${bestLap < Infinity ? ` · BEST ${bestLap.toFixed(1)}s` : ''}`);

    camRig.update(dt, car.position, toV3(car.chassis.velocity), car.heading);
  });

  return { car, aiCars, objectives, assets, track };
}
