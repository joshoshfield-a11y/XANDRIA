/**
 * Procedural low-poly characters + vehicles, forged per-seed by ModelForge.
 * PS2-era: chunky geometry, flat colors, baked limb-swing animation driven by
 * movement speed. No skeletal rigs, no external models — but no two games share
 * a cast: proportions, headgear, armor and extras all derive from the game seed.
 */
import * as THREE from 'three';
import type { MaterialLibrary } from './Materials';
import { Rng } from '../core/Rng';
import { forgeHumanoidPlan, forgeDronePlan, forgeVehiclePlan, type HumanoidPlan, type BodyArchetype } from './ModelForge';
import type { ForgeCustom } from '@spec';

/** Per-frame animation options (all optional — every field added after wave C is backward compatible). */
export interface AnimateOpts {
  /** 0..1 melee swing progress (externally driven) */
  attacking?: number;
  /** corpse mode — the momentum tumble owns the pose instead of locomotion */
  dead?: boolean;
  /** body velocity at the moment of death; seeds the tumble on the first dead frame */
  deadVelocity?: THREE.Vector3;
  /** landing squash: 1→0 progress, pre-scaled by impact (CharacterController sets it from onLand) */
  land?: number;
}

export interface CharacterRig {
  group: THREE.Group;
  /** limbs keyed for animation — the six legacy pivots (shoulder/hip positions unchanged) */
  limbs: {
    legL: THREE.Object3D; legR: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D;
    torso: THREE.Object3D; head: THREE.Object3D; weaponMount?: THREE.Object3D;
    /** OPTIONAL sub-pivots (wave C): elbow/knee joints, children of the matching limb pivot.
     *  Procedural only — no bones, no clips. animate() drives them phase-coupled to parents. */
    elbowL?: THREE.Object3D; elbowR?: THREE.Object3D;
    kneeL?: THREE.Object3D; kneeR?: THREE.Object3D;
    /** same four joints as a map, for code that prefers keyed access */
    joints?: { elbowL: THREE.Object3D; elbowR: THREE.Object3D; kneeL: THREE.Object3D; kneeR: THREE.Object3D };
    /** OPTIONAL segmented cape cloth (polish wave): chained pivots, same pattern as limb
     *  pivots — animate() drives them from speed + noise. Absent when the plan has no cape. */
    cape?: THREE.Object3D[];
  };
  /** call every frame with planar speed (m/s) */
  animate(t: number, speed: number, opts?: AnimateOpts): void;
  /** trigger a melee swing animation (self-advancing) */
  swing(): void;
  setDead(dead: boolean): void;
  flash(): void; // damage blink
  /** release per-instance GPU resources (geometries + owned materials) */
  dispose(): void;
}

/**
 * Clone a (possibly MaterialLibrary-cached/shared) material into a per-instance
 * owned copy. Owned materials are flagged via userData and disposed by disposeOwned().
 * Textures stay shared — only the material wrapper is unique.
 */
function own<T extends THREE.Material>(m: T): T {
  const c = m.clone() as T;
  c.userData.owned = true;
  return c;
}

/** Dispose per-instance GPU resources under root: every geometry + materials flagged owned. Shared cached materials are left alone. */
export function disposeOwned(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mm of mats) {
      const mat = mm as THREE.Material | undefined;
      if (mat && mat.userData.owned) mat.dispose();
    }
  });
}

/**
 * Enemies wave C: dispose per-instance OWNED materials only — leaves
 * geometries alone for the cache-shared path (geometry sharing without
 * material sharing: damage-flash mutates owned materials, so they must
 * stay per-instance on the direct-render path, while geometries dedup
 * across the roster). Library-cached (non-owned) materials are never
 * disposed here, same as disposeOwned.
 */
export function disposeOwnedMaterials(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mm of mats) {
      const mat = mm as THREE.Material | undefined;
      if (mat && mat.userData.owned) mat.dispose();
    }
  });
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Faceted low-poly finish: de-index so flat normals survive (keeps the PS2 look on smooth primitives). */
function faceted<T extends THREE.BufferGeometry>(g: T): T {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.computeVertexNormals();
  return ng as T;
}

