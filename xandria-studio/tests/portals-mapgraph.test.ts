/**
 * Open-world portals, workstream C: map graph + derived seeds + per-map biomes.
 *
 * The addressing/seed/biome foundation workers B and D build on.
 *
 * 1. Frozen contract: MapGraph exports (deriveMapSeed known-answer vectors,
 *    neighborOf, oppositeEdge, ORIGIN) + hash quality (avalanche).
 * 2. deriveMapBiome: deterministic, valid ids, varies across neighboring maps.
 * 3. Determinism gate: build map digests for (0,0), (0,1), then (0,0) again —
 *    the round trip must regenerate the identical map (FNV-1a pattern from
 *    the maxsize wave, tests/determinism-ref.ts). (0,1) must differ.
 * 4. Generator defaults: open-world-scale games → 8km + portals on; arena
 *    genres unchanged (no portals field at all).
 * 5. Legacy contract: specs without world.portals generate byte-identical
 *    worlds — the portal branch never fires without an explicit opt-in.
 * 6. Schema validation of world.portals.
 *
 * DOM is stubbed (no jsdom) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  ORIGIN, deriveMapSeed, neighborOf, oppositeEdge, type MapCoord,
} from '../src/engine/world/MapGraph';
import {
  BIOME_IDS, BIOMES, deriveMapBiome, portalMapOf, resolveBiomeDef, selectBiome,
  type BiomeId,
} from '../src/engine/world/Biomes';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Noise2D } from '../src/engine/core/Rng';
import { generateSpec } from '../src/generator/generate';
import { validateSpec, normalizeSpec, portalsEnabled, type GameSpec } from '@spec';
import {
  paramsFromSpec, legacyHeightAtP, digestGrid, stubDom,
} from './determinism-ref';

beforeEach(() => { stubDom(); });

// --- 1. frozen contract: MapGraph --------------------------------------------

// Known-answer vectors — pinned from the reference implementation (node,
// 2026-10-14). They guard the algorithm against accidental change: workers
// B/D persist map seeds, so the hash must never drift.
const SEED_KATS: Array<[number, number, number, number]> = [
  [1, 0, 0, 3866720800],
  [1, 0, 1, 2957637502],
  [1, 1, 0, 1868728634],
  [1, -1, 0, 2061927151],
  [1, 0, -1, 45289681],
  [20261014, 0, 0, 297039156],
  [20261014, 3, -7, 2063881550],
  [0, 0, 0, 1868728634],
  [-5, 123, -456, 108147458],
  [4294967295, 2147483647, -2147483648, 1868728634],
];

describe('MapGraph frozen contract', () => {
  it.each(SEED_KATS)('deriveMapSeed(%i,%i,%i) = %i', (ws, mx, my, expected) => {
    expect(deriveMapSeed(ws, mx, my)).toBe(expected);
  });

  it('is deterministic and a uint32 across the int32 range', () => {
    for (const [ws, mx, my] of [[7, -999, 1000], [0, 0, 0], [2147483647, -2147483648, 5]]) {
      const a = deriveMapSeed(ws, mx, my);
      expect(deriveMapSeed(ws, mx, my)).toBe(a);
      expect(Number.isInteger(a) && a >= 0 && a <= 0xffffffff).toBe(true);
    }
  });

  it('avalanche: adjacent maps get uncorrelated seeds', () => {
    const pop = (n: number): number => { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; };
    let min = 32, total = 0, n = 0;
    for (const ws of [1, 20261014, 999]) {
      for (let mx = -3; mx <= 3; mx++) for (let my = -3; my <= 3; my++) {
        const d = pop(deriveMapSeed(ws, mx, my) ^ deriveMapSeed(ws, mx + 1, my));
        min = Math.min(min, d); total += d; n++;
      }
    }
    expect(min).toBeGreaterThanOrEqual(8);   // no visible tiling across the grid
    expect(total / n).toBeGreaterThan(12);  // ~16 ideal for a 32-bit hash
  });

  it('neighborOf follows the grid convention', () => {
    const c: MapCoord = { mx: 3, my: -2 };
    expect(neighborOf(c, 'N')).toEqual({ mx: 3, my: -1 });
    expect(neighborOf(c, 'S')).toEqual({ mx: 3, my: -3 });
    expect(neighborOf(c, 'E')).toEqual({ mx: 4, my: -2 });
    expect(neighborOf(c, 'W')).toEqual({ mx: 2, my: -2 });
  });

  it('oppositeEdge inverts, and crossing N then S returns home', () => {
    expect(oppositeEdge('N')).toBe('S');
    expect(oppositeEdge('S')).toBe('N');
    expect(oppositeEdge('E')).toBe('W');
    expect(oppositeEdge('W')).toBe('E');
    const home = neighborOf(neighborOf(ORIGIN, 'N'), oppositeEdge('N'));
    expect(home).toEqual(ORIGIN);
  });

  it('ORIGIN is (0,0)', () => {
    expect(ORIGIN).toEqual({ mx: 0, my: 0 });
  });
});

// --- 2. deriveMapBiome -------------------------------------------------------

describe('deriveMapBiome', () => {
  it('is deterministic and always a valid biome id', () => {
    for (const [ws, mx, my] of [[1, 0, 0], [20261014, 5, -5], [0, -100, 100]]) {
      const b = deriveMapBiome(ws, mx, my);
      expect(deriveMapBiome(ws, mx, my)).toBe(b);
      expect((BIOME_IDS as readonly string[]).includes(b)).toBe(true);
    }
  });

  it('varies across neighboring maps (travel feels like going somewhere new)', () => {
    const seen = new Set<BiomeId>();
    for (let mx = -2; mx <= 2; mx++) for (let my = -2; my <= 2; my++) {
      seen.add(deriveMapBiome(20261014, mx, my));
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('does not disturb the legacy biome path', () => {
    const spec = generateSpec('neon cyberpunk fps arena deathmatch');
    expect(resolveBiomeDef(spec).id)
      .toBe(selectBiome(spec.meta.seed, spec.meta.genre, spec.theme.environment));
  });
});

// --- 3. determinism gate -----------------------------------------------------

/**
 * Build a "map": the session contract worker B's transition flow implements —
 * spec.meta.seed is THIS map's build seed (deriveMapSeed(worldSeed, mx, my),
 * stamped for the origin map too), and custom.portalMap carries the grid
 * coordinate plus the world seed for the per-map biome derivation.
 */
