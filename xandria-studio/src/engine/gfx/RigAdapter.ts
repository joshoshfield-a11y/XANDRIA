/**
 * RigAdapter (workstream E, phase 1) — adapt an imported GLB/GLTF character
 * model to the six-pivot CharacterRig contract so the EXISTING procedural
 * animate() swing math drives it. No animation clips (phase 3, out of scope).
 *
 * Pipeline: load (GLTFLoader, 20s timeout, https-only) → normalize scale
 * (target ~1.8 m tall) → translate so feet sit at origin → map pivots via
 * the Mixamo bone-name convention (with a manual `boneMap` remap fallback)
 * → clone materials into per-instance owned copies (same `own()` treatment
 * makeHumanoid uses, so flash()/setDead()/dispose() are safe).
 *
 * Any failure → null, and the caller keeps the procedural rig. Never throws.
 *
 * Assumptions (documented, phase-1): the model faces +Z (Mixamo GLB default);
 * pivot swing rotates bone-local X (true for typical Mixamo exports). A
 * non-conforming skeleton still loads — it just swings oddly until the
 * bone-remap UI maps the right nodes.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { disposeOwned, type CharacterRig } from './Characters';
import { CHARACTER_PIVOTS, GLB_URL_RE, type CharacterPivot } from '@spec';

/** pivot → node name override supplied by the user (spec.custom.characters.*.boneMap) */
export type BoneMapping = Partial<Record<CharacterPivot, string>>;

export const ADAPTER_TARGET_HEIGHT = 1.8; // meters — matches the procedural humanoid
const LOAD_TIMEOUT_MS = 20000;

/**
 * Normalize a node name for convention matching: lowercase, strip the
 * `mixamorig`/`mixamo` prefix, drop every non-alphanumeric.
 * 'mixamorig:Hips' → 'hips', 'mixamorig_LeftArm' → 'leftarm', 'Hips' → 'hips'.
 */
export function normalizeBoneName(name: string): string {
  return name.toLowerCase().replace(/^mixamorig?/, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Default Mixamo-convention pivot targets, in normalized-name form.
 * Verified against the canonical Mixamo skeleton (Hips → Spine → Spine1 →
 * Spine2 → Neck → Head; LeftShoulder → LeftArm → LeftForeArm → LeftHand;
 * LeftUpLeg → LeftLeg → LeftFoot → LeftToeBase).
 */
const MIXAMO_DEFAULTS: Record<CharacterPivot, string[]> = {
  torso: ['hips', 'spine', 'pelvis'],
  head: ['head'],
  armL: ['leftarm', 'larm'],
  armR: ['rightarm', 'rarm'],
  legL: ['leftupleg', 'lupleg', 'leftthigh'],
  legR: ['rightupleg', 'rupleg', 'rightthigh'],
  elbowL: ['leftforearm', 'lelbow'],
  elbowR: ['rightforearm', 'relbow'],
  kneeL: ['leftleg', 'lknee'],
  kneeR: ['rightleg', 'rknee'],
};

/** Find the first node under root whose normalized name is in `names` (names are normalized too). */
function findNode(root: THREE.Object3D, names: string[]): THREE.Object3D | null {
  const want = new Set(names.map(normalizeBoneName));
  let hit: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (hit || !o.name) return;
    if (want.has(normalizeBoneName(o.name))) hit = o;
  });
  return hit;
}

/**
 * Resolve pivots against a model graph. A `boneMap` entry wins when it names
 * an existing node; otherwise the Mixamo convention is tried. Missing pivots
 * are simply absent from the result (animate() guards with optional access).
 */
export function resolvePivots(
  root: THREE.Object3D,
  mapping?: BoneMapping,
): Partial<Record<CharacterPivot, THREE.Object3D>> {
  const out: Partial<Record<CharacterPivot, THREE.Object3D>> = {};
  for (const pivot of CHARACTER_PIVOTS) {
    const manual = mapping?.[pivot];
    const hit = (manual ? findNode(root, [manual]) : null) ?? findNode(root, MIXAMO_DEFAULTS[pivot]);
    if (hit) out[pivot] = hit;
  }
  return out;
}

/**
 * Scale the model to ~targetHeight meters tall and translate it so the
 * lowest point (feet) sits at y=0. Returns the applied scale.
 */
export function fitModelToHeight(model: THREE.Object3D, targetHeight = ADAPTER_TARGET_HEIGHT): number {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const h = size.y > 0 ? size.y : 1;
  // Wide clamp: pathological scales (a 1000 m statue, a 1 mm figurine) still
  // normalize; only absurd-beyond-physics factors are trimmed.
  const s = THREE.MathUtils.clamp(targetHeight / h, 1e-4, 1e4);
  model.scale.multiplyScalar(s);
  model.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(model);
  model.position.y -= box2.min.y; // feet at origin
  return s;
}

/** Per-instance owned clone of every material under root (the makeHumanoid `own()` treatment). */
function ownMaterials(root: THREE.Object3D): THREE.Material[] {
  const owned: THREE.Material[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    const cur = m.material as THREE.Material | THREE.Material[] | undefined;
    if (!cur) return;
    const list = (Array.isArray(cur) ? cur : [cur]).map((mm) => {
      const c = mm.clone() as THREE.Material;
      c.userData.owned = true;
      owned.push(c);
      return c;
    });
    m.material = (Array.isArray(cur) ? list : list[0]) as THREE.Material | THREE.Material[];
  });
  return owned;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

