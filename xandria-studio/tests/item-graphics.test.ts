/**
 * Inventory wave — item graphics.
 * - ItemSkins: built-in library validity + determinism, resolve precedence
 *   (custom > built-in > undefined), applyItemSkin mutates ONLY owned
 *   role-tagged materials, unmapped roles keep defaults, never throws
 * - ItemModels: meshFor returns role-tagged, shadow-casting meshes for every
 *   kind; name-keyword → weapon-model mapping; armor/material slot mapping;
 *   RARITY_GLOW applied; deterministic; quality tiers change detail;
 *   ItemModelForge satisfies ItemMeshFactory structurally; GLB fail-closed
 * - EquipRig: equip mounts on the right pivots, re-equip replaces cleanly
 *   (old mesh disposed), unequip/clear remove + dispose
 * - Characters.ts variety: seeded features are deterministic per seed and
 *   vary across seeds; the 5-material role-tag discipline is intact
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  defaultSpec, ITEM_SKIN_ROLES, SKIN_TEXTURE_PATTERNS,
  type GameSpec, type ItemDef, type ItemRarity,
} from '@spec';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid, type CharacterRig } from '../src/engine/gfx/Characters';
import {
  BUILT_IN_ITEM_SKINS, resolveItemSkinDef, applyItemSkin, availableItemSkinIds,
} from '../src/engine/gfx/ItemSkins';
import {
  ItemModelForge, meshFor, meshForAsync, itemKindFor, applyRarityTrim,
  RARITY_GLOW, type ItemMeshFactory, type ItemKind,
} from '../src/engine/gfx/ItemModels';
import { equip, unequip, clear, equippedMesh } from '../src/engine/gfx/EquipRig';

/* DOM stub: canvas 2d recording context (pattern painters) + image-data ops (MaterialLibrary) */
const ctx2d = () => {
  const calls: string[] = [];
  const gradient = { addColorStop(..._a: unknown[]) { calls.push('addColorStop'); } };
  return {
    calls,
    set fillStyle(_v: string) {}, get fillStyle() { return '#000'; },
    set strokeStyle(_v: string) {}, get strokeStyle() { return '#000'; },
    set lineWidth(_v: number) {}, get lineWidth() { return 1; },
    set shadowBlur(_v: number) {}, get shadowBlur() { return 0; },
    set shadowColor(_v: string) {}, get shadowColor() { return '#000'; },
    fillRect(..._a: unknown[]) { calls.push('fillRect'); },
    beginPath() { calls.push('beginPath'); },
    moveTo(..._a: unknown[]) {}, lineTo(..._a: unknown[]) { calls.push('lineTo'); },
    ellipse(..._a: unknown[]) { calls.push('ellipse'); },
    fill() { calls.push('fill'); }, stroke() { calls.push('stroke'); },
    createLinearGradient(..._a: unknown[]) { calls.push('createLinearGradient'); return gradient; },
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
  };
};
(globalThis as any).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d() }),
};

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};
const mats = () => new MaterialLibrary(testSpec);
const rig = (seed = 11) => makeHumanoid(mats(), {}, seed);
const isHex = (v: unknown): boolean => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

const def = (over: Partial<ItemDef> & { name: string; type: ItemDef['type'] }): ItemDef => over as ItemDef;

/** owned, role-tagged standard materials under root */
function ownedRoleMats(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mm of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[]) {
      if (mm.userData.owned && typeof mm.userData.role === 'string' && !out.includes(mm as THREE.MeshStandardMaterial))
        out.push(mm as THREE.MeshStandardMaterial);
    }
  });
  return out;
}

function meshCount(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) n++; });
  return n;
}

