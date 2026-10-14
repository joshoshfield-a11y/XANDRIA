/**
 * Workstream E — perf instrumentation tests (instrumentation ONLY, no adaptive quality):
 *  E1  engine.perf exists on every Engine with all counters zeroed at boot
 *  E2  counters update across frames (frames/frameMs/physicsMs advance)
 *  E3  renderer.info integration: draw calls / triangles / geometries /
 *      textures / programs are read from the GL info object; the constructor
 *      switches info.autoReset off (documented three.js multi-pass pattern)
 *  E4  disabled monitor: zero state change, counters stay 0 (cheap = one branch)
 *  E5  PerfMonitor rolling math is exact (mean + population variance)
 *  E6  reset() clears counters; Engine.resetRun() starts a fresh measurement window
 *  E7  opt-in debug overlay (?perfoverlay=1 / setPerfOverlayVisible) shows live numbers
 *  E8  snapshot() returns a detached plain-object copy
 *
 * WebGLRenderer is stubbed (with a fake info object) and engine.postfx is
 * replaced with a no-op that populates info like a real render would, so
 * step() never touches GL. DOM is hand-stubbed (no jsdom) — same pattern as
 * engine.test.ts.
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
        const l = listeners[t];
        if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
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
    /** fake of three's WebGLInfo shape (r182: programs is an array after render, null before) */
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

import * as THREE from 'three';
import { Engine } from '../src/engine/Engine';
import { PerfMonitor } from '../src/engine/core/Perf';
import { generateSpec } from '../src/generator/generate';
import { _setProfileStorage } from '../src/engine/game/Profile';
import type { GameSpec } from '../src/spec/schema';

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
});

function makeEngine(spec?: GameSpec): Engine {
  const s = spec ?? generateSpec('neon fps arena at night', { seed: 42 });
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, s, { testMode: true, noTerrain: true });
  // unit tests never touch GL: the fake render populates info the way a real
  // frame would (after Engine's per-frame info.reset()).
  (engine as any).postfx = {
    render() {
      const info = (engine as any).renderer.info;
      if (!info) return; // E3: engine must tolerate info-less renderer stubs
      info.render.calls = 37;
      info.render.triangles = 1234;
      info.memory.geometries = 12;
      info.memory.textures = 5;
      info.programs = [{}, {}, {}];
    },
    resize() {},
    dispose() {},
  };
  return engine;
}

function stepFrames(engine: Engine, n: number) {
  engine.state = 'playing';
  for (let i = 0; i < n; i++) engine.step(1 / 60);
}

/* ---------------- E1: shape ---------------- */

describe('E1 engine.perf shape', () => {
  it('exposes every counter, all zeroed at boot', () => {
    const engine = makeEngine();
    const p = engine.perf;
    expect(p).toBeInstanceOf(PerfMonitor);
    expect(p.enabled).toBe(true);
    for (const k of ['frameMs', 'frameMsVariance', 'fps', 'drawCalls', 'triangles',
      'geometries', 'textures', 'programs', 'physicsMs', 'frames'] as const) {
      expect(p[k], k).toBe(0);
    }
  });
});

/* ---------------- E2: counters advance ---------------- */

describe('E2 counters update across frames', () => {
  it('frames/frameMs/physicsMs advance over stepped frames', () => {
    const engine = makeEngine();
    stepFrames(engine, 10);
    const p = engine.perf;
    expect(p.frames).toBe(10);
    expect(p.frameMs).toBeGreaterThanOrEqual(0);
    expect(p.frameMs).toBeLessThan(1000); // headless stub: step() is fast
    expect(Number.isFinite(p.frameMsVariance)).toBe(true);
    expect(p.frameMsVariance).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(p.fps)).toBe(true);
    expect(p.physicsMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(p.physicsMs)).toBe(true);
  });
});

/* ---------------- E3: renderer.info ---------------- */

