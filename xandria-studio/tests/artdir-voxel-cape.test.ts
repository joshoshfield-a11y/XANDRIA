/**
 * Follow-up wave A — standalone voxel cape (VoxelArmor.ts).
 * - resolveVoxelCapeVariant: explicit wins, seeded pick deterministic, garbage falls back
 * - applyVoxelCape: segmented chain registers on rig.limbs.cape, blocky panels,
 *   owned role-less materials, shoulder clasps, seeded variants, determinism
 * - the rig's EXISTING animate() cloth math swings the chain with run speed
 *   (no second animation path); the chain hangs off the torso pivot, so turns carry it
 * - a pre-existing polish-wave cape is replaced on apply and restored on clear
 * - clearVoxelArmor never strips the cape (standalone lifecycle)
 * - never throws: drone rigs are silent no-ops; works on player- and enemy-style rigs
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid, makeDrone, type CharacterRig } from '../src/engine/gfx/Characters';
import { forgeHumanoidPlan } from '../src/engine/gfx/ModelForge';
import {
  VOXEL_CAPE_VARIANTS, resolveVoxelCapeVariant,
  applyVoxelCape, clearVoxelCape, applyVoxelArmor, clearVoxelArmor,
  type VoxelCapeVariant,
} from '../src/engine/gfx/VoxelArmor';

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};
const mats = () => new MaterialLibrary(testSpec);
/** neutral-headgear rig so cloth reads cleanly */
const rigOf = (seed = 11) => makeHumanoid(mats(), {}, seed, { headStyle: 'helmet', armor: 'none' });
/** first seed (1..200) whose plan includes a polish-wave cape */
const capeSeed = (() => {
  for (let s = 1; s <= 200; s++) if (forgeHumanoidPlan(s).extras.includes('cape')) return s;
  return -1;
})();
/** first seed (1..200) whose plan has NO cape */
const plainSeed = (() => {
  for (let s = 1; s <= 200; s++) if (!forgeHumanoidPlan(s).extras.includes('cape')) return s;
  return -1;
})();

interface CapeMesh extends THREE.Mesh {
  userData: {
    armorPiece?: boolean; capePiece?: boolean; armorSet?: string;
    armorSlot?: string; armorOrigin?: string; owned?: boolean; role?: string;
  };
}
const capeMeshes = (rig: CharacterRig): CapeMesh[] => {
  const out: CapeMesh[] = [];
  rig.group.traverse((o) => {
    const m = o as CapeMesh;
    if (m.isMesh && m.userData.capePiece === true) out.push(m);
  });
  return out;
};
/** polish-wave cloth panels: faceted plane meshes on the accentDS role material */
const polishClothMeshes = (rig: CharacterRig): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  rig.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mm = Array.isArray(m.material) ? m.material : [m.material];
    if (mm.some((mat) => (mat as THREE.MeshStandardMaterial).userData?.role === 'accentDS')) out.push(m);
  });
  return out;
};
const capeSig = (rig: CharacterRig): string =>
  capeMeshes(rig)
    .map((m) => {
      const p = (m.geometry as THREE.BoxGeometry).parameters as { width: number; height: number; depth: number };
      const q = m.position;
      return [m.userData.armorSlot, p.width.toFixed(4), p.height.toFixed(4), p.depth.toFixed(4),
        q.x.toFixed(4), q.y.toFixed(4), q.z.toFixed(4)].join('|');
    })
    .sort()
    .join('\n');
const glowMats = (rig: CharacterRig): THREE.MeshStandardMaterial[] => {
  const out: THREE.MeshStandardMaterial[] = [];
  for (const m of capeMeshes(rig)) {
    const mm = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
    for (const mat of mm) if (mat.emissiveIntensity > 1 && !out.includes(mat)) out.push(mat);
  }
  return out;
};
const isDescendantOf = (o: THREE.Object3D, anc: THREE.Object3D): boolean => {
  let p: THREE.Object3D | null = o;
  while (p) { if (p === anc) return true; p = p.parent; }
  return false;
};

describe('cape: variant resolution', () => {
  it('exposes exactly the five variants', () => {
    expect([...VOXEL_CAPE_VARIANTS].sort()).toEqual(['full', 'half', 'hooded', 'mantle', 'tattered'].sort());
  });
  it('explicit variant wins; garbage falls back to the seeded pick; pick is deterministic', () => {
    expect(resolveVoxelCapeVariant(7, 'mantle')).toBe('mantle');
    expect(resolveVoxelCapeVariant(7)).toBe(resolveVoxelCapeVariant(7));
    expect(resolveVoxelCapeVariant(7, 'nope' as never)).toBe(resolveVoxelCapeVariant(7));
    expect(resolveVoxelCapeVariant()).toBe(resolveVoxelCapeVariant(1));
  });
});

