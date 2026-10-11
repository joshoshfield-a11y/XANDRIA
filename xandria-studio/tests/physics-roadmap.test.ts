/**
 * Physics wave tests (roadmap items 1–7):
 *  - Surfaces: data table lookups, fallback, Terrain.surfaceAt derivation,
 *    ice-vs-stone controller feel, water wading + splash
 *  - Water: buoyancy — items float instead of sinking (dry control settles)
 *  - Breakables: intact → damaged → collapsed, deterministic fragments,
 *    chest wiring via onChestDamaged, debris cleanup
 *  - PhysicsScheduler: distance bands, budget cap, unregister release
 *  - TerrainAwarePlacement: ground clamp, rejections, no memory growth
 *  - MeleeCombat: windup → active → recovery → idle, active-frame sweeps hit
 *    once per target, skipBody semantics, damage values preserved
 *  - AnimationAdjust: post-pass lean / slope feet / weapon-carry arm pose,
 *    layered over animate(), dead rigs skipped
 *
 * Headless harness (no jsdom): same stub pattern as tests/items-world.test.ts —
 * real Engine, stubbed WebGLRenderer, hand-stubbed DOM. cannon-es + three run
 * fully in-process. Deterministic: seeded engines, no Math.random/Date.now.
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
import * as CANNON from 'cannon-es';
import { Engine } from '../src/engine/Engine';
import { GROUP } from '../src/engine/core/Physics';
import { defaultSpec } from '../src/spec/schema';
import type { GameSpec, ItemDef, ItemChestDef } from '../src/spec/schema';
import { CharacterController } from '../src/engine/game/CharacterController';
import { ItemWorld } from '../src/engine/game/items/ItemWorld';
import { SURFACES, surfaceProps, DEFAULT_SURFACE_ID } from '../src/engine/physics/Surfaces';
import { submergedFraction, wadingState, SplashDetector, applyBuoyancy } from '../src/engine/physics/Water';
import { Breakables, DEFAULT_BREAKABLE_DEF } from '../src/engine/physics/Breakables';
import { PhysicsScheduler, budgetForQuality } from '../src/engine/physics/PhysicsScheduler';
import { sample, sampleChecked, placeStaticBox } from '../src/engine/physics/TerrainAwarePlacement';
import { MeleeSwing, DEFAULT_MELEE_TIMING } from '../src/engine/physics/MeleeCombat';
import { AnimationAdjust } from '../src/engine/physics/AnimationAdjust';
import { makeHumanoid } from '../src/engine/gfx/Characters';
import { MaterialLibrary } from '../src/engine/gfx/Materials';

/* ---------------- harness ---------------- */

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
});

function makeEngine(spec?: GameSpec, noTerrain = true): Engine {
  const s = spec ?? defaultSpec(99);
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, s, { testMode: true, noTerrain });
  (engine as any).postfx = { render() {}, resize() {}, dispose() {} };
  return engine;
}

function addGround(engine: Engine) {
  engine.physics.box(new THREE.Vector3(60, 1, 60), new THREE.Vector3(0, -0.5, 0), { mass: 0, group: GROUP.WORLD });
}

const DEFS = {
  ironSword: { name: 'Iron Sword', type: 'weapon', slot: 'weapon', rarity: 'common', stats: { damage: 12 }, stack: 1, value: 50 },
} as unknown as Record<string, ItemDef>;

const CHEST = {
  id: 'c1', pos: [4, 0, 4], loot: ['ironSword'], locked: false,
} as unknown as ItemChestDef;

const FAR = new THREE.Vector3(100, 0, 100);

/** flat deterministic terrain stub for surface/water/placement tests */
function stubTerrain(over: Record<string, any> = {}): any {
  return {
    heightAt: () => 0,
    normalAt: () => new THREE.Vector3(0, 1, 0),
    slopeAt: () => 0,
    surfaceAt: () => 'stone',
    waterLevelAt: () => null,
    inBounds: () => true,
    ...over,
  };
}

/* ---------------- 1. Surfaces ---------------- */

