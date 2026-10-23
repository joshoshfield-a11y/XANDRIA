/**
 * QA fix wave 2026-10-22 (phone-playability), F3(a) — tier-as-ceiling.
 *
 * Pre-fix, tier and quality combined with max-semantics (tier = floor), so
 * on the s25 tier a quality=high spec silently defeated three tier caps:
 * shadow map forced to 2048, ground micro-detail at full strength, PostFX
 * MSAA at 4 samples. On mobile tiers the tier now CAPS those values;
 * desktop semantics are unchanged (floor), which the control cases pin.
 *
 * DOM/WebGL stubbed exactly like tests/perf-tiers.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { generateSpec } from '../src/generator/generate';
import * as THREE from 'three';
import { Scatter } from '../src/engine/world/Scatter';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import {
  TIER_FLAGS, tierShadowMapSize, tierDetailQuality, tierMsaaSamples, type PerfTier,
} from '../src/engine/core/PerformanceManager';
import { groundDetailUniforms } from '../src/engine/gfx/Materials';
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

function engineWith(tier: PerfTier, quality: 'retro' | 'standard' | 'high') {
  const spec: any = generateSpec('a heroic knight adventure', { seed: 4242 });
  spec.world.terrain.size = 2000;
  spec.world.terrain.type = 'hills';
  spec.world.portals = { enabled: false };
  spec.custom = { quality, tier };
  const container: any = { ...makeEl('div'), clientWidth: 1280, clientHeight: 720 };
  return new Engine(container, spec, { testMode: true, noTerrain: true, tier });
}

describe('F3(a) pure ceiling helpers', () => {
  it('shadow: s25 caps at 1024, desktop floors at 2048', () => {
    expect(tierShadowMapSize(TIER_FLAGS.s25, 2048)).toBe(1024);
    expect(tierShadowMapSize(TIER_FLAGS.s25, 1024)).toBe(1024);
    expect(tierShadowMapSize(TIER_FLAGS.desktop, 2048)).toBe(2048);
    expect(tierShadowMapSize(TIER_FLAGS.desktop, 1024)).toBe(2048);
  });
  it('detail: s25 caps at retro, desktop floors at high', () => {
    expect(tierDetailQuality(TIER_FLAGS.s25, 'high')).toBe('retro');
    expect(tierDetailQuality(TIER_FLAGS.s25, 'standard')).toBe('retro');
    expect(tierDetailQuality(TIER_FLAGS.s25, 'retro')).toBe('retro');
    expect(tierDetailQuality(TIER_FLAGS.desktop, 'retro')).toBe('high');
    expect(tierDetailQuality(TIER_FLAGS.desktop, 'high')).toBe('high');
  });
  it('msaa: s25 caps at 2, desktop keeps 4', () => {
    expect(tierMsaaSamples(TIER_FLAGS.s25, 'high')).toBe(2);
    expect(tierMsaaSamples(TIER_FLAGS.s25, 'retro')).toBe(2);
    expect(tierMsaaSamples(TIER_FLAGS.desktop, 'high')).toBe(4);
    expect(tierMsaaSamples(TIER_FLAGS.desktop, 'retro')).toBe(2);
  });
});

describe('F3(a) engine wiring — s25 + quality high (the user-reported config)', () => {
  it('shadow map resolves to the 1024 tier cap at boot', () => {
    const e = engineWith('s25', 'high');
    expect(e.sky.sun!.shadow.mapSize.x).toBe(1024);
  });
  it('ground micro-detail is capped off (retro strength 0)', () => {
    engineWith('s25', 'high');
    expect(groundDetailUniforms.uDetailStrength.value).toBe(0);
  });
  it('PostFX MSAA is capped at 2 samples', () => {
    const e = engineWith('s25', 'high');
    expect(e.postfx.msaaSamples).toBe(2);
  });
  it('applySettings (pause-menu path) keeps the ceiling', () => {
    const e = engineWith('s25', 'retro');
    e.settings.data.quality = 'high';
    e.applySettings();
    expect(e.sky.sun!.shadow.mapSize.x).toBe(1024);
    expect(groundDetailUniforms.uDetailStrength.value).toBe(0);
  });
});

describe('F3(a) controls — desktop unchanged', () => {
  it('desktop + high: shadow 2048, full detail, MSAA 4', () => {
    const e = engineWith('desktop', 'high');
    expect(e.sky.sun!.shadow.mapSize.x).toBe(2048);
    expect(groundDetailUniforms.uDetailStrength.value).toBe(1);
    expect(e.postfx.msaaSamples).toBe(4);
  });
  it('desktop + retro quality still floor-raises shadow to 2048', () => {
    const e = engineWith('desktop', 'retro');
    expect(e.sky.sun!.shadow.mapSize.x).toBe(2048);
  });
  it('s25 + retro: shadow 1024, MSAA 2 (same as pre-fix)', () => {
    const e = engineWith('s25', 'retro');
    expect(e.sky.sun!.shadow.mapSize.x).toBe(1024);
    expect(e.postfx.msaaSamples).toBe(2);
  });
});

describe('F3(b)+(c) shadow diet + physics diet — reference scene census', () => {
  // The user's exact session: prompt "A cyberpunk rpg shooter" (seed
  // 2242542926), third-person-action, quality high, 8000 m neon-city world.
  // Pre-fix census (measured): 2,768 physics bodies after scatter (rocks
  // 1,440 / hero-stones 992 / waystones 320 per-instance bodies), every pool
  // castShadow=true. Placement (instances + 2D colliders) must not move.
  function referenceScatter() {
    const spec: any = generateSpec('A cyberpunk rpg shooter', { genre: 'third-person-action' });
    spec.custom = { ...(spec.custom ?? {}), quality: 'high' };
    expect(spec.meta.seed).toBe(2242542926);
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    const scatter = new Scatter(spec, terrain, mats, physics, scene, { quality: 'high', densityMul: 1 });
    return { physics, scatter };
  }

  it('debris pools stop casting; structures keep shadows', () => {
    const { scatter } = referenceScatter();
    const pools = (scatter.chunked as any).pools as any[];
    const byKey = new Map(pools.map((p) => [p.def.key, p]));
    expect(byKey.get('rocks').mesh.castShadow).toBe(false); // debris
    expect(byKey.get('hero-stones').mesh.castShadow).toBe(true); // structures
    expect(byKey.get('biome-waystones').mesh.castShadow).toBe(true); // structures
    expect(byKey.get('biome-lanterns').mesh.castShadow).toBe(true); // light posts
  });

  it('colliders merge per chunk: body census collapses, collision shapes preserved', () => {
    const { physics, scatter } = referenceScatter();
    const cs: any = scatter.chunked;
    const pools = cs.pools as any[];
    let shapes = 0;
    for (const pool of pools) {
      let bodies = 0;
      for (const [, d] of pool.chunks) {
        bodies += d.bodies.length;
        for (const b of d.bodies) shapes += b.shapes.length;
      }
      // at most one merged body per chunk for this pool
      expect(bodies).toBeLessThanOrEqual(cs.loadedChunkCount);
    }
    // every physical instance's cylinder survives as a shape on a merged body
    expect(shapes).toBe(1440 + 992 + 320);
    // 16 terrain bodies + 3 physical pools × 32 chunks = 112 (was 2,768)
    expect(physics.world.bodies.length).toBe(112);
  });

  it('placement is untouched: instances and 2D colliders identical to pre-fix', () => {
    const { scatter } = referenceScatter();
    const cs: any = scatter.chunked;
    expect(cs.residentInstances).toBe(3040);
    expect(scatter.colliders.length).toBe(3040);
  });
});
