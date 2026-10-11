/**
 * Art-direction pass — voxel armor.
 * - registry: 5 built-in sets, ids match VOXEL_ARMOR_SET_IDS, custom registration
 * - applyVoxelArmor / applyVoxelArmorSlot / clearVoxelArmor: pivot mounting,
 *   owned role-less materials, determinism, never-throws, slot/origin clearing
 * - skins: 4 new armor skins (armor set + palette + visor color);
 *   applySkin renders armor automatically; the 12 legacy skins render armor-free
 * - schema: SkinDef.armor/visor + ItemSkinDef.armor validation (known id or
 *   custom-defined via customArmorSets; visor #rrggbb, intensity 0..5)
 * - EquipRig: armor-slot items whose item skin carries armor render slot pieces
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  validateSpec, defaultSpec, VOXEL_ARMOR_SET_IDS,
  type GameSpec, type SkinDef,
} from '@spec';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid, makeDrone, type CharacterRig } from '../src/engine/gfx/Characters';
import { BUILT_IN_SKINS, applySkin } from '../src/engine/gfx/Skins';
import {
  VOXEL_ARMOR_SETS, applyVoxelArmor, applyVoxelArmorSlot, clearVoxelArmor,
  resolveVoxelArmorSet, registerVoxelArmorSet, registeredVoxelArmorSetIds,
  voxelArmorSetIds,
} from '../src/engine/gfx/VoxelArmor';
import { equip, unequip, equippedMesh } from '../src/engine/gfx/EquipRig';

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};
const mats = () => new MaterialLibrary(testSpec);
/** standard-archetype rig, neutral headgear so armor shells read cleanly */
const rigOf = (seed = 11) => makeHumanoid(mats(), {}, seed, { headStyle: 'helmet', armor: 'none' });

interface ArmorMesh extends THREE.Mesh {
  userData: {
    armorPiece?: boolean; armorSet?: string; armorSlot?: string; armorOrigin?: string;
    owned?: boolean; role?: string;
  };
}
const armorMeshes = (rig: CharacterRig, slot?: string, origin?: string): ArmorMesh[] => {
  const out: ArmorMesh[] = [];
  rig.group.traverse((o) => {
    const m = o as ArmorMesh;
    if (m.isMesh && m.userData.armorPiece === true &&
      (slot === undefined || m.userData.armorSlot === slot) &&
      (origin === undefined || m.userData.armorOrigin === origin)) out.push(m);
  });
  return out;
};
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

describe('artdir: voxel armor registry', () => {
  it('has 5 built-in sets and the ids match VOXEL_ARMOR_SET_IDS', () => {
    expect(Object.keys(VOXEL_ARMOR_SETS).sort()).toEqual([...VOXEL_ARMOR_SET_IDS].sort());
    expect(voxelArmorSetIds().sort()).toEqual([...VOXEL_ARMOR_SET_IDS].sort());
    for (const id of VOXEL_ARMOR_SET_IDS) {
      const s = VOXEL_ARMOR_SETS[id];
      expect(s.id).toBe(id);
      expect(s.name).toBeTruthy();
      expect(typeof s.build).toBe('function');
      expect(s.visor.intensity).toBeGreaterThanOrEqual(0);
      expect(s.visor.intensity).toBeLessThanOrEqual(5);
    }
  });
  it('resolveVoxelArmorSet returns undefined for unknown ids', () => {
    expect(resolveVoxelArmorSet('nope')).toBeUndefined();
    expect(resolveVoxelArmorSet(undefined)).toBeUndefined();
  });
  it('registerVoxelArmorSet accepts well-formed defs, rejects garbage, never throws', () => {
    expect(registerVoxelArmorSet({
      id: 'test-custom', name: 'Test', palette: { shell: '#111', trim: '#222', dark: '#000' },
      visor: { color: '#ffffff', intensity: 1 }, build: () => {},
    })).toBe(true);
    expect(resolveVoxelArmorSet('test-custom')?.name).toBe('Test');
    expect(registeredVoxelArmorSetIds()).toContain('test-custom');
    expect(registerVoxelArmorSet({} as never)).toBe(false);
    expect(registerVoxelArmorSet({ id: '', build: () => {} } as never)).toBe(false);
    expect(registerVoxelArmorSet(null as never)).toBe(false);
  });
});

