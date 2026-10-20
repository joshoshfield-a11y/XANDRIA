/**
 * Portal-backlog wave — LandmarkSystem (map-local landmark lifecycle).
 *
 * 1. Determinism: same mapSeed → identical placed roster (kind + position),
 *    across despawn/respawn cycles.
 * 2. Departure hygiene: despawnAll() returns scene children + physics bodies
 *    to the pre-spawn baseline; double-despawn is a no-op.
 * 3. Wear-point guard: spawning twice on the SAME Terrain instance (the LRU
 *    cache-hit path) does not duplicate wear discs (addWearPoints appends).
 * 4. Racing-adapter evaluation (kept inactive BY DESIGN): the generator never
 *    enables portals for racing (even 8000m rally) — pin it.
 *
 * Real Engine + real Terrain, DOM/WebGL stubbed (same pattern as
 * portal-crossmap.test.ts); no GL calls.
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
      id: '',
      value: '',
      checked: false,
      innerHTML: '',
      appendChild(c: any) { c.parent = el; el.children.push(c); return c; },
      append(...cs: any[]) { for (const c of cs) { c.parent = el; el.children.push(c); } },
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
    info: any = {
      autoReset: true,
      render: { calls: 0, frame: 0, lines: 0, points: 0, triangles: 0 },
      memory: { geometries: 0, textures: 0 },
      programs: null,
      reset() { this.render.calls = 0; this.render.triangles = 0; this.render.points = 0; this.render.lines = 0; },
    };
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

import { Engine } from '../src/engine/Engine';
import { LandmarkSystem } from '../src/engine/world/LandmarkSystem';
import { generateSpec } from '../src/generator/generate';
import { portalsEnabled } from '../src/spec/schema';
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
    body: makeEl('body'),
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
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

function makeEngine(): Engine {
  const s = generateSpec('a heroic knight adventure', { seed: 77000 });
  s.world.terrain.size = 2000;
  s.world.terrain.type = 'mountains' as any;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, s, { testMode: true });
  engine.state = 'playing';
  return engine;
}

/** stable digest of the placed roster: kind + quantized positions */
function digest(sys: LandmarkSystem): string {
  return sys.placed
    .map((p) => `${p.kind}@${p.pos.x.toFixed(2)},${p.pos.z.toFixed(2)}`)
    .sort()
    .join('|');
}

function wearDiscCount(engine: Engine): number {
  return ((engine.terrain as any).wearDiscs as unknown[]).length;
}

describe('LandmarkSystem — map-local landmark lifecycle', () => {
  it('spawns a non-empty deterministic roster; same seed → identical digest', () => {
    const engine = makeEngine();
    const sys = new LandmarkSystem(engine, { exclusion: [{ x: 0, z: 0, r: 12 }] });
    engine.portalEntities.register(sys);

    sys.spawnForMap(77000);
    expect(sys.placed.length).toBeGreaterThan(0);
    const first = digest(sys);
    const draws = sys.drawCalls();
    expect(draws).toBeGreaterThan(0);

    // rebuild from the same seed → identical roster
    sys.spawnForMap(77000);
    expect(digest(sys)).toBe(first);
    expect(sys.drawCalls()).toBe(draws);
  });

  it('different seeds (very likely) diverge; digest differs', () => {
    const engine = makeEngine();
    const sys = new LandmarkSystem(engine, { exclusion: [{ x: 0, z: 0, r: 12 }] });
    sys.spawnForMap(77000);
    const a = digest(sys);
    sys.spawnForMap(12345678);
    const b = digest(sys);
    expect(a).not.toBe(b);
  });

  it('despawnAll returns scene + physics to baseline; double-despawn is a no-op', () => {
    const engine = makeEngine();
    const bodies0 = engine.physics.world.bodies.length;
    const scene0 = engine.scene.children.length;

    const sys = new LandmarkSystem(engine, { exclusion: [{ x: 0, z: 0, r: 12 }] });
    sys.spawnForMap(77000);
    expect(engine.physics.world.bodies.length).toBeGreaterThan(bodies0);
    expect(engine.scene.children.length).toBeGreaterThan(scene0);
    expect(sys.drawCalls()).toBeGreaterThan(0);

    sys.despawnAll();
    expect(engine.physics.world.bodies.length).toBe(bodies0);
    expect(engine.scene.children.length).toBe(scene0);
    expect(sys.drawCalls()).toBe(0);
    expect(sys.placed).toEqual([]);

    // second call: no-op, never an error
    expect(() => sys.despawnAll()).not.toThrow();
    expect(engine.physics.world.bodies.length).toBe(bodies0);
    expect(engine.scene.children.length).toBe(scene0);
  });

  it('respawn after despawn reproduces the identical roster', () => {
    const engine = makeEngine();
    const sys = new LandmarkSystem(engine, { exclusion: [{ x: 0, z: 0, r: 12 }] });
    sys.spawnForMap(77000);
    const first = digest(sys);
    sys.despawnAll();
    sys.spawnForMap(77000);
    expect(digest(sys)).toBe(first);
  });

  it('wear-point bake is not duplicated on same-terrain respawn (LRU-hit guard)', () => {
    const engine = makeEngine();
    const sys = new LandmarkSystem(engine, { exclusion: [{ x: 0, z: 0, r: 12 }] });
    const wear0 = wearDiscCount(engine);
    sys.spawnForMap(77000);
    const wear1 = wearDiscCount(engine);
    expect(wear1).toBeGreaterThanOrEqual(wear0);
    // second spawn on the SAME Terrain instance (cache-hit arrival) must not
    // append the same discs again — addWearPoints is not idempotent
    sys.spawnForMap(77000);
    expect(wearDiscCount(engine)).toBe(wear1);
  });

  it('registry order: spawnForMap/despawnAll flow through engine.portalEntities', () => {
    const engine = makeEngine();
    const sys = new LandmarkSystem(engine, { exclusion: [{ x: 0, z: 0, r: 12 }] });
    engine.portalEntities.register(sys);
    expect(engine.portalEntities.ids()).toContain('landmarks');
    const bodies0 = engine.physics.world.bodies.length;
    engine.portalEntities.spawnForMap(77000);
    expect(sys.placed.length).toBeGreaterThan(0);
    engine.portalEntities.despawnAll();
    expect(engine.physics.world.bodies.length).toBe(bodies0);
    expect(sys.placed).toEqual([]);
  });
});

describe('racing portal adapter — evaluation (kept inactive by design)', () => {
  it('generator never enables portals for racing (closed-loop track)', () => {
    const race = generateSpec('race cars on a desert track', { seed: 42 });
    expect(race.meta.genre).toBe('racing');
    expect(portalsEnabled(race)).toBe(false);
  });

  it('generator never enables portals for rally either (8000m rally keeps walls)', () => {
    const rally = generateSpec('an epic desert rally raid', { seed: 42 });
    expect(rally.meta.genre).toBe('racing');
    expect(portalsEnabled(rally)).toBe(false);
  });

  it('open-world third-person-action still gets portals (no regression)', () => {
    const tpa = generateSpec('a vast open world sword adventure', { seed: 42 });
    expect(portalsEnabled(tpa)).toBe(true);
  });
});