/** A shadow-casting mesh from a faceted primitive. */
function part(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(faceted(geo), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Tapered limb segment hanging down from a pivot: top radius rt, bottom radius rb, length len. */
function segment(mat: THREE.Material, rt: number, rb: number, len: number, radial = 7): THREE.Mesh {
  return part(new THREE.CylinderGeometry(rt, rb, len, radial), mat, 0, -len / 2, 0);
}

/** Per-archetype visual multipliers applied inside makeHumanoid (seeded via plan.archetype). */
const ARCH_SCALE: Record<BodyArchetype, { limb: number; hand: number; foot: number; shoulder: number; torso: number }> = {
  standard: { limb: 1.0, hand: 1.0, foot: 1.0, shoulder: 1.0, torso: 1.0 },
  brute: { limb: 1.28, hand: 1.45, foot: 1.3, shoulder: 1.18, torso: 1.14 },
  scout: { limb: 0.85, hand: 0.85, foot: 0.9, shoulder: 0.9, torso: 0.9 },
};

/** Face the +Z direction: true for head styles with a visible face. */
const FACE_VISIBLE: Record<string, boolean> = {
  visor: true, mohawk: true, antenna: true, crest: true, horned: true,
  helmet: false, hood: false,
};

/** Seeded eye-glow variants (inventory wave: cheap facial/feature variety). */
const EYE_GLOW_VARIANTS = ['#ffffff', '#ff5533', '#35e0ff'] as const;

/**
 * Facial/feature variety, seeded from the rig seed (deterministic: same seed →
 * same face). All bits are tiny shared-material meshes — skins never touch
 * them (owned materials are untouched) and they cost ~6 draw calls at most.
 * - eyes: glowing eyes for face-visible styles without built-in eyes
 *   (hood/helmet already have them); color drawn from EYE_GLOW_VARIANTS or
 *   the plan accent
 * - war-paint: two thin accent stripes across the cheeks (face-visible only)
 * - headband: cloth band for mohawk/antenna/crest (visor has its own band)
 * - scar: thin dark diagonal slash on the forehead (face-visible only)
 */
function dressFeatures(
  head: THREE.Mesh, plan: HumanoidPlan, s: number, hr: number,
  accent: THREE.Material, mats: MaterialLibrary, frng: Rng,
) {
  const faceVisible = FACE_VISIBLE[plan.headStyle] ?? true;
  if (plan.headStyle === 'visor' || plan.headStyle === 'mohawk' || plan.headStyle === 'antenna' || plan.headStyle === 'crest') {
    // eye-glow variant: plan accent or one of the cold/hot variants
    const eyeHex = frng.chance(0.5) ? plan.colors.accent : frng.pick(EYE_GLOW_VARIANTS);
    const eyeMat = mats.glow(eyeHex, 1.8);
    head.add(
      part(new THREE.SphereGeometry(0.024, 6, 5), eyeMat, 0.06 * s, 0.03, hr * 0.86),
      part(new THREE.SphereGeometry(0.024, 6, 5), eyeMat, -0.06 * s, 0.03, hr * 0.86),
    );
  }
  if (faceVisible && frng.chance(0.35)) {
    // war-paint: accent cheek stripes
    for (const side of [1, -1]) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.13 * s, 0.022), accent);
      stripe.position.set(0.085 * s * side, -0.035, hr * 0.88);
      stripe.rotation.y = 0.35 * side;
      head.add(stripe);
    }
  }
  if (faceVisible && frng.chance(0.25)) {
    // scar: thin dark slash on the forehead
    const scar = new THREE.Mesh(
      new THREE.PlaneGeometry(0.016, 0.10 * s),
      mats.flat('#5a3a2e', { roughness: 0.9 }),
    );
    scar.position.set(0.05 * s, 0.075, hr * 0.90);
    scar.rotation.z = 0.5;
    head.add(scar);
  }
  if ((plan.headStyle === 'mohawk' || plan.headStyle === 'antenna' || plan.headStyle === 'crest') && frng.chance(0.4)) {
    // cloth headband (visor/horned styles already wear a band)
    head.add(part(new THREE.CylinderGeometry(hr * 1.03, hr * 1.03, 0.06, 12, 1, true, -0.8, 1.6), accent, 0, 0.075, 0));
  }
}