function mapSpec(worldSeed: number, mx: number, my: number, size = 8000): GameSpec {
  const spec = generateSpec('a heroic knight adventure through hills at dusk', { seed: worldSeed });
  spec.meta.seed = deriveMapSeed(worldSeed, mx, my);
  spec.world.terrain.size = size;
  spec.world.portals = { enabled: true };
  spec.custom = spec.custom ?? {};
  spec.custom.portalMap = { mx, my, worldSeed };
  return spec;
}

/** FNV-1a digest of the built heightfield (pure height function, byte-exact). */
function heightDigest(spec: GameSpec, res = 96): string {
  const p = paramsFromSpec(spec);
  const noise = new Noise2D(p.seed);
  const half = p.size / 2, cell = p.size / (res - 1);
  const grid: number[][] = [];
  for (let i = 0; i < res; i++) {
    grid[i] = [];
    for (let j = 0; j < res; j++) grid[i][j] = legacyHeightAtP(noise, p, -half + i * cell, -half + j * cell);
  }
  return digestGrid(grid);
}

describe('determinism gate: (0,0) → (0,1) → (0,0) regenerates identically', () => {
  const WS = 20261014;

  it('pure height digests: round trip matches, neighbor differs', () => {
    const d00a = heightDigest(mapSpec(WS, 0, 0));
    const d01 = heightDigest(mapSpec(WS, 0, 1));
    const d00b = heightDigest(mapSpec(WS, 0, 0));
    expect(d00b, 'round trip (0,0) regenerates identically').toBe(d00a);
    expect(d01, 'neighbor map is a different world').not.toBe(d00a);
    console.log(`[portals-determinism] map digests: (0,0)=${d00a} (0,1)=${d01}`);
  });

  it('per-map biomes are deterministic across the round trip', () => {
    const b00a = resolveBiomeDef(mapSpec(WS, 0, 0)).id;
    const b01 = resolveBiomeDef(mapSpec(WS, 0, 1)).id;
    const b00b = resolveBiomeDef(mapSpec(WS, 0, 0)).id;
    expect(b00b).toBe(b00a);
    expect(b00a).toBe(deriveMapBiome(WS, 0, 0));
    expect(b01).toBe(deriveMapBiome(WS, 0, 1));
  });

  it('full Terrain builds: round trip heightAt digests match', () => {
    const buildDigest = (mx: number, my: number): string => {
      const spec = mapSpec(WS, mx, my);
      const physics = new Physics(spec.world.gravity);
      const mats = new MaterialLibrary(spec);
      const scene = new THREE.Scene();
      const terrain = new Terrain(spec, physics, mats, scene);
      try {
        const RES = 48, half = spec.world.terrain.size / 2, cell = spec.world.terrain.size / (RES - 1);
        const grid: number[][] = [];
        for (let i = 0; i < RES; i++) {
          grid[i] = [];
          for (let j = 0; j < RES; j++) grid[i][j] = terrain.heightAt(-half + i * cell, -half + j * cell);
        }
        return digestGrid(grid);
      } finally {
        terrain.dispose(scene, physics);
      }
    };
    const d00a = buildDigest(0, 0);
    const d01 = buildDigest(0, 1);
    const d00b = buildDigest(0, 0);
    expect(d00b, 'engine build round trip (0,0) identical').toBe(d00a);
    expect(d01).not.toBe(d00a);
  }, 600000);
});

// --- 4. generator defaults ---------------------------------------------------

