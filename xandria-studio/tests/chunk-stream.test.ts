/**
 * Stage-1 workstream B: chunked physics + streaming manager.
 *
 * - Pure hysteresis/layout logic (chunkLayout.ts) — no THREE/cannon needed.
 * - ChunkStream budget + teleport + no-thrash behavior with a fake lifecycle.
 * - Terrain integration on a 1200m world: per-chunk body count, per-chunk
 *   B3-style mirror correctness, shared edges between adjacent chunks.
 * - Scripted traversal acceptance: walk a capsule across multiple chunk
 *   borders (no falls, no pops), then a simulated 2-minute traverse with
 *   bounded queue + stable loaded count + no load/unload oscillation.
 * - PerfMonitor streaming counters.
 *
 * DOM is stubbed (no jsdom) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { PerfMonitor } from '../src/engine/core/Perf';
import { generateSpec } from '../src/generator/generate';
import {
  chunkKey,
  worldToChunk,
  chunkCellRange,
  chunkRectDistance,
  classifyChunk,
  planChunkChanges,
  type ChunkGrid,
} from '../src/engine/world/chunkLayout';
import { ChunkStream } from '../src/engine/world/ChunkStream';
import { TERRAIN_CHUNK_TARGET, TERRAIN_CHUNK_CELL } from '../src/engine/world/Terrain';

/**
 * Test-local replica of worker A's canonical chunk layout (built from A's
 * exported constants, so it tracks the real algorithm): chunksPerSide =
 * ceil(size/256); single-chunk worlds use the legacy grid, larger worlds use
 * fixed ~2.5m cells; chunkSize = size/chunksPerSide exactly.
 */
function makeGrid(size: number): ChunkGrid {
  const chunksPerSide = Math.max(1, Math.ceil(size / TERRAIN_CHUNK_TARGET));
  let cellsPerChunk: number, res: number;
  if (chunksPerSide === 1) {
    res = Math.min(128, Math.max(32, Math.round(size / 2.5)));
    cellsPerChunk = res - 1;
  } else {
    cellsPerChunk = Math.max(1, Math.round(size / chunksPerSide / TERRAIN_CHUNK_CELL));
    res = chunksPerSide * cellsPerChunk + 1;
  }
  return {
    chunksPerSide, cellsPerChunk, chunkSize: size / chunksPerSide,
    cell: size / (res - 1), half: size / 2, res,
  };
}

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

/** 1200m hills world (non-uniform heights so mirror/edge bugs are visible). */
function buildBigTerrain() {
  const spec = generateSpec('a heroic knight adventure', { seed: 4242 });
  spec.world.terrain.type = 'hills';
  spec.world.terrain.size = 1200;
  spec.world.terrain.water = false;
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  return { spec, physics, mats, scene, terrain };
}

/** Small default world — must behave exactly like the old single-body terrain. */
function buildSmallTerrain() {
  const spec = generateSpec('a heroic knight adventure', { seed: 99 });
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const terrain = new Terrain(spec, physics, mats, scene);
  return { spec, physics, scene, terrain };
}

