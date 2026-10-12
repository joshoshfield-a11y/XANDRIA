/**
 * Workstream A (graphics full-scale): layered armor sets.
 * - pickVoxelArmorSetId: seeded determinism through the engine Rng
 *   (same seed → same set; every set reachable; ids always resolve)
 * - joint parenting: every set's pieces live under the right CharacterRig
 *   pivots (the inventory-wave technique — procedural animation carries armor)
 * - animation survival: walk/run/attack (animate + swing) keep armor attached
 * - visor emissive slit color per set + skin visor override
 * - player + enemy archetypes: the 4 armor skins render armor on standard
 *   and brute-bulk humanoid rigs (the shared CharacterController/EnemyAI
 *   path every humanoid genre uses)
 * - SkinBuilder .armor()/.visor() round-trip + real spec validation
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { VOXEL_ARMOR_SET_IDS } from '@spec';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid, type CharacterRig } from '../src/engine/gfx/Characters';
import { BUILT_IN_SKINS, applySkin } from '../src/engine/gfx/Skins';
import { SkinBuilder } from '../src/engine/gfx/SkinBuilder';
import {
  applyVoxelArmor, pickVoxelArmorSetId, resolveVoxelArmorSet,
} from '../src/engine/gfx/VoxelArmor';

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};
const mats = () => new MaterialLibrary(testSpec);
/** standard-archetype rig; bulk 1.7 mirrors the EnemyAI brute build */
const rigOf = (seed = 11, bulk = 1) =>
  makeHumanoid(mats(), { bulk }, seed, { headStyle: 'helmet', armor: 'none' });