/**
 * Adapt a loaded GLTF scene to the CharacterRig contract. Drives the SAME
 * procedural swing math as makeHumanoid's animate() on the mapped pivots.
 * Never throws — a degenerate model yields a rig whose pivots are absent and
 * whose animate() is a safe no-op for those limbs.
 */
export function makeRigFromGLTF(
  gltf: { scene: THREE.Object3D },
  mapping?: BoneMapping,
): CharacterRig {
  const model = gltf.scene;
  fitModelToHeight(model);
  const pivots = resolvePivots(model, mapping);
  const allMats = ownMaterials(model);

  const group = new THREE.Group();
  group.add(model);

  // Fallback for unmapped pivots: a detached Object3D, so the six-pivot
  // contract always holds while missing limbs stay inert (never the group —
  // swinging group.rotation would tumble the whole character).
  const inert = new THREE.Object3D();

  // bob base positions (torso/head pivots bob around their rest pose)
  const baseY = {
    torso: pivots.torso?.position.y ?? 0,
    head: pivots.head?.position.y ?? 0,
  };
  let flashTime = 0;
  let atkT = -1; // self-advancing swing timer (1 → 0)

  const animate = (t: number, speed: number, opts: { attacking?: number; dead?: boolean } = {}) => {
    const k = Math.min(1, speed / 6);
    const f = t * (8 + k * 4);
    const s = Math.sin(f);
    const sw = s * 0.7 * k;
    if (pivots.legL) pivots.legL.rotation.x = sw;
    if (pivots.legR) pivots.legR.rotation.x = -sw;
    if (pivots.armL) pivots.armL.rotation.x = -sw * 0.85;
    if (pivots.armR) pivots.armR.rotation.x = sw * 0.85;
    // phase-coupled sub-pivots, same math as the procedural rig (guarded — imports may lack them)
    if (pivots.kneeL) pivots.kneeL.rotation.x = k * (0.08 + 0.85 * Math.max(0, -s));
    if (pivots.kneeR) pivots.kneeR.rotation.x = k * (0.08 + 0.85 * Math.max(0, s));
    if (pivots.elbowL) pivots.elbowL.rotation.x = -0.12 - k * 0.5 * Math.max(0, -s);
    if (pivots.elbowR) pivots.elbowR.rotation.x = -0.12 - k * 0.5 * Math.max(0, s);
    let atkP = opts.attacking && opts.attacking > 0 ? opts.attacking : 0;
    if (!atkP && atkT >= 0) { atkP = 1 - atkT; atkT -= 0.045; if (atkT < 0) atkT = -1; }
    if (atkP > 0 && pivots.armR) {
      const p = atkP;
      pivots.armR.rotation.x = -2.4 + p * 3.2;
      pivots.armR.rotation.z = 0.4 - p * 0.5;
      if (pivots.elbowR) pivots.elbowR.rotation.x = -0.25 - 0.9 * (1 - p);
    } else if (pivots.armR) {
      pivots.armR.rotation.z = 0;
    }
    const bob = Math.abs(Math.sin(f)) * 0.05 * k;
    if (pivots.torso) pivots.torso.position.y = baseY.torso + bob;
    if (pivots.head) pivots.head.position.y = baseY.head + bob;
    if (opts.dead) {
      group.rotation.x = -Math.PI / 2 * Math.min(1, (group.userData.deadT = (group.userData.deadT ?? 0) + 0.03));
    }
    if (flashTime > 0) {
      flashTime -= 0.016;
      const on = Math.floor(flashTime * 20) % 2 === 0;
      for (const m of allMats) {
        const sm = m as THREE.MeshStandardMaterial;
        if ('emissive' in sm) { sm.emissive.setHex(on ? 0xff2222 : 0x000000); sm.emissiveIntensity = on ? 0.8 : 0; }
      }
    }
  };

  return {
    group,
    limbs: {
      legL: pivots.legL ?? inert,
      legR: pivots.legR ?? inert,
      armL: pivots.armL ?? inert,
      armR: pivots.armR ?? inert,
      torso: pivots.torso ?? inert,
      head: pivots.head ?? inert,
      weaponMount: pivots.armR,
      elbowL: pivots.elbowL, elbowR: pivots.elbowR,
      kneeL: pivots.kneeL, kneeR: pivots.kneeR,
      joints: (pivots.elbowL && pivots.elbowR && pivots.kneeL && pivots.kneeR)
        ? { elbowL: pivots.elbowL, elbowR: pivots.elbowR, kneeL: pivots.kneeL, kneeR: pivots.kneeR }
        : undefined,
    },
    swing() { atkT = 1; },
    animate,
    setDead(dead) { if (dead) group.userData.deadT = 0; },
    flash() { flashTime = 0.25; },
    dispose() { disposeOwned(group); },
  };
}

/**
 * Load a character model URL and adapt it to a CharacterRig.
 * Returns null on ANY failure (bad URL, timeout, parse error, no pivots) —
 * the caller keeps the procedural rig. Never throws.
 */
export async function loadRigFromURL(url: string, mapping?: BoneMapping): Promise<CharacterRig | null> {
  try {
    if (!GLB_URL_RE.test(url)) return null; // https + .glb/.gltf only (defense in depth)
    const gltf = await withTimeout(new GLTFLoader().loadAsync(url), LOAD_TIMEOUT_MS);
    return makeRigFromGLTF(gltf, mapping);
  } catch (e) {
    console.warn('[RigAdapter] model load failed, keeping procedural rig:', url, e);
    return null;
  }
}
