/**
 * Graphics wave 2 (workstream E) — perf-tier regression tests.
 *
 * - PerformanceManager.resolveTier precedence (settings > engine opt >
 *   ?tier= > spec.custom.tier > auto-detect)
 * - Tier flag tables: s25 is the tuned-down profile; densityMul=1 on s25
 * - scaleBudget/scaleCount: 1.0 is the identity (byte-identical pre-tier path)
 * - Chunked scatter: densityMul=1.0 placement is identical to the default
 *   path; desktop densityMul never changes the POOL SET (draw-call parity)
 * - Engine boots with a resolved tier; ?tier= is honored
 * - validateSpec: custom.tier range-checked
 * - Settings: tier persists and round-trips
 *
 * DOM is stubbed (no jsdom here) — same pattern as chunk-scatter.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';

// WebGLRenderer is stubbed — engine tier tests never touch GL (same pattern
// as tests/engine.test.ts).
const { FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const listeners: Record<string, Function[]> = {};
    const el: any = {
      tag, children: [] as any[], style: {} as Record<string, string>,
      appendChild(c: any) { el.children.push(c); return c; },
      addEventListener(t: string, fn: Function) { (listeners[t] ??= []).push(fn); },
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      querySelector() { return makeEl(); },
      querySelectorAll() { return []; },
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
    };
    return el;
  }
  class FakeWebGLRenderer {
    domElement: any;
    shadowMap = { enabled: false, type: 0 };
    toneMapping = 0; toneMappingExposure = 1;
    info: any = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: null, autoReset: true, reset() {} };
    constructor() { this.domElement = makeEl('canvas'); }
    setPixelRatio() {}
    setSize() {}
    getPixelRatio() { return 1; }
    getSize() { return { width: 800, height: 600 }; }
    dispose() {}
    render() {}
  }
  return { FakeWebGLRenderer };
});
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});
import { validateSpec } from '../src/spec/schema';
import { generateSpec } from '../src/generator/generate';
import {
  PerformanceManager, TIER_FLAGS, scaleBudget, scaleCount,
  type PerfTier,
} from '../src/engine/core/PerformanceManager';
import { Settings } from '../src/engine/game/Settings';
import { Scatter } from '../src/engine/world/Scatter';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Engine } from '../src/engine/Engine';

function makeEl(tag = 'div'): any {
  const listeners: Record<string, Function[]> = {};
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as Record<string, string>,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    textContent: '',
    innerHTML: '',
    appendChild(c: any) { el.children.push(c); return c; },
    append(...cs: any[]) { for (const c of cs) el.children.push(c); },
    setAttribute() {},
    addEventListener(t: string, fn: Function) { (listeners[t] ??= []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
  };
  return el;
}

function memStore(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as Storage;
}

beforeEach(() => {
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head: makeEl('head'),
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as any).localStorage = memStore();
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1;
  (globalThis as any).innerWidth = 1280;
  (globalThis as any).innerHeight = 720;
});

function settingsWith(tier: 'auto' | 'desktop' | 's25') {
  return { data: { volume: 0.8, muted: false, quality: 'auto' as const, tier, floatingText: true, musicEnabled: true, sfxEnabled: true, musicVolume: 0.8, sfxVolume: 0.8 } };
}

function baseSpec() {
  const spec: any = generateSpec('a heroic knight adventure', { seed: 4242 });
  spec.world.terrain.size = 2000;
  spec.world.terrain.type = 'hills';
  spec.world.portals = { enabled: false };
  spec.world.scatter.trees = true;
  return spec;
}

describe('PerformanceManager.resolveTier', () => {
  it('player setting wins over everything', () => {
    const spec: any = baseSpec();
    spec.custom = { tier: 'desktop' };
    const t = PerformanceManager.resolveTier(spec, settingsWith('s25'), { tierParam: 'desktop' });
    expect(t).toBe('s25');
  });
  it('engine opt beats ?tier= and spec.custom.tier', () => {
    const spec: any = baseSpec();
    spec.custom = { tier: 's25' };
    const pm = new PerformanceManager(spec, settingsWith('auto'), { tierParam: 'desktop', autoTier: 's25' });
    // tierParam (?tier=) is the harness seam — explicit engine opt not passed
    // here, so ?tier=desktop wins over spec.custom.tier=s25
    expect(pm.tier).toBe('desktop');
  });
  it('spec.custom.tier beats auto-detect', () => {
    const spec: any = baseSpec();
    spec.custom = { tier: 's25' };
    expect(PerformanceManager.resolveTier(spec, settingsWith('auto'), {})).toBe('s25');
  });
  it('auto-detect falls back to desktop headless (no matchMedia)', () => {
    const spec: any = baseSpec();
    expect(PerformanceManager.resolveTier(spec, settingsWith('auto'), {})).toBe('desktop');
  });
  it('tierParamFromSearch parses ?tier=', () => {
    expect(PerformanceManager.tierParamFromSearch('?test=1&tier=s25')).toBe('s25');
    expect(PerformanceManager.tierParamFromSearch('?tier=desktop')).toBe('desktop');
    expect(PerformanceManager.tierParamFromSearch('?tier=bogus')).toBeNull();
    expect(PerformanceManager.tierParamFromSearch('')).toBeNull();
  });
});

describe('tier flag tables', () => {
  it('s25 is the tuned-down profile of the same build', () => {
    const d = TIER_FLAGS.desktop;
    const s = TIER_FLAGS.s25;
    expect(s.densityMul).toBe(1);
    expect(s.windMul).toBeLessThan(d.windMul);
    expect(d.windMul).toBe(1); // desktop = the authored sway, byte-identical ALU
    // E integration (workstream A): tier ground-detail floor
    expect(d.detailQuality).toBe('high');
    expect(s.detailQuality).toBe('retro');
    // E integration (workstream C diet): s25 disables structure shadows
    expect(d.structureShadows).toBe(true);
    expect(s.structureShadows).toBe(false);
    expect(s.shadowMapSize).toBeLessThanOrEqual(d.shadowMapSize);
    expect(s.pixelRatioCap).toBeLessThanOrEqual(d.pixelRatioCap);
    expect(s.maxRealLights).toBeLessThanOrEqual(d.maxRealLights);
    expect(s.bloomBoost).toBeLessThanOrEqual(d.bloomBoost);
    expect(s.shadows).toBe(true); // shadows stay real-time on both tiers
  });
  it('desktop gets the denser build without new draw calls (flags only)', () => {
    expect(TIER_FLAGS.desktop.densityMul).toBeGreaterThan(1);
    expect(TIER_FLAGS.desktop.maxRealLights).toBeGreaterThan(TIER_FLAGS.s25.maxRealLights);
  });
});

describe('scaleBudget / scaleCount', () => {
  it('1.0 is the identity', () => {
    for (const n of [0, 1, 48, 96, 128, 500, 6400]) {
      expect(scaleBudget(n, 1)).toBe(n);
      expect(scaleCount(n, 1)).toBe(n);
    }
  });
  it('scales up and stays integral', () => {
    expect(scaleBudget(96, 1.5)).toBe(144);
    expect(scaleCount(70, 1.5)).toBe(105);
    expect(scaleBudget(0, 1.5)).toBe(1); // pools never collapse to zero
  });
});

function buildScatter(densityMul?: number) {
  const spec = baseSpec();
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  const scatter = new Scatter(spec, terrain, mats, physics, scene, {
    quality: 'retro',
    densityMul,
  });
  return scatter;
}

describe('chunked scatter density tiers', () => {
  it('densityMul=1.0 is byte-identical to the default path', () => {
    const a = buildScatter();
    const b = buildScatter(1.0);
    a.chunked!.loadChunk(4, 4);
    b.chunked!.loadChunk(4, 4);
    expect(a.chunked!.chunkCounts(4, 4)).toEqual(b.chunked!.chunkCounts(4, 4));
    for (const key of Object.keys(a.chunked!.setBudgets())) {
      const ma = a.chunked!.chunkMatrices(key, 4, 4);
      const mb = b.chunked!.chunkMatrices(key, 4, 4);
      expect(mb).not.toBeNull();
      expect(ma).not.toBeNull();
      expect(Array.from(ma!)).toEqual(Array.from(mb!));
    }
    expect(a.chunked!.residentInstances).toBe(b.chunked!.residentInstances);
  });

  it('desktop densityMul scales instance counts but NOT the pool set', () => {
    const s25 = buildScatter(TIER_FLAGS.s25.densityMul);
    const desk = buildScatter(TIER_FLAGS.desktop.densityMul);
    // same pools exist on both tiers (draw-call parity by construction)
    expect(Object.keys(desk.chunked!.setBudgets()).sort())
      .toEqual(Object.keys(s25.chunked!.setBudgets()).sort());
    expect(desk.chunked!.sets.length).toBe(s25.chunked!.sets.length);
    s25.chunked!.loadChunk(4, 4);
    desk.chunked!.loadChunk(4, 4);
    const cs = s25.chunked!.chunkCounts(4, 4);
    const cd = desk.chunked!.chunkCounts(4, 4);
    // desktop holds >= instances per set, within the scaled budgets
    for (const key of Object.keys(cd)) {
      expect(cd[key]).toBeGreaterThanOrEqual(cs[key] ?? 0);
      expect(cd[key]).toBeLessThanOrEqual(desk.chunked!.setBudgets()[key]);
    }
    expect(desk.chunked!.residentInstances).toBeGreaterThanOrEqual(s25.chunked!.residentInstances);
  });

  it('vegetation + grass pools scale with the tier (same mesh count)', () => {
    const s25 = buildScatter(TIER_FLAGS.s25.densityMul);
    const desk = buildScatter(TIER_FLAGS.desktop.densityMul);
    s25.chunked!.loadChunk(4, 4);
    desk.chunked!.loadChunk(4, 4);
    // vegetation tier meshes: same count of InstancedMeshes (draw calls flat)
    const vmeshes = (s: Scatter) => {
      const out: THREE.InstancedMesh[] = [];
      s.chunked!.vegetation && (s.chunked!.vegetation as any).tiers.forEach((t: any) => out.push(t.mesh));
      return out;
    };
    expect(vmeshes(desk).length).toBe(vmeshes(s25).length);
    // desktop capacities are larger (denser forests fit)
    for (let i = 0; i < vmeshes(desk).length; i++) {
      expect(vmeshes(desk)[i].instanceMatrix.count)
        .toBeGreaterThanOrEqual(vmeshes(s25)[i].instanceMatrix.count);
    }
  });
});

describe('Engine tier wiring', () => {
  function makeEngine(tier?: PerfTier) {
    const spec: any = baseSpec();
    const container: any = { ...makeEl('div'), clientWidth: 1280, clientHeight: 720 };
    return new Engine(container, spec, { testMode: true, noTerrain: true, tier });
  }
  it('explicit engine opt tier wins', () => {
    const e = makeEngine('s25');
    expect(e.tiers.tier).toBe('s25');
    expect(e.tiers.flags.densityMul).toBe(1);
  });
  it('headless default resolves desktop (documented)', () => {
    const e = makeEngine();
    expect(e.tiers.tier).toBe('desktop');
    expect(e.tiers.flags).toBe(TIER_FLAGS.desktop);
  });
  it('spec.custom.tier is honored by the engine', () => {
    const spec: any = baseSpec();
    spec.custom = { tier: 's25' };
    const container: any = { ...makeEl('div'), clientWidth: 1280, clientHeight: 720 };
    const e = new Engine(container, spec, { testMode: true, noTerrain: true });
    expect(e.tiers.tier).toBe('s25');
  });
  it('detailQualityForTier: desktop floor (max) / s25 ceiling (min) — F3 2026-10-22', () => {
    const de = makeEngine('desktop');
    expect(de.detailQualityForTier('retro')).toBe('high');
    expect(de.detailQualityForTier('standard')).toBe('high');
    expect(de.detailQualityForTier('high')).toBe('high');
    const se = makeEngine('s25');
    // QA 2026-10-22 (F3): pre-fix this pinned max-semantics on s25 too
    // ('standard'→'standard', 'high'→'high'), which is exactly the defect —
    // quality=high silently defeated the s25 detail cap. The tier is now a
    // ceiling on mobile: nothing exceeds the tier's 'retro' detail level.
    expect(se.detailQualityForTier('retro')).toBe('retro');
    expect(se.detailQualityForTier('standard')).toBe('retro');
    expect(se.detailQualityForTier('high')).toBe('retro');
  });
});

describe('spec validation: custom.tier', () => {
  it('accepts desktop/s25', () => {
    for (const tier of ['desktop', 's25'] as const) {
      const spec: any = baseSpec();
      spec.custom = { tier };
      expect(validateSpec(spec).ok).toBe(true);
    }
  });
  it('rejects unknown tiers', () => {
    const spec: any = baseSpec();
    spec.custom = { tier: 'ultra' };
    const v = validateSpec(spec);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('custom.tier');
  });
});

describe('Settings tier', () => {
  it('persists and round-trips', () => {
    const s = new Settings();
    expect(s.data.tier).toBe('auto');
    s.set({ tier: 's25' });
    expect(s.data.tier).toBe('s25');
    const s2 = new Settings();
    expect(s2.data.tier).toBe('s25');
  });
  it('rejects garbage', () => {
    const s = new Settings();
    s.set({ tier: 'bogus' as any });
    expect(s.data.tier).toBe('auto');
  });
});
