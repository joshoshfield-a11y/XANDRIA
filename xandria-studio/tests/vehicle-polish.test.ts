/**
 * Polish wave — VEHICLE & DEBRIS crew tests.
 *
 * #12 vehicle feel: speed-sensitive downforce, progressive handbrake (frictionSlip
 * eases in, not snapped), stronger engine braking, drift-angle exposure.
 * #9 drift smoke + skid marks: smoke fires via particles.burst() while drifting;
 * SkidStrip lays a fading ribbon behind each rear wheel.
 * Debris: DebrisField shards scatter when the car hits them and self-clean
 * (home + asleep) after 7 s — they must never become track traps.
 *
 * Full-engine harness: hand-stubbed DOM + fake WebGLRenderer, same pattern as
 * tests/racing-lap.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as CANNON from 'cannon-es';

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
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
      __listeners: listeners,
    };
    return el;
  }
  class FakeWebGLRenderer {
    domElement: any = makeEl('canvas');
    shadowMap: any = {};
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
import { SkidStrip } from '../src/engine/game/VehicleController';
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

type RacingRun = ReturnType<typeof buildRacing>;

function makeRacingRun() {
  const spec = generateSpec('neon street race', { seed: 11 });
  expect(spec.meta.genre).toBe('racing');
  spec.world.terrain.size = 160;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, spec, { testMode: true });
  (engine as any).postfx = { render() {}, resize() {}, dispose() {} };
  (engine as any).state = 'playing';
  const built = buildRacing(engine, spec);
  return { engine, spec, built };
}

/** Point the chassis at heading 0 (forward = -z) with a horizontal velocity. */
function setCarMotion(built: RacingRun, vx: number, vz: number) {
  const car = built.car;
  car.chassis.quaternion.setFromEuler(0, 0, 0);
  car.chassis.position.set(0, 4, 0);
  car.chassis.velocity.set(vx, 0, vz);
  car.chassis.angularVelocity.set(0, 0, 0);
}

const noInput = { axes: { x: 0, y: 0 }, boost: false, brake: false, reset: false };

describe('#12 vehicle feel', () => {
  it('driftAngle is ~0 driving straight, nonzero when sliding sideways', () => {
    const { built } = makeRacingRun();
    setCarMotion(built, 0, -20); // straight along -z
    built.car.update(1 / 60, noInput);
    expect(Math.abs(built.car.driftAngle)).toBeLessThan(0.02);
    setCarMotion(built, -14, -14); // 45° slide
    built.car.update(1 / 60, noInput);
    expect(Math.abs(built.car.driftAngle)).toBeGreaterThan(0.5);
  });

  it('drifting flag needs handbrake + speed + slide angle', () => {
    const { built } = makeRacingRun();
    setCarMotion(built, -14, -14);
    built.car.update(1 / 60, noInput);
    expect(built.car.drifting).toBe(false); // no handbrake
    built.car.update(1 / 60, { ...noInput, brake: true });
    expect(built.car.drifting).toBe(true);
    setCarMotion(built, 0, -1); // too slow
    built.car.update(1 / 60, { ...noInput, brake: true });
    expect(built.car.drifting).toBe(false);
  });

  it('handbrake frictionSlip eases in instead of snapping', () => {
    const { built } = makeRacingRun();
    setCarMotion(built, 0, -20);
    built.car.update(1 / 60, { ...noInput, brake: true });
    const slip = built.car.vehicle.wheelInfos[2].frictionSlip;
    // after one 1/60 frame the damped value must be strictly between target
    // (0.9) and baseline (2.6) — a snap would read exactly 0.9
    expect(slip).toBeGreaterThan(0.9);
    expect(slip).toBeLessThan(2.6);
    // holding the brake converges on the drift target
    for (let i = 0; i < 120; i++) built.car.update(1 / 60, { ...noInput, brake: true });
    expect(built.car.vehicle.wheelInfos[2].frictionSlip).toBeCloseTo(0.9, 1);
  });

  it('downforce scales with speed squared', () => {
    const { built } = makeRacingRun();
    setCarMotion(built, 0, -30);
    built.car.chassis.force.set(0, 0, 0);
    built.car.update(1 / 60, noInput);
    // called before the next physics step, so the applied force is still on the body
    expect(built.car.chassis.force.y).toBeCloseTo(-0.35 * 900, 0);
  });

  it('coast applies the stronger engine braking', () => {
    const { built } = makeRacingRun();
    setCarMotion(built, 0, -20);
    built.car.update(1 / 60, noInput);
    for (const w of built.car.vehicle.wheelInfos) expect(w.brake).toBeCloseTo(1.1, 6);
  });

  it('handbrake entry kick starts the slide laterally', () => {
    const { built } = makeRacingRun();
    setCarMotion(built, 0, -20);
    built.car.update(1 / 60, { ...noInput, brake: true, axes: { x: 1, y: 0 } });
    // impulse is immediate in cannon-es; the car must have gained lateral velocity
    expect(Math.abs(built.car.chassis.velocity.x)).toBeGreaterThan(0.5);
  });
});

