/**
 * Photo mode orbit math: clamping, spherical offset, and the no-jump
 * enter derivation (deriveOrbit inverts orbitOffset exactly). The DOM
 * controller itself is covered by the photo-mode e2e spec (no jsdom
 * in this suite — same pattern as the other DOM-owning modules).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  clampOrbit, deriveOrbit, orbitOffset,
  PHOTO_ORBIT_MIN_DIST, PHOTO_ORBIT_MAX_DIST,
  PHOTO_ORBIT_MIN_PITCH, PHOTO_ORBIT_MAX_PITCH,
} from '../src/engine/game/PhotoMode';

describe('clampOrbit', () => {
  it('clamps distance and pitch, leaves yaw free', () => {
    const o = clampOrbit({ yaw: 9, pitch: 5, distance: 500 });
    expect(o.distance).toBe(PHOTO_ORBIT_MAX_DIST);
    expect(o.pitch).toBe(PHOTO_ORBIT_MAX_PITCH);
    expect(o.yaw).toBe(9);
    const o2 = clampOrbit({ yaw: -9, pitch: -5, distance: 0.1 });
    expect(o2.distance).toBe(PHOTO_ORBIT_MIN_DIST);
    expect(o2.pitch).toBe(PHOTO_ORBIT_MIN_PITCH);
  });

  it('passes a legal orbit through unchanged', () => {
    const o = { yaw: 0.7, pitch: 0.3, distance: 7.5 };
    expect(clampOrbit(o)).toEqual(o);
  });
});

describe('orbitOffset / deriveOrbit', () => {
  it('places the camera at the orbit distance from the look target', () => {
    const out = new THREE.Vector3();
    orbitOffset({ yaw: 0, pitch: 0, distance: 10 }, out);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(10, 9);
    orbitOffset({ yaw: Math.PI / 2, pitch: 0, distance: 4 }, out);
    expect(out.x).toBeCloseTo(4, 9);
    expect(out.z).toBeCloseTo(0, 9);
  });

  it('deriveOrbit inverts orbitOffset (no-jump enter transition)', () => {
    const look = new THREE.Vector3(10, 1.2, -5);
    for (const o of [
      { yaw: 0.4, pitch: 0.25, distance: 7.5 },
      { yaw: -2.1, pitch: 0.9, distance: 20 },
      { yaw: 3.0, pitch: -0.1, distance: 3.5 },
    ]) {
      const off = orbitOffset(o, new THREE.Vector3());
      const cam = look.clone().add(off);
      const back = deriveOrbit(cam, look);
      expect(back.yaw).toBeCloseTo(o.yaw, 9);
      expect(back.pitch).toBeCloseTo(o.pitch, 9);
      expect(back.distance).toBeCloseTo(o.distance, 9);
    }
  });

  it('deriveOrbit clamps an out-of-range camera framing into the orbit box', () => {
    const look = new THREE.Vector3(0, 1.2, 0);
    const far = new THREE.Vector3(0, 1.2, 500);
    const o = deriveOrbit(far, look);
    expect(o.distance).toBe(PHOTO_ORBIT_MAX_DIST);
    expect(o.pitch).toBeCloseTo(0, 9);
  });
});
