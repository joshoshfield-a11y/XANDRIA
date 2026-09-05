/**
 * Procedural low-poly characters + vehicles. PS2-era: chunky boxes, flat colors, baked limb
 * swing animation driven by movement speed. No skeletal rigs, no external models.
 */
import * as THREE from 'three';
import type { MaterialLibrary } from './Materials';
import { Rng } from '../core/Rng';

export interface CharacterRig {
  group: THREE.Group;
  /** limbs keyed for animation */
  limbs: { legL: THREE.Object3D; legR: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D; torso: THREE.Object3D; head: THREE.Object3D; weaponMount?: THREE.Object3D };
  /** call every frame with planar speed (m/s) */
  animate(t: number, speed: number, opts?: { attacking?: number; dead?: boolean }): void;
  /** trigger a melee swing animation (self-advancing) */
  swing(): void;
  setDead(dead: boolean): void;
  flash(): void; // damage blink
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Classic chunky humanoid, ~1.8m tall. Origin at feet. */
export function makeHumanoid(mats: MaterialLibrary, colors: { skin?: string; shirt?: string; pants?: string; accent?: string; bulk?: number }, seed = 1): CharacterRig {
  const rng = new Rng(seed);
  const bulk = colors.bulk ?? 1;
  const skin = mats.flat(colors.skin ?? '#d8a077', { roughness: 0.8 });
  const shirt = mats.flat(colors.shirt ?? '#3a6ea5', { roughness: 0.85 });
  const pants = mats.flat(colors.pants ?? '#3d3a35', { roughness: 0.9 });
  const accent = mats.flat(colors.accent ?? '#ffd23f', { roughness: 0.5, metalness: 0.3 });

  const group = new THREE.Group();
  const torso = box(0.62 * bulk, 0.7, 0.34 * bulk, shirt, 0, 1.12, 0);
  const head = box(0.34, 0.34, 0.32, skin, 0, 1.66, 0);
  // visor / eyes
  head.add(box(0.26, 0.08, 0.05, accent, 0, 0.02, 0.17));
  // shoulder pads
  torso.add(box(0.2 * bulk, 0.12, 0.38 * bulk, accent, 0.36 * bulk, 0.34, 0));
  torso.add(box(0.2 * bulk, 0.12, 0.38 * bulk, accent, -0.36 * bulk, 0.34, 0));

  const mkLimb = (mat: THREE.Material, w: number, len: number) => {
    const pivot = new THREE.Group();
    const seg = box(w, len, w, mat, 0, -len / 2, 0);
    pivot.add(seg);
    return pivot;
  };
  const armL = mkLimb(shirt, 0.17 * bulk, 0.62); armL.position.set(0.42 * bulk, 1.42, 0);
  const armR = mkLimb(shirt, 0.17 * bulk, 0.62); armR.position.set(-0.42 * bulk, 1.42, 0);
  const legL = mkLimb(pants, 0.2 * bulk, 0.74); legL.position.set(0.17 * bulk, 0.74, 0);
  const legR = mkLimb(pants, 0.2 * bulk, 0.74); legR.position.set(-0.17 * bulk, 0.74, 0);

  group.add(torso, head, armL, armR, legL, legR);

  const baseY = { torso: torso.position.y, head: head.position.y };
  let flashTime = 0;
  let atkT = -1; // self-advancing swing timer (1 → 0)
  const allMats = [skin, shirt, pants, accent];

  return {
    group,
    limbs: { legL, legR, armL, armR, torso, head, weaponMount: armR },
    swing() { atkT = 1; },
    animate(t, speed, opts = {}) {
      const k = Math.min(1, speed / 6);
      const f = t * (8 + k * 4);
      const sw = Math.sin(f) * 0.7 * k;
      legL.rotation.x = sw; legR.rotation.x = -sw;
      armL.rotation.x = -sw * 0.85; armR.rotation.x = sw * 0.85;
      let atkP = opts.attacking && opts.attacking > 0 ? opts.attacking : 0;
      if (!atkP && atkT >= 0) { atkP = 1 - atkT; atkT -= 0.045; if (atkT < 0) atkT = -1; }
      if (atkP > 0) {
        // overhead slash: 0..1 progress
        const p = atkP;
        armR.rotation.x = -2.4 + p * 3.2;
        armR.rotation.z = 0.4 - p * 0.5;
      } else armR.rotation.z = 0;
      const bob = Math.abs(Math.sin(f)) * 0.05 * k;
      torso.position.y = baseY.torso + bob;
      head.position.y = baseY.head + bob;
      if (opts.dead) {
        group.rotation.x = -Math.PI / 2 * Math.min(1, (group.userData.deadT = (group.userData.deadT ?? 0) + 0.03));
      }
      if (flashTime > 0) {
        flashTime -= 0.016;
        const on = Math.floor(flashTime * 20) % 2 === 0;
        for (const m of allMats) m.emissive.setHex(on ? 0xff2222 : 0x000000), m.emissiveIntensity = on ? 0.8 : 0;
      }
    },
    setDead(dead) { if (dead) group.userData.deadT = 0; },
    flash() { flashTime = 0.25; },
  };
}

/** Floating drone: body + rotor ring + eye. Origin at center. */
export function makeDrone(mats: MaterialLibrary, color = '#c33', eye = '#ff4444'): CharacterRig {
  const group = new THREE.Group();
  const body = mats.flat(color, { roughness: 0.4, metalness: 0.6 });
  const core = box(0.7, 0.3, 0.7, body, 0, 0, 0);
  const eyeM = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), mats.glow(eye, 2));
  eyeM.position.set(0, 0, 0.36);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.06, 6, 16), mats.flat('#444a55', { metalness: 0.7, roughness: 0.3 }));
  ring.rotation.x = Math.PI / 2;
  const rotorL = box(0.5, 0.03, 0.1, mats.flat('#222'), 0.55, 0.12, 0);
  const rotorR = box(0.5, 0.03, 0.1, mats.flat('#222'), -0.55, 0.12, 0);
  group.add(core, eyeM, ring, rotorL, rotorR);
  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  let flashTime = 0;
  return {
    group,
    limbs: { legL: rotorL, legR: rotorR, armL: rotorL, armR: rotorR, torso: core, head: eyeM },
    animate(t) {
      rotorL.rotation.y = t * 40; rotorR.rotation.y = -t * 40;
      group.position.y += 0; // hover handled by AI
      core.rotation.y = Math.sin(t * 1.3) * 0.15;
      if (flashTime > 0) { flashTime -= 0.016; body.emissive.setHex(Math.floor(flashTime * 20) % 2 ? 0xff2222 : 0); body.emissiveIntensity = 0.9; }
    },
    swing() { /* drones don't melee */ },
    setDead() { /* explosion handled by AI */ },
    flash() { flashTime = 0.25; },
  };
}

