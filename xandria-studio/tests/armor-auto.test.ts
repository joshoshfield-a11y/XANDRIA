/**
 * Worker E (graphics follow-up): opt-in seeded auto-armor.
 *
 * `custom.armor.auto: true` makes applySkin pick an armor set deterministically
 * from the spec seed (via pickVoxelArmorSetId) for skins with no explicit
 * `armor`. The flag is strict opt-in: absent/false (or a missing/invalid
 * seed) → the legacy path, byte-identical to before — all 12 legacy skins
 * keep their tested "render armor-free" contract.
 *
 * Covers:
 * - schema: ArmorCustom + custom.armor validation (boolean strict, warnings-free)
 * - skinOptionsForSpec: spec → ApplySkinOptions (strict boolean true only)
 * - applySkin: flag on → seeded set applied, same seed → same set;
 *   flag off/absent → legacy armor-free for ALL 12 legacy skins;
 *   explicit skin.armor always wins over auto
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  validateSpec, defaultSpec, type GameSpec, type SkinDef,
} from '@spec';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid, type CharacterRig } from '../src/engine/gfx/Characters';
import {
  BUILT_IN_SKINS, applySkin, skinOptionsForSpec, type ApplySkinOptions,
} from '../src/engine/gfx/Skins';
import { pickVoxelArmorSetId } from '../src/engine/gfx/VoxelArmor';

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};
const mats = () => new MaterialLibrary(testSpec);
/** neutral headgear / no forge armor so only voxel armor pieces count */
const rigOf = (seed = 11, bulk = 1) =>
  makeHumanoid(mats(), { bulk }, seed, { headStyle: 'helmet', armor: 'none' });

interface ArmorMesh extends THREE.Mesh {
  userData: { armorPiece?: boolean; armorSet?: string; armorSlot?: string; armorOrigin?: string };
}
const armorMeshes = (rig: CharacterRig): ArmorMesh[] => {
  const out: ArmorMesh[] = [];
  rig.group.traverse((o) => {
    const m = o as ArmorMesh;
    if (m.isMesh && m.userData.armorPiece === true) out.push(m);
  });
  return out;
};
/** geometry+placement signature: pins seeded determinism of a built set */
const armorSig = (rig: CharacterRig): string =>
  armorMeshes(rig)
    .map((m) => {
      const p = (m.geometry as THREE.BoxGeometry).parameters as { width: number; height: number; depth: number };
      const q = m.position;
      return [m.userData.armorSlot, m.userData.armorSet,
        p.width.toFixed(4), p.height.toFixed(4), p.depth.toFixed(4),
        q.x.toFixed(4), q.y.toFixed(4), q.z.toFixed(4)].join('|');
    })
    .sort()
    .join('\n');

/** the 12 legacy skins: every built-in without an explicit armor set */
const LEGACY = Object.entries(BUILT_IN_SKINS).filter(([, d]) => !d.armor);

describe('worker E: legacy contract — flag absent/off → armor-free', () => {
  it('exactly 12 legacy skins carry no explicit armor', () => {
    expect(LEGACY).toHaveLength(12);
  });
  it('all 12 legacy skins render armor-free with the flag absent (2-arg legacy call)', () => {
    for (const [id, def] of LEGACY) {
      const rig = rigOf(51);
      applySkin(rig, def); // no opts — the exact pre-flag call shape
      expect(armorMeshes(rig), `${id} armor-free`).toHaveLength(0);
      rig.dispose();
    }
  });
  it('all 12 legacy skins render armor-free with autoArmor: false and with empty opts', () => {
    for (const [id, def] of LEGACY) {
      const rig = rigOf(52);
      applySkin(rig, def, { autoArmor: false, seed: 7 });
      expect(armorMeshes(rig), `${id} autoArmor:false`).toHaveLength(0);
      const rig2 = rigOf(53);
      applySkin(rig2, def, {});
      expect(armorMeshes(rig2), `${id} empty opts`).toHaveLength(0);
      rig.dispose(); rig2.dispose();
    }
  });
  it('autoArmor: true with a missing/invalid seed falls back to the legacy armor-free path', () => {
    for (const bad of [undefined, NaN, 1.5, 'seven' as unknown as number]) {
      const rig = rigOf(54);
      const opts: ApplySkinOptions = { autoArmor: true, seed: bad };
      applySkin(rig, BUILT_IN_SKINS.crimson, opts);
      expect(armorMeshes(rig), `seed ${String(bad)}`).toHaveLength(0);
      rig.dispose();
    }
  });
});