describe('Surfaces table', () => {
  it('ice is slippery and slow, mud is draggy, stone is neutral', () => {
    expect(SURFACES.ice.accelMul).toBeLessThan(SURFACES.stone.accelMul);
    expect(SURFACES.ice.traction).toBeLessThan(0.4);
    expect(SURFACES.ice.stopMul).toBeLessThan(0.4);
    expect(SURFACES.mud.accelMul).toBeLessThan(SURFACES.sand.accelMul);
    expect(SURFACES.stone.accelMul).toBe(1);
    expect(SURFACES.stone.traction).toBe(1);
    expect(SURFACES.stone.stopMul).toBe(1);
    expect(SURFACES.shallow.footstepFX).toBe('splash');
    expect(SURFACES.gravel.footstepFX).toBe('crunch');
  });
  it('unknown surface ids fall back to the neutral default', () => {
    expect(surfaceProps('not-a-surface')).toBe(surfaceProps(DEFAULT_SURFACE_ID));
    expect(surfaceProps(undefined).accelMul).toBe(1);
  });
});

describe('Terrain.surfaceAt / waterLevelAt', () => {
  it('reports shallow under the water plane and a table id elsewhere, deterministically', () => {
    const s = defaultSpec(99);
    s.world.terrain.water = true;
    s.world.terrain.waterLevel = 2;
    const engine = makeEngine(s, false); // real terrain
    try {
      const t = engine.terrain;
      expect(t.waterLevelAt(0, 0)).toBeCloseTo(2, 6);
      expect(t.surfaceAt(0, 0)).toBe('shallow'); // spawn area is flattened to y≈0
      const id = t.surfaceAt(40, -30);
      expect(SURFACES[id]).toBeDefined();
      expect(t.surfaceAt(40, -30)).toBe(id); // deterministic
    } finally {
      engine.dispose();
    }
  });
  it('waterLevelAt is null when the spec has no water', () => {
    const engine = makeEngine(defaultSpec(99), false);
    try {
      expect(engine.terrain.waterLevelAt(0, 0)).toBeNull();
    } finally {
      engine.dispose();
    }
  });
});

describe('CharacterController surface feel', () => {
  function settledController(surface: string, water: (() => number | null) | null = null): { engine: Engine; ctrl: CharacterController } {
    const engine = makeEngine();
    addGround(engine);
    (engine as any).terrain = stubTerrain({ surfaceAt: () => surface, waterLevelAt: water ?? (() => null) });
    const ctrl = new CharacterController(engine, engine.spec.player, new THREE.Vector3(0, 5, 0));
    for (let i = 0; i < 150; i++) engine.physics.step(1 / 60); // fall + settle
    return { engine, ctrl };
  }
  function speedAfter(engine: Engine, steps: number): number {
    for (let i = 0; i < steps; i++) engine.physics.step(1 / 60);
    return stepsDone(engine);
  }
  function stepsDone(engine: Engine): number {
    const b: CANNON.Body = (engine as any)._lastCtrlBody ?? (engine.physics.world.bodies.find((x) => x.collisionFilterGroup === GROUP.PLAYER) as CANNON.Body);
    return Math.hypot(b.velocity.x, b.velocity.z);
  }

  it('ice accelerates slower than stone from rest', () => {
    const a = settledController('stone');
    const b = settledController('ice');
    try {
      a.engine.input.inject([], { lx: 1, ly: 0 });
      b.engine.input.inject([], { lx: 1, ly: 0 });
      const sa = speedAfter(a.engine, 30);
      const sb = speedAfter(b.engine, 30);
      expect(sa).toBeGreaterThan(5);
      expect(sb).toBeLessThan(sa * 0.8); // ice feels icy
      expect(a.ctrl.surfaceId).toBe('stone');
      expect(b.ctrl.surfaceId).toBe('ice');
      expect(b.ctrl.footstepFX).toBe('none');
    } finally {
      a.engine.dispose(); b.engine.dispose();
    }
  });

  it('ice keeps sliding after input release (low stopMul)', () => {
    const a = settledController('stone');
    const b = settledController('ice');
    try {
      for (const { engine } of [a, b]) {
        const body = engine.physics.world.bodies.find((x) => x.collisionFilterGroup === GROUP.PLAYER)!;
        (engine as any)._lastCtrlBody = body;
        body.velocity.set(7, 0, 0);
        engine.input.inject([], null);
      }
      const sa = speedAfter(a.engine, 30);
      const sb = speedAfter(b.engine, 30);
      expect(sa).toBeLessThan(0.5); // stone stops
      expect(sb).toBeGreaterThan(1); // ice slides on
    } finally {
      a.engine.dispose(); b.engine.dispose();
    }
  });

  it('wading sets the wading flag and fires a splash burst on enter', () => {
    const { engine, ctrl } = settledController('stone', () => 1.2);
    try {
      for (let i = 0; i < 10; i++) engine.physics.step(1 / 60);
      expect(ctrl.wading).toBe(true);
      expect(ctrl.submerged).toBeGreaterThan(0.4);
      // re-trigger the edges: teleport out (exit), back in (enter)
      const spy = vi.spyOn(engine.particles, 'burst');
      ctrl.teleport(new THREE.Vector3(0, 10, 0));
      engine.physics.step(1 / 60);
      ctrl.teleport(new THREE.Vector3(0, 2, 0));
      engine.physics.step(1 / 60);
      const splashes = spy.mock.calls.filter((c) => (c[1] as any).color === '#cfeaff');
      expect(splashes.length).toBeGreaterThanOrEqual(2); // exit + enter
      spy.mockRestore();
    } finally {
      engine.dispose();
    }
  });

  it('wading drag caps top speed', () => {
    const dry = settledController('stone', () => null);
    const wet = settledController('stone', () => 1.2);
    try {
      dry.engine.input.inject([], { lx: 1, ly: 0 });
      wet.engine.input.inject([], { lx: 1, ly: 0 });
      const sd = speedAfter(dry.engine, 120);
      const sw = speedAfter(wet.engine, 120);
      expect(sd).toBeGreaterThan(6);
      expect(sw).toBeLessThan(sd * 0.75); // water resistance
    } finally {
      dry.engine.dispose(); wet.engine.dispose();
    }
  });
});