describe('cape: applyVoxelCape', () => {
  it('mounts a segmented chain on limbs.cape with owned, role-less materials', () => {
    const rig = rigOf(plainSeed);
    applyVoxelCape(rig, { variant: 'full', seed: 3 });
    const chain = rig.limbs.cape!;
    expect(chain).toBeDefined();
    expect(chain.length).toBe(4);
    expect(chain[1].parent).toBe(chain[0]);
    expect(chain[2].parent).toBe(chain[1]);
    expect(chain[3].parent).toBe(chain[2]);
    // the chain hangs off the torso pivot — turns carry it
    expect(isDescendantOf(chain[0], rig.limbs.torso)).toBe(true);
    const pieces = capeMeshes(rig);
    expect(pieces.length).toBe(4 + 2); // 4 panels + 2 shoulder clasps
    for (const p of pieces) {
      expect(p.userData.capePiece).toBe(true);
      expect(p.userData.armorPiece).toBe(true);
      expect(p.userData.armorSet).toBe('cape');
      expect(p.userData.armorOrigin).toBe('skin');
      expect(p.castShadow).toBe(true);
      const mm = (Array.isArray(p.material) ? p.material : [p.material]) as THREE.MeshStandardMaterial[];
      for (const mat of mm) {
        expect(mat.userData.owned).toBe(true);
        expect(mat.userData.role).toBeUndefined(); // skins/flash never touch the cape
      }
    }
    rig.dispose();
  });
  it('each variant builds its segment count; hooded adds a head cowl', () => {
    const counts: Record<VoxelCapeVariant, number> = { full: 4, half: 3, mantle: 2, tattered: 4, hooded: 3 };
    for (const v of VOXEL_CAPE_VARIANTS) {
      const r = rigOf(plainSeed);
      applyVoxelCape(r, { variant: v, seed: 5 });
      expect(r.limbs.cape!.length, v).toBe(counts[v]);
      const cowls = capeMeshes(r).filter((p) => p.userData.armorSlot === 'head');
      expect(cowls.length, `${v} cowl`).toBe(v === 'hooded' ? 1 : 0);
      if (v === 'hooded') expect(isDescendantOf(cowls[0], r.limbs.head)).toBe(true);
      r.dispose();
    }
  });
  it('glowColor adds a glowing hem strip; invalid colors add none', () => {
    const r = rigOf(plainSeed);
    applyVoxelCape(r, { variant: 'full', seed: 3, glowColor: '#ff00ff' });
    const glows = glowMats(r);
    expect(glows.length).toBeGreaterThan(0);
    expect('#' + glows[0].emissive.getHexString()).toBe('#ff00ff');
    r.dispose();
    const r2 = rigOf(plainSeed);
    applyVoxelCape(r2, { variant: 'full', seed: 3, glowColor: 'red' });
    expect(glowMats(r2)).toHaveLength(0);
    r2.dispose();
  });
  it('seeded: same seed → same cape; tattered jitter varies across seeds', () => {
    const sig = (seed: number, variant?: VoxelCapeVariant) => {
      const r = rigOf(plainSeed);
      applyVoxelCape(r, { seed, variant });
      const s = capeSig(r);
      r.dispose();
      return s;
    };
    expect(sig(7)).toBe(sig(7));
    expect(sig(7, 'full')).toBe(sig(7, 'full'));
    expect(sig(7, 'tattered')).not.toBe(sig(8, 'tattered'));
  });
  it('re-apply replaces cleanly (no duplicate pieces or chains)', () => {
    const r = rigOf(plainSeed);
    applyVoxelCape(r, { variant: 'full', seed: 3 });
    applyVoxelCape(r, { variant: 'half', seed: 4 });
    expect(r.limbs.cape!.length).toBe(3);
    expect(capeMeshes(r)).toHaveLength(3 + 2);
    expect(capeMeshes(r).every((p) => p.userData.armorSet === 'cape')).toBe(true);
    r.dispose();
  });
  it('clearVoxelCape strips panels, pivots, and the limbs.cape registration', () => {
    const r = rigOf(plainSeed);
    applyVoxelCape(r, { variant: 'full', seed: 3 });
    clearVoxelCape(r);
    expect(capeMeshes(r)).toHaveLength(0);
    expect(r.limbs.cape).toBeUndefined();
    expect(() => clearVoxelCape(r)).not.toThrow();
    r.dispose();
  });
  it('origin narrows the clear', () => {
    const r = rigOf(plainSeed);
    applyVoxelCape(r, { variant: 'full', seed: 3, origin: 'skin' });
    clearVoxelCape(r, 'item');
    expect(capeMeshes(r).length).toBeGreaterThan(0); // skin cape survives an item clear
    clearVoxelCape(r, 'skin');
    expect(capeMeshes(r)).toHaveLength(0);
    r.dispose();
  });
});