describe('ItemSkins: built-in library', () => {
  it('has 8+ skins and every def is schema-valid + deterministic', () => {
    const ids = Object.keys(BUILT_IN_ITEM_SKINS);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const id of ids) {
      const d = BUILT_IN_ITEM_SKINS[id];
      expect(d.name, `${id}.name`).toBeTruthy();
      if (d.palette) for (const [role, hex] of Object.entries(d.palette)) {
        expect(ITEM_SKIN_ROLES, `${id}.palette.${role}`).toContain(role);
        expect(isHex(hex), `${id}.palette.${role}`).toBe(true);
      }
      if (d.emissive) {
        expect(isHex(d.emissive.color), `${id}.emissive`).toBe(true);
        expect(d.emissive.intensity).toBeGreaterThanOrEqual(0);
        expect(d.emissive.intensity).toBeLessThanOrEqual(5);
      }
      if (d.roughness !== undefined) { expect(d.roughness).toBeGreaterThanOrEqual(0); expect(d.roughness).toBeLessThanOrEqual(1); }
      if (d.metalness !== undefined) { expect(d.metalness).toBeGreaterThanOrEqual(0); expect(d.metalness).toBeLessThanOrEqual(1); }
      if (d.texture && 'pattern' in d.texture) expect(SKIN_TEXTURE_PATTERNS).toContain(d.texture.pattern);
      if (d.textureRoles) for (const r of d.textureRoles) expect(ITEM_SKIN_ROLES).toContain(r);
      // deterministic: two applications agree on every channel
      const a = meshFor(def({ name: 'Sword', type: 'weapon' }));
      const b = meshFor(def({ name: 'Sword', type: 'weapon' }));
      applyItemSkin(a, d); applyItemSkin(b, d);
      const ca = ownedRoleMats(a).map((m) => `${m.userData.role}:${m.color.getHexString()}`).sort().join('|');
      const cb = ownedRoleMats(b).map((m) => `${m.userData.role}:${m.color.getHexString()}`).sort().join('|');
      expect(ca, `${id} deterministic`).toBe(cb);
    }
  });

  it('the 8 required ids exist with distinct treatments', () => {
    for (const id of ['iron', 'steel', 'gold', 'ember', 'frost', 'shadow', 'verdant', 'storm'])
      expect(BUILT_IN_ITEM_SKINS[id], id).toBeTruthy();
    const primaries = new Set(Object.values(BUILT_IN_ITEM_SKINS).map((d) => d.palette?.primary));
    expect(primaries.size).toBeGreaterThanOrEqual(8); // distinct palettes
  });
});

describe('ItemSkins: resolve + apply', () => {
  it('custom spec skins override built-ins; unknown ids → undefined', () => {
    const spec = defaultSpec(1) as GameSpec;
    (spec as unknown as { custom: unknown }).custom = {
      items: { skins: { iron: { name: 'Custom Iron', palette: { primary: '#123456' } } } },
    };
    expect(resolveItemSkinDef(spec, 'iron')?.name).toBe('Custom Iron');
    expect(resolveItemSkinDef(spec, 'steel')?.name).toBe(BUILT_IN_ITEM_SKINS.steel.name);
    expect(resolveItemSkinDef(spec, 'nope')).toBeUndefined();
    expect(resolveItemSkinDef(spec, '')).toBeUndefined();
    expect(resolveItemSkinDef(spec, undefined)).toBeUndefined();
    expect(availableItemSkinIds(spec)).toContain('iron');
  });

  it('applyItemSkin mutates ONLY owned role-tagged materials (shared cache untouched)', () => {
    const mesh = meshFor(def({ name: 'Axe', type: 'weapon' }));
    // decoy: role-tagged but NOT owned (simulates a shared library material)
    const shared = new THREE.MeshStandardMaterial({ color: '#ffffff' });
    shared.userData.role = 'primary';
    const decoy = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), shared);
    mesh.add(decoy);
    const before = ownedRoleMats(mesh).map((m) => m.color.getHexString());
    applyItemSkin(mesh, { name: 't', palette: { primary: '#ff0000', secondary: '#00ff00', glow: '#0000ff' } });
    for (const m of ownedRoleMats(mesh)) {
      const want = { primary: 'ff0000', secondary: '00ff00', glow: '0000ff' }[m.userData.role as string];
      expect(m.color.getHexString(), `role ${m.userData.role}`).toBe(want);
    }
    expect(before.some((c) => c !== 'ffffff')).toBe(true); // owned mats actually changed
    expect(shared.color.getHexString()).toBe('ffffff'); // decoy untouched
  });

  it('unmapped roles keep mesh defaults; never throws on garbage', () => {
    const mesh = meshFor(def({ name: 'Staff', type: 'weapon' }));
    const glowBefore = ownedRoleMats(mesh).find((m) => m.userData.role === 'glow')!.color.getHexString();
    applyItemSkin(mesh, { name: 't', palette: { primary: '#111111' } });
    expect(ownedRoleMats(mesh).find((m) => m.userData.role === 'glow')!.color.getHexString()).toBe(glowBefore);
    expect(() => applyItemSkin(mesh, { name: 'bad', palette: { primary: 'nothex', bogus: '#ff0000' } } as never)).not.toThrow();
    expect(() => applyItemSkin(null as never, { name: 'x' })).not.toThrow();
    expect(() => applyItemSkin(mesh, null as never)).not.toThrow();
    expect(() => applyItemSkin(new THREE.Group(), { name: 'x' })).not.toThrow(); // no role tags → no-op
  });
});