describe('artdir: applyVoxelArmor', () => {
  it('mounts pieces on head/torso/legs/accessory with owned, role-less materials', () => {
    const rig = rigOf();
    applyVoxelArmor(rig, 'nomad');
    const pieces = armorMeshes(rig);
    expect(pieces.length).toBeGreaterThan(8);
    const slots = new Set(pieces.map((m) => m.userData.armorSlot));
    expect(slots).toEqual(new Set(['head', 'torso', 'legs', 'accessory']));
    for (const m of pieces) {
      expect(m.userData.armorSet).toBe('nomad');
      expect(m.userData.armorOrigin).toBe('skin');
      expect(m.castShadow).toBe(true);
      const mm = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
      for (const mat of mm) {
        expect(mat.userData.owned).toBe(true);
        expect(mat.userData.role).toBeUndefined(); // skins/flash never touch armor
      }
    }
    rig.dispose();
  });
  it('every set builds a visor slit (emissive material) and is deterministic', () => {
    for (const id of VOXEL_ARMOR_SET_IDS) {
      const a = rigOf(21); applyVoxelArmor(a, id);
      const b = rigOf(21); applyVoxelArmor(b, id);
      expect(glowMats(a).length, `${id} visor`).toBeGreaterThan(0);
      expect(armorSig(a), `${id} deterministic`).toBe(armorSig(b));
      expect(armorMeshes(a).length).toBeGreaterThan(0);
      a.dispose(); b.dispose();
    }
  });
  it('raider builds a hood, guardian an emblem, scout a scarf — exact piece counts pin the sets', () => {
    const head = (id: string) => { const r = rigOf(31); applyVoxelArmor(r, id); const n = armorMeshes(r, 'head').length; r.dispose(); return n; };
    const torso = (id: string) => { const r = rigOf(31); applyVoxelArmor(r, id); const n = armorMeshes(r, 'torso').length; r.dispose(); return n; };
    const acc = (id: string) => { const r = rigOf(31); applyVoxelArmor(r, id); const n = armorMeshes(r, 'accessory').length; r.dispose(); return n; };
    expect(head('raider')).toBe(5);   // back + peak + 2 cheeks + slit (hood, face open)
    expect(head('nomad')).toBe(4);    // shell + brow + slit + chin (closed helm)
    expect(head('guardian')).toBe(5); // helm + crest ridge
    expect(torso('raider')).toBe(8);  // plate + trim + collar + belt + buckle + 3 tabard flaps
    expect(torso('nomad')).toBe(6);   // plate + trim + collar + sash + belt + buckle
    expect(acc('scout')).toBe(8);    // pauldrons + vambraces + scarf wrap + flap
    expect(acc('nomad')).toBe(6);     // pauldrons + vambraces
  });
  it('never throws: unknown set, null rig, missing pivots (drone)', () => {
    const rig = rigOf();
    expect(() => applyVoxelArmor(rig, 'nope')).not.toThrow();
    expect(armorMeshes(rig)).toHaveLength(0);
    expect(() => applyVoxelArmor(null as never, 'nomad')).not.toThrow();
    const drone = makeDrone(mats(), '#c33', '#ff4444', 1);
    expect(() => applyVoxelArmor(drone, 'nomad')).not.toThrow();
    expect(() => clearVoxelArmor(drone)).not.toThrow();
    rig.dispose(); drone.dispose();
  });
  it('re-apply replaces cleanly (no duplicate pieces)', () => {
    const rig = rigOf();
    applyVoxelArmor(rig, 'nomad');
    expect(armorMeshes(rig).length).toBeGreaterThan(0);
    applyVoxelArmor(rig, 'guardian');
    expect(armorMeshes(rig).every((m) => m.userData.armorSet === 'guardian')).toBe(true);
    const fresh = rigOf(); // same seed → identical geometry
    applyVoxelArmor(fresh, 'guardian');
    expect(armorSig(rig)).toBe(armorSig(fresh));
    rig.dispose(); fresh.dispose();
  });
  it('clearVoxelArmor strips everything; slot/origin narrow the removal', () => {
    const rig = rigOf();
    applyVoxelArmor(rig, 'nomad'); // origin skin
    applyVoxelArmorSlot(rig, 'head', 'scout', { origin: 'item' }); // origin item, head slot
    expect(armorMeshes(rig, 'head', 'item').length).toBeGreaterThan(0);
    clearVoxelArmor(rig, 'head', 'item');
    expect(armorMeshes(rig, 'head', 'item')).toHaveLength(0);
    expect(armorMeshes(rig, 'head', 'skin').length).toBeGreaterThan(0); // skin helm survives
    clearVoxelArmor(rig);
    expect(armorMeshes(rig)).toHaveLength(0);
    expect(() => clearVoxelArmor(rig)).not.toThrow();
    rig.dispose();
  });
  it('applyVoxelArmorSlot builds only that slot', () => {
    const rig = rigOf();
    applyVoxelArmorSlot(rig, 'legs', 'plate');
    const pieces = armorMeshes(rig);
    expect(pieces.length).toBeGreaterThan(0);
    expect(new Set(pieces.map((m) => m.userData.armorSlot))).toEqual(new Set(['legs']));
    rig.dispose();
  });
});