/** Attach forged headgear to a head mesh (sphere, radius hr, face toward +Z). No boxes — bands, domes, cones, fins. */
function dressHead(head: THREE.Mesh, plan: HumanoidPlan, skin: THREE.Material, accent: THREE.Material, mats: MaterialLibrary) {
  const s = plan.headSize;
  const hr = 0.17 * s;
  /** curved visor band across the face: open cylinder arc centered on +Z */
  const visorBand = (mat: THREE.Material, glow = 0) =>
    part(new THREE.CylinderGeometry(hr * 1.04, hr * 1.04, 0.085, 12, 1, true, -0.75, 1.5), mat, 0, 0.02, 0);
  const hornMat = mats.flat('#e8e2d0', { roughness: 0.6 });
  switch (plan.headStyle) {
    case 'visor':
      head.add(visorBand(accent));
      break;
    case 'horned':
      head.add(visorBand(accent));
      for (const side of [1, -1]) {
        const horn = part(new THREE.ConeGeometry(0.05, 0.24, 6), hornMat, 0.14 * s * side, 0.2 * s, 0);
        horn.rotation.z = -0.4 * side;
        head.add(horn);
      }
      break;
    case 'helmet': {
      // dome shell + glowing visor slit
      head.add(part(new THREE.SphereGeometry(hr * 1.16, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), accent, 0, 0.03 * s, -0.01));
      const slit = new THREE.Mesh(new THREE.PlaneGeometry(0.22 * s, 0.055), mats.glow(plan.colors.accent, 1.8));
      slit.position.set(0, 0.03, hr * 0.99);
      head.add(slit);
      break;
    }
    case 'mohawk': {
      const fin = part(new THREE.OctahedronGeometry(0.13 * s), accent, 0, hr * 1.05, -0.02);
      fin.scale.set(0.32, 1.0, 2.0);
      head.add(fin, visorBand(mats.flat('#c9ccd2', { metalness: 0.7, roughness: 0.3 })));
      break;
    }
    case 'hood': {
      // open cone hood, front left open so the face shows; glowing eyes inside
      head.add(part(new THREE.ConeGeometry(hr * 1.55, hr * 2.4, 10, 1, true, 0.7, Math.PI * 2 - 1.4), accent, 0, hr * 0.45, -0.04));
      const eyeMat = mats.glow(plan.colors.accent, 2.2);
      head.add(
        part(new THREE.SphereGeometry(0.028, 6, 5), eyeMat, 0.06 * s, 0.03, hr * 0.78),
        part(new THREE.SphereGeometry(0.028, 6, 5), eyeMat, -0.06 * s, 0.03, hr * 0.78),
      );
      break;
    }
    case 'antenna': {
      head.add(visorBand(accent));
      const shaft = part(new THREE.CylinderGeometry(0.016, 0.022, 0.34, 6), mats.flat('#c9ccd2', { metalness: 0.7, roughness: 0.3 }), 0.1 * s, hr + 0.17, 0);
      const tip = part(new THREE.SphereGeometry(0.045, 8, 6), mats.glow(plan.colors.accent, 2), 0.1 * s, hr + 0.36, 0);
      head.add(shaft, tip);
      break;
    }
    case 'crest': {
      const fin = part(new THREE.OctahedronGeometry(0.11 * s), accent, 0, hr * 1.02, 0);
      fin.scale.set(1.5, 0.85, 0.55);
      const brow = new THREE.Mesh(new THREE.PlaneGeometry(0.24 * s, 0.05), mats.glow('#ffffff', 1.4));
      brow.position.set(0, 0.02, hr * 0.98);
      head.add(fin, brow);
      break;
    }
  }
}

/** Attach forged armor + extras to the torso. Torso is a tapered cylinder (top r≈0.30·b,
 *  bottom r≈0.22·b, h=0.72); children use torso-local coords, top at +0.36. No boxes —
 *  shells, caps, bands, cones, draped cloth. accentDS = double-sided owned accent (cape).
 *  Returns the segmented cape pivots (empty when the plan has no cape). */