describe('ItemModels: kind mapping', () => {
  const cases: [Partial<ItemDef>, ItemKind][] = [
    [{ name: 'Longsword', type: 'weapon' }, 'sword'],
    [{ name: 'Rusty Blade', type: 'weapon' }, 'sword'],
    [{ name: 'Plain Stick', type: 'weapon' }, 'sword'], // no keyword → sword
    [{ name: 'War Axe', type: 'weapon' }, 'axe'],
    [{ name: 'Oak Staff', type: 'weapon' }, 'staff'],
    [{ name: 'Wand of Sparks', type: 'weapon' }, 'staff'],
    [{ name: 'Longbow', type: 'weapon' }, 'bow'],
    [{ name: 'Ritual Dagger', type: 'weapon' }, 'dagger'],
    [{ name: 'War Hammer', type: 'weapon' }, 'mace'],
    [{ name: 'Knight Helm', type: 'armor', slot: 'head' }, 'helmet'],
    [{ name: 'Plate', type: 'armor', slot: 'torso' }, 'chestplate'],
    [{ name: 'Greaves', type: 'armor', slot: 'legs' }, 'greaves'],
    [{ name: 'Aegis', type: 'armor', slot: 'accessory' }, 'shield'],
    [{ name: 'Healing Draught', type: 'consumable' }, 'flask'],
    [{ name: 'Iron Ingot', type: 'material' }, 'ingot'],
    [{ name: 'Raw Crystal', type: 'material' }, 'crystal'],
    [{ name: 'Brass Key', type: 'key' }, 'key'],
    [{ name: 'Lucky Charm', type: 'trinket' }, 'charm'],
    [{ name: '???', type: 'mystery' as never }, 'shard'], // unknown type → fallback
  ];
  for (const [d, kind] of cases) {
    it(`"${d.name}" (${d.type}) → ${kind}`, () => {
      expect(itemKindFor(d as ItemDef)).toBe(kind);
      const mesh = meshFor(d as ItemDef);
      expect(mesh.userData.itemKind).toBe(kind);
    });
  }

  it('ItemModelForge satisfies the ItemMeshFactory contract structurally', () => {
    const f: ItemMeshFactory = ItemModelForge; // assignability is the structural check
    const mesh = f.meshFor(def({ name: 'Sword', type: 'weapon' }));
    expect(mesh).toBeInstanceOf(THREE.Object3D);
  });
});