describe('#9 skid marks', () => {
  it('SkidStrip stays hidden until segments are laid, then builds geometry', () => {
    const scene = new THREE.Scene();
    const strip = new SkidStrip(scene, 64);
    strip.update(0.016);
    const mesh = (strip as any).mesh as THREE.Mesh;
    expect(mesh.visible).toBe(false);
    strip.push(0, 0, 0.22, 0, 0.1);
    strip.push(1, 0, 1.22, 0, 0.1);
    strip.update(0.016);
    expect(mesh.visible).toBe(true);
    const geo = mesh.geometry as THREE.BufferGeometry;
    // buffers are preallocated (64 segs); only the draw range grows
    expect(geo.getAttribute('position').count).toBe(64 * 4);
    expect(geo.drawRange.count).toBe(6); // one quad = 2 triangles
    expect(geo.getAttribute('aBirth').count).toBe(64 * 4);
  });

  it('push requires ~0.3 m of wheel travel and breaks on command', () => {
    const scene = new THREE.Scene();
    const strip = new SkidStrip(scene, 64);
    strip.push(0, 0, 0.22, 0, 0.1);
    strip.push(0.05, 0, 0.27, 0, 0.1); // too close — ignored
    expect((strip as any).segs.length).toBe(0);
    strip.push(2, 0, 2.22, 0, 0.1);
    expect((strip as any).segs.length).toBe(1);
    strip.break();
    strip.push(10, 0, 10.22, 0, 0.1); // continuity broken: no segment
    expect((strip as any).segs.length).toBe(1);
  });

  it('segments are capped at maxSegs and fade out after 8 s', () => {
    const scene = new THREE.Scene();
    const strip = new SkidStrip(scene, 8, 8);
    for (let i = 0; i < 30; i++) strip.push(i * 1.0, 0, i * 1.0 + 0.22, 0, 0.1);
    expect((strip as any).segs.length).toBe(8);
    const mesh = (strip as any).mesh as THREE.Mesh;
    expect((mesh.geometry as THREE.BufferGeometry).drawRange.count).toBe(8 * 6);
    for (let i = 0; i < 60; i++) strip.update(0.15); // 9 s
    expect((strip as any).segs.length).toBe(0);
    expect(mesh.visible).toBe(false);
    expect((mesh.geometry as THREE.BufferGeometry).drawRange.count).toBe(0);
  });

  it('drifting emits smoke through the existing particles.burst() signature', () => {
    const { engine, built } = makeRacingRun();
    const spy = vi.spyOn(engine.particles, 'burst');
    // direct updates (no physics stepping) keep the slide deterministic; sweep
    // engine.frame across the smoke cadence so at least one frame fires
    for (let f = 0; f < 8; f++) {
      (engine as any).frame = f;
      setCarMotion(built, -14, -14);
      built.car.update(1 / 60, { ...noInput, brake: true });
      expect(built.car.drifting).toBe(true);
    }
    expect(spy).toHaveBeenCalled();
    const gray = spy.mock.calls.some(
      ([, opts]) => typeof (opts as any)?.color === 'string' && (opts as any).color.startsWith('#6'),
    );
    expect(gray).toBe(true);
    // no smoke when not drifting
    spy.mockClear();
    for (let f = 0; f < 8; f++) {
      (engine as any).frame = f;
      setCarMotion(built, 0, -20);
      built.car.update(1 / 60, noInput);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('interactive debris', () => {
  it('shards start asleep, off the racing ribbon, and never register colliders', () => {
    const { built, spec } = makeRacingRun();
    const debris = (built as any).debris;
    expect(debris).toBeDefined();
    const items = (debris as any).items as any[];
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.body.sleepState).toBe(CANNON.Body.SLEEPING);
      expect(it.hitAt).toBe(-1);
      // off the ribbon: nearestT-style check — every shard keeps clear of the
      // track curve samples by more than half the track width
      let minD = Infinity;
      const samples = built.track.curve.getSpacedPoints(60);
      for (const s of samples) {
        const d = Math.hypot(s.x - it.homePos.x, s.z - it.homePos.z);
        if (d < minD) minD = d;
      }
      expect(minD).toBeGreaterThan(built.track.width * 0.5);
    }
    expect(spec).toBeDefined();
  });

  it('a car hit scatters the shard, and it self-cleans home + asleep after 7 s', () => {
    const { engine, built } = makeRacingRun();
    const debris = (built as any).debris;
    const items = (debris as any).items as any[];
    const item = items[0];
    const home = item.homePos.clone();
    // drive the car into the shard at speed
    const dir = new THREE.Vector3().subVectors(home, built.car.position).setY(0).normalize();
    built.car.chassis.position.set(home.x - dir.x * 3, home.y + 1, home.z - dir.z * 3);
    built.car.chassis.velocity.set(dir.x * 18, 0, dir.z * 18);
    built.car.chassis.quaternion.setFromEuler(0, Math.atan2(dir.x, -dir.z), 0);
    let hit = false;
    for (let i = 0; i < 60; i++) {
      engine.step(1 / 60);
      if (item.hitAt >= 0) { hit = true; break; }
    }
    expect(hit).toBe(true);
    expect(item.body.sleepState).not.toBe(CANNON.Body.SLEEPING);
    // fast-forward: after the 7 s self-clean window the shard is home and asleep
    for (let i = 0; i < 480; i++) engine.step(1 / 60);
    expect(item.hitAt).toBe(-1);
    expect(item.body.sleepState).toBe(CANNON.Body.SLEEPING);
    expect(item.body.position.x).toBeCloseTo(home.x, 4);
    expect(item.body.position.z).toBeCloseTo(home.z, 4);
  });
});