function dressTorso(
  torso: THREE.Object3D, group: THREE.Group, plan: HumanoidPlan,
  tex: { accent: THREE.Material; shirt: THREE.Material; accentDS: THREE.Material },
  mats: MaterialLibrary, frng: Rng,
): { cape: THREE.Object3D[] } {
  const b = plan.bulk;
  const arch = ARCH_SCALE[plan.archetype];
  const { accent, shirt, accentDS } = tex;
  const shoulderX = 0.42 * b * arch.shoulder;
  const pad = (side: number) => {
    const p = part(new THREE.SphereGeometry(0.155 * b, 8, 6), accent, shoulderX * side, 0.33, 0);
    p.scale.set(1.15, 0.7, 1.1);
    return p;
  };
  switch (plan.armor) {
    case 'pads':
      torso.add(pad(1), pad(-1));
      break;
    case 'plate':
      // curved chest shell, open at the back
      torso.add(part(new THREE.CylinderGeometry(0.315 * b * arch.torso, 0.26 * b * arch.torso, 0.5, 10, 1, true, -0.95, 1.9), accent, 0, 0.06, 0));
      torso.add(pad(1), pad(-1));
      break;
    case 'bandolier': {
      const strap = part(new THREE.CylinderGeometry(0.32 * b * arch.torso, 0.27 * b * arch.torso, 0.13, 10, 1, true), accent, 0, 0.08, 0);
      strap.rotation.z = 0.5;
      const buckle = part(new THREE.SphereGeometry(0.06, 8, 6), mats.glow(plan.colors.accent, 1.6), 0.12, -0.08, 0.26 * b);
      torso.add(strap, buckle);
      break;
    }
    case 'none':
      break;
  }
  // Armor trim variety (inventory wave, seeded): glow rivets on pads/plate,
  // a second strap on bandoliers, a chest emblem on bare torsos — so each
  // armor set reads differently and torso-slot equips sit on something sensible.
  if ((plan.armor === 'pads' || plan.armor === 'plate') && frng.chance(0.5)) {
    const rivet = mats.glow(plan.colors.accent, 1.2);
    torso.add(
      part(new THREE.SphereGeometry(0.028, 6, 5), rivet, shoulderX * 0.82, 0.36, 0.10 * b),
      part(new THREE.SphereGeometry(0.028, 6, 5), rivet, -shoulderX * 0.82, 0.36, 0.10 * b),
    );
  } else if (plan.armor === 'bandolier' && frng.chance(0.5)) {
    const strap2 = part(new THREE.CylinderGeometry(0.32 * b * arch.torso, 0.27 * b * arch.torso, 0.09, 10, 1, true), accent, 0, 0.16, 0);
    strap2.rotation.z = -0.5;
    torso.add(strap2);
  } else if (plan.armor === 'none' && frng.chance(0.3)) {
    const emblem = part(new THREE.OctahedronGeometry(0.055), accent, 0, 0.18, 0.30 * b * arch.torso);
    emblem.scale.set(1, 1.3, 0.5);
    torso.add(emblem);
  }
  const capeSegs: THREE.Object3D[] = [];
  for (const e of plan.extras) {
    if (e === 'cape') {
      // Polish wave: the cape is a chain of pivots (same pattern as limb pivots),
      // not one rigid plane — animate() flutters the segments from speed + noise.
      const root = new THREE.Group();
      root.position.set(0, -0.12, -0.26 * b);
      root.rotation.x = 0.08;
      torso.add(root);
      let parent: THREE.Object3D = root;
      const n = 3, segH = 0.95 / n;
      for (let i = 0; i < n; i++) {
        const pivot = new THREE.Group();
        pivot.position.set(0, i === 0 ? 0 : -segH, 0);
        const w = 0.55 * b * (1 - 0.12 * i); // taper toward the hem, like the old baked drape
        const cloth = new THREE.Mesh(faceted(new THREE.PlaneGeometry(w, segH * 1.06, 1, 1)), accentDS);
        cloth.castShadow = true;
        cloth.position.y = -segH / 2;
        pivot.add(cloth);
        parent.add(pivot);
        parent = pivot;
        capeSegs.push(pivot);
      }
    } else if (e === 'backpack') {
      torso.add(part(new THREE.CapsuleGeometry(0.15 * b, 0.28, 4, 8), mats.flat('#4a4640', { roughness: 0.9 }), 0, 0.06, -(0.24 * b + 0.13)));
    } else if (e === 'spikes') {
      const sp = part(new THREE.ConeGeometry(0.06, 0.18, 4), accent, 0.36 * b, 0.44, 0);
      const sp2 = part(new THREE.ConeGeometry(0.06, 0.18, 4), accent, -0.36 * b, 0.44, 0);
      torso.add(sp, sp2);
    } else if (e === 'belt') {
      const belt = part(new THREE.TorusGeometry(0.25 * b * arch.torso, 0.05, 6, 14), accent, 0, -0.3, 0);
      belt.rotation.x = Math.PI / 2;
      torso.add(belt);
    } else if (e === 'skirt') {
      torso.add(part(new THREE.CylinderGeometry(0.3 * b, 0.4 * b, 0.26, 10, 1, true), shirt, 0, -0.42, 0));
    } else if (e === 'pauldron-asym') {
      torso.add(part(new THREE.SphereGeometry(0.17 * b, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), accent, shoulderX, 0.32, 0));
    }
  }
  return { cape: capeSegs };
}

/** Forged articulated humanoid, ~1.8m tall before plan scaling. Origin at feet.
 *  Capsule/tapered-cylinder/sphere body with real elbow + knee sub-pivots;
 *  the seeded archetype (standard/brute/scout) drives proportions. The six legacy
 *  limb pivots keep their exact positions; joints are children of them. */
