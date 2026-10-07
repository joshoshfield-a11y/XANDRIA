/**
 * B3 — physics terrain Z-mirror regression: every cannon Heightfield sample
 * (i,j) must collide at the world (x,z) where heightAt() and the visual mesh
 * place h[i][j]. The body rotation (-90° about X) + position map local
 * (i·e, j·e) to world (−half+i·e, +half−j·e), so the data handed to cannon
 * must be j-mirrored. This test fails on the unmirrored data.
 *
 * N2 — MaterialLibrary.flat() must not pass undefined transparent/opacity to
 * THREE (console warning spam).
 *
 * DOM is stubbed (no jsdom here) — same pattern as flow.test.ts; the canvas
 * stub only needs createImageData/putImageData for procedural textures.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { generateSpec } from '../src/generator/generate';

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

function buildTerrain(): Terrain {
  const spec = generateSpec('a heroic knight adventure', { seed: 99 });
  spec.world.terrain.type = 'hills'; // non-uniform heights so a mirror is detectable
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  return new Terrain(spec, physics, mats, scene);
}

describe('B3 physics terrain matches visual terrain', () => {
  it('heightfield sample (i,j) collides where heightAt() puts h[i][j]', () => {
    const terrain = buildTerrain();
    const shape = terrain.body.shapes[0] as CANNON.Heightfield;
    const data = shape.data as number[][];
    const half = terrain.size / 2;
    const cell = terrain.size / (terrain.res - 1);
    const n = terrain.res - 1;
    const samples: Array<[number, number]> = [
      [0, 0], [0, n], [n, 0], [n, n],
      [10, 20], [Math.floor(n / 2), Math.floor(n / 3)], [n - 5, 7],
    ];
    for (const [i, j] of samples) {
      const v = data[i][j];
      // world position of cannon's local grid point (i·e, j·e, h)
      const world = terrain.body.pointToWorldFrame(new CANNON.Vec3(i * cell, j * cell, v));
      expect(world.x).toBeCloseTo(-half + i * cell, 6);
      expect(world.z).toBeCloseTo(half - j * cell, 6);
      expect(world.y).toBeCloseTo(v, 6);
      // ...and the visual/heightAt ground truth agrees with the collision height
      expect(terrain.heightAt(world.x, world.z)).toBeCloseTo(v, 4);
    }
  });

  it('corner h[0][0] no longer collides mirrored (repro from the QA report)', () => {
    const terrain = buildTerrain();
    const half = terrain.size / 2;
    // QA verified: h[0][0] used to collide at z=+half while rendering at z=−half
    const zAt00 = terrain.body.pointToWorldFrame(new CANNON.Vec3(0, 0, 0)).z;
    expect(zAt00).toBeCloseTo(half, 6);
    const shape = terrain.body.shapes[0] as CANNON.Heightfield;
    const v = (shape.data as number[][])[0][0];
    expect(terrain.heightAt(-half, zAt00)).toBeCloseTo(v, 4);
  });
});

describe('N2 material params', () => {
  it('flat() never passes undefined transparent/opacity to THREE', () => {
    const spec = generateSpec('test', { seed: 1 });
    const mats = new MaterialLibrary(spec);
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    try {
      mats.flat('#ff0000');
      mats.flat('#00ff00', { transparent: true, opacity: 0.5 });
      mats.glow('#0000ff');
      mats.standard('rock', '#888888');
    } finally {
      console.warn = orig;
    }
    expect(warns.filter((w) => w.includes('has value of undefined'))).toEqual([]);
    // defined values still land on the material
    const t = mats.flat('#123456', { transparent: true, opacity: 0.5 });
    expect(t.transparent).toBe(true);
    expect(t.opacity).toBe(0.5);
    const o = mats.flat('#654321');
    expect(o.transparent).toBe(false);
    expect(o.opacity).toBe(1);
  });
});