describe('chunkLayout: pure grid math', () => {
  it('1200m world chunks to a 240m grid (worker A layout)', () => {
    const g = makeGrid(1200);
    expect(g.chunksPerSide).toBe(5);
    // cellsPerChunk = round(1200/5/2.5) = 96; chunkSize = 1200/5 = 240 exact
    expect(g.cellsPerChunk).toBe(96);
    expect(g.chunkSize).toBe(240);
    expect(g.cell).toBeCloseTo(2.5, 6);
    expect(g.res).toBe(5 * 96 + 1);
  });

  it('small worlds collapse to a single chunk', () => {
    expect(makeGrid(220).chunksPerSide).toBe(1);
    expect(makeGrid(400).chunksPerSide).toBe(2);
    expect(makeGrid(2000).chunksPerSide).toBe(8);
  });

  it('adjacent chunks share edge sample indices exactly', () => {
    const g = makeGrid(1200);
    for (let cx = 0; cx < g.chunksPerSide - 1; cx++) {
      const a = chunkCellRange(cx, 0, g);
      const b = chunkCellRange(cx + 1, 0, g);
      expect(b.i0).toBe(a.i1); // shared edge column
      const c = chunkCellRange(0, cx, g);
      const d = chunkCellRange(0, cx + 1, g);
      expect(d.j0).toBe(c.j1); // shared edge row
    }
    // union covers the whole grid exactly (A's layout has no partial chunks)
    const first = chunkCellRange(0, 0, g);
    const last = chunkCellRange(g.chunksPerSide - 1, g.chunksPerSide - 1, g);
    expect(first.i0).toBe(0);
    expect(last.i1).toBe(g.res - 1);
    expect(g.cellsPerChunk * g.chunksPerSide).toBe(g.res - 1);
  });

  it('worldToChunk maps points to the chunk containing them', () => {
    const g = makeGrid(1200);
    expect(worldToChunk(0, 0, g)).toEqual({ cx: 2, cz: 2 });
    expect(worldToChunk(-600, -600, g)).toEqual({ cx: 0, cz: 0 });
    expect(worldToChunk(599, 599, g)).toEqual({ cx: 4, cz: 4 });
    // out-of-bounds clamps to the edge chunk
    expect(worldToChunk(9999, -9999, g)).toEqual({ cx: 4, cz: 0 });
  });

  it('chunkRectDistance is 0 inside, Euclidean outside', () => {
    const g = makeGrid(1200);
    expect(chunkRectDistance(2, 2, 0, 0, g)).toBe(0);
    // point exactly 100m past chunk (2,2)'s +x edge
    const x1 = -g.half + 3 * g.cellsPerChunk * g.cell;
    expect(chunkRectDistance(2, 2, x1 + 100, 0, g)).toBeCloseTo(100, 6);
    // diagonal: 30m past +x edge and 40m past +z edge -> 50m
    const z1 = -g.half + 3 * g.cellsPerChunk * g.cell;
    expect(chunkRectDistance(2, 2, x1 + 30, z1 + 40, g)).toBeCloseTo(50, 6);
  });
});

describe('chunkLayout: hysteresis', () => {
  const LOAD = 150, UNLOAD = 300;

  it('classifyChunk implements the hysteresis band', () => {
    expect(classifyChunk(50, false, LOAD, UNLOAD)).toBe('load');
    expect(classifyChunk(200, false, LOAD, UNLOAD)).toBe('none'); // band: no load
    expect(classifyChunk(200, true, LOAD, UNLOAD)).toBe('none'); // band: no unload
    expect(classifyChunk(350, true, LOAD, UNLOAD)).toBe('unload');
    expect(classifyChunk(350, false, LOAD, UNLOAD)).toBe('none');
    expect(classifyChunk(50, true, LOAD, UNLOAD)).toBe('none');
  });

  it('planChunkChanges loads near chunks and unloads far ones', () => {
    const g = makeGrid(1200); // 5x5 chunks of ~255m
    const loaded = new Set<string>();
    const plan = planChunkChanges(0, 0, g, (cx, cz) => loaded.has(chunkKey(cx, cz)), LOAD, UNLOAD);
    // chunk (2,2) spans [-120,120]^2 and holds the origin; edge neighbors sit
    // 120m away (LOAD=150 loads them), diagonals ~170m stay out
    const got = plan.toLoad.map((c) => chunkKey(c.cx, c.cz)).sort();
    expect(got).toEqual(['1,2', '2,1', '2,2', '2,3', '3,2']);
    expect(plan.toUnload).toEqual([]);
    for (const c of plan.toLoad) loaded.add(chunkKey(c.cx, c.cz));
    // teleport far away: everything loaded is beyond unload radius -> unload all
    const plan2 = planChunkChanges(10000, 0, g, (cx, cz) => loaded.has(chunkKey(cx, cz)), LOAD, UNLOAD);
    expect(plan2.toUnload.length).toBe(5);
    // loads are nearest-first
    const plan3 = planChunkChanges(0, 0, g, () => false, 1000, 2000);
    for (let k = 1; k < plan3.toLoad.length; k++) {
      expect(plan3.toLoad[k].dist).toBeGreaterThanOrEqual(plan3.toLoad[k - 1].dist);
    }
  });
});

