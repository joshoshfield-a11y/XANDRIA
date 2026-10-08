/**
 * R2-M1 regression tests: the daily challenge must actually use the daily seed.
 *
 *  - startDailyRun() rebuilds the terrain from the daily seed (not the base seed)
 *  - attempt 1 and an in-place restart (attempt 2) produce the IDENTICAL world:
 *    same terrain samples + same spawn positions
 *  - two independent engines on the same day generate the identical daily world
 *  - toTitle() restores the base-game terrain; normal startRun() is untouched
 *
 * Same hand-stubbed DOM / stubbed WebGLRenderer harness as engine.test.ts.
 * Terrain is real here (no `noTerrain`): Terrain is pure three.js + cannon-es.
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

import { Engine } from '../src/engine/Engine';
import { generateSpec } from '../src/generator/generate';
import {
  _setProfileStorage,
  dailySeed,
  todayLocalDate,
} from '../src/engine/game/Profile';
import type { GameSpec } from '../src/spec/schema';

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

/** Deterministic run builder: records rng-driven "spawn" positions per attempt. */
function makeDailyEngine(seed = 42): { engine: Engine; spec: GameSpec; spawns: number[][] } {
  const spec = generateSpec('neon fps arena at night', { seed });
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, spec, { testMode: true }); // terrain ON
  (engine as any).postfx = { render() {}, resize() {}, dispose() {} };
  const spawns: number[][] = [];
  engine.setRunBuilder((e) => {
    spawns.length = 0;
    for (let i = 0; i < 6; i++) spawns.push([e.rng.range(-100, 100), e.rng.range(-100, 100)]);
    return {};
  });
  return { engine, spec, spawns };
}

function sampleTerrain(e: Engine): number[] {
  const pts: number[] = [];
  for (const x of [-80, -40, 0, 40, 80])
    for (const z of [-80, -40, 0, 40, 80]) pts.push(e.terrain.heightAt(x, z));
  return pts;
}

describe('R2-M1 daily challenge uses the daily seed', () => {
  it('startDailyRun rebuilds terrain from the daily seed; restart keeps the identical world', () => {
    const { engine, spec, spawns } = makeDailyEngine();
    const baseTerrain = sampleTerrain(engine);
    expect(spec.meta.seed).toBe(42);

    (engine as any).state = 'title';
    engine.startDailyRun();

    const expected = dailySeed(todayLocalDate());
    expect(spec.meta.seed).toBe(expected);
    expect(expected).not.toBe(42);

    const dailyTerrain = sampleTerrain(engine);
    expect(dailyTerrain).not.toEqual(baseTerrain); // the world actually changed
    expect(spawns).toHaveLength(6);
    const attempt1 = spawns.map((s) => [...s]);

    engine.restart(); // in-place restart = attempt 2 of the same daily run
    expect(engine.state).toBe('playing');
    expect(sampleTerrain(engine)).toEqual(dailyTerrain); // same terrain
    expect(spawns).toEqual(attempt1); // same spawns

    engine.toTitle(); // leaving the daily behind restores the base game
    expect(spec.meta.seed).toBe(42);
    expect(sampleTerrain(engine)).toEqual(baseTerrain);
  });

  it('two independent engines on the same day generate the identical daily world', () => {
    const a = makeDailyEngine();
    const b = makeDailyEngine();
    (a.engine as any).state = 'title';
    a.engine.startDailyRun();
    (b.engine as any).state = 'title';
    b.engine.startDailyRun();
    expect(a.spec.meta.seed).toBe(b.spec.meta.seed);
    expect(sampleTerrain(a.engine)).toEqual(sampleTerrain(b.engine));
    expect(a.spawns).toEqual(b.spawns);
  });

  it('normal startRun still uses the base seed and base terrain', () => {
    const { engine, spec } = makeDailyEngine();
    const baseTerrain = sampleTerrain(engine);
    (engine as any).state = 'title';
    engine.startRun();
    expect(spec.meta.seed).toBe(42);
    expect(sampleTerrain(engine)).toEqual(baseTerrain);
    // no pointless rebuild: the terrain object is untouched in the normal flow
    const terrainBefore = (engine as any).terrain;
    engine.toTitle();
    (engine as any).state = 'title';
    engine.startRun();
    expect((engine as any).terrain).toBe(terrainBefore);
  });
});