export function makeHumanoid(mats: MaterialLibrary, colors: { skin?: string; shirt?: string; pants?: string; accent?: string; bulk?: number }, seed = 1, hints?: ForgeCustom): CharacterRig {
  const plan = forgeHumanoidPlan(seed, colors, hints);
  const { height, bulk, legLen } = plan;
  const arch = ARCH_SCALE[plan.archetype];
  const b = bulk;
  // feature-variety RNG: seeded from the rig seed, independent of the plan
  // forge (same seed → same face, every time; no Math.random in sim paths)
  const frng = new Rng((seed ^ 0x5e47) >>> 0);
  // FIX: clone into per-instance owned materials — flash() mutates emissive, and
  // mutating the MaterialLibrary-cached originals permanently tinted every
  // same-palette character. Owned clones are disposed by dispose().
  const skin = own(mats.flat(plan.colors.skin, { roughness: 0.8 }));
  const shirt = own(mats.flat(plan.colors.shirt, { roughness: 0.85 }));
  const pants = own(mats.flat(plan.colors.pants, { roughness: 0.9 }));
  const accent = own(mats.flat(plan.colors.accent, { roughness: 0.5, metalness: 0.3 }));
  const accentDS = own(mats.flat(plan.colors.accent, { roughness: 0.5, metalness: 0.3 }));
  accentDS.side = THREE.DoubleSide; // cape cloth
  const allMats = [skin, shirt, pants, accent, accentDS];
  // DE-skins hook-in: semantic role tags so skins can target materials by role
  // (userData.owned is what dispose()/flash() key off; role is what skins key off).
  skin.userData.role = 'skin'; shirt.userData.role = 'shirt'; pants.userData.role = 'pants';
  accent.userData.role = 'accent'; accentDS.userData.role = 'accentDS';

  const legL0 = 0.74 * legLen, torsoY = legL0 + 0.38;
  const thighLen = legL0 * 0.5, shinLen = legL0 * 0.5;
  const upperArmLen = 0.34 * height, foreArmLen = 0.30 * height;
  const lr = arch.limb; // limb-radius multiplier

  const group = new THREE.Group();

  // torso: tapered cylinder + chest cap + neck + hips (children bob together)
  const torsoR = 0.30 * b * arch.torso;
  const torso = part(new THREE.CylinderGeometry(torsoR, 0.22 * b * arch.torso, 0.72, 8), shirt, 0, torsoY, 0);
  const chestCap = part(new THREE.SphereGeometry(torsoR * 0.99, 8, 6), shirt, 0, 0.32, 0);
  chestCap.scale.set(1, 0.55, 0.85);
  torso.add(chestCap);
  torso.add(part(new THREE.CylinderGeometry(0.07 * plan.headSize, 0.09, 0.22, 7), skin, 0, 0.44, 0));
  const hips = part(new THREE.SphereGeometry(0.20 * b * arch.torso, 8, 6), pants, 0, -0.3, 0);
  hips.scale.set(1.15, 0.75, 0.9);
  torso.add(hips);
  const { cape: capeSegs } = dressTorso(torso, group, plan, { accent, shirt, accentDS }, mats, frng);

  // head: sphere + forged headgear + seeded facial/feature variety
  const hr = 0.17 * plan.headSize;
  const head = part(new THREE.SphereGeometry(hr, 10, 8), skin, 0, torsoY + 0.54 * plan.headSize, 0);
  dressHead(head, plan, skin, accent, mats);
  dressFeatures(head, plan, plan.headSize, hr, accent, mats, frng);

  // arms: shoulder pivot → upper arm → elbow pivot → forearm + fist
  const buildArm = (side: 1 | -1) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.42 * b * side, torsoY + 0.3, 0);
    const delt = part(new THREE.SphereGeometry(0.10 * b * lr, 8, 6), shirt, 0, -0.02, 0);
    delt.scale.set(1, 0.8, 1);
    const upper = segment(shirt, 0.095 * b * lr, 0.075 * b * lr, upperArmLen);
    const elbow = new THREE.Group();
    elbow.position.set(0, -upperArmLen, 0);
    const fore = segment(skin, 0.07 * b * lr, 0.055 * b * lr, foreArmLen);
    const handR = 0.085 * b * arch.hand;
    const hand = part(new THREE.SphereGeometry(handR, 8, 6), skin, 0, -foreArmLen - handR * 0.45, 0);
    hand.scale.set(0.9, 1.25, 0.95);
    elbow.add(fore, hand);
    if (frng.chance(0.2)) {
      // bandaged forearm: white wrap ring at the elbow (shared material, like horns)
      const wrap = part(new THREE.TorusGeometry(0.075 * b * lr, 0.022, 6, 10), mats.flat('#e8e2d0', { roughness: 0.9 }), 0, -0.06, 0);
      wrap.rotation.x = Math.PI / 2;
      elbow.add(wrap);
    }
    shoulder.add(delt, upper, elbow);
    return { shoulder, elbow };
  };
  // legs: hip pivot → thigh → knee pivot → shin + boot
  const buildLeg = (side: 1 | -1) => {
    const hip = new THREE.Group();
    hip.position.set(0.17 * b * side, legL0, 0);
    const thigh = segment(pants, 0.115 * b * lr, 0.085 * b * lr, thighLen);
    const knee = new THREE.Group();
    knee.position.set(0, -thighLen, 0);
    const shin = segment(pants, 0.08 * b * lr, 0.06 * b * lr, shinLen);
    const footR = 0.10 * b * arch.foot;
    const boot = part(new THREE.SphereGeometry(footR, 8, 6), accent, 0, -shinLen + footR * 0.55, 0.06 * b);
    boot.scale.set(0.85, 0.6, 1.45);
    knee.add(shin, boot);
    if (frng.chance(0.3)) {
      // knee wrap: pants-colored band so legs-slot equips sit on something dressed
      const wrap = part(new THREE.TorusGeometry(0.088 * b * lr, 0.02, 6, 10), pants, 0, -0.04, 0);
      wrap.rotation.x = Math.PI / 2;
      knee.add(wrap);
    }
    hip.add(thigh, knee);
    return { hip, knee };
  };
  const armL = buildArm(1), armR = buildArm(-1);
  const legL = buildLeg(1), legR = buildLeg(-1);

  group.add(torso, head, armL.shoulder, armR.shoulder, legL.hip, legR.hip);
  group.scale.setScalar(height);

  const baseY = { torso: torso.position.y, head: head.position.y };
  let flashTime = 0;
  let atkT = -1; // self-advancing swing timer (1 → 0)
  const joints = { elbowL: armL.elbow, elbowR: armR.elbow, kneeL: legL.knee, kneeR: legR.knee };
  /** ragdoll-lite corpse state (polish wave): the body's death velocity becomes
   *  angular tumble + a visual-only slide/bounce. Sim bodies are never touched. */
  let deadTumble: { vel: THREE.Vector3; ang: THREE.Vector3; lastT: number } | null = null;
  /** lazy snapshot of group.scale so the landing squash restores exactly (enemies re-scale post-build) */
  let squashBase: THREE.Vector3 | null = null;

  // Follow-up wave A: limbs is a named binding (not an inline literal) so
  // animate() can read rig.limbs.cape LIVE each frame. Voxel capes applied
  // after construction register their segment pivots there and ride the same
  // speed + noise cloth math as the polish-wave cape — no second animation path.
  const limbs: CharacterRig['limbs'] = {
    legL: legL.hip, legR: legR.hip, armL: armL.shoulder, armR: armR.shoulder,
    torso, head, weaponMount: armR.shoulder,
    elbowL: armL.elbow, elbowR: armR.elbow, kneeL: legL.knee, kneeR: legR.knee, joints,
    ...(capeSegs.length ? { cape: capeSegs } : {}),
  };

  return {
    group,
    limbs,
    swing() { atkT = 1; },
    animate(t, speed, opts: AnimateOpts = {}) {
      const k = Math.min(1, speed / 6);
      if (opts.dead) {
        // DEATH FEEL: momentum-carrying procedural tumble — the death velocity
        // converts into angular tumble; the group slides/bounces to rest.
        if (!deadTumble) {
          const v = opts.deadVelocity ? opts.deadVelocity.clone() : new THREE.Vector3(0, 0, 0);
          const sp = Math.hypot(v.x, v.z);
          // deterministic tumble axis: perpendicular to travel (a body hit forward
          // tumbles forward), plus a backward tip so still deaths still read
          const ang = sp > 0.05
            ? new THREE.Vector3(-v.z / sp, 0, v.x / sp).multiplyScalar(1.6 + sp * 0.55)
            : new THREE.Vector3(1.8, 0.2, 0.3);
          ang.x += 1.2;
          v.y = Math.max(v.y, 1.0) + Math.min(2.0, sp * 0.2); // pop off the ground
          deadTumble = { vel: v, ang, lastT: -1 };
        }
        const d = deadTumble;
        const dt = d.lastT < 0 ? 1 / 60 : Math.min(0.05, t - d.lastT);
        d.lastT = t;
        d.vel.y -= 26 * dt; // visual gravity only
        group.position.x += d.vel.x * dt;
        group.position.y += d.vel.y * dt;
        group.position.z += d.vel.z * dt;
        const restY = 0.3 * group.scale.y;
        if (group.position.y < restY) {
          group.position.y = restY;
          d.vel.y = d.vel.y < -3 ? -d.vel.y * 0.35 : 0; // one bounce, then rest
          const fr = 1 - Math.min(1, 6 * dt);
          d.vel.x *= fr; d.vel.z *= fr; // ground friction
          d.ang.multiplyScalar(1 - Math.min(1, 5 * dt));
        } else {
          d.ang.multiplyScalar(1 - Math.min(1, 0.25 * dt)); // light air drag
        }
        group.rotation.x += d.ang.x * dt;
        group.rotation.y += d.ang.y * dt;
        group.rotation.z += d.ang.z * dt;
        // limbs go loose and splay — a corpse, not a mannequin
        const limp = 1 - Math.min(1, 5 * dt);
        legL.hip.rotation.x *= limp; legR.hip.rotation.x *= limp;
        armL.shoulder.rotation.x *= limp; armR.shoulder.rotation.x *= limp;
        legL.knee.rotation.x *= limp; legR.knee.rotation.x *= limp;
        armL.elbow.rotation.x *= limp; armR.elbow.rotation.x *= limp;
        armL.shoulder.rotation.z += (0.7 - armL.shoulder.rotation.z) * Math.min(1, 3 * dt);
        armR.shoulder.rotation.z += (-0.7 - armR.shoulder.rotation.z) * Math.min(1, 3 * dt);
      } else {
        if (deadTumble) deadTumble = null;
        const f = t * (8 + k * 4);
        const s = Math.sin(f);
        const sw = s * 0.7 * k;
        legL.hip.rotation.x = sw; legR.hip.rotation.x = -sw;
        armL.shoulder.rotation.x = -sw * 0.85; armR.shoulder.rotation.x = sw * 0.85;
        // Sub-pivot articulation, phase-coupled to the parent swing (procedural, no bones):
        // knees bend as their leg swings forward, elbows counter-swing the arms.
        legL.knee.rotation.x = k * (0.08 + 0.85 * Math.max(0, -s));
        legR.knee.rotation.x = k * (0.08 + 0.85 * Math.max(0, s));
        armL.elbow.rotation.x = -0.12 - k * 0.5 * Math.max(0, -s);
        armR.elbow.rotation.x = -0.12 - k * 0.5 * Math.max(0, s);
        let atkP = opts.attacking && opts.attacking > 0 ? opts.attacking : 0;
        if (!atkP && atkT >= 0) { atkP = 1 - atkT; atkT -= 0.045; if (atkT < 0) atkT = -1; }
        if (atkP > 0) {
          // overhead slash in three beats: anticipation windup → strike → follow-through
          const p = Math.min(1, atkP);
          let armX: number, elbow: number, coil: number;
          if (p < 0.35) {            // windup: coil back, elbow folds deep
            const q = p / 0.35, e = q * q;
            armX = -2.4 - 0.6 * e; elbow = -0.25 - 0.9 * e; coil = 0.35 * e;
          } else if (p < 0.8) {      // the strike: fast, elbow snaps straight late
            const q = (p - 0.35) / 0.45, e = 1 - Math.pow(1 - q, 3);
            armX = -3.0 + 3.7 * e; elbow = -1.15 + 1.0 * q * q; coil = 0.35 - 0.45 * e;
          } else {                   // follow-through: settle back toward rest
            const q = (p - 0.8) / 0.2, e = 1 - Math.pow(1 - q, 2);
            armX = 0.7 - 0.7 * e; elbow = -0.15 - 0.1 * e; coil = -0.1 + 0.1 * e;
          }
          armR.shoulder.rotation.x = armX;
          armR.shoulder.rotation.z = 0.4 - p * 0.5;
          armR.elbow.rotation.x = elbow;
          torso.rotation.y = coil;
        } else { armR.shoulder.rotation.z = 0; torso.rotation.y = 0; }
        // run-cycle weight: vertical bob + forward lean, both scaled by speed
        const bob = Math.abs(Math.sin(f)) * 0.05 * k;
        // idle breathing: subtle torso swell, fades out as speed rises
        const breath = Math.sin(t * 2.2) * 0.006 * (1 - k);
        torso.position.y = baseY.torso + bob + breath;
        head.position.y = baseY.head + bob + breath * 1.4;
        torso.scale.set(1 + breath * 0.4, 1 + breath, 1 + breath * 0.4);
        group.rotation.x = 0.13 * k;
        head.rotation.x = -0.08 * k; // head stabilizes against the lean
        // landing squash: brief y-compression, xz-bulge (land: 1→0, impact-scaled)
        const landQ = Math.min(1, Math.max(0, opts.land ?? 0));
        if (landQ > 0) {
          const sq = 0.16 * Math.sin(Math.PI * landQ);
          if (!squashBase) squashBase = group.scale.clone();
          group.scale.set(squashBase.x * (1 + 0.55 * sq), squashBase.y * (1 - sq), squashBase.z * (1 + 0.55 * sq));
        } else if (squashBase) { group.scale.copy(squashBase); squashBase = null; }
        // CLOTH: cape segments trail with speed and flutter on two detuned sines.
        // The segment array is read LIVE from limbs.cape (falling back to the
        // construction-time chain): a voxel cape registered post-construction
        // rides the exact same math as the polish-wave cape — it is driven
        // here, never by a second animation path. Turning follows automatically:
        // the chain hangs off the torso pivot, so group/torso rotation carries it.
        const cloth = limbs.cape ?? capeSegs;
        if (cloth.length) {
          const wob = 0.3 + k;
          for (let i = 0; i < cloth.length; i++) {
            const cg = cloth[i];
            cg.rotation.x = 0.12 + 0.10 * k * (i + 1)
              + Math.sin(t * 6.3 + i * 1.9) * 0.045 * wob
              + Math.sin(t * 11.7 + i * 0.7) * 0.028 * wob;
            cg.rotation.z = Math.sin(t * 5.1 + i * 2.3) * 0.035 * wob;
          }
        }
      }
      if (flashTime > 0) {
        flashTime -= 0.016;
        const on = Math.floor(flashTime * 20) % 2 === 0;
        for (const m of allMats) m.emissive.setHex(on ? 0xff2222 : 0x000000), m.emissiveIntensity = on ? 0.8 : 0;
      }
    },
    setDead(dead) { if (!dead) deadTumble = null; /* tumble inits lazily on animate(dead) */ },
    flash() { flashTime = 0.25; },
    dispose() { disposeOwned(group); },
  };
}