describe('ChunkStream: budget, teleport, no-thrash', () => {
  function makeStream() {
    const grid = makeGrid(1200); // 5x5
    const built: string[] = [];
    const released: string[] = [];
    const stream = new ChunkStream({
      grid,
      lifecycle: {
        buildChunk: (cx, cz) => { built.push(chunkKey(cx, cz)); },
        releaseChunk: (cx, cz) => { released.push(chunkKey(cx, cz)); },
      },
      maxBuildsPerFrame: 2,
    });
    return { stream, built, released, grid };
  }
  const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);

  it('first update pages in everything within loadRadius (spawn correctness)', () => {
    const { stream, built, grid } = makeStream();
    stream.update(v(0, 0));
    expect(stream.queueLength).toBe(0);
    expect(stream.loadedCount).toBe(built.length);
    expect(stream.loadedCount).toBeGreaterThan(1);
    expect(stream.isLoaded(2, 2)).toBe(true); // origin chunk resident
    expect(grid.chunksPerSide * grid.chunksPerSide).toBe(25);
  });

  it('per-frame build budget is respected and the queue drains', () => {
    // 4000m grid (16x16, loadRadius 625): walk +200m/update — new chunks keep
    // entering the radius without any teleport, so the budget path engages.
    const grid = makeGrid(4000);
    const built: string[] = [];
    const stream = new ChunkStream({
      grid,
      lifecycle: {
        buildChunk: (cx, cz) => { built.push(chunkKey(cx, cz)); },
        releaseChunk: () => {},
      },
      maxBuildsPerFrame: 1,
    });
    stream.update(v(0, 0)); // first update: teleport path, builds within 625m
    expect(stream.queueLength).toBe(0);
    let sawQueue = false;
    for (let s = 1; s <= 12; s++) {
      const before = built.length;
      stream.update(v(s * 200, 0));
      expect(built.length - before).toBeLessThanOrEqual(1); // budget honored
      if (stream.queueLength > 0) sawQueue = true;
    }
    expect(sawQueue).toBe(true); // the budget genuinely queued work
    // park: the queue must drain fully within the budget
    let guard = 0;
    while (stream.queueLength > 0 && guard++ < 200) {
      const before = built.length;
      stream.update(v(2400, 0));
      expect(built.length - before).toBeLessThanOrEqual(1);
    }
    expect(stream.queueLength).toBe(0);
  });

  it('teleport bypasses the budget: new area is fully built immediately', () => {
    // 4000m grid: an in-world jump CAN exceed unloadRadius here (on the 1200m
    // grid the world is smaller than unloadRadius, so teleports are
    // unreachable — the constructor's first update covers that path).
    const grid = makeGrid(4000); // 16x16 chunks of 250m
    const built: string[] = [];
    const released: string[] = [];
    const stream = new ChunkStream({
      grid,
      lifecycle: {
        buildChunk: (cx, cz) => { built.push(chunkKey(cx, cz)); },
        releaseChunk: (cx, cz) => { released.push(chunkKey(cx, cz)); },
      },
      maxBuildsPerFrame: 2,
    });
    stream.update(v(0, 0));
    expect(stream.isLoaded(8, 8)).toBe(true); // origin chunk: (0+2000)/250 = 8
    built.length = 0;
    stream.update(v(1500, 1500)); // 2121m jump > unloadRadius (1000) -> teleport
    expect(stream.queueLength).toBe(0); // no budget queueing on teleport
    expect(built.length).toBeGreaterThan(0);
    expect(stream.isLoaded(14, 14)).toBe(true); // chunk under the new focus
    expect(stream.isLoaded(8, 8)).toBe(false); // old area paged out
    expect(released.length).toBeGreaterThan(0);
  });

  it('no thrash: a parked focus with small jitter never unloads/reloads', () => {
    const { stream, built, released } = makeStream();
    stream.update(v(0, 0)); // all 25 chunks resident (max dist 509m < 600m)
    const rel0 = released.length;
    const b0 = built.length;
    // jitter ±2m: every chunk's classification must stay put — the hysteresis
    // band is hundreds of meters wide, so nothing may flip
    for (let k = 0; k < 120; k++) stream.update(v(k % 2 === 0 ? 2 : -2, (k % 3) - 1));
    expect(released.length).toBe(rel0); // nothing unloaded
    expect(built.length).toBe(b0); // nothing reloaded
  });

  it('unloadRadius must exceed loadRadius (constructor guard)', () => {
    const grid = makeGrid(1200);
    expect(() => new ChunkStream({ grid, lifecycle: { buildChunk() {}, releaseChunk() {} }, loadRadius: 200, unloadRadius: 200 }))
      .toThrow(/hysteresis/);
  });
});

