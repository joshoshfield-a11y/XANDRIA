/**
 * Procedural low-poly characters + vehicles, forged per-seed by ModelForge.
 * PS2-era: chunky geometry, flat colors, baked limb-swing animation driven by
 * movement speed. No skeletal rigs, no external models — but no two games share
 * a cast: proportions, headgear, armor and extras all derive from the game seed.
 */
import * as THREE from 'three';
import type { MaterialLibrary } from './Materials';
import { forgeHumanoidPlan, forgeDronePlan, forgeVehiclePlan, type HumanoidPlan } from './ModelForge';

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

/** Attach forged headgear to a head mesh. */
function dressHead(head: THREE.Mesh, plan: HumanoidPlan, skin: THREE.Material, accent: THREE.Material, mats: MaterialLibrary) {
  const s = plan.headSize;
  switch (plan.headStyle) {
    case 'visor':
      head.add(box(0.26 * s, 0.08, 0.05, accent, 0, 0.02, 0.17 * s));
      break;
    case 'horned':
      head.add(box(0.26 * s, 0.07, 0.05, accent, 0, 0.01, 0.17 * s));
      const hornMat = mats.flat('#e8e2d0', { roughness: 0.6 });
      const h1 = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 5), hornMat);
      h1.position.set(0.13 * s, 0.22 * s, 0); h1.rotation.z = -0.35; h1.castShadow = true;
      const h2 = h1.clone(); h2.position.x *= -1; h2.rotation.z = 0.35;
      head.add(h1, h2);
      break;
    case 'helmet':
      head.add(box(0.4 * s, 0.12, 0.38 * s, accent, 0, 0.2 * s, 0));
      head.add(box(0.3 * s, 0.06, 0.05, mats.glow(plan.colors.accent, 1.6), 0, 0.03, 0.18 * s));
      break;
    case 'mohawk':
      head.add(box(0.07, 0.2 * s, 0.34 * s, accent, 0, 0.24 * s, 0));
      head.add(box(0.24 * s, 0.06, 0.04, accent, 0, 0.0, 0.17 * s));
      break;
    case 'hood':
      head.add(box(0.42 * s, 0.4 * s, 0.4 * s, accent, 0, 0.06, -0.03));
      head.add(box(0.2 * s, 0.05, 0.04, mats.glow(plan.colors.accent, 2.2), 0, 0.0, 0.2 * s));
      break;
    case 'antenna': {
      head.add(box(0.24 * s, 0.07, 0.05, accent, 0, 0.02, 0.17 * s));
      const a = box(0.03, 0.3, 0.03, mats.flat('#c9ccd2', { metalness: 0.7, roughness: 0.3 }), 0.1 * s, 0.3 * s, 0);
      a.add(box(0.07, 0.07, 0.07, mats.glow(plan.colors.accent, 2), 0, 0.18, 0));
      head.add(a);
      break;
    }
    case 'crest':
      head.add(box(0.34 * s, 0.14, 0.1, accent, 0, 0.22 * s, 0));
      head.add(box(0.24 * s, 0.06, 0.05, mats.glow('#ffffff', 1.4), 0, 0.02, 0.17 * s));
      break;
  }
}

/** Attach forged armor + extras to torso/group. */
function dressTorso(torso: THREE.Mesh, group: THREE.Group, plan: HumanoidPlan, accent: THREE.Material, shirt: THREE.Material, mats: MaterialLibrary) {
  const b = plan.bulk;
  switch (plan.armor) {
    case 'pads':
      torso.add(box(0.2 * b, 0.12, 0.38 * b, accent, 0.36 * b, 0.34, 0));
      torso.add(box(0.2 * b, 0.12, 0.38 * b, accent, -0.36 * b, 0.34, 0));
      break;
    case 'plate':
      torso.add(box(0.56 * b, 0.5, 0.08, accent, 0, 0.04, 0.2 * b));
      torso.add(box(0.2 * b, 0.12, 0.38 * b, accent, 0.36 * b, 0.34, 0));
      torso.add(box(0.2 * b, 0.12, 0.38 * b, accent, -0.36 * b, 0.34, 0));
      break;
    case 'bandolier': {
      const strap = box(0.1, 0.78, 0.4 * b, accent, 0, 0, 0);
      strap.rotation.z = 0.5;
      torso.add(strap);
      break;
    }
    case 'none':
      break;
  }
  for (const e of plan.extras) {
    if (e === 'cape') {
      const cape = box(0.5 * b, 0.85, 0.04, accent, 0, -0.12, -0.22 * b);
      cape.rotation.x = 0.12;
      torso.add(cape);
    } else if (e === 'backpack') {
      torso.add(box(0.4 * b, 0.5, 0.18, mats.flat('#4a4640', { roughness: 0.9 }), 0, 0.02, -0.28 * b));
    } else if (e === 'spikes') {
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 4), accent);
      sp.position.set(0.36 * b, 0.46, 0); sp.castShadow = true;
      const sp2 = sp.clone(); sp2.position.x *= -1;
      torso.add(sp, sp2);
    } else if (e === 'belt') {
      torso.add(box(0.64 * b, 0.09, 0.36 * b, accent, 0, -0.32, 0));
    } else if (e === 'skirt') {
      torso.add(box(0.6 * b, 0.22, 0.34 * b, shirt, 0, -0.44, 0));
    } else if (e === 'pauldron-asym') {
      torso.add(box(0.26 * b, 0.18, 0.44 * b, accent, 0.38 * b, 0.36, 0));
    }
  }
}