describe('artdir: skins with armor', () => {
  const FOUR = [
    ['nomad', 'nomad', '#ffd23f'],
    ['desert-raider', 'raider', '#ff9d2e'],
    ['emerald-guardian', 'guardian', '#4dff6a'],
    ['void-scout', 'scout', '#35e0ff'],
  ] as const;
  it('four new built-ins each name an armor set + palette + visor color', () => {
    for (const [id, armor, visor] of FOUR) {
      const def = BUILT_IN_SKINS[id];
      expect(def, id).toBeDefined();
      expect(def.armor).toBe(armor);
      expect(def.visor?.color.toLowerCase()).toBe(visor);
      expect(def.palette).toBeDefined();
    }
  });
  it('applySkin renders the armor set + visor glow automatically', () => {
    for (const [id, armor, visor] of FOUR) {
      const rig = rigOf(41);
      applySkin(rig, BUILT_IN_SKINS[id]);
      const pieces = armorMeshes(rig);
      expect(pieces.length, `${id} pieces`).toBeGreaterThan(8);
      expect(pieces.every((m) => m.userData.armorSet === armor)).toBe(true);
      const glows = glowMats(rig);
      expect(glows.length, `${id} visor`).toBeGreaterThan(0);
      expect('#' + glows[0].emissive.getHexString()).toBe(visor);
      rig.dispose();
    }
  });
  it('skin.visor overrides the set default visor color/intensity', () => {
    const rig = rigOf(42);
    const def: SkinDef = { ...BUILT_IN_SKINS.nomad, visor: { color: '#ff0000', intensity: 3 } };
    applySkin(rig, def);
    const glows = glowMats(rig);
    expect(glows.length).toBeGreaterThan(0);
    expect('#' + glows[0].emissive.getHexString()).toBe('#ff0000');
    expect(glows[0].emissiveIntensity).toBe(3);
    rig.dispose();
  });
  it('legacy skins render armor-free (backward compatible) and strip skin armor', () => {
    const rig = rigOf(43);
    applySkin(rig, BUILT_IN_SKINS.nomad);
    expect(armorMeshes(rig).length).toBeGreaterThan(0);
    applySkin(rig, BUILT_IN_SKINS.crimson);
    expect(armorMeshes(rig, 'head', 'skin')).toHaveLength(0);
    expect(armorMeshes(rig)).toHaveLength(0);
    // palette still lands on role materials
    rig.dispose();
  });
  it('unknown armor id is a silent no-op; visor without armor does nothing', () => {
    const rig = rigOf(44);
    expect(() => applySkin(rig, { ...BUILT_IN_SKINS.nomad, armor: 'nope' } as SkinDef)).not.toThrow();
    expect(armorMeshes(rig)).toHaveLength(0);
    expect(() => applySkin(rig, { name: 'X', visor: { color: '#ff0000' } } as SkinDef)).not.toThrow();
    expect(armorMeshes(rig)).toHaveLength(0);
    rig.dispose();
  });
  it('skin palette/roughness never mutates armor materials', () => {
    const rig = rigOf(45);
    applySkin(rig, BUILT_IN_SKINS.nomad);
    const shells = armorMeshes(rig)
      .flatMap((m) => (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[])
      .filter((mat) => '#' + mat.color.getHexString() === '#1b1e26');
    expect(shells.length).toBeGreaterThan(0); // set shell color survived the skin's roughness/metalness pass
    rig.dispose();
  });
});

describe('artdir: schema validation', () => {
  const withChars = (characters: unknown, opts?: { customArmorSets?: string[] }) => {
    const s = defaultSpec(1) as GameSpec;
    (s as unknown as { custom: unknown }).custom = { characters };
    return validateSpec(s, opts);
  };
  const withItemSkins = (skins: unknown, opts?: { customArmorSets?: string[] }) => {
    const s = defaultSpec(1) as GameSpec;
    (s as unknown as { custom: unknown }).custom = { items: { skins } };
    return validateSpec(s, opts);
  };
  it('accepts armor + visor on custom skins', () => {
    const v = withChars({ skins: { x: { name: 'X', armor: 'nomad', visor: { color: '#ff0000', intensity: 2 } } } });
    expect(v.ok).toBe(true);
  });
  it('rejects unknown armor ids, bad visor colors, out-of-range intensity', () => {
    let v = withChars({ skins: { x: { name: 'X', armor: 'nope' } } });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/armor/);
    v = withChars({ skins: { x: { name: 'X', armor: 'nomad', visor: { color: 'red' } } } });
    expect(v.ok).toBe(false);
    v = withChars({ skins: { x: { name: 'X', visor: { color: '#ff0000', intensity: 6 } } } });
    expect(v.ok).toBe(false);
    v = withChars({ skins: { x: { name: 'X', armor: 42 } } });
    expect(v.ok).toBe(false);
  });
  it('accepts custom-defined armor ids via customArmorSets', () => {
    const skins = { x: { name: 'X', armor: 'my-set' } };
    expect(withChars({ skins }).ok).toBe(false);
    expect(withChars({ skins }, { customArmorSets: ['my-set'] }).ok).toBe(true);
  });
  it('validates ItemSkinDef.armor the same way', () => {
    expect(withItemSkins({ s: { name: 'S', armor: 'plate' } }).ok).toBe(true);
    const v = withItemSkins({ s: { name: 'S', armor: 'nope' } });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/armor/);
    expect(withItemSkins({ s: { name: 'S', armor: 'my-set' } }, { customArmorSets: ['my-set'] }).ok).toBe(true);
  });
});