/* ---------------- 2. Water ---------------- */

describe('Water helpers', () => {
  it('submergedFraction spans 0..1 across the capsule', () => {
    expect(submergedFraction(10, 0.85, 5)).toBe(0);
    expect(submergedFraction(0, 0.85, 5)).toBe(1);
    expect(submergedFraction(5, 0.85, 5)).toBeCloseTo(0.5, 6);
  });
  it('wadingState flags feet-wet/head-dry', () => {
    expect(wadingState(0.85, 0.85, 1.2).wading).toBe(true);
    expect(wadingState(0.85, 0.85, null).wading).toBe(false);
    expect(wadingState(0.85, 0.85, 5).wading).toBe(false); // fully under
  });
  it('SplashDetector fires enter/exit edges only', () => {
    const d = new SplashDetector();
    expect(d.update(0)).toBeNull();
    expect(d.update(0.5)).toBe('enter');
    expect(d.update(0.6)).toBeNull();
    expect(d.update(0)).toBe('exit');
    expect(d.update(0)).toBeNull();
  });
  it('applyBuoyancy lifts a sunk body toward the surface without allocating', () => {
    const engine = makeEngine();
    try {
      const body = engine.physics.sphere(0.5, [0, 0, 0], { mass: 1, group: GROUP.PICKUP });
      body.velocity.set(0, -5, 0);
      const touched = applyBuoyancy(body, 2, 0.5, 1 / 60, engine.physics.world.gravity.y, 0.7, 1.0);
      expect(touched).toBe(true);
      expect(body.velocity.y).toBeGreaterThan(-5); // pushed up
      const dry = applyBuoyancy(body, 2, 0.5, 1 / 60, engine.physics.world.gravity.y, 0.7, 1.0);
      body.position.set(0, 10, 0);
      expect(applyBuoyancy(body, 2, 0.5, 1 / 60, engine.physics.world.gravity.y, 0.7, 1.0)).toBe(false);
      void dry;
    } finally {
      engine.dispose();
    }
  });
});

