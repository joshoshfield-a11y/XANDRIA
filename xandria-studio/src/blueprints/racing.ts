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
import { makeCar } from '../engine/gfx/Characters';
import { Rng } from '../engine/core/Rng';
import { toV3 } from '../engine/core/Physics';

interface AiCar {
  mesh: THREE.Group;
  wheels: THREE.Mesh[];
  t: number;          // curve param 0..1
  speed: number;
  lap: number;
  color: string;
}

export function buildRacing(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud, input } = engine;
  const rng = engine.rng.fork(303);

  const structures = new Structures(engine.physics, engine.mats);
  const track = structures.track(spec, terrain, spec.meta.seed);
  scene.add(structures.group);

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
    const c = makeCar(engine.mats, aiColors[i % aiColors.length], spec.meta.seed + i * 31);
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
  const checkpoints = [0.25, 0.5, 0.75].map((t) => track.curve.getPointAt(t));
  for (const cp of checkpoints) {
    const gate = new THREE.Mesh(new THREE.TorusGeometry(track.width / 2 + 1, 0.22, 8, 24), engine.mats.glow(spec.theme.palette.accent, 1.5));
    gate.position.copy(cp).add(new THREE.Vector3(0, 4, 0));
    scene.add(gate);
  }

  // race state
  const lapsNeeded = Math.max(1, spec.objective.count || 3);
  const objectives = new Objectives(engine, { ...spec.objective, type: 'race', count: lapsNeeded, description: `${lapsNeeded} laps — first to the line wins` });
  hud.setObjective(spec.meta.name.toUpperCase(), `${lapsNeeded} LAPS — beat the pack`);
  hud.setHint('W/S throttle · A/D steer · Space boost · Ctrl drift · R reset');
  hud.showBoostBar(true);

  // player progress tracking: nearest curve param
  let playerT = 0;
  let playerLap = 1;
  let lastT = 0;
  let raceTime = 0;
  let bestLap = Infinity;
  let lapStart = 0;
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
    if (lastT > 0.92 && playerT < 0.08) {
      const lapTime = raceTime - lapStart;
      if (lapTime > 10) { // debounce bad wraps
        if (lapTime < bestLap) bestLap = lapTime;
        engine.audio.play('checkpoint');
        hud.toast(playerLap >= lapsNeeded ? 'FINISH!' : `LAP ${playerLap + 1} — ${lapTime.toFixed(1)}s`);
        objectives.addProgress(1);
        playerLap++;
        lapStart = raceTime;
      }
    }
    lastT = playerT;

    // boost pads
    for (const pad of pads) {
      if (car.position.distanceToSquared(pad) < 9) {
        car.boost = Math.min(1, car.boost + dt * 1.4);
        if (engine.frame % 12 === 0) engine.particles.magic(car.position, '#3fd8ff', 4);
      }
    }

    // AI follow the curve with rubber-banding
    for (const ai of aiCars) {
      const targetSpeed = 22 + (playerT - ai.t) * 8; // rubber band
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

  const trackLenApprox = track.curve.getLength();

  return { car, aiCars, objectives };
}
