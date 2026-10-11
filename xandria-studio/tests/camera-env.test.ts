/**
 * Camera collision + Props determinism/shatter tests (inventory wave, camera-env crew).
 *
 * Headless: real cannon-es physics (a static wall body + player capsule), real
 * THREE math (PerspectiveCamera constructs fine without GL), stubbed input and
 * material library. No DOM, no renderer.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeCameraRig, type CameraCollisionOpts } from '../src/engine/game/Cameras';
import { Physics, GROUP } from '../src/engine/core/Physics';
import { Rng } from '../src/engine/core/Rng';
import { scatterProps, shatterBurst, FRAGILE_KINDS, type PropPalette } from '../src/engine/gfx/Props';
import type { MaterialLibrary } from '../src/engine/gfx/Materials';
import type { Input } from '../src/engine/core/Input';

const stubInput = () => ({ look: { x: 0, y: 0 } } as unknown as Input);
const stubMats = () => ({
  standard: (_k: string, hex: string) => new THREE.MeshStandardMaterial({ color: hex }),
  glow: (hex: string) => new THREE.MeshStandardMaterial({ color: hex, emissive: hex }),
} as unknown as MaterialLibrary);
const PAL: PropPalette = {
  primary: '#ff2233', secondary: '#33ff44', accent: '#33aaff', rock: '#888888', ground: '#554433',
};

function makeRig(kind: 'third-person' | 'chase' | 'side', collision?: CameraCollisionOpts) {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  return makeCameraRig(kind, cam, stubInput(), undefined, collision);
}

/** Player capsule tall enough that the look target (y=1.2) sits inside it. */
function makePlayer(physics: Physics) {
  return physics.capsule(0.6, 3.0, [0, 0, 0], { group: GROUP.PLAYER });
}

const TARGET = new THREE.Vector3(0, 0, 0);
const STILL = new THREE.Vector3(0, 0, 0);
const DT = 1 / 60;

describe('camera collision: third-person wall', () => {
  it('clamps the boom in front of a wall between look target and camera', () => {
    const physics = new Physics(-20);
    const player = makePlayer(physics);
    // wall between the look target (0,1.2,0) and the desired camera (0,4.36,-7.12)
    physics.box([10, 6, 1], [0, 3, -4], { mass: 0, group: GROUP.WORLD });

    const rig = makeRig('third-person', { physics, skipBody: player });
    rig.update(DT, TARGET, STILL, 0);
    const p = rig.camera.position;

    // desired (unclamped) spot: y=-sin(-0.32)*7.5+2.0 ≈ 4.36, z=-cos(-0.32)*7.5 ≈ -7.12
    // wall front face at z=-3.5; margin 0.45 → camera must stop before the wall
    expect(p.z).toBeGreaterThan(-3.6);
    expect(p.z).toBeLessThan(-2.5);
    // boom pulled in: much closer to the look target than the full 7.79 m segment
    const look = new THREE.Vector3(0, 1.2, 0);
    expect(p.distanceTo(look)).toBeLessThan(4.5);
  });

  it('skipBody excludes the avatar: without it the probe stops at the player, with it at the wall', () => {
    // player capsule sits ON the look→camera segment (not containing the look
    // target): from (0,1.2,0) toward (0,4.36,-7.12), t=0.45 → (0,2.62,-3.20).
    // In GROUP.WORLD so the default probe mask sees it (a GROUP.PLAYER avatar
    // would already be masked out — skipBody is the belt-and-braces exclusion
    // for custom masks, and this is what exercises the wave-beta semantics).
    const mkWorld = (withSkip: boolean) => {
      const physics = new Physics(-20);
      const player = physics.capsule(0.5, 1.6, [0, 2.62, -3.2], { group: GROUP.WORLD });
      physics.box([10, 6, 1], [0, 3, -4], { mass: 0, group: GROUP.WORLD });
      const rig = makeRig('third-person', withSkip ? { physics, skipBody: player } : { physics });
      rig.update(DT, TARGET, STILL, 0);
      return rig.camera.position.distanceTo(new THREE.Vector3(0, 1.2, 0));
    };
    const dSkip = mkWorld(true);
    const dNoSkip = mkWorld(false);
    expect(dSkip).toBeGreaterThan(3.0);   // probe passes the avatar, stops at the wall
    expect(dNoSkip).toBeLessThan(3.0);     // probe stops at the avatar
    expect(dNoSkip).toBeLessThan(dSkip);
  });

  it('no wall → position identical to the collision-free rig', () => {
    const physics = new Physics(-20);
    const player = makePlayer(physics);
    const a = makeRig('third-person', { physics, skipBody: player });
    const b = makeRig('third-person');
    for (let i = 0; i < 30; i++) {
      a.update(DT, TARGET, STILL, 0);
      b.update(DT, TARGET, STILL, 0);
    }
    expect(a.camera.position.distanceTo(b.camera.position)).toBeLessThan(1e-9);
  });

  it('boom regrows smoothly once the wall is gone (no popping)', () => {
    const physics = new Physics(-20);
    const player = makePlayer(physics);
    const wall = physics.box([10, 6, 1], [0, 3, -4], { mass: 0, group: GROUP.WORLD });
    const rig = makeRig('third-person', { physics, skipBody: player });
    for (let i = 0; i < 10; i++) rig.update(DT, TARGET, STILL, 0);
    const look = new THREE.Vector3(0, 1.2, 0);
    const clamped = rig.camera.position.distanceTo(look);
    expect(clamped).toBeLessThan(4.5);

    physics.remove(wall);
    for (let i = 0; i < 240; i++) rig.update(DT, TARGET, STILL, 0);
    const full = 7.79; // unclamped segment length for third-person at pitch -0.32
    expect(rig.camera.position.distanceTo(look)).toBeGreaterThan(full * 0.95);
  });
});

