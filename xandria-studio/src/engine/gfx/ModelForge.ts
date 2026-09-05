/**
 * ModelForge — deterministic procedural model synthesis.
 *
 * The successor of the legacy lattice's asset-forge ambitions (Aethelgard / Mythos
 * needed a live LLM; v3.0's ModelGenerator visualized ASTs). This one is fully
 * self-contained: a seed in, a distinct model out — same seed, same model, always.
 *
 * Every game gets its own "art direction": body proportions, headgear, armor and
 * color roles are forged from the game seed, so two generated games never share
 * a cast. Geometry stays chunky/flat-shaded — the PS2 look is the brand.
 */
import * as THREE from 'three';
import { Rng } from '../core/Rng';

export type HeadStyle = 'visor' | 'horned' | 'helmet' | 'mohawk' | 'hood' | 'antenna' | 'crest';
export type ArmorStyle = 'none' | 'pads' | 'plate' | 'bandolier';
export type Extra = 'cape' | 'backpack' | 'spikes' | 'belt' | 'skirt' | 'pauldron-asym';

export interface HumanoidPlan {
  height: number;            // overall scale, 0.9..1.25
  bulk: number;              // width scale, 0.8..1.55
  headSize: number;          // 0.85..1.3
  legLen: number;            // 0.85..1.15
  headStyle: HeadStyle;
  armor: ArmorStyle;
  extras: Extra[];
  colors: { skin: string; shirt: string; pants: string; accent: string };
}

const HEAD_STYLES: HeadStyle[] = ['visor', 'horned', 'helmet', 'mohawk', 'hood', 'antenna', 'crest'];
const ARMOR_STYLES: ArmorStyle[] = ['none', 'pads', 'plate', 'bandolier'];
const EXTRAS: Extra[] = ['cape', 'backpack', 'spikes', 'belt', 'skirt', 'pauldron-asym'];

/** Derive a visually distinct humanoid plan from a seed. Deterministic. */
export function forgeHumanoidPlan(
  seed: number,
  base: { skin?: string; shirt?: string; pants?: string; accent?: string; bulk?: number } = {},
): HumanoidPlan {
  const rng = new Rng(seed ^ 0xf04e);
  const extras: Extra[] = [];
  const shuffled = [...EXTRAS].sort(() => rng.next() - 0.5);
  for (const e of shuffled) if (rng.next() < 0.28) extras.push(e);
  return {
    height: rng.range(0.92, 1.22),
    bulk: (base.bulk ?? 1) * rng.range(0.88, 1.18),
    headSize: rng.range(0.85, 1.3),
    legLen: rng.range(0.88, 1.12),
    headStyle: rng.pick(HEAD_STYLES),
    armor: rng.pick(ARMOR_STYLES),
    extras,
    colors: {
      skin: base.skin ?? '#d8a077',
      shirt: base.shirt ?? '#3a6ea5',
      pants: base.pants ?? '#3d3a35',
      accent: base.accent ?? '#ffd23f',
    },
  };
}

export interface VehiclePlan {
  bodyLen: number;      // 3.1..4.3
  cabinLen: number;     // 1.3..2.1
  cabinZ: number;       // -0.6..0.3
  spoiler: 'none' | 'lip' | 'wing' | 'ducktail';
  scoop: boolean;
  fenders: boolean;
  nose: 'flat' | 'wedge' | 'splitter';
}

export function forgeVehiclePlan(seed: number): VehiclePlan {
  const rng = new Rng(seed ^ 0xca22);
  return {
    bodyLen: rng.range(3.2, 4.2),
    cabinLen: rng.range(1.3, 2.1),
    cabinZ: rng.range(-0.6, 0.2),
    spoiler: rng.pick(['none', 'lip', 'wing', 'ducktail'] as const),
    scoop: rng.next() < 0.45,
    fenders: rng.next() < 0.5,
    nose: rng.pick(['flat', 'wedge', 'splitter'] as const),
  };
}

export type DronePlan = {
  kind: 'ring' | 'quad' | 'eyebot';
  size: number;
  fins: number;
};

export function forgeDronePlan(seed: number): DronePlan {
  const rng = new Rng(seed ^ 0xd021);
  return {
    kind: rng.pick(['ring', 'quad', 'eyebot'] as const),
    size: rng.range(0.85, 1.25),
    fins: rng.int(0, 4),
  };
}

/** Stable numeric fingerprint of a mesh tree — used by determinism tests. */
export function fingerprint(root: THREE.Object3D): number {
  let h = 2166136261;
  const mix = (n: number) => { h ^= Math.round(n * 1000) & 0x7fffffff; h = Math.imul(h, 16777619); };
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const g = (o as THREE.Mesh).geometry;
      mix(g.attributes.position?.count ?? 0);
      mix(o.position.x); mix(o.position.y); mix(o.position.z);
      mix(o.scale.x); mix(o.scale.y); mix(o.scale.z);
    }
  });
  return h >>> 0;
}