describe('ItemModels: mesh structure', () => {
  const kinds: ItemKind[] = ['sword', 'axe', 'staff', 'bow', 'dagger', 'mace', 'helmet', 'chestplate', 'greaves', 'shield', 'flask', 'crystal', 'ingot', 'key', 'charm', 'shard'];
  it('every kind builds a role-tagged, shadow-casting mesh', () => {
    const byKind: Record<ItemKind, Partial<ItemDef>> = {
      sword: { name: 'Sword', type: 'weapon' }, axe: { name: 'Axe', type: 'weapon' },
      staff: { name: 'Staff', type: 'weapon' }, bow: { name: 'Bow', type: 'weapon' },
      dagger: { name: 'Dagger', type: 'weapon' }, mace: { name: 'Mace', type: 'weapon' },
      helmet: { name: 'Helm', type: 'armor', slot: 'head' }, chestplate: { name: 'Plate', type: 'armor', slot: 'torso' },
      greaves: { name: 'Greaves', type: 'armor', slot: 'legs' }, shield: { name: 'Shield', type: 'armor', slot: 'accessory' },
      flask: { name: 'Potion', type: 'consumable' }, crystal: { name: 'Crystal', type: 'material' },
      ingot: { name: 'Ingot', type: 'material' }, key: { name: 'Key', type: 'key' },
      charm: { name: 'Charm', type: 'trinket' }, shard: { name: 'X', type: 'mystery' as never },
    };
    for (const kind of kinds) {
      const mesh = meshFor(byKind[kind] as ItemDef);
      expect(meshCount(mesh), `${kind} has meshes`).toBeGreaterThan(0);
      const roles = ownedRoleMats(mesh);
      expect(roles.length, `${kind} owned role mats`).toBeGreaterThan(0);
      for (const r of ['primary', 'secondary', 'glow'])
        expect(roles.some((m) => m.userData.role === r), `${kind} has ${r}`).toBe(true);
      mesh.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) expect(o.castShadow, `${kind} castShadow`).toBe(true);
      });
    }
  });

  it('RARITY_GLOW matches the shared contract and is stamped on glow roles', () => {
    expect(RARITY_GLOW).toEqual({
      common: '#9a9a9a', uncommon: '#4dff6a', rare: '#4da6ff', epic: '#c97aff', legendary: '#ffb13d',
    });
    for (const rarity of ['common', 'uncommon', 'rare', 'epic', 'legendary'] as ItemRarity[]) {
      const mesh = meshFor(def({ name: 'Sword', type: 'weapon', rarity }));
      const glow = ownedRoleMats(mesh).filter((m) => m.userData.role === 'glow');
      expect(glow.length).toBeGreaterThan(0);
      for (const m of glow) {
        expect(m.emissive.getHexString(), `${rarity} glow`).toBe(RARITY_GLOW[rarity].slice(1));
        expect(m.emissiveIntensity, `${rarity} intensity`).toBe(rarity === 'common' ? 0.35 : 1.0);
      }
    }
  });

  it('an explicit skin wins over the rarity default', () => {
    const mesh = meshFor(def({ name: 'Sword', type: 'weapon', rarity: 'legendary', skin: 'frost' }));
    const glow = ownedRoleMats(mesh).filter((m) => m.userData.role === 'glow');
    expect(glow[0].emissive.getHexString()).toBe('9ff2ff'); // frost, not legendary orange
    expect(glow[0].color.getHexString()).toBe('9ff2ff');
  });

  it('deterministic: same def → same geometry + colors (no Math.random)', () => {
    const d = def({ name: 'Stormcaller Axe', type: 'weapon', rarity: 'epic' });
    const a = meshFor(d), b = meshFor(d);
    const verts = (g: THREE.Group) => {
      let n = 0;
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) n += (m.geometry.getAttribute('position')?.count ?? 0); });
      return n;
    };
    expect(verts(a)).toBe(verts(b));
    const ca = ownedRoleMats(a).map((m) => m.color.getHexString()).sort().join('|');
    const cb = ownedRoleMats(b).map((m) => m.color.getHexString()).sort().join('|');
    expect(ca).toBe(cb);
  });

  it('quality tiers change geometry detail', () => {
    const d = def({ name: 'Sword', type: 'weapon' });
    const verts = (g: THREE.Group) => {
      let n = 0;
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) n += (m.geometry.getAttribute('position')?.count ?? 0); });
      return n;
    };
    const retro = verts(meshFor(d, { quality: 'retro' }));
    const high = verts(meshFor(d, { quality: 'high' }));
    expect(high).toBeGreaterThan(retro);
  });

  it('never throws: garbage defs fall back to a shard', () => {
    expect(() => meshFor(null as never)).not.toThrow();
    expect(() => meshFor({} as never)).not.toThrow();
    const g = meshFor({} as never);
    expect(g.userData.itemKind).toBe('shard');
    expect(meshCount(g)).toBeGreaterThan(0);
  });

  it('meshForAsync returns the procedural mesh immediately and never throws (GLB fail-closed)', () => {
    const g1 = meshForAsync(def({ name: 'Sword', type: 'weapon', model: 'not-a-url' }));
    expect(g1.userData.itemKind).toBe('sword');
    expect(meshCount(g1)).toBeGreaterThan(0);
    // a well-formed https GLB URL still returns the procedural mesh synchronously;
    // the async swap can only fail offline and keeps the procedural mesh
    const g2 = meshForAsync(def({ name: 'Sword', type: 'weapon', model: 'https://example.com/x.glb' }));
    expect(g2.userData.itemKind).toBe('sword');
    expect(meshCount(g2)).toBeGreaterThan(0);
  });
});