describe('camera collision: chase + side rigs', () => {
  it('chase rig clamps behind the car when a wall blocks the boom', () => {
    const physics = new Physics(-20);
    const player = makePlayer(physics);
    physics.box([20, 8, 1], [0, 4, -5], { mass: 0, group: GROUP.WORLD });
    const rig = makeRig('chase', { physics, skipBody: player });
    // driving +z at 10 m/s: chase yaw settles to 0, camera wants (0, ~5.8, ~-9.7)
    for (let i = 0; i < 5; i++) rig.update(DT, TARGET, new THREE.Vector3(0, 0, 10), 0);
    const p = rig.camera.position;
    expect(p.z).toBeGreaterThan(-4.6); // wall front face at z=-4.5
    expect(p.z).toBeLessThan(-2);
  });

  it('side rig clamps against a wall on the camera side', () => {
    const physics = new Physics(-20);
    const player = makePlayer(physics);
    physics.box([10, 8, 1], [0, 4, 8], { mass: 0, group: GROUP.WORLD });
    const rig = makeRig('side', { physics, skipBody: player });
    rig.update(DT, TARGET, STILL, 0);
    // desired z=13; wall front face at z=7.5
    expect(rig.camera.position.z).toBeLessThan(7.6);
    expect(rig.camera.position.z).toBeGreaterThan(4);
  });
});

describe('Props: determinism, quality tiers, shatter', () => {
  function scatter(seed: number, quality: 'retro' | 'standard' | 'high', count = 26) {
    const scene = new THREE.Scene();
    const rng = new Rng(seed);
    const field = scatterProps(scene, rng, {
      mats: stubMats(), pal: PAL, quality, count, half: 40,
      groundY: () => 0,
    });
    return { scene, field };
  }

  it('same seed → same transforms', () => {
    const a = scatter(1234, 'high');
    const b = scatter(1234, 'high');
    expect(a.field.props.length).toBe(b.field.props.length);
    expect(a.field.props.length).toBeGreaterThan(0);
    for (let i = 0; i < a.field.props.length; i++) {
      const pa = a.field.props[i], pb = b.field.props[i];
      expect(pa.kind).toBe(pb.kind);
      expect(pa.node.position.equals(pb.node.position)).toBe(true);
      expect(pa.node.rotation.y).toBe(pb.node.rotation.y);
      expect(pa.node.scale.equals(pb.node.scale)).toBe(true);
    }
  });

  it('quality tiers scale counts down (retro < standard < high)', () => {
    const r = scatter(77, 'retro').field.props.length;
    const s = scatter(77, 'standard').field.props.length;
    const h = scatter(77, 'high').field.props.length;
    expect(r).toBeLessThan(s);
    expect(s).toBeLessThan(h);
  });

  it('tryShatter removes fragile props in range and fires bursts', () => {
    const scene = new THREE.Scene();
    const field = scatterProps(scene, new Rng(42), {
      mats: stubMats(), pal: PAL, quality: 'high', count: 12, half: 20,
      kinds: ['crystal', 'vase'], groundY: () => 0,
    });
    expect(field.props.length).toBeGreaterThan(0);
    expect(field.props.every((p) => FRAGILE_KINDS.has(p.kind))).toBe(true);

    const target = field.props[0];
    const before = field.props.length;
    const bursts: string[] = [];
    const n = field.tryShatter(target.pos.clone(), 1.5, (_p, kind) => bursts.push(kind));

    expect(n).toBeGreaterThanOrEqual(1);
    expect(bursts.length).toBe(n);
    expect(field.props).not.toContain(target);
    expect(target.node.parent).toBeNull();
    expect(field.props.length).toBe(before - n);
    expect(field.shattered).toBe(n);
    // burst payloads are valid particle options
    const opts = shatterBurst('crystal', PAL.accent);
    expect(opts.count).toBeGreaterThan(0);
  });

  it('tryShatter leaves non-fragile props alone', () => {
    const scene = new THREE.Scene();
    const field = scatterProps(scene, new Rng(9), {
      mats: stubMats(), pal: PAL, quality: 'high', count: 10, half: 20,
      kinds: ['crate', 'pillar', 'barrel'], groundY: () => 0,
    });
    const before = field.props.length;
    const n = field.tryShatter(field.props[0].pos.clone(), 5);
    expect(n).toBe(0);
    expect(field.props.length).toBe(before);
  });

  it('dispose tears the field down without touching shared materials', () => {
    const { scene, field } = scatter(5, 'standard');
    expect(scene.children).toContain(field.group);
    const nProps = field.props.length;
    expect(nProps).toBeGreaterThan(0);
    field.dispose();
    expect(field.props.length).toBe(0);
    expect(scene.children).not.toContain(field.group);
  });
});
