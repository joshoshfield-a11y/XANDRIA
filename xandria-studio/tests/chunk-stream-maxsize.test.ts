/**
 * Workstream D (maxsize): physics + streaming regression at 4km.
 *
 * Guards the two things the maxsize traverse measured:
 * - the ChunkStream queue stays bounded at racing top speed (70 m/s) —
 *   budget 2/frame drains far faster than chunks enter the radius;
 * - no falls / no seam tunneling at speed (focus chunk resident every frame,
 *   clearance stays positive across chunk-border crossings).
 *
 * Bounds are deliberately loose (observed: queue max 0, focusMiss 0,
 * min clearance ~0.5m on a 0.5-half-height box) — this test catches
 * regressions (unbounded growth, missing focus chunk, falls), not exact
 * profiling numbers. See scripts/measure-traverse-maxsize.ts for the full
 * 2-minute instrumented run.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics, GROUP } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { generateSpec } from '../src/generator/generate';
import { worldToChunk } from '../src/engine/world/chunkLayout';

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

/** 4km hills world — chunkSize 250m, 16x16 chunks. */
function build4km() {
  const spec = generateSpec('a heroic knight adventure', { seed: 4242 });
  spec.world.terrain.type = 'hills';
  spec.world.terrain.size = 4000;
  spec.world.terrain.water = false;
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  return { spec, physics, scene, terrain };
}

describe('maxsize streaming: 70 m/s traverse on a 4km world', () => {
  it('queue stays bounded, focus chunk always resident, no falls at seams', () => {
    const { physics, terrain } = build4km();
    const world = physics.world;
    const SIZE = 4000, half = SIZE / 2;
    const SPEED = 70; // racing measured top speed with boost held

    const car = new CANNON.Body({
      mass: 400,
      shape: new CANNON.Box(new CANNON.Vec3(1, 0.5, 2)),
      collisionFilterGroup: GROUP.VEHICLE,
      collisionFilterMask: GROUP.WORLD,
    });
    const z0 = -1500;
    car.position.set(-half + 100, terrain.heightAt(-half + 100, z0) + 2, z0);
    world.addBody(car);

    const grid = {
      chunksPerSide: Math.round(SIZE / terrain.chunkSize),
      cellsPerChunk: 0, chunkSize: terrain.chunkSize, cell: 0, half, res: 0,
    };
    const focus = new THREE.Vector3();
    const frames = 30 * 60; // 30 sim-seconds, 2100m straight line, 8 border crossings
    let qMax = 0, qMaxSteady = 0, focusMiss = 0, minClear = Infinity, seamMinClear = Infinity;
    let prevCx = -1, prevCz = -1;

    for (let f = 0; f < frames; f++) {
      car.wakeUp();
      car.velocity.x = SPEED;
      car.velocity.z = 0;
      focus.set(car.position.x, car.position.y, car.position.z);
      terrain.update(focus); // exactly what Engine.step does per frame
      world.step(1 / 60);

      const st = terrain.getStreamStats();
      qMax = Math.max(qMax, st.queue);
      // Stage-1b A: lazy geometry builds mean the opening teleport queues a
      // real burst (geometry builds drain at 2/frame). Steady state — after
      // the first 10s — is what must stay near-zero.
      if (f > 600) qMaxSteady = Math.max(qMaxSteady, st.queue);

      const { cx, cz } = worldToChunk(car.position.x, car.position.z, grid);
      if (!terrain.isChunkLoaded(cx, cz)) focusMiss++;
      const clear = car.position.y - terrain.heightAt(car.position.x, car.position.z);
      minClear = Math.min(minClear, clear);
      if (prevCx >= 0 && (cx !== prevCx || cz !== prevCz)) {
        seamMinClear = Math.min(seamMinClear, clear);
      }
      prevCx = cx; prevCz = cz;
    }

    expect(qMax).toBeLessThanOrEqual(64); // opening lazy-build burst; drains at 2/frame
    expect(qMaxSteady).toBeLessThanOrEqual(8); // steady state: budget drains far faster than entry rate
    expect(focusMiss).toBe(0); // focus chunk resident on 100% of frames
    expect(minClear).toBeGreaterThan(0.3); // box half-height 0.5 — never fell through
    expect(seamMinClear).toBeGreaterThan(0.3); // no tunneling at chunk seams
    expect(car.position.x).toBeGreaterThan(0); // actually traveled (>1900m)
  }, 120000);
});
