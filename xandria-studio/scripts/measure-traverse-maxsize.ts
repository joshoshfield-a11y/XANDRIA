/**
 * Workstream D (maxsize): physics + streaming at scale.
 *
 * 1. Broadphase cost: cannon-es SAPBroadphase world.step time with all
 *    resident chunk Heightfield bodies (4km world) vs a single-body control.
 * 2. 2-minute high-speed traverse (70 m/s = racing measured top speed with
 *    boost): a physical sphere driven along a snake path; per frame we run
 *    terrain.update(focus) exactly like Engine.step does, then world.step.
 *    Records stream queue depth, loaded body count, build ms, focus-chunk
 *    residency, and clearance (falls / pops / tunneling).
 *
 * Usage: npx tsx scripts/measure-traverse-maxsize.ts [size=4000] [seconds=120]
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics, GROUP } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { generateSpec } from '../src/generator/generate';
import { worldToChunk } from '../src/engine/world/chunkLayout';

function makeEl(tag = 'div'): any {
  const el: any = {
    tag, children: [] as any[], style: {} as Record<string, string>,
    appendChild(c: any) { el.children.push(c); return c; },
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
  };
  return el;
}
(globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head') };

const SIZE = Number(process.argv[2] ?? 4000);
const SECONDS = Number(process.argv[3] ?? 120);
const SPEED = 70; // m/s — racing measured top speed with boost held (racing.ts comment)

function buildWorld(size: number) {
  const spec = generateSpec('a heroic knight adventure', { seed: 4242 });
  spec.world.terrain.type = 'hills';
  spec.world.terrain.size = size;
  spec.world.terrain.water = false;
  const physics = new Physics(spec.world.gravity);
  const mats = new MaterialLibrary(spec);
  const scene = new THREE.Scene();
  const t0 = performance.now();
  const terrain = new Terrain(spec, physics, mats, scene);
  return { spec, physics, mats, scene, terrain, buildMs: performance.now() - t0 };
}

function benchStep(world: CANNON.World, iters: number): { mean: number; median: number; p95: number } {
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    world.step(1 / 60);
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  const mean = ts.reduce((s, v) => s + v, 0) / ts.length;
  return { mean, median: ts[Math.floor(ts.length / 2)], p95: ts[Math.floor(ts.length * 0.95)] };
}

// ------------------------------------------------------------------ build
const { physics, terrain } = buildWorld(SIZE);
const world = physics.world;
const half = SIZE / 2;
const focus = new THREE.Vector3();

// ------------------------------------------------- 1. broadphase benchmark
// Park the sphere high above the terrain (no contacts): world.step cost is
// then broadphase + integration only.
const probe = new CANNON.Body({ mass: 10, shape: new CANNON.Sphere(1), collisionFilterGroup: GROUP.PLAYER });
probe.position.set(0, 500, 0);
world.addBody(probe);

// Warm: force a center streaming state (~max resident bodies for travel)
terrain.update(new THREE.Vector3(0, 0, 0));
const residentMany = world.bodies.length;
const manyBodies = benchStep(world, 2000);

// Control: keep only the origin chunk body + walls, remove the rest.
const keep = new Set(terrain.loadedChunkBodies.slice(0, 1));
const removed: CANNON.Body[] = [];
for (const b of [...terrain.loadedChunkBodies]) {
  if (!keep.has(b)) { world.removeBody(b); removed.push(b); }
}
const residentFew = world.bodies.length;
const fewBodies = benchStep(world, 2000);
for (const b of removed) world.addBody(b); // restore for the traverse
world.removeBody(probe);

const r4 = (v: number) => +v.toFixed(4);
console.log(JSON.stringify({
  size: SIZE, chunkSize: terrain.chunkSize,
  broadphase: {
    bodiesMany: residentMany, bodiesFew: residentFew,
    stepMs_many: { mean: r4(manyBodies.mean), median: r4(manyBodies.median), p95: r4(manyBodies.p95) },
    stepMs_one: { mean: r4(fewBodies.mean), median: r4(fewBodies.median), p95: r4(fewBodies.p95) },
    delta_median_ms: r4(manyBodies.median - fewBodies.median),
  },
}, null, 1));

// ------------------------------------------------- 2. high-speed traverse
const car = new CANNON.Body({
  mass: 400,
  shape: new CANNON.Box(new CANNON.Vec3(1, 0.5, 2)),
  collisionFilterGroup: GROUP.VEHICLE,
  collisionFilterMask: GROUP.WORLD,
});
const leg = half - 100;
const waypoints: Array<[number, number]> = [];
{
  // snake: legs along x, stepping in z
  const zs: number[] = [];
  for (let z = -leg; z <= leg; z += 500) zs.push(z);
  zs.forEach((z, i) => {
    if (i % 2 === 0) { waypoints.push([-leg, z], [leg, z]); }
    else { waypoints.push([leg, z], [-leg, z]); }
  });
}
car.position.set(waypoints[0][0], terrain.heightAt(waypoints[0][0], waypoints[0][1]) + 2, waypoints[0][1]);
world.addBody(car);

let wpIdx = 1;
const frames = SECONDS * 60;
let qMax = 0, qSum = 0, buildMax = 0, buildSum = 0, loadedMax = 0;
let focusMiss = 0, minClear = Infinity, maxDy = 0, maxDh = 0;
let pageIns = 0, pageOuts = 0, lastLoaded = terrain.getStreamStats().loaded;
let streamMsMax = 0, stepMsMax = 0, pathLen = 0;
let streamMsMaxFrame = -1, seamCrossings = 0, seamMinClear = Infinity;
let prevCx = -1, prevCz = -1;
let prevY = car.position.y, prevX = car.position.x, prevZ = car.position.z;
const qSeries: number[] = [];

const f0 = new THREE.Vector3();
for (let f = 0; f < frames; f++) {
  // steer toward waypoint (kinematic steering, vertical stays physical)
  let [wx, wz] = waypoints[wpIdx];
  const dx = wx - car.position.x, dz = wz - car.position.z;
  if (Math.hypot(dx, dz) < 60 && wpIdx < waypoints.length - 1) {
    wpIdx++;
    [wx, wz] = waypoints[wpIdx];
  }
  const dl = Math.hypot(wx - car.position.x, wz - car.position.z) || 1;
  car.wakeUp(); // cannon-es: setting .velocity never wakes a sleeping body
  car.velocity.x = ((wx - car.position.x) / dl) * SPEED;
  car.velocity.z = ((wz - car.position.z) / dl) * SPEED;

  f0.set(car.position.x, car.position.y, car.position.z);
  const tS = performance.now();
  terrain.update(f0);
  const streamMs = performance.now() - tS;
  const tP = performance.now();
  world.step(1 / 60);
  const stepMs = performance.now() - tP;

  const st = terrain.getStreamStats();
  qMax = Math.max(qMax, st.queue); qSum += st.queue;
  buildMax = Math.max(buildMax, st.buildMs); buildSum += st.buildMs;
  loadedMax = Math.max(loadedMax, st.loaded);
  streamMsMax = Math.max(streamMsMax, streamMs);
  if (streamMs === streamMsMax) streamMsMaxFrame = f;
  stepMsMax = Math.max(stepMsMax, stepMs);
  if (st.loaded > lastLoaded) pageIns += st.loaded - lastLoaded;
  if (st.loaded < lastLoaded) pageOuts += lastLoaded - st.loaded;
  lastLoaded = st.loaded;
  if (f % 60 === 0) qSeries.push(st.queue);

  const { cx, cz } = worldToChunk(car.position.x, car.position.z, {
    chunksPerSide: Math.round(SIZE / terrain.chunkSize),
    cellsPerChunk: 0, chunkSize: terrain.chunkSize, cell: 0, half, res: 0,
  });
  if (!terrain.isChunkLoaded(cx, cz)) focusMiss++;
  if (prevCx >= 0 && (cx !== prevCx || cz !== prevCz)) {
    seamCrossings++;
    seamMinClear = Math.min(seamMinClear, car.position.y - terrain.heightAt(car.position.x, car.position.z));
  }
  prevCx = cx; prevCz = cz;

  const h = terrain.heightAt(car.position.x, car.position.z);
  const clear = car.position.y - h;
  minClear = Math.min(minClear, clear);
  const dy = Math.abs(car.position.y - prevY);
  const dh = Math.abs(h - terrain.heightAt(prevX, prevZ));
  maxDy = Math.max(maxDy, dy); maxDh = Math.max(maxDh, dh);
  pathLen += Math.hypot(car.position.x - prevX, car.position.z - prevZ);
  prevY = car.position.y; prevX = car.position.x; prevZ = car.position.z;
}

const dist = Math.hypot(car.position.x - waypoints[0][0], car.position.z - waypoints[0][1]);
console.log(JSON.stringify({
  traverse: {
    seconds: SECONDS, frames, speed_m_s: SPEED,
    distance_from_start_m: Math.round(dist),
    path_length_m: Math.round(pathLen),
    waypoints_reached: wpIdx,
    queue_max: qMax, queue_mean: +(qSum / frames).toFixed(3),
    queue_series_1s: qSeries,
    buildMs_max: +buildMax.toFixed(3), buildMs_mean: +(buildSum / frames).toFixed(3),
    loadedBodies_max: loadedMax, pageIns, pageOuts,
    focusChunk_missing_frames: focusMiss,
    seamCrossings, seamMinClearance_m: +seamMinClear.toFixed(3),
    minClearance_m: +minClear.toFixed(3),
    maxFrameDy_m: +maxDy.toFixed(3), maxFrameTerrainDh_m: +maxDh.toFixed(3),
    streamUpdateMs_max: +streamMsMax.toFixed(3), streamUpdateMs_max_frame: streamMsMaxFrame,
    worldStepMs_max: +stepMsMax.toFixed(3),
  },
}, null, 1));