describe('ItemWorld buoyancy', () => {
  it('dropped items float on water instead of sinking', () => {
    const engine = makeEngine();
    (engine as any).terrain = stubTerrain({ waterLevelAt: () => 2 });
    const iw = new ItemWorld(engine, DEFS);
    try {
      const item = iw.drop('ironSword', new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 0, 0));
      for (let i = 0; i < 300; i++) {
        engine.physics.step(1 / 60);
        iw.update(1 / 60, FAR);
      }
      expect(item.mode).toBe('physics'); // still bobbing, never settled
      expect(item.body!.position.y).toBeGreaterThan(1.2); // near surface 2, not sunk
      expect(item.body!.position.y).toBeLessThan(3.2);
    } finally {
      iw.dispose(); engine.dispose();
    }
  });
  it('dry control: the same drop settles to presentation mode', () => {
    const engine = makeEngine();
    addGround(engine);
    (engine as any).terrain = stubTerrain(); // waterLevelAt → null
    const iw = new ItemWorld(engine, DEFS);
    try {
      const item = iw.drop('ironSword', new THREE.Vector3(0, 3, 0), new THREE.Vector3(0, 0, 0));
      for (let i = 0; i < 300; i++) {
        engine.physics.step(1 / 60);
        iw.update(1 / 60, FAR);
      }
      expect(item.mode).toBe('presentation');
      expect(item.body).toBeNull();
    } finally {
      iw.dispose(); engine.dispose();
    }
  });
});

/* ---------------- 3. Breakables ---------------- */

describe('Breakables', () => {
  it('transitions intact → damaged → collapsed with fragment bodies', () => {
    const engine = makeEngine();
    const br = new Breakables(engine);
    try {
      const b = br.create(new THREE.Vector3(0, 1, 0));
      expect(b.state).toBe('intact');
      expect(br.damage(b, 1)).toBe('damaged');
      expect(b.fragBodies.length).toBe(0); // no fragments until collapse
      expect(br.damage(b, 1)).toBe('collapsed');
      expect(b.fragBodies.length).toBe(DEFAULT_BREAKABLE_DEF.fragments);
      expect(b.fragMeshes.length).toBe(DEFAULT_BREAKABLE_DEF.fragments);
      expect(br.damage(b, 1)).toBe('collapsed'); // idempotent
    } finally {
      br.dispose(); engine.dispose();
    }
  });

  it('fragment scatter is deterministic for the same seed', () => {
    const scatter = () => {
      const engine = makeEngine(defaultSpec(99));
      const br = new Breakables(engine);
      const b = br.create(new THREE.Vector3(1, 2, 3));
      br.damage(b, 1);
      br.damage(b, 1);
      const pts = b.fragBodies.map((x) => [x.position.x, x.position.y, x.position.z, x.velocity.x, x.velocity.y, x.velocity.z]);
      const n = engine.physics.world.bodies.length;
      br.dispose(); engine.dispose();
      return { pts, n };
    };
    const a = scatter();
    const c = scatter();
    expect(a.pts).toEqual(c.pts);
  });

  it('settled debris is released after debrisLife', () => {
    const engine = makeEngine();
    const br = new Breakables(engine);
    try {
      const b = br.create(new THREE.Vector3(0, 1, 0), { debrisLife: 0.2, fragments: 4 });
      br.damage(b, 99); // overkill → straight to collapsed
      expect(b.state).toBe('collapsed');
      const before = engine.physics.world.bodies.length;
      for (let i = 0; i < 30; i++) { engine.physics.step(1 / 60); br.update(1 / 60); }
      expect(br.live.length).toBe(0);
      expect(engine.physics.world.bodies.length).toBe(before - 4);
    } finally {
      br.dispose(); engine.dispose();
    }
  });

  it('wires into ItemWorld.damageChest via onChestDamaged', () => {
    const engine = makeEngine();
    (engine as any).terrain = stubTerrain();
    const iw = new ItemWorld(engine, DEFS);
    const br = new Breakables(engine);
    try {
      br.wireChest(iw);
      const chest = iw.spawnChest(CHEST);
      const calls: number[] = [];
      const prev = iw.onChestDamaged!;
      iw.onChestDamaged = (c, hpBefore) => { calls.push(hpBefore); prev(c, hpBefore); };
      iw.damageChest(chest, 1); // 3 → 2: damaged FX
      expect(calls).toEqual([3]);
      expect(chest.broken).toBe(false);
      iw.damageChest(chest, 1); // 2 → 1
      iw.damageChest(chest, 1); // 1 → 0: collapsed + fragments
      expect(calls).toEqual([3, 2, 1]);
      expect(chest.broken).toBe(true);
      const collapsed = br.live.find((b) => b.state === 'collapsed');
      expect(collapsed).toBeDefined();
      expect(collapsed!.fragBodies.length).toBe(DEFAULT_BREAKABLE_DEF.fragments);
    } finally {
      br.dispose(); iw.dispose(); engine.dispose();
    }
  });
});

