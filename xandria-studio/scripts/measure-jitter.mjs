/**
 * Open World Stage 1b — workstream B: float32 jitter-vs-distance measurement.
 *
 * Headless harness (node, no browser/WebGL). Faithfully simulates the
 * three.js r182 transform pipeline for terrain-chunk vertices:
 *
 *   - three.js composes modelViewMatrix = camera.matrixWorldInverse *
 *     object.matrixWorld in float64 JS (Matrix4.elements are f64), then
 *     uploads it as float32 uniforms.
 *   - The vertex shader then computes gl_Position = P * MV * position in
 *     float32, with per-operation rounding.
 *
 * Two pipelines are simulated:
 *   ACTUAL (current engine): chunk mesh at origin, vertex attributes in
 *     WORLD coordinates (Float32Array), camera at world position c.
 *   FIXED (camera-relative): vertex attributes chunk-LOCAL (world minus
 *     chunk origin, float32), mesh at chunk origin, scene shifted by -O and
 *     camera at (c - O), O = camera world position.
 *
 * Metrics per camera distance D from origin:
 *   attrErr  max |f32(v) - v| in world units (vertex attribute quantization)
 *   static   max pixel |actual - f64 reference| (stationary-camera error)
 *   swim     max pixel deviation of a 2mm camera dolly's frame-to-frame
 *            displacement from the f64 reference (temporal instability)
 *
 * Usage:
 *   node scripts/measure-jitter.mjs [--three=/path/to/three.module.js]
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const threeArg = args.find((a) => a.startsWith('--three='));
const threePath = threeArg
  ? threeArg.slice('--three='.length)
  : '/home/hatch/workspace/xandria/repo/xandria-studio/node_modules/three/build/three.module.js';
const THREE = await import(threePath);

const f32 = Math.fround;
const W = 1920, H = 1080;

/** float32-rounded 4x4 matrix * vec4, faithful per-op rounding like a shader. */
function mv4f32(m, x, y, z, w) {
  const e = m.elements;
  const dot = (r) => {
    let s = f32(f32(e[r] * x) + f32(e[r + 4] * y));
    s = f32(s + f32(e[r + 8] * z));
    s = f32(s + f32(e[r + 12] * w));
    return s;
  };
  return [dot(0), dot(1), dot(2), dot(3)];
}

/** Upload rounding: f64 matrix -> float32 uniform, element-wise. */
function uploadF32(m) {
  const o = new THREE.Matrix4();
  const e = m.elements, d = o.elements;
  for (let i = 0; i < 16; i++) d[i] = f32(e[i]);
  return o;
}

/** f64 reference projection of world vertex v with camera at c, rotation R. */
function projectRef(P, R, c, v) {
  const dx = v[0] - c[0], dy = v[1] - c[1], dz = v[2] - c[2];
  const e = R.elements; // view rotation is R^T (inverse of camera world rotation)
  const vx = e[0] * dx + e[1] * dy + e[2] * dz;
  const vy = e[4] * dx + e[5] * dy + e[6] * dz;
  const vz = e[8] * dx + e[9] * dy + e[10] * dz;
  const pe = P.elements;
  const cx = pe[0] * vx;
  const cy = pe[5] * vy;
  const cw = -vz;
  return [(cx / cw * 0.5 + 0.5) * W, (cy / cw * 0.5 + 0.5) * H, cw];
}

/** Shared: camera rotation looking from c toward look, and projection matrix. */
function cameraMats(c, look) {
  const cam = new THREE.PerspectiveCamera(66, W / H, 0.1, 20000);
  cam.position.set(c[0], c[1], c[2]);
  cam.lookAt(look[0], look[1], look[2]);
  cam.updateMatrixWorld();
  const R = new THREE.Matrix4().extractRotation(cam.matrixWorld);
  const P = cam.projectionMatrix.clone();
  return { R, P };
}

/**
 * Simulate one pipeline for a set of world vertices.
 * mode 'actual' | 'fixed'. Returns {px: Float64Array(2n), attrErr}
 */