describe('cape: driven by the existing animate() cloth math', () => {
  it('segments trail with run speed and flutter over time', () => {
    const r = rigOf(plainSeed);
    applyVoxelCape(r, { variant: 'full', seed: 3 });
    const chain = r.limbs.cape!;
    // same timestamp, different speeds: the k*(i+1) trail term dominates the flutter delta
    r.animate(2.0, 0);
    const idle = chain.map((c) => c.rotation.x);
    r.animate(2.0, 6);
    const run = chain.map((c) => c.rotation.x);
    for (let i = 0; i < chain.length; i++) expect(run[i], `seg ${i} trails`).toBeGreaterThan(idle[i]);
    // flutter: same speed, different timestamps
    r.animate(2.0, 6);
    const a = chain.map((c) => c.rotation.x);
    r.animate(2.37, 6);
    const b = chain.map((c) => c.rotation.x);
    expect(a).not.toEqual(b);
    r.dispose();
  });
  it('renders on player-style and enemy-style rigs alike', () => {
    // CharacterController builds the player rig; EnemyAI builds enemy rigs — both makeHumanoid
    const player = makeHumanoid(mats(), {}, 7, { headStyle: 'helmet', armor: 'none' });
    const enemy = makeHumanoid(mats(), { bulk: 1.3 }, 99, { headStyle: 'helmet', armor: 'none' });
    for (const [label, r] of [['player', player], ['enemy', enemy]] as const) {
      applyVoxelCape(r, { variant: 'half', seed: 12 });
      expect(r.limbs.cape!.length, label).toBe(3);
      expect(capeMeshes(r).length, label).toBeGreaterThan(3);
      r.animate(1.0, 4);
      expect(r.limbs.cape!.every((c) => c.rotation.x !== 0), `${label} swings`).toBe(true);
      r.dispose();
    }
  });
});

describe('cape: polish-wave cape interplay', () => {
  it('replaces the polish chain on apply, restores it on clear', () => {
    expect(capeSeed).toBeGreaterThan(0);
    const r = rigOf(capeSeed);
    expect(r.limbs.cape!.length).toBe(3);
    expect(polishClothMeshes(r)).toHaveLength(3);
    applyVoxelCape(r, { variant: 'mantle', seed: 9 });
    expect(r.limbs.cape!.length).toBe(2); // voxel chain took the slot
    expect(polishClothMeshes(r)).toHaveLength(0); // polish cloth detached
    expect(capeMeshes(r).length).toBeGreaterThan(0);
    clearVoxelCape(r);
    expect(r.limbs.cape!.length).toBe(3); // polish chain restored
    expect(polishClothMeshes(r)).toHaveLength(3);
    expect(capeMeshes(r)).toHaveLength(0);
    r.dispose();
  });
});

describe('cape: standalone lifecycle vs armor', () => {
  it('clearVoxelArmor never strips the cape; armor and cape coexist', () => {
    const r = rigOf(plainSeed);
    applyVoxelArmor(r, 'nomad');
    applyVoxelCape(r, { variant: 'full', seed: 3 });
    const capeN = capeMeshes(r).length;
    expect(capeN).toBeGreaterThan(0);
    clearVoxelArmor(r); // full armor clear
    expect(capeMeshes(r)).toHaveLength(capeN); // cape survives
    expect(r.limbs.cape!.length).toBe(4);
    clearVoxelArmor(r, 'accessory', 'skin'); // slot clear
    expect(capeMeshes(r)).toHaveLength(capeN);
    // and the cape clear leaves armor alone
    clearVoxelCape(r);
    expect(capeMeshes(r)).toHaveLength(0);
    r.dispose();
  });
});

describe('cape: never throws', () => {
  it('non-humanoid rigs never throw and clear fully', () => {
    const drone = makeDrone(mats(), '#c33', '#ff4444', 1);
    expect(() => applyVoxelCape(drone, { seed: 3 })).not.toThrow();
    // drones expose a torso pivot (the core box), so the cape mounts like any
    // armor piece; their animate() has no cloth math, so it hangs static —
    // decorative, never blocking
    expect(() => clearVoxelCape(drone)).not.toThrow();
    expect(capeMeshes(drone)).toHaveLength(0);
    expect(drone.limbs.cape).toBeUndefined();
    expect(() => applyVoxelCape(null as never)).not.toThrow();
    expect(() => clearVoxelCape(null as never)).not.toThrow();
    expect(() => applyVoxelCape(drone, { variant: 'nope' as never, glowColor: 'xx', seed: NaN })).not.toThrow();
    clearVoxelCape(drone);
    expect(capeMeshes(drone)).toHaveLength(0);
    drone.dispose();
  });
});