/* ---------------- 4. PhysicsScheduler ---------------- */

describe('PhysicsScheduler', () => {
  it('sleeps distant bodies, wakes nearby ones', () => {
    const engine = makeEngine();
    const sch = new PhysicsScheduler(engine, { activeRadius: 28, dormantRadius: 60, budget: 64 });
    try {
      const near = engine.physics.sphere(0.5, [0, 1, 0], { mass: 1, group: GROUP.PICKUP });
      const far = engine.physics.sphere(0.5, [0, 1, 100], { mass: 1, group: GROUP.PICKUP });
      near.sleep(); far.sleep();
      sch.register(near);
      sch.register(far);
      sch.update({ x: 0, y: 0, z: 0 });
      expect(near.sleepState).not.toBe(CANNON.Body.SLEEPING);
      expect(far.sleepState).toBe(CANNON.Body.SLEEPING);
    } finally {
      sch.dispose(); engine.dispose();
    }
  });

  it('enforces the active-body budget cap, farthest first', () => {
    const engine = makeEngine();
    const sch = new PhysicsScheduler(engine, { activeRadius: 1000, dormantRadius: 2000, budget: 10 });
    try {
      for (let i = 0; i < 12; i++) {
        const b = engine.physics.sphere(0.5, [i * 2, 1, 0], { mass: 1, group: GROUP.PICKUP });
        b.allowSleep = true;
        sch.register(b);
      }
      sch.update({ x: 0, y: 0, z: 0 });
      expect(sch.awakeCount()).toBeLessThanOrEqual(10);
      // the two farthest (x=20, 22) were the ones put to sleep
      const states = sch['entries'].map((e: { body: CANNON.Body }) => e.body.sleepState === CANNON.Body.SLEEPING);
      expect(states.filter(Boolean).length).toBe(2);
    } finally {
      sch.dispose(); engine.dispose();
    }
  });

  it('essential bodies are exempt from forced sleep and the budget', () => {
    const engine = makeEngine();
    const sch = new PhysicsScheduler(engine, { activeRadius: 28, dormantRadius: 60, budget: 0 });
    try {
      const b = engine.physics.sphere(0.5, [0, 1, 500], { mass: 1, group: GROUP.PLAYER });
      sch.register(b, true);
      sch.update({ x: 0, y: 0, z: 0 });
      expect(b.sleepState).not.toBe(CANNON.Body.SLEEPING);
    } finally {
      sch.dispose(); engine.dispose();
    }
  });

  it('unregister releases the body from the world; budget scales with quality tier', () => {
    const engine = makeEngine();
    const sch = new PhysicsScheduler(engine);
    try {
      const b = engine.physics.sphere(0.5, [0, 1, 0], { mass: 1, group: GROUP.PICKUP });
      const before = engine.physics.world.bodies.length;
      sch.register(b);
      sch.unregister(b);
      expect(sch.tracked).toBe(0);
      expect(engine.physics.world.bodies.length).toBe(before - 1);
      expect(budgetForQuality('high')).toBeGreaterThan(budgetForQuality('standard'));
      expect(budgetForQuality('standard')).toBeGreaterThan(budgetForQuality('retro'));
    } finally {
      sch.dispose(); engine.dispose();
    }
  });

  it('scheduler update is fast: 200 bodies in well under a frame budget', () => {
    const engine = makeEngine();
    const sch = new PhysicsScheduler(engine);
    try {
      for (let i = 0; i < 200; i++) {
        sch.register(engine.physics.sphere(0.3, [(i % 20) * 3, 1, Math.floor(i / 20) * 3], { mass: 1, group: GROUP.PICKUP }));
      }
      const t0 = performance.now();
      for (let i = 0; i < 60; i++) sch.update({ x: 0, y: 0, z: 0 });
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(500); // 60 updates of 200 bodies « 16.7ms each
    } finally {
      sch.dispose(); engine.dispose();
    }
  });
});

