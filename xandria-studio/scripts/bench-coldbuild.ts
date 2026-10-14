/**
 * Cold-build benchmark for workstream A (stage-1b maxsize).
 * New (lazy) semantics:
 *   - ctorTime: constructor wall-clock (spawn-area-first: only the
 *     3x3 spawn neighborhood is sync-built; the rest streams in).
 *   - drainTime: updates needed to reach streaming steady state with the
 *     player parked at spawn (all chunks within mesh radius paged in,
 *     queue drained), plus wall-clock and total chunkBuildMs.
 * Run: npx tsx scripts/bench-coldbuild.ts [size ...]
 * (default sizes: 2000 4000 8000)
 */
import * as THREE from 'three';
import { generateSpec } from '../src/generator/generate.js';
import { MaterialLibrary } from '../src/engine/gfx/Materials.js';
import { Physics } from '../src/engine/core/Physics.js';
import { Terrain } from '../src/engine/world/Terrain.js';

// minimal DOM stub (mirrors the unit tests)
const makeEl = (tag: string) => ({
  tagName: tag, style: {}, appendChild() {}, addEventListener() {},
  getContext: () => ({
    fillRect() {}, clearRect() {}, getImageData: () => ({ data: [] }),
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
  }),
});
(globalThis as any).document = {
  createElement: (t: string) => makeEl(t),
  head: makeEl('head'),
};

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
for (const size of sizes.length ? sizes : [2000, 4000, 8000]) {
  const spec = generateSpec('a vast open world desert rally', { seed: 4242 });
  spec.world.terrain.type = 'hills';
  spec.world.terrain.size = size;
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();

  const t0 = performance.now();
  const terrain = new Terrain(spec, physics, mats, scene);
  const ctorMs = performance.now() - t0;
  const builtAtCtor = terrain.builtMeshCount;
  const cps = Math.round(size / terrain.chunkSize);

  // park the player at spawn and run the streaming update loop at the
  // budget (2 chunks per update) until the queue drains and steady state
  // is reached — this is "time until the world around the player exists".
  const player = new THREE.Vector3(0, 0, 0);
  const d0 = performance.now();
  let updates = 0;
  let guard = 0;
  for (;;) {
    terrain.update(player);
    updates++;
    // queue is body+mesh queues; when both are empty the in-radius world
    // exists around the player (steady state)
    if (terrain.getStreamStats().queue === 0) break;
    if (++guard > 5000) break; // safety
  }
  const drainMs = performance.now() - d0;
  const stats = terrain.getStreamStats();
  const bodyQ = (terrain as any).bodyStream.queueLength;
  const meshQ = (terrain as any).meshStream.queueLength;
  console.log(
    `size=${size}m chunks/side=${cps} chunkSize=${terrain.chunkSize}m ` +
    `ctor=${ctorMs.toFixed(0)}ms (built ${builtAtCtor}) ` +
    `drain=${drainMs.toFixed(0)}ms over ${updates} updates ` +
    `steadyStateBodies=${stats.loaded} meshes=${terrain.builtMeshCount} ` +
    `queues(b/m)=${bodyQ}/${meshQ} buildMsEMA=${stats.buildMs.toFixed(2)}ms`,
  );
  terrain.dispose(scene, physics);
}