describe('E3 renderer.info integration', () => {
  it('switches info.autoReset off in the constructor (multi-pass pattern)', () => {
    const engine = makeEngine();
    expect((engine as any).renderer.info.autoReset).toBe(false);
  });

  it('reads draw calls / triangles / memory / programs from renderer.info', () => {
    const engine = makeEngine();
    stepFrames(engine, 3);
    const p = engine.perf;
    expect(p.drawCalls).toBe(37);
    expect(p.triangles).toBe(1234);
    expect(p.geometries).toBe(12);
    expect(p.textures).toBe(5);
    expect(p.programs).toBe(3);
  });

  it('tolerates a renderer with no info object (unit-test stubs)', () => {
    const engine = makeEngine();
    delete (engine as any).renderer.info;
    expect(() => stepFrames(engine, 3)).not.toThrow();
    expect(engine.perf.frames).toBe(3); // frame timing still works
    expect(engine.perf.drawCalls).toBe(0);
  });
});

/* ---------------- E4: disabled ---------------- */

describe('E4 disabled monitor is zero/cheap', () => {
  it('step() leaves every counter at 0 when enabled=false', () => {
    const engine = makeEngine();
    engine.perf.enabled = false;
    stepFrames(engine, 5);
    const p = engine.perf;
    expect(p.frames).toBe(0);
    expect(p.frameMs).toBe(0);
    expect(p.frameMsVariance).toBe(0);
    expect(p.drawCalls).toBe(0);
    expect(p.physicsMs).toBe(0);
    // re-enabling resumes sampling immediately
    engine.perf.enabled = true;
    engine.step(1 / 60);
    expect(engine.perf.frames).toBe(1);
  });

  it('PerfMonitor.sample() is a no-op when disabled', () => {
    const m = new PerfMonitor();
    m.enabled = false;
    m.sample(16.7, 1.2, {
      render: { calls: 5, triangles: 50 },
      memory: { geometries: 1, textures: 2 },
      programs: [],
    });
    expect(m.frames).toBe(0);
    expect(m.frameMs).toBe(0);
    expect(m.drawCalls).toBe(0);
  });
});

/* ---------------- E5: rolling math ---------------- */

describe('E5 rolling mean/variance math', () => {
  it('computes exact mean and population variance', () => {
    const m = new PerfMonitor();
    for (const v of [10, 20, 10, 20]) m.sample(v, 0);
    expect(m.frames).toBe(4);
    expect(m.frameMs).toBeCloseTo(15, 10);
    expect(m.frameMsVariance).toBeCloseTo(25, 10); // population variance of {10,20,10,20}
    expect(m.fps).toBeCloseTo(1000 / 15, 10);
  });

  it('constant samples give zero variance', () => {
    const m = new PerfMonitor();
    for (let i = 0; i < 10; i++) m.sample(16, 0);
    expect(m.frameMs).toBeCloseTo(16, 10);
    expect(m.frameMsVariance).toBe(0);
  });

  it('is allocation-free in the hot path (no observable state beyond the ring)', () => {
    const m = new PerfMonitor();
    const before = (m as any).samples;
    m.sample(16.7, 0.5);
    expect((m as any).samples).toBe(before); // same preallocated buffer
    expect((m as any).samples).toBeInstanceOf(Float64Array);
  });
});

/* ---------------- E6: reset ---------------- */

describe('E6 reset', () => {
  it('PerfMonitor.reset() zeroes every counter and the window', () => {
    const m = new PerfMonitor();
    for (const v of [10, 20, 30]) m.sample(v, 1);
    expect(m.frames).toBe(3);
    m.reset();
    expect(m.frames).toBe(0);
    expect(m.frameMs).toBe(0);
    expect(m.frameMsVariance).toBe(0);
    expect(m.fps).toBe(0);
    expect(m.drawCalls).toBe(0);
    expect(m.physicsMs).toBe(0);
    m.sample(16, 0);
    expect(m.frameMs).toBeCloseTo(16, 10); // window was cleared, not polluted
  });

  it('Engine.resetRun() starts a fresh measurement window', () => {
    const engine = makeEngine();
    engine.setRunBuilder(() => ({}));
    stepFrames(engine, 4);
    expect(engine.perf.frames).toBe(4);
    (engine as any).resetRun();
    expect(engine.perf.frames).toBe(0);
    expect(engine.perf.frameMs).toBe(0);
    expect(engine.perf.frameMsVariance).toBe(0);
  });
});