function simulate(mode, P, R, c, verts, chunkOrigin) {
  const n = verts.length;
  const px = new Float64Array(n * 2);
  let attrErr = 0;
  const O = c; // render origin = camera world pos (fixed mode)
  const useShift = mode === 'fixed'; // rebaseOnly: chunk-local attrs, NO scene shift
  // f64 matrices, exactly as three.js composes them
  const V = new THREE.Matrix4().copy(
    new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion().setFromRotationMatrix(R),
    ),
  );
  // Build view matrix V = inverse(T(c') * R) with c' = render-frame camera pos
  const camPos = mode === 'actual'
    ? new THREE.Vector3(c[0], c[1], c[2])
    : useShift
      ? new THREE.Vector3(c[0] - O[0], c[1] - O[1], c[2] - O[2])
      : new THREE.Vector3(c[0], c[1], c[2]); // rebaseOnly: camera stays world-frame
  const camWorld = new THREE.Matrix4().compose(camPos, new THREE.Quaternion().setFromRotationMatrix(R), new THREE.Vector3(1, 1, 1));
  const Vinv = camWorld.invert(); // == three's matrixWorldInverse, f64
  let MW;
  if (mode === 'actual') {
    MW = new THREE.Matrix4(); // identity: mesh at origin, verts in world coords
  } else if (useShift) {
    const shift = new THREE.Matrix4().makeTranslation(-O[0], -O[1], -O[2]);
    const mesh = new THREE.Matrix4().makeTranslation(chunkOrigin[0], chunkOrigin[1], chunkOrigin[2]);
    MW = shift.multiply(mesh); // T(-O) * T(chunkOrigin), f64
  } else {
    // rebaseOnly: chunk-local attrs + mesh at chunk origin, no scene shift
    MW = new THREE.Matrix4().makeTranslation(chunkOrigin[0], chunkOrigin[1], chunkOrigin[2]);
  }
  const mvF64 = new THREE.Matrix4().multiplyMatrices(Vinv, MW);
  const mvUp = uploadF32(mvF64); // f32 uniform upload
  const Pup = uploadF32(P);
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    let ax, ay, az;
    if (mode !== 'actual') {
      ax = f32(v[0] - chunkOrigin[0]); ay = f32(v[1] - chunkOrigin[1]); az = f32(v[2] - chunkOrigin[2]);
      attrErr = Math.max(attrErr, Math.abs(ax - (v[0] - chunkOrigin[0])), Math.abs(az - (v[2] - chunkOrigin[2])));
    } else {
      ax = f32(v[0]); ay = f32(v[1]); az = f32(v[2]);
      attrErr = Math.max(attrErr, Math.abs(ax - v[0]), Math.abs(az - v[2]));
    }
    const p = mv4f32(mvUp, ax, ay, az, 1);
    const cl = mv4f32(Pup, p[0], p[1], p[2], p[3]);
    const w = cl[3];
    px[i * 2] = (f32(cl[0] / w) * 0.5 + 0.5) * W;
    px[i * 2 + 1] = (f32(cl[1] / w) * 0.5 + 0.5) * H;
  }
  return { px, attrErr };
}

/**
 * Instanced-scatter residual: global InstancedMesh pools (ChunkScatter /
 * Grass / Vegetation) bake WORLD translations into the float32
 * instanceMatrix. The RenderOrigin scene shift does not shrink those, so
 * this measures the residual wall the fix leaves behind.
 */
function simulateInstanced(P, R, c, fixed) {
  const O = fixed ? c : [0, 0, 0];
  const camPos = new THREE.Vector3(c[0] - O[0], c[1] - O[1], c[2] - O[2]);
  const camWorld = new THREE.Matrix4().compose(camPos, new THREE.Quaternion().setFromRotationMatrix(R), new THREE.Vector3(1, 1, 1));
  const Vinv = camWorld.invert();
  const MW = fixed ? new THREE.Matrix4().makeTranslation(-O[0], -O[1], -O[2]) : new THREE.Matrix4();
  const mvUp = uploadF32(new THREE.Matrix4().multiplyMatrices(Vinv, MW));
  const Pup = uploadF32(P);
  // a few prop instances ~30m ahead of the camera, 2m rock geometry
  const instances = [];
  for (let k = 0; k < 8; k++) instances.push([c[0] - 30 + k * 3.7, 0.5, (k - 4) * 5.3]);
  const local = [];
  for (let x = -1; x <= 1; x += 0.5) for (let y = 0; y <= 2; y += 0.5) for (let z = -1; z <= 1; z += 0.5) local.push([x, y, z]);
  let errMax = 0;
  for (const t of instances) {
    const im = new THREE.Matrix4().makeTranslation(f32(t[0]), f32(t[1]), f32(t[2]));
    for (const v of local) {
      const p1 = mv4f32(im, f32(v[0]), f32(v[1]), f32(v[2]), 1);
      const p2 = mv4f32(mvUp, p1[0], p1[1], p1[2], p1[3]);
      const cl = mv4f32(Pup, p2[0], p2[1], p2[2], p2[3]);
      const w = cl[3];
      if (w <= 0.5) continue;
      const sx = (f32(cl[0] / w) * 0.5 + 0.5) * W, sy = (f32(cl[1] / w) * 0.5 + 0.5) * H;
      if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
      // f64 reference: instance translation exact, view exact
      const ref = projectRef(P, R, c, [t[0] + v[0], t[1] + v[1], t[2] + v[2]]);
      errMax = Math.max(errMax, Math.hypot(sx - ref[0], sy - ref[1]));
    }
  }
  return errMax;
}