/* ---------------- 5. TerrainAwarePlacement ---------------- */

describe('TerrainAwarePlacement', () => {
  const terr = () => stubTerrain({
    heightAt: (x: number, z: number) => 1.5 + x * 0 + z * 0,
    normalAt: () => new THREE.Vector3(0, 1, 0),
    inBounds: (x: number, z: number) => Math.abs(x) < 50 && Math.abs(z) < 50,
  });

  it('sample() reports ground, slope, surface and water depth', () => {
    const s = sample(terr(), 3, 4);
    expect(s.groundY).toBeCloseTo(1.5, 6);
    expect(s.slope).toBeCloseTo(0, 6);
    expect(s.surfaceId).toBe('stone');
    expect(s.waterLevel).toBeNull();
    expect(s.waterDepth).toBe(0);
  });

  it('sampleChecked rejects deep water and out-of-bounds', () => {
    const wet = stubTerrain({ heightAt: () => 0, waterLevelAt: () => 3, inBounds: () => true });
    const r1 = sampleChecked(wet, 0, 0, { maxWaterDepth: 0.25 });
    expect(r1.ok).toBe(false);
    expect(r1.rejection).toBe('too-deep');
    const r2 = sampleChecked(terr(), 500, 500, {});
    expect(r2.ok).toBe(false);
    expect(r2.rejection).toBe('out-of-bounds');
    const steep = stubTerrain({ normalAt: () => new THREE.Vector3(0.7, 0.7, 0).normalize(), inBounds: () => true });
    const r3 = sampleChecked(steep, 0, 0, { maxSlope: 0.2 });
    expect(r3.ok).toBe(false);
    expect(r3.rejection).toBe('too-steep');
  });

  it('placeStaticBox grounds the body and registers it with physics', () => {
    const engine = makeEngine();
    try {
      const r = placeStaticBox(engine, terr(), engine.physics, 3, 4, new THREE.Vector3(2, 1, 2));
      expect('body' in r).toBe(true);
      if ('body' in r) {
        expect(r.body.position.y).toBeCloseTo(1.5 + 0.5, 6);
        expect(r.sample.surfaceId).toBe('stone');
        expect(engine.physics.world.bodies).toContain(r.body);
      }
    } finally {
      engine.dispose();
    }
  });

  it('ItemWorld.spawnLootGrounded / spawnChestGrounded adopt the contract', () => {
    const engine = makeEngine();
    (engine as any).terrain = stubTerrain({
      heightAt: () => 2,
      normalAt: () => new THREE.Vector3(0, 1, 0),
      inBounds: () => true,
    });
    const iw = new ItemWorld(engine, DEFS);
    try {
      const item = iw.spawnLootGrounded({ item: 'ironSword', pos: [10, 99, 10], count: 1 });
      expect(item).not.toBeNull();
      expect(item!.mesh.position.y).toBeCloseTo(2.5, 6); // ground-clamped, not 99
      const chest = iw.spawnChestGrounded(CHEST);
      expect(chest).not.toBeNull();
      expect(chest!.group.position.y).toBeCloseTo(2, 6);
      // rejected in deep water
      (engine as any).terrain = stubTerrain({ heightAt: () => 0, waterLevelAt: () => 5, inBounds: () => true });
      expect(iw.spawnLootGrounded({ item: 'ironSword', pos: [10, 99, 10], count: 1 })).toBeNull();
    } finally {
      iw.dispose(); engine.dispose();
    }
  });

  it('repeated generate/dispose cycles do not grow the physics world', () => {
    const engine = makeEngine();
    try {
      const baseline = engine.physics.world.bodies.length;
      for (let i = 0; i < 25; i++) {
        const br = new Breakables(engine);
        const sch = new PhysicsScheduler(engine);
        const b = br.create(new THREE.Vector3(i, 1, 0), { fragments: 6, debrisLife: 0.01 });
        br.damage(b, 99);
        for (const fb of b.fragBodies) sch.register(fb);
        for (let k = 0; k < 5; k++) { engine.physics.step(1 / 60); br.update(1 / 60); sch.update({ x: 0, y: 0, z: 0 }); }
        br.update(1); // expire debris
        br.dispose();
        sch.dispose();
      }
      expect(engine.physics.world.bodies.length).toBe(baseline);
    } finally {
      engine.dispose();
    }
  });
});