/** Forged chunky humanoid, ~1.8m tall before plan scaling. Origin at feet. */
export function makeHumanoid(mats: MaterialLibrary, colors: { skin?: string; shirt?: string; pants?: string; accent?: string; bulk?: number }, seed = 1): CharacterRig {
  const plan = forgeHumanoidPlan(seed, colors);
  const { height, bulk, legLen } = plan;
  const skin = mats.flat(plan.colors.skin, { roughness: 0.8 });
  const shirt = mats.flat(plan.colors.shirt, { roughness: 0.85 });
  const pants = mats.flat(plan.colors.pants, { roughness: 0.9 });
  const accent = mats.flat(plan.colors.accent, { roughness: 0.5, metalness: 0.3 });

  const legL0 = 0.74 * legLen, torsoY = legL0 + 0.38;
  const group = new THREE.Group();
  const torso = box(0.62 * bulk, 0.7, 0.34 * bulk, shirt, 0, torsoY, 0);
  const head = box(0.34 * plan.headSize, 0.34 * plan.headSize, 0.32 * plan.headSize, skin, 0, torsoY + 0.54 * plan.headSize, 0);
  dressHead(head, plan, skin, accent, mats);
  dressTorso(torso, group, plan, accent, shirt, mats);

  const mkLimb = (mat: THREE.Material, w: number, len: number) => {
    const pivot = new THREE.Group();
    const seg = box(w, len, w, mat, 0, -len / 2, 0);
    pivot.add(seg);
    return pivot;
  };
  const armLen = 0.62 * height;
  const armL = mkLimb(shirt, 0.17 * bulk, armLen); armL.position.set(0.42 * bulk, torsoY + 0.3, 0);
  const armR = mkLimb(shirt, 0.17 * bulk, armLen); armR.position.set(-0.42 * bulk, torsoY + 0.3, 0);
  const legL = mkLimb(pants, 0.2 * bulk, legL0); legL.position.set(0.17 * bulk, legL0, 0);
  const legR = mkLimb(pants, 0.2 * bulk, legL0); legR.position.set(-0.17 * bulk, legL0, 0);

  group.add(torso, head, armL, armR, legL, legR);
  group.scale.setScalar(height);

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

/** Floating drone, forged variant: ring / quad-rotor / eyebot. Origin at center. */
export function makeDrone(mats: MaterialLibrary, color = '#c33', eye = '#ff4444', seed = 1): CharacterRig {
  const plan = forgeDronePlan(seed);
  const s = plan.size;
  const group = new THREE.Group();
  const body = mats.flat(color, { roughness: 0.4, metalness: 0.6 });
  const core = box(0.7 * s, 0.3 * s, 0.7 * s, body, 0, 0, 0);
  const eyeM = new THREE.Mesh(new THREE.SphereGeometry(0.12 * s, 8, 8), mats.glow(eye, 2));
  eyeM.position.set(0, 0, 0.36 * s);
  group.add(core, eyeM);

  const rotorMat = mats.flat('#222', { roughness: 0.7 });
  const rotorL = box(0.5 * s, 0.03, 0.1 * s, rotorMat, 0.55 * s, 0.12 * s, 0);
  const rotorR = box(0.5 * s, 0.03, 0.1 * s, rotorMat, -0.55 * s, 0.12 * s, 0);

  if (plan.kind === 'ring') {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55 * s, 0.06 * s, 6, 16), mats.flat('#444a55', { metalness: 0.7, roughness: 0.3 }));
    ring.rotation.x = Math.PI / 2;
    group.add(ring, rotorL, rotorR);
  } else if (plan.kind === 'quad') {
    const rF = box(0.5 * s, 0.03, 0.1 * s, rotorMat, 0, 0.12 * s, 0.55 * s);
    const rB = box(0.5 * s, 0.03, 0.1 * s, rotorMat, 0, 0.12 * s, -0.55 * s);
    group.add(rotorL, rotorR, rF, rB);
    rF.rotation.y = Math.PI / 2; rB.rotation.y = Math.PI / 2;
  } else {
    // eyebot: sphere shell + fins
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.42 * s, 10, 8), body);
    shell.castShadow = true;
    group.add(shell);
    for (let i = 0; i < plan.fins; i++) {
      const fin = box(0.04, 0.3 * s, 0.16 * s, rotorMat, 0, 0, 0);
      const a = (i / Math.max(1, plan.fins)) * Math.PI * 2;
      fin.position.set(Math.cos(a) * 0.45 * s, 0, Math.sin(a) * 0.45 * s);
      fin.rotation.y = -a;
      group.add(fin);
    }
  }
  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  let flashTime = 0;
  return {
    group,
    limbs: { legL: rotorL, legR: rotorR, armL: rotorL, armR: rotorR, torso: core, head: eyeM },
    animate(t) {
      rotorL.rotation.y = t * 40; rotorR.rotation.y = -t * 40;
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

/** Forged low-poly car: silhouette varies by seed. Origin at chassis center. */
export function makeCar(mats: MaterialLibrary, color: string, seed = 1): { group: THREE.Group; wheels: THREE.Mesh[]; bodyMesh: THREE.Mesh } {
  const plan = forgeVehiclePlan(seed);
  const group = new THREE.Group();
  const paint = mats.flat(color, { roughness: 0.35, metalness: 0.5 });
  const dark = mats.flat('#1c1f24', { roughness: 0.6 });
  const glass = mats.flat('#9fd4e8', { roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0.85 });
  const L = plan.bodyLen;

  const bodyMesh = box(1.9, 0.5, L, paint, 0, 0.35, 0);
  const cabin = box(1.6, 0.45, plan.cabinLen, glass, 0, 0.78, plan.cabinZ);
  group.add(bodyMesh, cabin);

  if (plan.nose === 'wedge') {
    const w = box(1.8, 0.3, 0.7, paint, 0, 0.28, -L / 2 - 0.2);
    w.rotation.x = 0.18;
    group.add(w);
  } else if (plan.nose === 'splitter') {
    group.add(box(1.95, 0.1, 0.5, dark, 0, 0.1, -L / 2 - 0.15));
  }
  if (plan.scoop) group.add(box(0.5, 0.16, 0.6, dark, 0, 0.68, -L * 0.28));
  if (plan.fenders) {
    group.add(box(0.16, 0.3, 0.9, paint, 0.98, 0.3, -L * 0.32), box(0.16, 0.3, 0.9, paint, -0.98, 0.3, -L * 0.32));
    group.add(box(0.16, 0.3, 0.9, paint, 0.98, 0.3, L * 0.32), box(0.16, 0.3, 0.9, paint, -0.98, 0.3, L * 0.32));
  }
  if (plan.spoiler === 'wing') {
    const spoiler = box(1.7, 0.08, 0.4, paint, 0, 0.95, L / 2 - 0.15);
    spoiler.add(box(0.08, 0.35, 0.3, paint, 0.7, -0.2, 0), box(0.08, 0.35, 0.3, paint, -0.7, -0.2, 0));
    group.add(spoiler);
  } else if (plan.spoiler === 'lip') {
    group.add(box(1.8, 0.08, 0.25, dark, 0, 0.62, L / 2 - 0.05));
  } else if (plan.spoiler === 'ducktail') {
    const dt = box(1.85, 0.12, 0.35, paint, 0, 0.66, L / 2 - 0.1);
    dt.rotation.x = -0.25;
    group.add(dt);
  }
  const bumperF = box(1.95, 0.28, 0.25, dark, 0, 0.22, -L / 2 - 0.03);
  const bumperR = box(1.95, 0.28, 0.25, dark, 0, 0.22, L / 2 + 0.03);
  const hl = mats.glow('#fff6c8', 1.6), tl = mats.glow('#ff2233', 1.6);
  group.add(bumperF, bumperR);
  group.add(box(0.3, 0.14, 0.06, hl, 0.6, 0.42, -L / 2 - 0.07), box(0.3, 0.14, 0.06, hl, -0.6, 0.42, -L / 2 - 0.07));
  group.add(box(0.35, 0.12, 0.06, tl, 0.6, 0.42, L / 2 + 0.07), box(0.35, 0.12, 0.06, tl, -0.6, 0.42, L / 2 + 0.07));

  const wheels: THREE.Mesh[] = [];
  const wg = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 12);
  wg.rotateZ(Math.PI / 2);
  const wm = mats.flat('#14161a', { roughness: 0.9 });
  const hub = mats.flat('#b9c0c9', { metalness: 0.8, roughness: 0.3 });
  const wz = L / 2 - 0.65;
  const wp: [number, number][] = [[0.85, -wz], [-0.85, -wz], [0.85, wz], [-0.85, wz]];
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
