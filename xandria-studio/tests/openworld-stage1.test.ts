/**
 * Open World — Stage 1, workstream E (spec / generator / Studio).
 *
 * 1. Legacy regression: a fixed set of intents must produce BYTE-IDENTICAL
 *    specs (sha256 of JSON.stringify) before/after the stage-1 change.
 *    Baselines captured pre-change on feature/openworld-stage1 @ 00474e33.
 * 2. New behavior: prompts asking for big/open worlds map to big sizes;
 *    schema validation of the 60..2000 range the new paths produce.
 * 3. Studio wiring: the ASSET_GROUPS 'World size' registry control applies
 *    to the spec, and a 1500m world builds headless from BOTH the prompt
 *    path and the Studio-control path.
 *
 * DOM is stubbed (no jsdom) — same pattern as terrain.test.ts; Terrain +
 * Physics + MaterialLibrary build headless in vitest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { generateSpec } from '../src/generator/generate';
import { buildArchitectPrompt } from '../src/generator/llm';
import { validateSpec } from '../src/spec/schema';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import {
  ASSET_GROUPS, applyAssetControl, cloneSpec, type AssetControl,
} from '../src/studio/editor/specOps';

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// [intent, pre-change sha256(JSON.stringify(generateSpec(intent))).slice(0,16)]
const LEGACY_BASELINES: [string, string][] = [
  ['epic sword adventure through ancient ruins at dusk', '3f595fb0a9819a60'],
  ['neon cyberpunk fps arena deathmatch', '28e2e61e5b3de929'],
  ['racing through a volcanic canyon', 'eace8bb83e859607'],
  ['dreamy platformer in the clouds', '4bea1eaa3ab7d850'],
  ['top-down twin stick horde survival', 'baaeb7fb88924cc3'],
  ['a quiet walk in the forest', '00525e780e840afc'],
  ['kart grand prix on tropical islands', 'dd19c3d94a23fecb'],
  ['race me across the desert', '8e11377a5b5560ac'],
  ['a heroic knight adventure', 'b9aea421fffbf21b'],
  ['giant robot boss fight in the city', '12763a04f837ced3'],
  ['survive the endless horde at night', '2b8e2b26b4410943'],
  ['a long journey across the wasteland', '3c8a2dfa98458f37'],
  ['explore the alpine mountains', 'ac7e50b13627a744'],
  ['fight the colossus with a rifle', 'e7c976eb3693f834'],
  ['tropical island racing', '5b23edcbe6a8ac33'],
];

describe('E1 legacy specs are byte-identical', () => {
  it.each(LEGACY_BASELINES)('"%s" unchanged', (intent, baseline) => {
    const spec = generateSpec(intent);
    expect(sha(JSON.stringify(spec))).toBe(baseline);
  });
});

describe('E2 prompt → big world sizes (stage 1)', () => {
  it('open desert rally → 2000m racing world', () => {
    const s = generateSpec('an epic desert rally raid');
    expect(s.meta.genre).toBe('racing');
    expect(s.world.terrain.size).toBe(2000);
    expect(validateSpec(s).errors).toEqual([]);
  });
  it('"vast open world" → 1500m', () => {
    const s = generateSpec('a vast open world sword adventure');
    expect(s.world.terrain.size).toBe(1500);
    expect(validateSpec(s).errors).toEqual([]);
  });
  it('"huge sprawling" → 1500m', () => {
    const s = generateSpec('a huge sprawling fantasy world to explore');
    expect(s.world.terrain.size).toBe(1500);
    expect(validateSpec(s).errors).toEqual([]);
  });
  it('big-world platformer → 1500m (not the 260 default)', () => {
    const s = generateSpec('a huge open world platformer adventure');
    expect(s.meta.genre).toBe('platformer');
    expect(s.world.terrain.size).toBe(1500);
  });
  it('plain prompts keep legacy defaults', () => {
    expect(generateSpec('sword adventure').world.terrain.size).toBe(220);
    expect(generateSpec('a hard platformer over lava').world.terrain.size).toBe(260);
    expect(generateSpec('kart grand prix').world.terrain.size).toBe(400);
  });
});

describe('E3 LLM architect prompt describes the open-world option', () => {
  it('suggests 200-2000 and the open-world rule', () => {
    const base = generateSpec('a sword adventure');
    const p = buildArchitectPrompt('a vast open world to explore', base);
    expect(p).toContain('200-2000');
    expect(p).toContain('open world');
    expect(p).toContain('1000-2000');
  });
});

describe('E4 schema validates the stage-1 size range', () => {
  it('accepts 60..2000 (the sizes generator + Studio now produce)', () => {
    for (const size of [60, 220, 400, 1500, 2000]) {
      const s = generateSpec('a sword adventure');
      s.world.terrain.size = size;
      expect(validateSpec(s).errors).toEqual([]);
    }
  });
  it('rejects outside the range', () => {
    const tooBig = generateSpec('a sword adventure');
    tooBig.world.terrain.size = 2001;
    expect(validateSpec(tooBig).errors.some((e) => e.includes('world.terrain.size'))).toBe(true);
    const tooSmall = generateSpec('a sword adventure');
    tooSmall.world.terrain.size = 59;
    expect(validateSpec(tooSmall).errors.some((e) => e.includes('world.terrain.size'))).toBe(true);
  });
});

describe('E5 Studio world-size control wiring', () => {
  const findSizeControl = (): AssetControl => {
    const world = ASSET_GROUPS.find((g) => g.namespace === 'world');
    const terrain = world?.assets.find((a) => a.id === 'world.terrain');
    const ctrl = terrain?.controls.find((c) => c.path.join('.') === 'world.terrain.size');
    expect(ctrl).toBeDefined();
    return ctrl!;
  };

  it('world.terrain registry has a bounded World size slider', () => {
    const ctrl = findSizeControl();
    expect(ctrl.kind).toBe('slider');
    expect(ctrl.min).toBe(60);
    expect(ctrl.max).toBe(2000);
  });

  it('applying the control writes spec.world.terrain.size and stays valid', () => {
    const ctrl = findSizeControl();
    const spec = generateSpec('a sword adventure');
    const before = JSON.parse(JSON.stringify(spec));
    applyAssetControl(spec, ctrl, 1500);
    expect(spec.world.terrain.size).toBe(1500);
    expect(validateSpec(spec).errors).toEqual([]);
    before.world.terrain.size = 1500;
    expect(JSON.stringify(spec)).toBe(JSON.stringify(before)); // nothing else touched
  });
});

// --- headless world builds (prompt path + Studio control path) ---

function makeEl(tag = 'div'): any {
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as Record<string, string>,
    appendChild(c: any) { el.children.push(c); return c; },
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
  };
  return el;
}

beforeEach(() => {
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head: makeEl('head'),
  };
});

function buildTerrain(spec: ReturnType<typeof generateSpec>): Terrain {
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  return new Terrain(spec, physics, mats, scene);
}

describe('E6 1500m world builds end-to-end', () => {
  it('prompt path: "vast open world" → Terrain(1500m)', () => {
    const spec = generateSpec('a vast open world adventure');
    expect(spec.world.terrain.size).toBe(1500);
    const terrain = buildTerrain(spec);
    expect(terrain.size).toBe(1500);
    expect(terrain.body.shapes[0]).toBeInstanceOf(CANNON.Heightfield);
    expect(Number.isFinite(terrain.heightAt(0, 0))).toBe(true);
  });

  it('Studio path: control sets size 1500 on a 220m spec → Terrain(1500m)', () => {
    const spec = generateSpec('a sword adventure');
    expect(spec.world.terrain.size).toBe(220);
    // same mutation the Studio WORLD SIZE slider commits: sp.world.terrain.size = v
    const working = cloneSpec(spec);
    working.world.terrain.size = 1500;
    expect(validateSpec(working).errors).toEqual([]);
    const terrain = buildTerrain(working);
    expect(terrain.size).toBe(1500);
    expect(terrain.body.shapes[0]).toBeInstanceOf(CANNON.Heightfield);
    expect(Number.isFinite(terrain.heightAt(700, -700))).toBe(true);
  });
});