describe('worker E: flag on → seeded armor set applied', () => {
  it('auto-armor renders the seeded set on a legacy skin (golden: seed 7 → nomad)', () => {
    const rig = rigOf(61);
    applySkin(rig, BUILT_IN_SKINS.crimson, { autoArmor: true, seed: 7 });
    const pieces = armorMeshes(rig);
    expect(pieces.length, 'armor pieces').toBeGreaterThan(8);
    expect(pickVoxelArmorSetId(7)).toBe('nomad');
    expect(pieces.every((m) => m.userData.armorSet === 'nomad')).toBe(true);
    rig.dispose();
  });
  it('the picked set matches pickVoxelArmorSetId for several seeds', () => {
    for (const seed of [1, 7, 100, 12345, 999]) {
      const rig = rigOf(62 + seed);
      applySkin(rig, BUILT_IN_SKINS.stealth, { autoArmor: true, seed });
      const pieces = armorMeshes(rig);
      const want = pickVoxelArmorSetId(seed);
      expect(pieces.length, `seed ${seed} pieces`).toBeGreaterThan(8);
      expect(pieces.every((m) => m.userData.armorSet === want), `seed ${seed} set`).toBe(true);
      rig.dispose();
    }
  });
  it('same seed → same set, byte-identical armor geometry on independent rigs', () => {
    const a = rigOf(63); applySkin(a, BUILT_IN_SKINS.gold, { autoArmor: true, seed: 12345 });
    const b = rigOf(63); applySkin(b, BUILT_IN_SKINS.gold, { autoArmor: true, seed: 12345 });
    expect(armorSig(a)).toBe(armorSig(b));
    expect(armorSig(a).length).toBeGreaterThan(0);
    a.dispose(); b.dispose();
  });
  it('an explicit skin.armor always wins over auto-armor (seed 1 would pick scout, skin says nomad)', () => {
    expect(pickVoxelArmorSetId(1)).toBe('scout'); // sanity: seed 1 does NOT pick nomad
    const rig = rigOf(65);
    applySkin(rig, BUILT_IN_SKINS.nomad, { autoArmor: true, seed: 1 });
    const pieces = armorMeshes(rig);
    expect(pieces.length).toBeGreaterThan(8);
    expect(pieces.every((m) => m.userData.armorSet === 'nomad')).toBe(true);
    rig.dispose();
  });
  it('works on brute-bulk rigs too (the EnemyAI brute build shape)', () => {
    const rig = rigOf(66, 1.7);
    applySkin(rig, BUILT_IN_SKINS.rustscrap, { autoArmor: true, seed: 100 });
    const pieces = armorMeshes(rig);
    expect(pieces.length).toBeGreaterThan(8);
    expect(pieces.every((m) => m.userData.armorSet === pickVoxelArmorSetId(100))).toBe(true);
    rig.dispose();
  });
});

describe('worker E: skinOptionsForSpec', () => {
  const specWith = (custom: unknown): GameSpec => {
    const s = defaultSpec(42) as GameSpec;
    (s as unknown as { custom: unknown }).custom = custom;
    return s;
  };
  it('reads the opt-in flag and the spec seed', () => {
    expect(skinOptionsForSpec(specWith({ armor: { auto: true } })))
      .toEqual({ autoArmor: true, seed: 42 });
  });
  it('absent flag / false / custom → autoArmor false, seed still carried', () => {
    expect(skinOptionsForSpec(specWith(undefined))).toEqual({ autoArmor: false, seed: 42 });
    expect(skinOptionsForSpec(specWith({}))).toEqual({ autoArmor: false, seed: 42 });
    expect(skinOptionsForSpec(specWith({ armor: { auto: false } })))
      .toEqual({ autoArmor: false, seed: 42 });
  });
  it('only the boolean true opts in — truthy junk stays off', () => {
    expect(skinOptionsForSpec(specWith({ armor: { auto: 'yes' } })).autoArmor).toBe(false);
    expect(skinOptionsForSpec(specWith({ armor: { auto: 1 } })).autoArmor).toBe(false);
    expect(skinOptionsForSpec(undefined)).toEqual({ autoArmor: false, seed: undefined });
  });
});

describe('worker E: validateSpec accepts and range-checks custom.armor', () => {
  const withArmor = (armor: unknown) => {
    const s = defaultSpec(1) as GameSpec;
    (s as unknown as { custom: unknown }).custom = { armor };
    return validateSpec(s);
  };
  it('auto: true / false / absent all validate with no unknown-key warning', () => {
    for (const armor of [{ auto: true }, { auto: false }, undefined]) {
      const r = armor === undefined ? validateSpec(defaultSpec(1)) : withArmor(armor);
      expect(r.ok, JSON.stringify(armor)).toBe(true);
      expect(r.warnings.filter((w) => w.includes('custom key'))).toHaveLength(0);
    }
  });
  it('rejects a non-boolean auto and a non-object armor', () => {
    const r1 = withArmor({ auto: 'yes' });
    expect(r1.ok).toBe(false);
    expect(r1.errors.some((e) => e.includes('custom.armor.auto'))).toBe(true);
    const r2 = withArmor('nope');
    expect(r2.ok).toBe(false);
    expect(r2.errors.some((e) => e.includes('custom.armor'))).toBe(true);
  });
  it('a custom SkinDef type-checks with the armor flag present', () => {
    const def: SkinDef = { name: 'Legacy', palette: { shirt: '#334455' } };
    expect(def.armor).toBeUndefined();
  });
});