describe('Terrain: chunked physics bodies', () => {
  it('getChunkStats reports the chunk layout', () => {
    const { terrain, scene, physics } = buildBigTerrain();
    try {
      const s = terrain.getChunkStats();
      expect(s.chunkCount).toBe(25);
      expect(s.chunkSize).toBe(240); // worker A: 1200/5 exact
    } finally {
      terrain.dispose(scene, physics);
    }
  });

  it('small worlds stay single-chunk: one body, zero streaming behavior', () => {
    const { terrain, scene, physics } = buildSmallTerrain();
    try {
      expect(terrain.getChunkStats().chunkCount).toBe(1);
      expect(terrain.loadedChunkBodies.length).toBe(1);
      expect(terrain.body).toBe(terrain.loadedChunkBodies[0]);
      const n0 = physics.world.bodies.length;
      // update far outside the world: nothing may page in or out
      terrain.update(new THREE.Vector3(5000, 0, 5000));
      terrain.update(new THREE.Vector3(-5000, 0, -5000));
      expect(physics.world.bodies.length).toBe(n0);
      expect(terrain.loadedChunkBodies.length).toBe(1);
      const ss = terrain.getStreamStats();
      expect(ss.loaded).toBe(1);
      expect(ss.queue).toBe(0);
    } finally {
      terrain.dispose(scene, physics);
    }
  });

  it('every chunk body collides exactly where heightAt() puts the heights (per-chunk B3)', () => {
    const { terrain, scene, physics } = buildBigTerrain();
    try {
      const grid = makeGrid(terrain.size);
      for (let cx = 0; cx < grid.chunksPerSide; cx++) {
        for (let cz = 0; cz < grid.chunksPerSide; cz++) {
          // stage-1b A: bodies stream lazily — ensure each one before checking
          const b = terrain.ensureChunkBody(cx, cz);
          expect(b).toBeDefined();
          const shape = b!.shapes[0] as CANNON.Heightfield;
          const data = shape.data as number[][];
          const r = chunkCellRange(cx, cz, grid);
          const nI = r.i1 - r.i0, nJ = r.j1 - r.j0;
          expect(data.length).toBe(nI + 1);
          expect(data[0].length).toBe(nJ + 1);
          // spot-check corners + center: physics sample == heightAt at that world pos
          const pts: Array<[number, number]> = [[0, 0], [nI, 0], [0, nJ], [nI, nJ], [nI >> 1, nJ >> 1]];
          for (const [li, lj] of pts) {
            const val = data[li][lj];
            const world = b!.pointToWorldFrame(new CANNON.Vec3(li * grid.cell, lj * grid.cell, val));
            expect(world.x).toBeCloseTo(-grid.half + (r.i0 + li) * grid.cell, 6);
            expect(world.z).toBeCloseTo(-grid.half + (r.j1 - lj) * grid.cell, 6);
            expect(terrain.heightAt(world.x, world.z)).toBeCloseTo(val, 4);
          }
        }
      }
    } finally {
      terrain.dispose(scene, physics);
    }
  });

  it('adjacent chunk bodies share edge heights exactly (no seam tunneling)', () => {
    const { terrain, scene, physics } = buildBigTerrain();
    try {
      const grid = makeGrid(terrain.size);
      // stage-1b A: bodies stream lazily — ensure every chunk body before
      // comparing the seams (on a 1200m world all 25 are within loadRadius
      // of spawn, so they would page in on first update anyway)
      for (let ecx = 0; ecx < grid.chunksPerSide; ecx++) {
        for (let ecz = 0; ecz < grid.chunksPerSide; ecz++) terrain.ensureChunkBody(ecx, ecz);
      }
      for (let cx = 0; cx < grid.chunksPerSide - 1; cx++) {
        for (let cz = 0; cz < grid.chunksPerSide; cz++) {
          const a = terrain.ensureChunkBody(cx, cz)!;
          const b = terrain.ensureChunkBody(cx + 1, cz)!;
          const da = (a.shapes[0] as CANNON.Heightfield).data as number[][];
          const db = (b.shapes[0] as CANNON.Heightfield).data as number[][];
          const nJ = da[0].length;
          for (let lj = 0; lj < nJ; lj++) {
            // a's +i edge (last li row) meets b's -i edge (first li row)
            expect(db[0][lj]).toBe(da[da.length - 1][lj]);
          }
          // ...and both agree with heightAt() along the seam in world space
          const r = chunkCellRange(cx, cz, grid);
          for (let lj = 0; lj < nJ; lj += 4) {
            const wx = -grid.half + r.i1 * grid.cell;
            const wz = -grid.half + (r.j1 - lj) * grid.cell;
            expect(terrain.heightAt(wx, wz)).toBeCloseTo(da[da.length - 1][lj], 6);
          }
        }
      }
      // same for vertical neighbors (shared j edge rows)
      for (let cx = 0; cx < grid.chunksPerSide; cx++) {
        for (let cz = 0; cz < grid.chunksPerSide - 1; cz++) {
          const a = terrain.ensureChunkBody(cx, cz)!;
          const b = terrain.ensureChunkBody(cx, cz + 1)!;
          const da = (a.shapes[0] as CANNON.Heightfield).data as number[][];
          const db = (b.shapes[0] as CANNON.Heightfield).data as number[][];
          // a's +j edge row (lj=0 holds h[*][j1], the j-mirror) meets b's -j
          // edge row (last lj row holds h[*][J0] with J0 == j1)
          for (let li = 0; li < da.length; li++) {
            expect(db[li][db[0].length - 1]).toBe(da[li][0]);
          }
        }
      }
    } finally {
      terrain.dispose(scene, physics);
    }
  });

  it('dispose removes every chunk body from the physics world', () => {
    const { terrain, scene, physics } = buildBigTerrain();
    const n0 = physics.world.bodies.length;
    expect(n0).toBeGreaterThan(1);
    terrain.dispose(scene, physics);
    expect(physics.world.bodies.length).toBe(0);
    expect(terrain.loadedChunkBodies.length).toBe(0);
  });
});