/* ---------------- E7: overlay ---------------- */

describe('E7 debug overlay', () => {
  it('is hidden by default and toggles on/off without duplicating', () => {
    const engine = makeEngine();
    const body = (globalThis as any).document.body;
    const found = () => body.children.filter((c: any) => c.id === 'xandria-perf-overlay');
    expect(found().length).toBe(0);

    engine.setPerfOverlayVisible(true);
    engine.setPerfOverlayVisible(true); // idempotent
    expect(found().length).toBe(1);

    stepFrames(engine, 12); // overlay refreshes every 10 frames
    const text: string = found()[0].textContent;
    expect(text).toContain('frame');
    expect(text).toContain('physics');
    expect(text).toContain('draws 37');

    engine.setPerfOverlayVisible(false);
    engine.setPerfOverlayVisible(false); // idempotent
    expect(found().length).toBe(0);
    expect((engine as any).perfOverlayEl).toBeNull();
  });
});

/* ---------------- E8: snapshot ---------------- */

describe('E8 snapshot()', () => {
  it('returns a detached plain object with the current counters', () => {
    const engine = makeEngine();
    stepFrames(engine, 5);
    const s = engine.perf.snapshot();
    expect(s.frames).toBe(5);
    expect(s.drawCalls).toBe(37);
    expect(typeof s.frameMs).toBe('number');
    // detached: mutating the snapshot does not touch the monitor
    s.frameMs = -999;
    expect(engine.perf.frameMs).not.toBe(-999);
    expect(JSON.parse(JSON.stringify(s)).frames).toBe(5);
  });
});

/* ---------------- B: streaming counters wiring (stage-1 workstream B) ---------------- */

describe('B streaming counters wiring', () => {
  function makeEngineWithTerrain(): Engine {
    const s = generateSpec('neon fps arena at night', { seed: 42 });
    s.world.terrain.size = 1200;
    const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
    const engine = new Engine(container, s, { testMode: true });
    (engine as any).postfx = {
      render() {
        const info = (engine as any).renderer.info;
        if (!info) return;
        info.render.calls = 37;
        info.render.triangles = 1234;
        info.memory.geometries = 12;
        info.memory.textures = 5;
        info.programs = [{}, {}, {}];
      },
      resize() {},
      dispose() {},
    };
    return engine;
  }

  it('terrain.update runs every Engine.step and feeds perf.sampleStream', () => {
    const engine = makeEngineWithTerrain();
    try {
      stepFrames(engine, 5);
      const ss = engine.terrain.getStreamStats();
      expect(ss.loaded).toBeGreaterThan(0);
      expect(engine.perf.chunksLoaded).toBe(ss.loaded);
      expect(engine.perf.chunkBuildMs).toBe(ss.buildMs);
      expect(engine.perf.streamQueue).toBe(ss.queue);
      expect(engine.perf.snapshot().chunksLoaded).toBe(ss.loaded);
    } finally {
      engine.dispose();
    }
  });

  it('streamFocus override steers the streaming focus', () => {
    const engine = makeEngineWithTerrain();
    try {
      engine.state = 'playing';
      // park the focus in the far corner; drain the budget queue
      engine.streamFocus = new THREE.Vector3(590, 0, 590);
      for (let i = 0; i < 60; i++) engine.step(1 / 60);
      expect(engine.perf.streamQueue).toBe(0);
      expect(engine.terrain.getChunkStats().chunkCount).toBe(25);
      // (590,590) sits in chunk (4,4) -> must be resident
      expect(engine.terrain.isChunkLoaded(4, 4)).toBe(true);
      expect(engine.perf.chunksLoaded).toBe(engine.terrain.getStreamStats().loaded);
    } finally {
      engine.dispose();
    }
  });
});