describe('generator: portals defaults', () => {
  it('open-world genre starts at 8km with portals on', () => {
    const s = generateSpec('a heroic knight adventure');
    expect(s.meta.genre).toBe('third-person-action');
    expect(s.world.terrain.size).toBe(8000);
    expect(s.world.portals).toEqual({ enabled: true });
    expect(portalsEnabled(s)).toBe(true);
    expect(validateSpec(s).errors).toEqual([]);
  });

  it('"vast open world" prompt → 8000m with portals on', () => {
    const s = generateSpec('a vast open world sword adventure');
    expect(s.world.terrain.size).toBe(8000);
    expect(s.world.portals).toEqual({ enabled: true });
  });

  it('arena genres keep walls and get no portals field', () => {
    for (const intent of ['neon cyberpunk fps arena deathmatch', 'top-down twin stick horde survival']) {
      const s = generateSpec(intent);
      expect('portals' in s.world).toBe(false);
      expect(portalsEnabled(s)).toBe(false);
      expect(s.world.boundary).toBe('walls');
      expect(JSON.stringify(s)).not.toContain('portals');
    }
  });

  it('racing unchanged: 400m, no portals; rally 8000m, no portals', () => {
    const plain = generateSpec('kart grand prix');
    expect(plain.world.terrain.size).toBe(400);
    expect('portals' in plain.world).toBe(false);
    const rally = generateSpec('an epic desert rally raid');
    expect(rally.world.terrain.size).toBe(8000);
    expect('portals' in rally.world).toBe(false);
  });

  it('plain platformer unchanged (260m, no portals)', () => {
    const s = generateSpec('a hard platformer over lava');
    expect(s.world.terrain.size).toBe(260);
    expect('portals' in s.world).toBe(false);
  });
});

// --- 5. legacy contract ------------------------------------------------------

describe('legacy contract: specs without world.portals are untouched', () => {
  it('portal-less spec takes the legacy biome path exactly', () => {
    const spec = generateSpec('a heroic knight adventure');
    delete (spec.world as { portals?: unknown }).portals; // strip the new default
    expect(portalsEnabled(spec)).toBe(false);
    expect(resolveBiomeDef(spec).id)
      .toBe(BIOMES[selectBiome(spec.meta.seed, spec.meta.genre, spec.theme.environment)].id);
    expect(validateSpec(spec).errors).toEqual([]);
  });

  it('{ enabled: false } + stamped coord still behaves as legacy', () => {
    const spec = mapSpec(20261014, 0, 1);
    spec.world.portals = { enabled: false };
    expect(portalsEnabled(spec)).toBe(false);
    // disabled portals: the stamped coord is ignored, seed selection wins
    expect(resolveBiomeDef(spec).id)
      .toBe(selectBiome(spec.meta.seed, spec.meta.genre, spec.theme.environment));
  });

  it('normalizeSpec never injects world.portals', () => {
    const spec = generateSpec('neon cyberpunk fps arena deathmatch');
    const norm = normalizeSpec(JSON.parse(JSON.stringify(spec)));
    expect('portals' in norm.world).toBe(false);
  });

  it('portalMapOf is total: garbage in → undefined, never throws', () => {
    const spec = generateSpec('a sword adventure') as GameSpec;
    expect(portalMapOf(spec)).toBeUndefined();
    const custom = ((spec as { custom?: unknown }).custom ??= {}) as Record<string, unknown>;
    custom.portalMap = { mx: 'x', my: 1, worldSeed: 5 };
    expect(portalMapOf(spec)).toBeUndefined();
    custom.portalMap = { mx: 2, my: -3 }; // worldSeed missing → not a context
    expect(portalMapOf(spec)).toBeUndefined();
    custom.portalMap = { mx: 2, my: -3, worldSeed: 5 };
    expect(portalMapOf(spec)).toEqual({ mx: 2, my: -3, worldSeed: 5 });
  });
});

// --- 6. schema validation ----------------------------------------------------

describe('schema: world.portals validation', () => {
  const good = () => generateSpec('a heroic knight adventure');

  it('accepts absent, { enabled: true }, { enabled: false }', () => {
    const a = good(); delete (a.world as { portals?: unknown }).portals;
    expect(validateSpec(a).errors).toEqual([]);
    const b = good(); b.world.portals = { enabled: true };
    expect(validateSpec(b).errors).toEqual([]);
    const c = good(); c.world.portals = { enabled: false };
    expect(validateSpec(c).errors).toEqual([]);
  });

  it('accepts portals at any valid size (documented: designed for 8000m)', () => {
    const s = good();
    s.world.terrain.size = 400;
    s.world.portals = { enabled: true };
    expect(validateSpec(s).errors).toEqual([]);
  });

  it('rejects non-object and non-boolean shapes', () => {
    const a = good(); (a.world as { portals?: unknown }).portals = 'yes';
    expect(validateSpec(a).errors.some((e) => e.includes('world.portals'))).toBe(true);
    const b = good(); (b.world as { portals?: unknown }).portals = {};
    expect(validateSpec(b).errors.some((e) => e.includes('world.portals.enabled'))).toBe(true);
    const c = good(); (c.world as { portals?: unknown }).portals = { enabled: 'true' };
    expect(validateSpec(c).errors.some((e) => e.includes('world.portals.enabled'))).toBe(true);
  });
});
