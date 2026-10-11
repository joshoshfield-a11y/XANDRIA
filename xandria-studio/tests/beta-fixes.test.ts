/**
 * Beta-bugfix regression tests (bot-found gameplay bugs, 2026-10-10):
 *
 * 1. Racing respawn trap: VehicleController used a single `lastSafe` point
 *    recorded whenever speed > 3 — including while driving INTO a trap at
 *    speed. Once wedged, R/reset respawned into the same pocket forever.
 *    Fix: ring of contact-gated safe snapshots; respawn picks the newest
 *    snapshot >5 m from the wedge (re-oriented along travel), falling back
 *    to spawn. Repeated resets walk further back.
 *
 * 2. Platformer pit wedging: the course floats above solid terrain; a missed
 *    jump could strand the player on the ground far below the course, where
 *    the hazard plane (startY-22) never catches them and no jump reaches back.
 *    Fix: track the last grounded spot (ratcheted gradually so deep
 *    off-course landings don't move it); if the player stays >6 m below it,
 *    bounce them back after a 1.2 s grace period.
 *
 * Full-engine harness: hand-stubbed DOM + fake WebGLRenderer, same pattern
 * as tests/racing-lap.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const listeners: Record<string, Function[]> = {};
    const el: any = {
      tag,
      children: [] as any[],
      style: {} as Record<string, string>,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '',
      className: '',
      value: '',
      checked: false,
      innerHTML: '',
      appendChild(c: any) { el.children.push(c); return c; },
      append(...cs: any[]) { for (const c of cs) el.children.push(c); },
      remove() {
        const p = (el as any).parent;
        if (p && Array.isArray(p.children)) {
          const i = p.children.indexOf(el);
          if (i >= 0) p.children.splice(i, 1);
        }
      },
      setAttribute() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener(t: string, fn: Function) { (listeners[t] ??= []).push(fn); },
      removeEventListener(t: string, fn: Function) {
        const l = listeners[t]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
      },
      querySelector() { return makeEl(); },
      querySelectorAll() { return []; },
      getContext: (kind: string) => {
        if (kind === '2d') {
          return {
            canvas: el,
            fillStyle: '',
            clearRect() {},
            beginPath() {},
            closePath() {},
            moveTo() {},
            lineTo() {},
            fill() {},
            createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
            putImageData() {},
            createLinearGradient: () => ({ addColorStop() {} }),
          };
        }
        return {
          createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData() {},
        };
      },
      __listeners: listeners,
    };
    return el;
  }
  class FakeWebGLRenderer {
    domElement: any = makeEl('canvas');
    shadowMap: any = {} as any;
    toneMapping: any = null;
    toneMappingExposure = 1;
    setPixelRatio() {}
    setSize() {}
    getPixelRatio() { return 1; }
    getSize() { return { width: 800, height: 600 }; }
    dispose() {}
    render() {}
  }
  return { makeEl, FakeWebGLRenderer };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import { Engine } from '../src/engine/Engine';
import { generateSpec } from '../src/generator/generate';
import { buildRacing } from '../src/blueprints/racing';
import { buildPlatformer } from '../src/blueprints/platformer';
import { _setProfileStorage } from '../src/engine/game/Profile';

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

beforeEach(() => {
  const head = makeEl('head');
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head,
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as any).localStorage = memStore();
  (globalThis as any).window = {
    addEventListener() {},
    removeEventListener() {},
    setInterval: vi.fn(() => 42),
    clearInterval: vi.fn(),
  };
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1;
  (globalThis as any).innerWidth = 800;
  (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0;
  (globalThis as any).cancelAnimationFrame = () => {};
  _setProfileStorage(memStore() as any);
});

function makeEngine(spec: ReturnType<typeof generateSpec>) {
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, spec, { testMode: true });
  (engine as any).postfx = { render() {}, resize() {}, dispose() {} };
  (engine as any).state = 'playing';
  return engine;
}

const NEUTRAL = { axes: { x: 0, y: 0 }, boost: false, brake: false, reset: false };
const DRIVE = { axes: { x: 0, y: -1 }, boost: false, brake: false, reset: false };

describe('beta bugfix: racing respawn trap', () => {
  it('reset after wedging into a barrier respawns away from the trap, on drivable track', () => {
    const spec = generateSpec('desert racing grand prix', { seed: 7 });
    expect(spec.meta.genre).toBe('racing');
    const engine = makeEngine(spec);
    const built = buildRacing(engine, spec);
    const car = built.car;
    const curve = built.track.curve;

    // 1. seed safe history FAR from the test barrier: cruise along the track at speed
    for (let k = 0; k < 4; k++) {
      const t = 0.3 + k * 0.02;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).setY(0).normalize();
      car.chassis.position.set(p.x, p.y + 1, p.z);
      car.chassis.velocity.set(tan.x * 12, 0, tan.z * 12);
      car.chassis.angularVelocity.set(0, 0, 0);
      car.chassis.quaternion.setFromEuler(0, Math.atan2(tan.x, tan.z), 0);
      for (let i = 0; i < 30; i++) {
        car.update(1 / 60, NEUTRAL);
        engine.physics.world.step(1 / 60);
      }
    }

    // 2. aim at a real track-side barrier: replicate Structures.track placement
    // (samples = curve.getSpacedPoints(400), physics boxes at i%6==0, ±6.6 m).
    // Drive INTO it at speed, like the bot did — this is what poisons lastSafe
    // in the old code.
    const samples = curve.getSpacedPoints(400);
    const bi = 60;
    const bp = samples[bi];
    const tanB = curve.getTangentAt(bi / 400).setY(0).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const sideB = new THREE.Vector3().crossVectors(tanB, up).normalize();
    const barrier = new THREE.Vector3(bp.x + sideB.x * 6.6, bp.y + 0.5, bp.z + sideB.z * 6.6);
    // launch from the track center straight at the barrier, already at speed
    const launch = curve.getPointAt(bi / 400);
    car.chassis.position.set(launch.x, launch.y + 1, launch.z);
    car.chassis.velocity.set(sideB.x * 12, 0, sideB.z * 12);
    car.chassis.angularVelocity.set(0, 0, 0);
    // face the barrier: probe both yaw candidates, keep the one that approaches
    const yawA = Math.atan2(-sideB.x, -sideB.z);
    const distToBarrier = () => Math.hypot(car.position.x - barrier.x, car.position.z - barrier.z);
    car.chassis.quaternion.setFromEuler(0, yawA, 0);
    const d0 = distToBarrier();
    for (let i = 0; i < 15; i++) { car.update(1 / 60, DRIVE); engine.physics.world.step(1 / 60); }
    if (distToBarrier() >= d0) {
      car.chassis.position.set(launch.x, launch.y + 1, launch.z);
      car.chassis.velocity.set(sideB.x * 12, 0, sideB.z * 12);
      car.chassis.quaternion.setFromEuler(0, yawA + Math.PI, 0);
      for (let i = 0; i < 15; i++) { car.update(1 / 60, DRIVE); engine.physics.world.step(1 / 60); }
    }

    // 3. drive into the barrier until real contact, then wedge (the bot's state:
    // wheels churn, no translation)
    let collided = false;
    const onCollide = () => { collided = true; };
    car.chassis.addEventListener('collide', onCollide);
    for (let i = 0; i < 240 && !collided; i++) {
      car.update(1 / 60, DRIVE);
      engine.physics.world.step(1 / 60);
    }
    car.chassis.removeEventListener('collide', onCollide);
    expect(collided).toBe(true); // setup validity: we hit real geometry
    car.chassis.velocity.set(0, 0, 0);
    car.chassis.angularVelocity.set(0, 0, 0);
    const wedge = car.position.clone();

    // 4. reset
    car.update(1 / 60, { axes: { x: 0, y: 0 }, boost: false, brake: false, reset: true });
    const p1 = car.position.clone();

    // 5a. not back in the trap (the old bug: respawn landed in the same pocket)
    expect(Math.hypot(p1.x - wedge.x, p1.z - wedge.z)).toBeGreaterThan(4);
    // 5b. back near the track (drivable), not flung into the wilderness
    let bd = Infinity;
    for (const s of samples) {
      const d = Math.hypot(s.x - p1.x, s.z - p1.z);
      if (d < bd) bd = d;
    }
    expect(bd).toBeLessThan(15);
    // 5c. the car can actually drive away
    for (let i = 0; i < 120; i++) {
      car.update(1 / 60, DRIVE);
      engine.physics.world.step(1 / 60);
    }
    expect(Math.hypot(car.position.x - p1.x, car.position.z - p1.z)).toBeGreaterThan(1.5);
  });

  it('beauty-wave sanity: a wreck shard near the track cannot trap the car', () => {
    // The beauty env pass (feature/beauty-wave) added physical wreck shards
    // near the track (Scatter hero set: BoxGeometry(1.8,0.5,1.1), physical
    // cylinder collider). Bot stress tests flagged repeated racing softlocks
    // possibly from shards. The shards respect the track exclusion zone, but a
    // car that veers off-track can still wedge against one — verify the
    // contact-gated history respawn frees it just like a barrier wedge.
    const spec = generateSpec('desert racing grand prix', { seed: 7 });
    const engine = makeEngine(spec);
    const built = buildRacing(engine, spec);
    const car = built.car;
    const curve = built.track.curve;

    // seed safe history on the track
    for (let k = 0; k < 4; k++) {
      const t = 0.3 + k * 0.02;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).setY(0).normalize();
      car.chassis.position.set(p.x, p.y + 1, p.z);
      car.chassis.velocity.set(tan.x * 12, 0, tan.z * 12);
      car.chassis.angularVelocity.set(0, 0, 0);
      car.chassis.quaternion.setFromEuler(0, Math.atan2(tan.x, tan.z), 0);
      for (let i = 0; i < 30; i++) {
        car.update(1 / 60, NEUTRAL);
        engine.physics.world.step(1 / 60);
      }
    }

    // replicate the beauty shard collider: physics.cylinder(collideR*s.x*0.8,
    // collideR*s.x*0.9, 6*s.y, [p.x, p.y+3*s.y, p.z]) with collideR=0.9, s=1
    const tShard = 0.21;
    const sp = curve.getPointAt(tShard);
    const sTan = curve.getTangentAt(tShard).setY(0).normalize();
    const sSide = new THREE.Vector3().crossVectors(sTan, new THREE.Vector3(0, 1, 0)).normalize();
    const shardPos = new THREE.Vector3(sp.x + sSide.x * 10, sp.y, sp.z + sSide.z * 10);
    engine.physics.cylinder(0.72, 0.81, 6, [shardPos.x, shardPos.y + 3, shardPos.z], {});

    // launch from the track center straight at the shard, at speed
    car.chassis.position.set(sp.x, sp.y + 1, sp.z);
    car.chassis.velocity.set(sSide.x * 12, 0, sSide.z * 12);
    car.chassis.angularVelocity.set(0, 0, 0);
    const yawA = Math.atan2(-sSide.x, -sSide.z);
    const distToShard = () => Math.hypot(car.position.x - shardPos.x, car.position.z - shardPos.z);
    car.chassis.quaternion.setFromEuler(0, yawA, 0);
    const d0 = distToShard();
    for (let i = 0; i < 15; i++) { car.update(1 / 60, DRIVE); engine.physics.world.step(1 / 60); }
    if (distToShard() >= d0) {
      car.chassis.position.set(sp.x, sp.y + 1, sp.z);
      car.chassis.velocity.set(sSide.x * 12, 0, sSide.z * 12);
      car.chassis.quaternion.setFromEuler(0, yawA + Math.PI, 0);
      for (let i = 0; i < 15; i++) { car.update(1 / 60, DRIVE); engine.physics.world.step(1 / 60); }
    }
    let collided = false;
    const onCollide = () => { collided = true; };
    car.chassis.addEventListener('collide', onCollide);
    for (let i = 0; i < 240 && !collided; i++) {
      car.update(1 / 60, DRIVE);
      engine.physics.world.step(1 / 60);
    }
    car.chassis.removeEventListener('collide', onCollide);
    expect(collided).toBe(true);
    car.chassis.velocity.set(0, 0, 0);
    car.chassis.angularVelocity.set(0, 0, 0);
    const wedge = car.position.clone();

    car.update(1 / 60, { axes: { x: 0, y: 0 }, boost: false, brake: false, reset: true });
    const p1 = car.position.clone();
    // free of the shard, back on drivable track, able to drive
    expect(Math.hypot(p1.x - wedge.x, p1.z - wedge.z)).toBeGreaterThan(4);
    for (let i = 0; i < 120; i++) {
      car.update(1 / 60, DRIVE);
      engine.physics.world.step(1 / 60);
    }
    expect(Math.hypot(car.position.x - p1.x, car.position.z - p1.z)).toBeGreaterThan(1.5);
  });

  it('repeated resets walk further back instead of ping-ponging', () => {
    const spec = generateSpec('desert racing grand prix', { seed: 7 });
    const engine = makeEngine(spec);
    const built = buildRacing(engine, spec);
    const car = built.car;
    const curve = built.track.curve;
    for (let k = 0; k < 6; k++) {
      const t = 0.1 + k * 0.02;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).setY(0).normalize();
      car.chassis.position.set(p.x, p.y + 1, p.z);
      car.chassis.velocity.set(tan.x * 12, 0, tan.z * 12);
      car.chassis.quaternion.setFromEuler(0, Math.atan2(tan.x, tan.z), 0);
      for (let i = 0; i < 30; i++) {
        car.update(1 / 60, NEUTRAL);
        engine.physics.world.step(1 / 60);
      }
    }
    // wedge far from all history
    const p0 = curve.getPointAt(0.5);
    car.chassis.position.set(p0.x + 40, p0.y + 1, p0.z + 40);
    car.chassis.velocity.set(0, 0, 0);
    const w = car.position.clone();
    car.update(1 / 60, { axes: { x: 0, y: 0 }, boost: false, brake: false, reset: true });
    const r1 = car.position.clone();
    // wedge again at the respawn point, reset again
    car.chassis.velocity.set(0, 0, 0);
    car.update(1 / 60, { axes: { x: 0, y: 0 }, boost: false, brake: false, reset: true });
    const r2 = car.position.clone();
    const d1 = Math.hypot(r1.x - w.x, r1.z - w.z);
    const d2 = Math.hypot(r2.x - w.x, r2.z - w.z);
    expect(d1).toBeGreaterThan(4);
    expect(d2).toBeGreaterThan(4);
    // second reset went further back (or to spawn), not to the same spot
    expect(Math.hypot(r2.x - r1.x, r2.z - r1.z)).toBeGreaterThan(0.5);
  });
});

describe('beta bugfix: platformer pit wedging', () => {
  it('landing resets the jump counter (ground-probe regression)', () => {
    // Root cause of the bot's "pits it can't jump out of": Physics.raycast
    // nulled any probe whose closest hit was the skipped body. The
    // CharacterController ground probe starts inside the player capsule, so
    // `grounded` was never true, the jump counter never reset, and jumping
    // died permanently after the first double jump.
    const spec = generateSpec('dreamy platformer', { seed: 22 });
    const engine = makeEngine(spec);
    const built = buildPlatformer(engine, spec);
    const ctrl = built.avatar.ctrl;
    for (let i = 0; i < 200 && !ctrl.grounded; i++) engine.step(1 / 60);
    expect(ctrl.grounded).toBe(true);
    let fired = 0;
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 40; i++) engine.step(1 / 60); // settle/land
      const vyBefore = ctrl.body.velocity.y;
      (engine.input as any).tap('jump');
      engine.step(1 / 60);
      if (ctrl.body.velocity.y > 3 && ctrl.body.velocity.y > vyBefore + 2) fired++;
      (engine.input as any).inject([]);
    }
    expect(fired).toBe(5);
  });
});