describe('PerfMonitor: streaming counters', () => {
  it('sampleStream feeds chunksLoaded/chunkBuildMs/streamQueue into snapshot + reset', () => {
    const p = new PerfMonitor();
    p.sampleStream(17, 1.25, 3);
    expect(p.chunksLoaded).toBe(17);
    expect(p.chunkBuildMs).toBe(1.25);
    expect(p.streamQueue).toBe(3);
    const s = p.snapshot();
    expect(s.chunksLoaded).toBe(17);
    expect(s.chunkBuildMs).toBe(1.25);
    expect(s.streamQueue).toBe(3);
    p.reset();
    expect(p.chunksLoaded).toBe(0);
    expect(p.snapshot().streamQueue).toBe(0);
  });

  it('sampleStream is a no-op when disabled', () => {
    const p = new PerfMonitor();
    p.enabled = false;
    p.sampleStream(5, 1, 1);
    expect(p.chunksLoaded).toBe(0);
  });
});

describe('acceptance: scripted traversal across chunk borders', () => {
  // Flat terrain keeps the walk deterministic (seam tiling is terrain-type
  // independent — hills exactness is covered by the per-chunk B3 test above).
  // 2000m => 8x8 chunks of ~252m: streaming is genuinely active here
  // (loadRadius 630m < world half 1000m), unlike the 1200m all-resident case.
  function buildWalkWorld() {
    const spec = generateSpec('a heroic knight adventure', { seed: 777 });
    spec.world.terrain.type = 'flat';
    spec.world.terrain.size = 2000;
    spec.world.terrain.water = false;
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    return { spec, physics, scene, terrain };
  }

  /** Walk one leg toward (tx,tz) at speed m/s; returns per-frame min clearance + max pop. */
  function walkLeg(
    physics: Physics, terrain: Terrain, body: CANNON.Body,
    tx: number, tz: number, speed: number, maxFrames: number,
  ): { minClear: number; maxPop: number; reached: boolean; frames: number } {
    let minClear = Infinity, maxPop = 0, prevY = body.position.y, frames = 0;
    const focus = new THREE.Vector3();
    for (let f = 0; f < maxFrames; f++) {
      const dx = tx - body.position.x, dz = tz - body.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 4) return { minClear, maxPop, reached: true, frames };
      body.velocity.x = (dx / d) * speed;
      body.velocity.z = (dz / d) * speed;
      physics.step(1 / 60);
      focus.set(body.position.x, body.position.y, body.position.z);
      terrain.update(focus);
      const clear = body.position.y - terrain.heightAt(body.position.x, body.position.z);
      minClear = Math.min(minClear, clear);
      maxPop = Math.max(maxPop, Math.abs(body.position.y - prevY));
      prevY = body.position.y;
      frames++;
      if (!Number.isFinite(clear) || !Number.isFinite(body.position.y)) {
        return { minClear: -Infinity, maxPop: Infinity, reached: false, frames };
      }
    }
    return { minClear, maxPop, reached: false, frames };
  }

  it('walks across 4 chunk borders: no falls, no pops, borders actually crossed', () => {
    const { terrain, scene, physics } = buildWalkWorld();
    try {
      const grid = makeGrid(terrain.size);
      // chunk x-borders in world coords: -1000 + k*250 (worker A exact tiling)
      const borders = [1, 2, 3, 4].map((cx) => -grid.half + cx * grid.chunkSize);
      const zLane = 40;
      const sx = -grid.half + 60;
      const y0 = terrain.heightAt(sx, zLane);
      const body = physics.capsule(0.42, 1.7, [sx, y0 + 2, zLane], { mass: 70 });
      const focus = new THREE.Vector3(sx, y0 + 2, zLane);
      terrain.update(focus);
      for (let f = 0; f < 90; f++) { physics.step(1 / 60); terrain.update(focus.set(body.position.x, body.position.y, body.position.z)); }
      let minClear = Infinity, maxPop = 0;
      // legs: cross borders[0..2] heading +x, then head back across one border
      const legs: Array<[number, number]> = [
        [borders[0] + 60, zLane],
        [borders[1] + 60, zLane],
        [borders[2] + 60, zLane],
        [borders[1] - 60, zLane],
      ];
      for (const [tx, tz] of legs) {
        const r = walkLeg(physics, terrain, body, tx, tz, 12, 2200);
        expect(r.reached).toBe(true);
        minClear = Math.min(minClear, r.minClear);
        maxPop = Math.max(maxPop, r.maxPop);
      }
      // capsule center rests ~0.85m above ground: never below 0.2 (no fall-through)
      expect(minClear).toBeGreaterThan(0.2);
      // no position pops at seams (one frame = 1/60s; 0.6m is generous)
      expect(maxPop).toBeLessThan(0.6);
      physics.remove(body);
    } finally {
      terrain.dispose(scene, physics);
    }
  }, 180000);

  it('2-minute simulated traverse: bounded queue, stable loaded count, no oscillation, full coverage', () => {
    const { terrain, scene, physics } = buildWalkWorld();
    try {
      // count streaming page in/out events via the cannon world event bus
      let adds = 0, removes = 0;
      physics.world.addEventListener('addBody', () => adds++);
      physics.world.addEventListener('removeBody', () => removes++);
      const sx = -800, sz = -600;
      const y0 = terrain.heightAt(sx, sz);
      const body = physics.capsule(0.42, 1.7, [sx, y0 + 2, sz], { mass: 70 });
      const focus = new THREE.Vector3(sx, y0 + 2, sz);
      terrain.update(focus);
      for (let f = 0; f < 60; f++) { physics.step(1 / 60); terrain.update(focus.set(body.position.x, body.position.y, body.position.z)); }
      adds = 0; removes = 0; // ignore settle phase

      // snake path across the 2000m world (~6 chunk borders at 12 m/s)
      const waypoints: Array<[number, number]> = [];
      const rows = [-600, -360, -120];
      rows.forEach((z, ri) => {
        const xs = ri % 2 === 0 ? [-800, -560, -320, -80, 160, 400, 640] : [640, 400, 160, -80, -320, -560, -800];
        for (const x of xs) waypoints.push([x, z]);
      });
      const queueSamples: number[] = [];
      const loadedSamples: number[] = [];
      let minClear = Infinity, maxPop = 0, prevY = body.position.y;
      let probeFails = 0, probes = 0, focusChunkMissing = 0;
      let wi = 0;
      const totalFrames = 7200; // 2 simulated minutes at 60Hz
      for (let f = 0; f < totalFrames; f++) {
        const [tx, tz] = waypoints[wi];
        const dx = tx - body.position.x, dz = tz - body.position.z;
        if (Math.hypot(dx, dz) < 6) { wi = Math.min(wi + 1, waypoints.length - 1); continue; }
        const d = Math.hypot(dx, dz);
        body.velocity.x = (dx / d) * 12;
        body.velocity.z = (dz / d) * 12;
        physics.step(1 / 60);
        focus.set(body.position.x, body.position.y, body.position.z);
        terrain.update(focus);
        // core streaming invariant: the chunk under the focus is ALWAYS resident
        const fc = worldToChunk(focus.x, focus.z, makeGrid(terrain.size));
        if (!terrain.isChunkLoaded(fc.cx, fc.cz)) focusChunkMissing++;
        const clear = body.position.y - terrain.heightAt(body.position.x, body.position.z);
        if (clear < minClear) minClear = clear;
        const pop = Math.abs(body.position.y - prevY);
        if (pop > maxPop) maxPop = pop;
        prevY = body.position.y;
        if (f % 60 === 0) {
          const ss = terrain.getStreamStats();
          queueSamples.push(ss.queue);
          loadedSamples.push(ss.loaded);
        }
        // coverage probe: ground must exist under the player (raycast vs paged bodies)
        if (f % 120 === 0) {
          probes++;
          const gy = physics.groundY(body.position.x, body.position.z);
          if (gy === null || Math.abs(gy - terrain.heightAt(body.position.x, body.position.z)) > 1.0) probeFails++;
        }
      }
      // park and let the stream settle
      for (let f = 0; f < 240; f++) { physics.step(1 / 60); terrain.update(focus.set(body.position.x, body.position.y, body.position.z)); }
      const settled = terrain.getStreamStats();
      const distWalked = Math.hypot(body.position.x - sx, body.position.z - sz);

      expect(distWalked).toBeGreaterThan(1000); // sustained walking happened
      expect(minClear).toBeGreaterThan(0.2); // never fell through
      expect(maxPop).toBeLessThan(0.6); // no pops
      expect(focusChunkMissing).toBe(0); // focus chunk always resident
      expect(probeFails).toBe(0); // ground always present under player
      expect(probes).toBeGreaterThan(0);
      expect(Math.max(...queueSamples)).toBeLessThanOrEqual(6); // queue bounded
      expect(settled.queue).toBe(0); // queue drains at rest
      // no sudden churn: consecutive samples (1s apart) never jump — the
      // loaded count drifts smoothly with the hysteresis band, it must not
      // flip-flop (a load/unload oscillation would show up as large deltas)
      let maxDelta = 0;
      for (let k = 1; k < loadedSamples.length; k++) {
        maxDelta = Math.max(maxDelta, Math.abs(loadedSamples[k] - loadedSamples[k - 1]));
      }
      expect(maxDelta).toBeLessThanOrEqual(3);
      // page in/out counts stay sane for a 2-minute walk (no churn)
      expect(adds).toBeLessThan(300);
      expect(removes).toBeLessThan(300);
      // streaming actually did work (not everything resident the whole time)
      expect(adds + removes).toBeGreaterThan(0);
      physics.remove(body);
    } finally {
      terrain.dispose(scene, physics);
    }
  }, 240000);

  it('parked at a border: no load/unload oscillation after settling', () => {
    const { terrain, scene, physics } = buildWalkWorld();
    try {
      let adds = 0, removes = 0;
      physics.world.addEventListener('addBody', () => adds++);
      physics.world.addEventListener('removeBody', () => removes++);
      const grid = makeGrid(terrain.size);
      // park exactly on a chunk border (inside the hysteresis band by construction)
      const bx = -grid.half + 4 * grid.cellsPerChunk * grid.cell;
      const px = bx + 1, pz = 0;
      const body = physics.capsule(0.42, 1.7, [px, terrain.heightAt(px, pz) + 2, pz], { mass: 70 });
      const focus = new THREE.Vector3(px, 0, pz);
      for (let f = 0; f < 120; f++) { physics.step(1 / 60); terrain.update(focus.set(body.position.x, body.position.y, body.position.z)); }
      const a0 = adds, r0 = removes;
      for (let f = 0; f < 600; f++) { physics.step(1 / 60); terrain.update(focus.set(body.position.x, body.position.y, body.position.z)); }
      expect(adds).toBe(a0); // zero new page-ins
      expect(removes).toBe(r0); // zero new page-outs
      physics.remove(body);
    } finally {
      terrain.dispose(scene, physics);
    }
  }, 120000);
});