/** Floating drone, forged variant: ring / quad-rotor / eyebot. Origin at center. */
export function makeDrone(mats: MaterialLibrary, color = '#c33', eye = '#ff4444', seed = 1): CharacterRig {
  const plan = forgeDronePlan(seed);
  const s = plan.size;
  const group = new THREE.Group();
  // FIX: per-instance owned clone — drone flash() mutates emissive on this material.
  const body = own(mats.flat(color, { roughness: 0.4, metalness: 0.6 }));
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
    dispose() { disposeOwned(group); },
  };
}

/** Static turret: base + swiveling head + barrel. */
export function makeTurret(mats: MaterialLibrary, color = '#5a6270', accent = '#ff5533'): { group: THREE.Group; head: THREE.Group; muzzle: THREE.Object3D; dispose(): void } {
  const group = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.65, 0.7, 8), mats.flat(color, { metalness: 0.6, roughness: 0.4 }));
  base.position.y = 0.35; base.castShadow = true;
  const head = new THREE.Group(); head.position.y = 0.85;
  // FIX: dome is flash-mutated on damage — per-instance owned clone, not the cached shared material.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), own(mats.flat(color, { metalness: 0.6, roughness: 0.35 })));
  dome.castShadow = true;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 6), mats.flat('#222831', { metalness: 0.8, roughness: 0.3 }));
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0, 0.55);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, 1.0);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), mats.glow(accent, 2.5));
  eye.position.set(0, 0.12, 0.36);
  head.add(dome, barrel, muzzle, eye);
  group.add(base, head);
  return { group, head, muzzle, dispose() { disposeOwned(group); } };
}

/** Forged low-poly car: silhouette varies by seed. Origin at chassis center. */
export function makeCar(mats: MaterialLibrary, color: string, seed = 1, hints?: ForgeCustom): { group: THREE.Group; wheels: THREE.Mesh[]; bodyMesh: THREE.Mesh } {
  const plan = forgeVehiclePlan(seed, hints);
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