describe('artdir: EquipRig armor slots', () => {
  const itemSpec = (): GameSpec => {
    const s = defaultSpec(1) as GameSpec;
    (s as unknown as { custom: unknown }).custom = {
      items: {
        defs: {
          warHelm: { name: 'War Helm', type: 'armor', slot: 'head', skin: 'plateSkin' },
          plainHelm: { name: 'Plain Helm', type: 'armor', slot: 'head' },
          warSword: { name: 'War Sword', type: 'weapon', slot: 'weapon', skin: 'plateSkin' },
        },
        skins: { plateSkin: { name: 'Plate Skin', armor: 'plate' } },
      },
    };
    return s;
  };
  const defOf = (spec: GameSpec, id: string) => (spec.custom!.items!.defs as Record<string, never>)[id] as never;
  it('equipping a head item whose item skin carries armor renders head pieces (origin item)', () => {
    const spec = itemSpec();
    const rig = rigOf(51);
    const m = equip(rig, 'head', defOf(spec, 'warHelm'), { spec });
    expect(m).not.toBeNull();
    expect(equippedMesh(rig, 'head')).toBe(m);
    const pieces = armorMeshes(rig, 'head', 'item');
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.every((p) => p.userData.armorSet === 'plate')).toBe(true);
    // visor slit glows with the set default
    expect(glowMats(rig).length).toBeGreaterThan(0);
    unequip(rig, 'head');
    expect(armorMeshes(rig, 'head', 'item')).toHaveLength(0);
    expect(equippedMesh(rig, 'head')).toBeUndefined();
    rig.dispose();
  });
  it('weapon slot never renders armor; missing spec never renders armor', () => {
    const spec = itemSpec();
    const rig = rigOf(52);
    equip(rig, 'weapon', defOf(spec, 'warSword'), { spec });
    expect(armorMeshes(rig)).toHaveLength(0);
    unequip(rig, 'weapon');
    equip(rig, 'head', defOf(spec, 'warHelm')); // no spec → mesh only
    expect(equippedMesh(rig, 'head')).not.toBeUndefined();
    expect(armorMeshes(rig)).toHaveLength(0);
    rig.dispose();
  });
  it('item armor does not disturb skin armor, and vice versa', () => {
    const spec = itemSpec();
    const rig = rigOf(53);
    applySkin(rig, BUILT_IN_SKINS.nomad);
    const skinPieces = armorMeshes(rig, undefined, 'skin').length;
    equip(rig, 'head', defOf(spec, 'warHelm'), { spec });
    // item helm replaced the slot's item pieces; skin pieces untouched
    expect(armorMeshes(rig, undefined, 'skin')).toHaveLength(skinPieces);
    unequip(rig, 'head');
    expect(armorMeshes(rig, undefined, 'skin')).toHaveLength(skinPieces);
    expect(armorMeshes(rig, undefined, 'item')).toHaveLength(0);
    rig.dispose();
  });
  it('re-equip replaces the slot armor cleanly', () => {
    const spec = itemSpec();
    const rig = rigOf(54);
    equip(rig, 'head', defOf(spec, 'warHelm'), { spec });
    const n = armorMeshes(rig, 'head', 'item').length;
    equip(rig, 'head', defOf(spec, 'warHelm'), { spec });
    expect(armorMeshes(rig, 'head', 'item')).toHaveLength(n);
    rig.dispose();
  });
});