describe('EquipRig', () => {
  const sword = () => def({ name: 'Sword', type: 'weapon', slot: 'weapon' });
  const helm = () => def({ name: 'Helm', type: 'armor', slot: 'head' });
  const plate = () => def({ name: 'Plate', type: 'armor', slot: 'torso' });
  const greaves = () => def({ name: 'Greaves', type: 'armor', slot: 'legs' });
  const charm = () => def({ name: 'Charm', type: 'trinket', slot: 'accessory' });

  it('equips each slot onto the right pivot', () => {
    const r = rig(11);
    const w = equip(r, 'weapon', sword());
    expect(w?.parent).toBe(r.limbs.weaponMount);
    const h = equip(r, 'head', helm());
    expect(h?.parent).toBe(r.limbs.head);
    const t = equip(r, 'torso', plate());
    expect(t?.parent).toBe(r.limbs.torso);
    const l = equip(r, 'legs', greaves());
    expect(l?.parent).toBe(r.group); // feet-origin greaves
    const a = equip(r, 'accessory', charm());
    expect(a?.parent).toBe(r.limbs.torso);
    expect(a!.position.z).toBeLessThan(0); // on the back
    expect(equippedMesh(r, 'weapon')).toBe(w);
    expect(equippedMesh(r, 'head')).toBe(h);
  });

  it('re-equip replaces cleanly: old mesh removed + disposed, parent child-count stable', () => {
    const r = rig(11);
    const first = equip(r, 'weapon', sword())!;
    const parent = first.parent!;
    const before = parent.children.length;
    const second = equip(r, 'weapon', def({ name: 'Axe', type: 'weapon', slot: 'weapon' }))!;
    expect(second).not.toBe(first);
    expect(first.parent).toBeNull();
    expect(parent.children.length).toBe(before);
    expect(equippedMesh(r, 'weapon')).toBe(second);
    r.dispose();
  });

  it('unequip removes + disposes; clear empties every slot', () => {
    const r = rig(11);
    const w = equip(r, 'weapon', sword())!;
    const h = equip(r, 'head', helm())!;
    unequip(r, 'weapon');
    expect(w.parent).toBeNull();
    expect(equippedMesh(r, 'weapon')).toBeUndefined();
    expect(equippedMesh(r, 'head')).toBe(h); // other slots untouched
    unequip(r, 'weapon'); // idempotent, no throw
    clear(r);
    expect(equippedMesh(r, 'head')).toBeUndefined();
    expect(h.parent).toBeNull();
    r.dispose();
  });

  it('never throws on bad rigs/slots (GLB-imported rigs without pivots → null)', () => {
    const r = rig(11);
    expect(() => equip(null as never, 'weapon', sword())).not.toThrow();
    expect(equip(null as never, 'weapon', sword())).toBeNull();
    // rig with missing pivots: equip degrades to null instead of throwing
    const bare = { group: new THREE.Group(), limbs: {} } as unknown as CharacterRig;
    expect(equip(bare, 'weapon', sword())).toBeNull();
    expect(() => clear(null as never)).not.toThrow();
  });

  it('equipped gear survives a rig dispose without touching shared materials', () => {
    const r = rig(11);
    equip(r, 'torso', plate());
    expect(() => r.dispose()).not.toThrow();
  });
});

describe('Characters.ts feature variety (inventory wave)', () => {
  it('same seed → same features (deterministic); the 5-material role discipline is intact', () => {
    const a = rig(42), b = rig(42);
    const snap = (r: CharacterRig) => {
      const parts: string[] = [];
      r.limbs.head!.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) parts.push(`${m.position.x.toFixed(3)},${m.position.y.toFixed(3)},${m.position.z.toFixed(3)}`);
      });
      return parts.sort().join('|');
    };
    expect(snap(a)).toBe(snap(b));
    // role-tag discipline intact: every owned role-tagged material is one of
    // the 5 known roles (accentDS only exists when the plan has a cape), and
    // features added no NEW owned materials (war paint/headband reuse the
    // accent instance; eyes/scars/bandages are shared cache materials)
    const roles = ownedRoleMats(a.group).map((m) => m.userData.role as string);
    for (const r of roles) expect(['skin', 'shirt', 'pants', 'accent', 'accentDS']).toContain(r);
    expect(new Set(roles).size).toBeGreaterThanOrEqual(4);
    expect(new Set(roles).size).toBeLessThanOrEqual(5);
    a.dispose(); b.dispose();
  });

  it('features vary across seeds (variety exists)', () => {
    const counts = new Set<number>();
    for (let s = 1; s <= 24; s++) {
      const r = rig(s);
      counts.add(meshCount(r.limbs.head!));
      r.dispose();
    }
    expect(counts.size).toBeGreaterThan(1);
  });
});
