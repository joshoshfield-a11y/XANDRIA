/**
 * Workstream F: physics render interpolation.
 *
 *  - stepped sim records prev/current transforms per dynamic body
 *  - syncMeshInterpolated lerps position / slerps quaternion by alpha in [0,1]
 *  - alpha=0 yields prev, alpha=1 yields current, fractional alpha lies between
 *  - bodies added/removed mid-frame never produce NaNs (prev = current on first sight)
 *  - interpolation is render-only: the fixed-step sim is bit-identical with or
 *    without interpolated sync calls
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Physics, syncMesh } from '../src/engine/core/Physics';

const EPS = 1e-6;

function makeSim() {
  const p = new Physics(-9.82);
  // Static ground so the sphere has something to interact with.
  p.box([50, 1, 50], [0, -0.5, 0], { mass: 0 });
  const body = p.sphere(0.5, [0, 5, 0], { mass: 1 });
  body.velocity.set(3, 0, 0);
  body.angularVelocity.set(0, 2, 0);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.5),
    new THREE.MeshBasicMaterial(),
  );
  return { p, body, mesh };
}

function noNaNs(o: THREE.Object3D) {
  for (const v of [o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]) {
    expect(Number.isNaN(v)).toBe(false);
  }
}

describe('physics render interpolation', () => {
  it('alpha=0 yields prev, alpha=1 yields current, alpha=0.5 lies between', () => {
    const { p, body, mesh } = makeSim();
    p.step(1 / 60); // first step: first-sight init (prev = current)
    p.step(1 / 60); // second step: prev = step-1 transform, current = step-2

    const st = p.interpState(body);
    expect(st.prevPos.distanceTo(st.curPos)).toBeGreaterThan(0); // the body moved

    p.syncMeshInterpolated(mesh, body, 0);
    expect(mesh.position.distanceTo(st.prevPos)).toBeLessThan(EPS);
    expect(mesh.quaternion.angleTo(st.prevQuat)).toBeLessThan(EPS);
    noNaNs(mesh);

    p.syncMeshInterpolated(mesh, body, 1);
    expect(mesh.position.distanceTo(st.curPos)).toBeLessThan(EPS);
    expect(mesh.quaternion.angleTo(st.curQuat)).toBeLessThan(EPS);

    // Fractional alpha: position is the exact lerp midpoint.
    p.syncMeshInterpolated(mesh, body, 0.5);
    const mid = new THREE.Vector3().lerpVectors(st.prevPos, st.curPos, 0.5);
    expect(mesh.position.distanceTo(mid)).toBeLessThan(EPS);
    // Each component lies between prev and current (monotone single-step motion).
    for (const k of ['x', 'y', 'z'] as const) {
      const lo = Math.min(st.prevPos[k], st.curPos[k]) - EPS;
      const hi = Math.max(st.prevPos[k], st.curPos[k]) + EPS;
      expect(mesh.position[k]).toBeGreaterThanOrEqual(lo);
      expect(mesh.position[k]).toBeLessThanOrEqual(hi);
    }
    // Quaternion lies on the slerp arc between prev and current.
    const arc = st.prevQuat.angleTo(st.curQuat);
    const viaMesh = st.prevQuat.angleTo(mesh.quaternion) + mesh.quaternion.angleTo(st.curQuat);
    expect(Math.abs(viaMesh - arc)).toBeLessThan(1e-4);
    expect(st.prevQuat.angleTo(mesh.quaternion)).toBeGreaterThan(0); // rotation moved too
    noNaNs(mesh);
  });

  it('clamps alpha to [0,1]', () => {
    const { p, body, mesh } = makeSim();
    p.step(1 / 60);
    p.syncMeshInterpolated(mesh, body, -5);
    const neg = mesh.position.clone();
    const negQ = mesh.quaternion.clone();
    p.syncMeshInterpolated(mesh, body, 0);
    expect(mesh.position.distanceTo(neg)).toBeLessThan(EPS);
    expect(mesh.quaternion.angleTo(negQ)).toBeLessThan(EPS);

    p.syncMeshInterpolated(mesh, body, 5);
    const over = mesh.position.clone();
    const overQ = mesh.quaternion.clone();
    p.syncMeshInterpolated(mesh, body, 1);
    expect(mesh.position.distanceTo(over)).toBeLessThan(EPS);
    expect(mesh.quaternion.angleTo(overQ)).toBeLessThan(EPS);

    // The convenience getter also stays clamped through real frame sequences.
    for (let i = 0; i < 10; i++) {
      p.step(1 / 30); // partial accumulator leftovers
      const a = p.getInterpolationAlpha();
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it('tracks accumulator/fixedStep between steps', () => {
    const { p } = makeSim();
    p.step(1 / 120); // half a fixed step: no substep runs, alpha should be ~0.5
    expect(Math.abs(p.getInterpolationAlpha() - 0.5)).toBeLessThan(1e-9);
  });

  it('body added mid-frame: prev = current on first sight, no NaNs', () => {
    const { p, mesh } = makeSim();
    p.step(1 / 60);
    const late = p.sphere(0.3, [10, 2, 0], { mass: 1 });
    // Render before the new body has ever been stepped.
    p.syncMeshInterpolated(mesh, late, 0.37);
    noNaNs(mesh);
    expect(mesh.position.x).toBeCloseTo(10, 9);
    expect(mesh.position.y).toBeCloseTo(2, 9);
    expect(mesh.position.z).toBeCloseTo(0, 9);
    // alpha extremes agree: nothing to interpolate yet.
    p.syncMeshInterpolated(mesh, late, 0);
    const at0 = mesh.position.clone();
    p.syncMeshInterpolated(mesh, late, 1);
    expect(mesh.position.distanceTo(at0)).toBeLessThan(EPS);
  });

  it('body removed mid-frame: no NaNs', () => {
    const { p, body, mesh } = makeSim();
    p.step(1 / 60);
    p.remove(body);
    p.syncMeshInterpolated(mesh, body, 0.6);
    noNaNs(mesh);
    p.step(1 / 60);
    p.syncMeshInterpolated(mesh, body, 0.2);
    noNaNs(mesh);
  });

  it('interpolation is render-only: fixed-step sim results are unchanged', () => {
    const a = makeSim();
    const b = makeSim();
    // Same dt sequence on both: substeps, partial frames, and a spiral-guard frame.
    const dts = [1 / 60, 1 / 120, 1 / 30, 0.09, 1 / 60, 1 / 240, 1 / 60, 0.2];
    for (const dt of dts) {
      a.p.step(dt);
      // Render-path interpolation calls interleaved on sim A only.
      a.p.syncMeshInterpolated(a.mesh, a.body);
      a.p.syncMeshInterpolated(a.mesh, a.body, 0.33);
      b.p.step(dt);
    }
    for (const k of ['x', 'y', 'z'] as const) {
      expect(a.body.position[k]).toBe(b.body.position[k]);
      expect(a.body.velocity[k]).toBe(b.body.velocity[k]);
    }
    for (const k of ['x', 'y', 'z', 'w'] as const) {
      expect(a.body.quaternion[k]).toBe(b.body.quaternion[k]);
    }
    // syncMesh (direct copy) still behaves as before.
    const { p, body, mesh } = makeSim();
    p.step(1 / 60);
    syncMesh(mesh, body);
    expect(mesh.position.x).toBe(body.position.x);
    expect(mesh.quaternion.w).toBe(body.quaternion.w);
  });
});