interface ArmorMesh extends THREE.Mesh {
  userData: { armorPiece?: boolean; armorSet?: string; armorSlot?: string; armorOrigin?: string };
}
const armorMeshes = (rig: CharacterRig, slot?: string): ArmorMesh[] => {
  const out: ArmorMesh[] = [];
  rig.group.traverse((o) => {
    const m = o as ArmorMesh;
    if (m.isMesh && m.userData.armorPiece === true &&
      (slot === undefined || m.userData.armorSlot === slot)) out.push(m);
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
const glowMats = (rig: CharacterRig): THREE.MeshStandardMaterial[] => {
  const out: THREE.MeshStandardMaterial[] = [];
  for (const m of armorMeshes(rig)) {
    const mm = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mm as THREE.MeshStandardMaterial[]) {
      if (mat.emissiveIntensity > 1 && !out.includes(mat)) out.push(mat);
    }
  }
  return out;
};
const underPivot = (m: THREE.Object3D, pivot: THREE.Object3D): boolean => {
  let o: THREE.Object3D | null = m.parent;
  while (o) { if (o === pivot) return true; o = o.parent; }
  return false;
};

/** the 4 art-direction sets from character-target-voxel.png */
const FOUR = ['nomad', 'raider', 'guardian', 'scout'] as const;

describe('workstream A: pickVoxelArmorSetId (seeded)', () => {
  it('same seed → same set, across calls and sessions (golden values)', () => {
    expect(pickVoxelArmorSetId(7)).toBe('nomad');
    expect(pickVoxelArmorSetId(1)).toBe('scout');
    expect(pickVoxelArmorSetId(100)).toBe('raider');
    expect(pickVoxelArmorSetId(12345)).toBe('plate');
    expect(pickVoxelArmorSetId(7)).toBe(pickVoxelArmorSetId(7));
    expect(pickVoxelArmorSetId(0)).toBe(pickVoxelArmorSetId(0));
  });
  it('every pick is a resolvable built-in id; every set is reachable', () => {
    const seen = new Set<string>();
    for (let s = 1; s <= 500; s++) {
      const id = pickVoxelArmorSetId(s);
      expect(VOXEL_ARMOR_SET_IDS).toContain(id);
      expect(resolveVoxelArmorSet(id), `seed ${s}`).toBeDefined();
      seen.add(id);
    }
    expect(seen.size).toBe(VOXEL_ARMOR_SET_IDS.length);
  });
  it('same seed + specified set → identical armor geometry on independent rigs', () => {
    for (const id of FOUR) {
      const a = rigOf(42); applyVoxelArmor(a, id);
      const b = rigOf(42); applyVoxelArmor(b, id);
      expect(armorMeshes(a).length, `${id} pieces`).toBeGreaterThan(8);
      expect(armorSig(a), `${id} seeded geometry`).toBe(armorSig(b));
      a.dispose(); b.dispose();
    }
  });
});

describe('workstream A: joint parenting', () => {
  it('head/torso/leg pieces parent under the matching rig pivots', () => {
    for (const id of FOUR) {
      const rig = rigOf(13);
      applyVoxelArmor(rig, id);
      const L = rig.limbs;
      for (const m of armorMeshes(rig, 'head'))
        expect(underPivot(m, L.head), `${id}: head piece under head pivot`).toBe(true);
      for (const m of armorMeshes(rig, 'torso'))
        expect(underPivot(m, L.torso), `${id}: torso piece under torso pivot`).toBe(true);
      const legs = armorMeshes(rig, 'legs');
      expect(legs.length, `${id}: greaves built`).toBe(4); // 2 boxes × kneeL/kneeR
      for (const m of legs)
        expect(underPivot(m, L.kneeL!) || underPivot(m, L.kneeR!), `${id}: greave under a knee pivot`).toBe(true);
      rig.dispose();
    }
  });
  it('pauldrons mount directly on the arm pivots (procedural animation carries them)', () => {
    for (const id of FOUR) {
      const rig = rigOf(13);
      applyVoxelArmor(rig, id);
      const L = rig.limbs;
      const direct = armorMeshes(rig, 'accessory')
        .filter((m) => m.parent === L.armL || m.parent === L.armR);
      expect(direct.length, `${id}: pauldron boxes on arm pivots`).toBe(4); // shell + trim × L/R
      rig.dispose();
    }
  });
});

describe('workstream A: armor survives animation', () => {
  it('walk/run/attack (animate + swing) keep every piece attached', () => {
    for (const id of FOUR) {
      const rig = rigOf(17);
      applyVoxelArmor(rig, id);
      const before = armorMeshes(rig).length;
      expect(before).toBeGreaterThan(0);
      expect(() => {
        for (let i = 0; i < 60; i++) rig.animate(i * 0.016, 2.0);  // walk
        for (let i = 0; i < 60; i++) rig.animate(i * 0.016, 6.5);  // run
        rig.swing();                                                // attack
        for (let i = 0; i < 60; i++) rig.animate(i * 0.016, 0.5);  // settle
      }).not.toThrow();
      const after = armorMeshes(rig);
      expect(after.length, `${id}: no piece lost`).toBe(before);
      for (const m of after)
        expect(underPivot(m, rig.group), `${id}: piece still under the rig`).toBe(true);
      rig.dispose();
    }
  });
});

describe('workstream A: visor emissive color per set', () => {
  it('each set glows its art-direction slit color', () => {
    const expected: [string, string][] = [
      ['nomad', 'ffd23f'],    // amber
      ['raider', 'ff9d2e'],   // ember orange
      ['guardian', '4dff6a'], // emerald
      ['scout', '35e0ff'],    // void cyan
    ];
    for (const [id, hex] of expected) {
      const rig = rigOf(23);
      applyVoxelArmor(rig, id);
      const glows = glowMats(rig);
      expect(glows.length, `${id}: visor slit built`).toBeGreaterThan(0);
      for (const g of glows)
        expect(g.emissive.getHexString(), `${id}: visor color`).toBe(hex);
      rig.dispose();
    }
  });
  it('skin visor overrides the set default; explicit applyVoxelArmor visor wins', () => {
    const skins: [string, string][] = [
      ['nomad', 'ffd23f'],
      ['desert-raider', 'ff9d2e'],
      ['emerald-guardian', '4dff6a'],
      ['void-scout', '35e0ff'],
    ];
    for (const [skinId, hex] of skins) {
      const rig = rigOf(29);
      applySkin(rig, BUILT_IN_SKINS[skinId]);
      expect(armorMeshes(rig).length, `${skinId}: armor rendered`).toBeGreaterThan(8);
      for (const g of glowMats(rig))
        expect(g.emissive.getHexString(), `${skinId}: visor`).toBe(hex);
      rig.dispose();
    }
    const rig = rigOf(29);
    applyVoxelArmor(rig, 'nomad', { visorColor: '#ff00ff', visorIntensity: 3 });
    for (const g of glowMats(rig))
      expect(g.emissive.getHexString(), 'explicit visor override').toBe('ff00ff');
    rig.dispose();
  });
});

describe('workstream A: player + enemy archetypes', () => {
  it('the 4 armor skins render armor on standard and brute-bulk rigs', () => {
    const skinIds = ['nomad', 'desert-raider', 'emerald-guardian', 'void-scout'];
    for (const skinId of skinIds) {
      const player = rigOf(37, 1); // standard archetype, bulk 1 (player)
      applySkin(player, BUILT_IN_SKINS[skinId]);
      expect(armorMeshes(player).length, `${skinId}: player armor`).toBeGreaterThan(8);
      player.dispose();
      const brute = rigOf(37, 1.7); // brute bulk (EnemyAI walker/brute path)
      applySkin(brute, BUILT_IN_SKINS[skinId]);
      expect(armorMeshes(brute).length, `${skinId}: brute armor`).toBeGreaterThan(8);
      brute.dispose();
    }
  });
});

describe('workstream A: SkinBuilder armor/visor', () => {
  it('.armor()/.visor() round-trip, validate clean, and render', () => {
    const b = new SkinBuilder('warden-test')
      .displayName('Warden Test')
      .palette({ skin: '#d9a066', shirt: '#3f5a78', pants: '#2e2a26', accent: '#ffd23f' })
      .armor('guardian')
      .visor('#4dff6a', 2.2);
    const def = b.build();
    expect(def.armor).toBe('guardian');
    expect(def.visor).toEqual({ color: '#4dff6a', intensity: 2.2 });
    expect(b.validate()).toEqual([]);
    const rig = rigOf(41);
    applySkin(rig, def);
    expect(armorMeshes(rig).length, 'builder skin renders armor').toBeGreaterThan(8);
    for (const g of glowMats(rig))
      expect(g.emissive.getHexString(), 'builder skin visor').toBe('4dff6a');
    rig.dispose();
  });
  it('item skins accept .armor() (EquipRig slot pieces)', () => {
    const def = new SkinBuilder('edge-test').displayName('Edge Test').forItem().armor('scout').build();
    expect(def.armor).toBe('scout');
  });
});