function measure(D, lookAhead = 30, camH = 2.0) {
  // camera at distance D from origin, camH up, looking lookAhead m ahead
  const c = [D, camH, 0];
  const look = [D - lookAhead, 0.2, 0];
  const { R, P } = cameraMats(c, look);
  // vertex grid: the terrain chunk in view (2.5m cells like the engine)
  const verts = [];
  for (let x = D - lookAhead - 128; x <= D - lookAhead + 128; x += 2.5)
    for (let z = -128; z <= 128; z += 2.5) verts.push([x, 0, z]);
  const chunkOrigin = [D - lookAhead - 128, 0, -128];
  const ref = verts.map((v) => projectRef(P, R, c, v));
  // keep only verts in front of the camera (w > 0)
  // visible-jitter metric: only vertices that actually land on screen
  const idx = [];
  for (let i = 0; i < verts.length; i++) {
    if (ref[i][2] > 0.5 && ref[i][0] >= 0 && ref[i][0] < W && ref[i][1] >= 0 && ref[i][1] < H) idx.push(i);
  }

  const out = {};
  for (const mode of ['actual', 'fixed', 'rebaseOnly']) {
    const { px, attrErr } = simulate(mode, P, R, c, verts, chunkOrigin);
    let staticMax = 0, worst = -1;
    for (const i of idx) {
      const dx = px[i * 2] - ref[i][0], dy = px[i * 2 + 1] - ref[i][1];
      const ee = Math.hypot(dx, dy);
      if (ee > staticMax) { staticMax = ee; worst = i; }
    }
    if (process.env.DEBUG_WORST && worst >= 0)
      console.log('  worst ' + mode + ' vert ' + verts[worst].join(',') +
        ' refpx ' + ref[worst][0].toFixed(1) + ',' + ref[worst][1].toFixed(1) +
        ' w ' + ref[worst][2].toFixed(2));
    // micro-motion: 2mm dolly along view dir -> frame-to-frame displacement
    const c2 = [c[0] - 0.002, c[1], c[2]];
    const { R: R2 } = cameraMats(c2, [look[0] - 0.002, look[1], look[2]]);
    const ref2 = verts.map((v) => projectRef(P, R2, c2, v));
    const s2 = simulate(mode, P, R2, c2, verts, chunkOrigin);
    let swimMax = 0;
    for (const i of idx) {
      const actD = Math.hypot(s2.px[i * 2] - px[i * 2], s2.px[i * 2 + 1] - px[i * 2 + 1]);
      const refD = Math.hypot(ref2[i][0] - ref[i][0], ref2[i][1] - ref[i][1]);
      swimMax = Math.max(swimMax, Math.abs(actD - refD));
    }
    out[mode] = { static: staticMax, swim: swimMax, attrErr };
  }
  return out;
}

const distances = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000];
console.log('D(m) | attrErr_a(mm) | static_a(px) | swim_a(px) || attrErr_f(mm) | static_f(px) | swim_f(px) | static_ro(px) || inst_a(px) | inst_f(px)');
const scenario = process.env.SCENARIO || 'trail';
const scLook = scenario === 'close' ? 6 : 30, scH = 2.0;
for (const D of distances) {
  const r = measure(D, scLook, scH);
  const f = (x, d = 2) => x.toFixed(d).padStart(8);
  const c = [D, scH, 0], look = [D - scLook, 0.2, 0];
  const { R: Ri, P: Pi } = cameraMats(c, look);
  const iBefore = simulateInstanced(Pi, Ri, c, false);
  const iAfter = simulateInstanced(Pi, Ri, c, true);
  console.log(
    `${String(D).padStart(5)} | ${f(r.actual.attrErr * 1000, 3)} | ${f(r.actual.static)} | ${f(r.actual.swim)} || ${f(r.fixed.attrErr * 1000, 3)} | ${f(r.fixed.static, 4)} | ${f(r.fixed.swim, 4)} | ${f(r.rebaseOnly.static, 4)} || ${f(iBefore)} | ${f(iAfter)}`,
  );
}