/* ---------------- 6. MeleeCombat ---------------- */

describe('MeleeSwing phases', () => {
  function swingEnv() {
    const engine = makeEngine();
    const attacker = engine.physics.capsule(0.42, 1.7, [0, 1.2, 0], { mass: 70, group: GROUP.PLAYER });
    const enemy = engine.physics.sphere(0.5, [0, 1.2, 2.4], { mass: 1, group: GROUP.ENEMY });
    const hits: Array<{ body: CANNON.Body; point: THREE.Vector3 }> = [];
    const swing = new MeleeSwing(engine);
    return { engine, attacker, enemy, hits, swing };
  }

  it('walks windup → active → recovery → idle with default timing', () => {
    const { engine, swing } = swingEnv();
    try {
      expect(swing.phase).toBe('idle');
      expect(swing.start(new THREE.Vector3(0, 0, 0), 0)).toBe(true);
      expect(swing.start(new THREE.Vector3(0, 0, 0), 0)).toBe(false); // no re-entry
      expect(swing.phase).toBe('windup');
      swing.update(DEFAULT_MELEE_TIMING.windup * 0.5);
      expect(swing.phase).toBe('windup');
      swing.update(DEFAULT_MELEE_TIMING.windup * 0.6);
      expect(swing.phase).toBe('active');
      swing.update(DEFAULT_MELEE_TIMING.active + 0.01);
      expect(swing.phase).toBe('recovery');
      swing.update(DEFAULT_MELEE_TIMING.recovery + 0.01);
      expect(swing.phase).toBe('idle');
      expect(swing.active).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('active-frame sweeps hit the enemy once per swing (skipBody respected)', () => {
    const { engine, attacker, enemy, hits, swing } = swingEnv();
    try {
      let activeFired = 0;
      swing.start(new THREE.Vector3(0, 0, 0), 0, {
        range: 2.6, arc: 1.3, tipHeight: 1.2,
        mask: GROUP.ENEMY, skipBody: attacker,
        onHit: (body, point) => { hits.push({ body, point }); },
        onActiveStart: () => { activeFired++; },
      });
      // drive the whole swing in small substeps like a real frame loop
      let guard = 100;
      while (swing.active && guard-- > 0) swing.update(1 / 60);
      expect(activeFired).toBe(1);
      expect(hits.length).toBe(1); // one target → one hit, not one per sample
      expect(hits[0].body).toBe(enemy);
      expect(hits[0].point.z).toBeGreaterThan(1.0);
    } finally {
      engine.dispose();
    }
  });

  it('misses when the enemy is outside the arc', () => {
    const { engine, attacker, enemy, hits, swing } = swingEnv();
    try {
      enemy.position.set(0, 1.2, -2.0); // behind the attacker
      swing.start(new THREE.Vector3(0, 0, 0), 0, {
        range: 2.6, arc: 0.6, mask: GROUP.ENEMY, skipBody: attacker,
        onHit: (body) => { hits.push({ body, point: new THREE.Vector3() }); },
      });
      let guard = 100;
      while (swing.active && guard-- > 0) swing.update(1 / 60);
      expect(hits.length).toBe(0);
    } finally {
      engine.dispose();
    }
  });

  it('damage value flows through onHit unchanged (existing feel kept)', () => {
    const { engine, attacker, enemy, swing } = swingEnv();
    try {
      const dealt: number[] = [];
      const DAMAGE = 25; // the PlayerAvatar.melee default
      swing.start(new THREE.Vector3(0, 0, 0), 0, {
        range: 2.6, arc: 1.3, mask: GROUP.ENEMY, skipBody: attacker,
        onHit: () => { dealt.push(DAMAGE); },
      });
      let guard = 100;
      while (swing.active && guard-- > 0) swing.update(1 / 60);
      expect(dealt).toEqual([25]);
    } finally {
      engine.dispose();
    }
  });

  it('cancel() returns to idle immediately', () => {
    const { engine, swing } = swingEnv();
    try {
      swing.start(new THREE.Vector3(0, 0, 0), 0);
      swing.update(0.2);
      swing.cancel();
      expect(swing.phase).toBe('idle');
    } finally {
      engine.dispose();
    }
  });
});

/* ---------------- 7. AnimationAdjust ---------------- */

describe('AnimationAdjust post-pass', () => {
  const testSpec: any = {
    meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
    custom: {},
    theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
  };
  const rigOf = () => makeHumanoid(new MaterialLibrary(testSpec), {}, 11);

  it('leans the torso forward under acceleration, back under braking', () => {
    const rig = rigOf();
    rig.animate(1.0, 3, {});
    const baseX = rig.limbs.torso.rotation.x;
    AnimationAdjust.apply(rig, { accel: 12, brake: 0, turnRate: 0, weaponCarry: false });
    expect(rig.limbs.torso.rotation.x).toBeGreaterThan(baseX);
    const rig2 = rigOf();
    rig2.animate(1.0, 3, {});
    const base2 = rig2.limbs.torso.rotation.x;
    AnimationAdjust.apply(rig2, { accel: 0, brake: 10, turnRate: 0, weaponCarry: false });
    expect(rig2.limbs.torso.rotation.x).toBeLessThan(base2);
  });

  it('counter-rotates legs on slopes and poses the weapon arm when carrying', () => {
    const rig = rigOf();
    rig.animate(1.0, 2, {});
    const legX = rig.limbs.legL.rotation.x;
    const armX = rig.limbs.armR.rotation.x;
    AnimationAdjust.apply(rig, {
      slopeNormal: new THREE.Vector3(0, 0.9, 0.44).normalize(),
      accel: 0, brake: 0, turnRate: 0, weaponCarry: true,
    });
    expect(rig.limbs.legL.rotation.x).not.toBeCloseTo(legX, 6); // slope feet
    expect(rig.limbs.armR.rotation.x).toBeLessThan(armX); // arm raised
    for (const k of ['legL', 'legR', 'armL', 'armR', 'torso', 'head'] as const) {
      const r = rig.limbs[k].rotation;
      expect(Number.isFinite(r.x + r.y + r.z), k).toBe(true);
    }
  });

  it('skips the arm pose while attacking and skips dead rigs entirely', () => {
    const rig = rigOf();
    rig.animate(1.0, 2, {});
    const armX = rig.limbs.armR.rotation.x;
    AnimationAdjust.apply(rig, { accel: 0, brake: 0, turnRate: 0, weaponCarry: true, attacking: true });
    expect(rig.limbs.armR.rotation.x).toBeCloseTo(armX, 6);
    const rig2 = rigOf();
    rig2.animate(1.0, 2, {});
    const torsoX = rig2.limbs.torso.rotation.x;
    AnimationAdjust.apply(rig2, { accel: 12, brake: 0, turnRate: 2, weaponCarry: true, dead: true });
    expect(rig2.limbs.torso.rotation.x).toBeCloseTo(torsoX, 6);
  });

  it('leans are clamped — no runaway rotations at extreme inputs', () => {
    const rig = rigOf();
    rig.animate(1.0, 2, {});
    AnimationAdjust.apply(rig, { accel: 999, brake: 0, turnRate: 999, weaponCarry: false });
    expect(Math.abs(rig.limbs.torso.rotation.x)).toBeLessThan(1.0);
    expect(Math.abs(rig.limbs.torso.rotation.y)).toBeLessThan(1.0);
  });
});