/** Static turret: base + swiveling head + barrel. */
export function makeTurret(mats: MaterialLibrary, color = '#5a6270', accent = '#ff5533'): { group: THREE.Group; head: THREE.Group; muzzle: THREE.Object3D } {
  const group = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.65, 0.7, 8), mats.flat(color, { metalness: 0.6, roughness: 0.4 }));
  base.position.y = 0.35; base.castShadow = true;
  const head = new THREE.Group(); head.position.y = 0.85;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), mats.flat(color, { metalness: 0.6, roughness: 0.35 }));
  dome.castShadow = true;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 6), mats.flat('#222831', { metalness: 0.8, roughness: 0.3 }));
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0, 0.55);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, 1.0);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), mats.glow(accent, 2.5));
  eye.position.set(0, 0.12, 0.36);
  head.add(dome, barrel, muzzle, eye);
  group.add(base, head);
  return { group, head, muzzle };
}

/** Low-poly car. Origin at chassis center. Returns wheel meshes for spin/steer. */
export function makeCar(mats: MaterialLibrary, color: string, seed = 1): { group: THREE.Group; wheels: THREE.Mesh[]; bodyMesh: THREE.Mesh } {
  const rng = new Rng(seed);
  const group = new THREE.Group();
  const paint = mats.flat(color, { roughness: 0.35, metalness: 0.5 });
  const dark = mats.flat('#1c1f24', { roughness: 0.6 });
  const glass = mats.flat('#9fd4e8', { roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0.85 });

  const bodyMesh = box(1.9, 0.5, 3.6, paint, 0, 0.35, 0);
  const cabin = box(1.6, 0.45, 1.7, glass, 0, 0.78, -0.25);
  const spoiler = box(1.7, 0.08, 0.4, paint, 0, 0.85, 1.65);
  spoiler.add(box(0.08, 0.25, 0.3, paint, 0.7, -0.15, 0), box(0.08, 0.25, 0.3, paint, -0.7, -0.15, 0));
  const bumperF = box(1.95, 0.28, 0.25, dark, 0, 0.22, -1.78);
  const bumperR = box(1.95, 0.28, 0.25, dark, 0, 0.22, 1.78);
  const hl = mats.glow('#fff6c8', 1.6), tl = mats.glow('#ff2233', 1.6);
  group.add(bodyMesh, cabin, spoiler, bumperF, bumperR);
  group.add(box(0.3, 0.14, 0.06, hl, 0.6, 0.42, -1.82), box(0.3, 0.14, 0.06, hl, -0.6, 0.42, -1.82));
  group.add(box(0.35, 0.12, 0.06, tl, 0.6, 0.42, 1.82), box(0.35, 0.12, 0.06, tl, -0.6, 0.42, 1.82));

  const wheels: THREE.Mesh[] = [];
  const wg = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 12);
  wg.rotateZ(Math.PI / 2);
  const wm = mats.flat('#14161a', { roughness: 0.9 });
  const hub = mats.flat('#b9c0c9', { metalness: 0.8, roughness: 0.3 });
  const wp: [number, number][] = [[0.85, -1.15], [-0.85, -1.15], [0.85, 1.15], [-0.85, 1.15]];
  for (const [x, z] of wp) {
    const w = new THREE.Mesh(wg, wm);
    w.position.set(x, 0, z);
    w.castShadow = true;
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.32, 8), hub);
    h.rotation.z = Math.PI / 2;
    w.add(h);
    wheels.push(w);
    group.add(w);
  }
  return { group, wheels, bodyMesh };
}

/** Simple flag marker for goals/checkpoints. */
export function makeGoalFlag(mats: MaterialLibrary, color = '#ffd23f'): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 5, 6), mats.flat('#e8e8e8', { metalness: 0.6, roughness: 0.3 }));
  pole.position.y = 2.5;
  const flag = box(1.6, 1, 0.06, mats.glow(color, 1.2), 0.85, 4.3, 0);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 0.4, 8), mats.flat('#555c66'));
  base.position.y = 0.2;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.08, 8, 32), mats.glow(color, 1.8));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.15;
  g.add(pole, flag, base, ring);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}
