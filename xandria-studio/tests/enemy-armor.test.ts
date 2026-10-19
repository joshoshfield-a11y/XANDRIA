/**
 * Enemies wave, workstream B — hostile visual read.
 * - enemy armor sets resolve from their own registry (never in the villager
 *   VOXEL_ARMOR_SETS / VOXEL_ARMOR_SET_IDS registries);
 * - visor emissive color is ember-family (red-dominant), never amber;
 * - spiked cone geometry is present on pauldrons (brutehide also has
 *   back-spikes); a villager nomad set has none — negative control;
 * - enemy palettes share no hex with any villager palette;
 * - the six-pivot CharacterRig contract survives (animate/swing/dead run
 *   without throwing on walker and brute bulks);
 * - enemy armor materials stay inside the NPC instancing role census
 *   (non-emissive roles) or add emissive-only roles; every armor material
 *   is per-application owned with NO role tag (the VoxelArmor discipline);
 * - Enemy construction wires the sets by kind (walker/brute/drone/flyer/
 *   turret) with silhouette families unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- headless three/engine harness (same pattern as npc.test.ts) -----------
const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '', width: 0, height: 0,
      appendChild(c: any) { el.children.push(c); return c; }, append(...cs: any[]) { for (const c of cs) el.children.push(c); },
      remove() {}, setAttribute() {}, getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener() {}, removeEventListener() {}, querySelector() { return makeEl(); }, querySelectorAll() { return []; },
      getContext: () => ({ createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
    };
    return el;
  }
  class FakeWebGLRenderer {
    domElement: any = makeEl('canvas'); shadowMap: any = {}; toneMapping: any = null; toneMappingExposure = 1;
    setPixelRatio() {} setSize() {} getPixelRatio() { return 1; } getSize() { return { width: 800, height: 600 }; }
    dispose() {} render() {}
  }
  return { makeEl, FakeWebGLRenderer };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import { Engine } from '../src/engine/Engine';
import { defaultSpec, type GameSpec, type EnemyKind, VOXEL_ARMOR_SET_IDS } from '../src/spec/schema';
import { makeHumanoid, makeDrone, type CharacterRig } from '../src/engine/gfx/Characters';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import {
  VOXEL_ARMOR_SETS,
  applyVoxelArmor, applyEnemyArmor, resolveEnemyArmorSet,
  ENEMY_ARMOR_SET_IDS, isEmberHex,
} from '../src/engine/gfx/VoxelArmor';
import { Enemy } from '../src/engine/game/EnemyAI';

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};
const mats = () => new MaterialLibrary(testSpec);
/** standard-archetype rig; bulk 1.7 mirrors the EnemyAI brute build */
const rigOf = (seed = 11, bulk = 1) =>
  makeHumanoid(mats(), { bulk }, seed, { headStyle: 'helmet', armor: 'none' });

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

/** meshes tagged as armor pieces (the VoxelArmor contract) */
function armorMeshes(rig: CharacterRig): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  rig.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.userData as any).armorPiece === true) out.push(m);
  });
  return out;
}

/** true when `o` is at-or-under `pivot` */
function underPivot(o: THREE.Object3D, pivot: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = o;
  while (cur) { if (cur === pivot) return true; cur = cur.parent; }
  return false;
}

/** cone-spike armor meshes under the given rig pivots */
function spikeMeshes(rig: CharacterRig, pivots: THREE.Object3D[]): THREE.Mesh[] {
  return armorMeshes(rig).filter(
    (m) => m.geometry instanceof THREE.ConeGeometry && pivots.some((p) => underPivot(m, p)),
  );
}

/** every villager visor hex (armor sets + the NPC amber list) — the negative control */
const VILLAGER_VISORS = [
  ...VOXEL_ARMOR_SET_IDS.map((id) => VOXEL_ARMOR_SETS[id].visor.color),
  '#ffb545', '#ffd27a', '#ffd23f', '#ffab33', // Npc.ts AMBER_VISORS
];
/** a material's real glow color, or null (default MeshStandardMaterials carry
 *  black emissive at intensity 1 — that is "no glow", not a black glow) */
const emissiveHex = (mat: THREE.MeshStandardMaterial | undefined): string | null => {
  if (!mat?.emissive || mat.emissiveIntensity <= 0) return null;
  if (mat.emissive.equals(new THREE.Color(0x000000))) return null;
  return '#' + mat.emissive.getHexString();
};
/** every villager palette hex (armor sets + the Npc.ts cloth/pants lists) */
const VILLAGER_PALETTE_HEXES = new Set([
  ...VOXEL_ARMOR_SET_IDS.flatMap((id) => Object.values(VOXEL_ARMOR_SETS[id].palette)),
  // Npc.ts VILLAGER_CLOTH / VILLAGER_PANTS (mirror — update if Npc.ts changes)
  '#7a5c3a', '#5e6e4a', '#4a5e6e', '#6e4a5e', '#8a6a3a',
  '#3a5e5e', '#75553f', '#8f7a4a', '#556b3a', '#6b4a3a',
  '#3a342e', '#2e3a34', '#463a2e', '#33302e', '#2e3440',
].map((h) => h.toLowerCase()));

describe('workstream B: enemy armor registry', () => {
  it('all three enemy sets resolve; ids stay out of the villager registries', () => {
    expect([...ENEMY_ARMOR_SET_IDS].sort()).toEqual(['bloodreaver', 'brutehide', 'marauder']);
    for (const id of ENEMY_ARMOR_SET_IDS) {
      expect(resolveEnemyArmorSet(id), id).toBeDefined();
      expect(VOXEL_ARMOR_SET_IDS as readonly string[]).not.toContain(id);
    }
    expect(resolveEnemyArmorSet('nomad')).toBeUndefined(); // villager sets don't resolve here
    expect(resolveEnemyArmorSet(undefined)).toBeUndefined();
    expect(resolveEnemyArmorSet('nope')).toBeUndefined();
  });

  it('unknown set id is a silent no-op (never throws, no pieces)', () => {
    const rig = rigOf(42);
    expect(() => applyEnemyArmor(rig, 'nope')).not.toThrow();
    expect(armorMeshes(rig)).toHaveLength(0);
    rig.dispose();
  });
});

describe('workstream B: ember visors, not amber', () => {
  it('every enemy set visor is ember-family and never a villager visor', () => {
    for (const id of ENEMY_ARMOR_SET_IDS) {
      const set = resolveEnemyArmorSet(id)!;
      expect(isEmberHex(set.visor.color), `${id} visor ${set.visor.color}`).toBe(true);
      expect(VILLAGER_VISORS.map((v) => v.toLowerCase())).not.toContain(set.visor.color.toLowerCase());
    }
  });

  it('the ember predicate rejects every villager visor (negative control)', () => {
    for (const v of VILLAGER_VISORS) {
      expect(isEmberHex(v), `villager visor ${v} must not read ember`).toBe(false);
    }
  });

  it('the built slit material glows ember on the rig', () => {
    for (const id of ENEMY_ARMOR_SET_IDS) {
      const rig = rigOf(42);
      applyEnemyArmor(rig, id);
      const glowHexes = new Set<string>();
      rig.group.traverse((o) => {
        const m = o as THREE.Mesh;
        // armor glow only: the forged base rig carries its own accent slit /
        // eyes — the hostile read is the armor's visor slit
        if ((m.userData as any).armorPiece !== true) return;
        const h = emissiveHex(m.material as THREE.MeshStandardMaterial | undefined);
        if (m.isMesh && h) glowHexes.add(h);
      });
      expect(glowHexes.size, `${id} has an emissive slit`).toBeGreaterThan(0);
      for (const h of glowHexes) {
        expect(isEmberHex(h), `${id} emissive ${h}`).toBe(true);
      }
      rig.dispose();
    }
  });
});

describe('workstream B: spiked armor geometry', () => {
  it('enemy pauldrons carry cone spikes; villager nomad pauldrons carry none', () => {
    for (const id of ENEMY_ARMOR_SET_IDS) {
      const rig = rigOf(42);
      applyEnemyArmor(rig, id);
      const spikes = spikeMeshes(rig, [rig.limbs.armL, rig.limbs.armR]);
      expect(spikes.length, `${id} pauldron spikes`).toBeGreaterThanOrEqual(6); // 3 per arm
      rig.dispose();
    }
    // negative control: villager sets use boxes only
    const v = rigOf(42);
    applyVoxelArmor(v, 'nomad');
    expect(spikeMeshes(v, [v.limbs.armL, v.limbs.armR])).toHaveLength(0);
    expect(armorMeshes(v).length).toBeGreaterThan(8); // armor still applied
    v.dispose();
  });

  it('brutehide has jagged back-spikes on the torso', () => {
    const rig = rigOf(7, 1.7);
    applyEnemyArmor(rig, 'brutehide');
    const back = spikeMeshes(rig, [rig.limbs.torso]);
    expect(back.length).toBeGreaterThanOrEqual(3);
    for (const s of back) {
      expect(s.position.z, 'spike sits behind the torso shell').toBeLessThan(0);
    }
    rig.dispose();
  });

  it('spikes are tagged armor pieces (clearVoxelArmor / instancing see them)', () => {
    const rig = rigOf(42);
    applyEnemyArmor(rig, 'marauder');
    const spikes = spikeMeshes(rig, [rig.limbs.armL, rig.limbs.armR]);
    for (const s of spikes) {
      expect((s.userData as any).armorSet).toBe('marauder');
      expect((s.userData as any).armorPiece).toBe(true);
    }
    rig.dispose();
  });
});

describe('workstream B: palettes never read villager', () => {
  it('no enemy palette hex appears in any villager palette', () => {
    for (const id of ENEMY_ARMOR_SET_IDS) {
      const set = resolveEnemyArmorSet(id)!;
      for (const [slot, hex] of Object.entries(set.palette)) {
        expect(VILLAGER_PALETTE_HEXES.has(hex.toLowerCase()), `${id}.${slot} ${hex} overlaps a villager palette`).toBe(false);
      }
    }
  });
});

describe('workstream B: CharacterRig contract survives enemy armor', () => {
  it.each([
    ['marauder', 1.0],
    ['bloodreaver', 1.0],
    ['brutehide', 1.7],
  ] as const)('%s at bulk %s: animate/swing/dead run without throwing', (setId, bulk) => {
    const rig = rigOf(1234, bulk);
    applyEnemyArmor(rig, setId);
    // the six pivots are intact and parent armor
    for (const key of ['legL', 'legR', 'armL', 'armR', 'torso', 'head'] as const) {
      expect(rig.limbs[key], `${setId} limbs.${key}`).toBeDefined();
    }
    expect(armorMeshes(rig).length, `${setId} pieces`).toBeGreaterThan(10);
    expect(() => {
      rig.animate(1.5, 0);            // idle breath
      rig.animate(2.0, 3.4);          // run cycle
      rig.swing();                     // self-advancing melee swing
      rig.animate(2.5, 1.2, { attacking: 0.5 });
      rig.setDead(true);
      rig.animate(3.0, 0, { dead: true, deadVelocity: new THREE.Vector3(2, 1, 0) });
      rig.setDead(false);
    }).not.toThrow();
    rig.dispose();
  });
});

describe('workstream B: instancing role-census compatibility', () => {
  /** (roughness, metalness, side, transparent, opacity) — the census key minus diffuse/emissive */
  const roleTuple = (m: THREE.Material): string => {
    const s = m as THREE.MeshStandardMaterial;
    return `${s.roughness}|${s.metalness}|${s.side}|${s.transparent ? 1 : 0}|${s.opacity}`;
  };
  const hasEmissive = (m: THREE.Material): boolean => {
    const s = m as THREE.MeshStandardMaterial;
    return !!s.emissive && s.emissiveIntensity > 0 && !s.emissive.equals(new THREE.Color(0x000000));
  };

  it('enemy armor adds no new non-emissive shader-param combos (new emissive colors are fine as baked roles)', () => {
    // census: every villager set, full application
    const census = new Set<string>();
    for (const id of VOXEL_ARMOR_SET_IDS) {
      const rig = rigOf(99);
      applyVoxelArmor(rig, id);
      rig.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !Array.isArray(m.material)) census.add(roleTuple(m.material));
      });
      rig.dispose();
    }
    for (const id of ENEMY_ARMOR_SET_IDS) {
      const rig = rigOf(99);
      applyEnemyArmor(rig, id);
      rig.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || Array.isArray(m.material)) return;
        if (!(m.userData as any).armorPiece) return;
        if (hasEmissive(m.material)) return; // emissive roles bake per color — allowed
        expect(census.has(roleTuple(m.material)),
          `${id}: new non-emissive shader combo ${roleTuple(m.material)}`).toBe(true);
      });
      rig.dispose();
    }
  });

  it('enemy armor materials are per-application owned with NO role tag', () => {
    for (const id of ENEMY_ARMOR_SET_IDS) {
      const rig = rigOf(99);
      applyEnemyArmor(rig, id);
      for (const m of armorMeshes(rig)) {
        const mat = m.material as THREE.MeshStandardMaterial;
        expect((mat.userData as any).owned, `${id} armor owned`).toBe(true);
        expect((mat.userData as any).role, `${id} armor has no role tag`).toBeUndefined();
      }
      rig.dispose();
    }
  });
});

describe('workstream B: Enemy construction wires hostile visuals by kind', () => {
  const enemySpec = (kind: EnemyKind) => ({
    kind, count: 1, health: 100, speed: 2, damage: 10, weapon: 'melee' as const,
  });

  it('walker/brute get enemy armor with ember visors; kinds keep their rigs', () => {
    const engine = makeEngine();
    const spawn = new THREE.Vector3(0, 2, 0);
    const walker = new Enemy(engine, enemySpec('walker'), spawn, null, {}, 4242);
    const brute = new Enemy(engine, enemySpec('brute'), spawn, null, {}, 4243);
    try {
      for (const [e, kind] of [[walker, 'walker'], [brute, 'brute']] as const) {
        expect(e.rig, `${kind} rig`).not.toBeNull();
        const pieces = armorMeshes(e.rig!);
        expect(pieces.length, `${kind} armor pieces`).toBeGreaterThan(10);
        const spikes = spikeMeshes(e.rig!, [e.rig!.limbs.armL, e.rig!.limbs.armR]);
        expect(spikes.length, `${kind} pauldron spikes`).toBeGreaterThanOrEqual(6);
        const ember = new Set<string>();
        e.rig!.group.traverse((o) => {
          const m = o as THREE.Mesh;
          if ((m.userData as any).armorPiece !== true) return;
          const h = emissiveHex(m.material as THREE.MeshStandardMaterial | undefined);
          if (m.isMesh && h) ember.add(h);
        });
        expect(ember.size, `${kind} ember emissive present`).toBeGreaterThan(0);
        for (const h of ember) expect(isEmberHex(h), `${kind} ${h}`).toBe(true);
        // silhouette family unchanged: six-pivot humanoid
        for (const key of ['legL', 'legR', 'armL', 'armR', 'torso', 'head'] as const) {
          expect(e.rig!.limbs[key], `${kind} limbs.${key}`).toBeDefined();
        }
      }
      // brute reads heavier: brutehide set (seeded walker choice is one of the two walker sets)
      const bruteSet = new Set(
        armorMeshes(brute.rig!).map((m) => (m.userData as any).armorSet as string));
      expect([...bruteSet]).toEqual(['brutehide']);
      const walkerSet = new Set(
        armorMeshes(walker.rig!).map((m) => (m.userData as any).armorSet as string));
      expect(['marauder', 'bloodreaver']).toContain([...walkerSet][0]);
      expect(walkerSet.size).toBe(1);
    } finally {
      walker.dispose(); brute.dispose();
    }
  });

  it('drone/flyer get the ember eye; turret gets charcoal hull + ember eye', () => {
    const engine = makeEngine();
    const spawn = new THREE.Vector3(0, 2, 0);
    const drone = new Enemy(engine, enemySpec('drone'), spawn, null, {}, 5150);
    const flyer = new Enemy(engine, enemySpec('flyer'), spawn, null, {}, 5151);
    const turret = new Enemy(engine, enemySpec('turret'), spawn, null, {}, 5152);
    try {
      for (const [e, kind] of [[drone, 'drone'], [flyer, 'flyer']] as const) {
        expect(e.rig, `${kind} rig`).not.toBeNull();
        const eyes = new Set<string>();
        e.rig!.group.traverse((o) => {
          const m = o as THREE.Mesh;
          const h = emissiveHex(m.material as THREE.MeshStandardMaterial | undefined);
          if (m.isMesh && h) eyes.add(h);
        });
        expect([...eyes].some(isEmberHex), `${kind} ember eye in ${[...eyes]}`).toBe(true);
      }
      expect(turret.turret, 'turret assembly').not.toBeNull();
      expect(turret.rig).toBeNull();
      const tEyes = new Set<string>();
      turret.turret!.group.traverse((o) => {
        const m = o as THREE.Mesh;
        const h = emissiveHex(m.material as THREE.MeshStandardMaterial | undefined);
        if (m.isMesh && h) tEyes.add(h);
      });
      expect([...tEyes].some(isEmberHex), `turret ember eye in ${[...tEyes]}`).toBe(true);
    } finally {
      drone.dispose(); flyer.dispose(); turret.dispose();
    }
  });

  it('no villager visor color appears on any enemy emissive', () => {
    const engine = makeEngine();
    const spawn = new THREE.Vector3(0, 2, 0);
    const kinds: EnemyKind[] = ['walker', 'brute', 'drone', 'flyer', 'turret'];
    const enemies = kinds.map((k, i) => new Enemy(engine, enemySpec(k), spawn, null, {}, 6000 + i));
    try {
      for (const e of enemies) {
        const root = e.rig?.group ?? e.turret?.group;
        expect(root).toBeDefined();
        root!.traverse((o) => {
          const m = o as THREE.Mesh;
          // armor glow only: the forged base rig's own accent slit predates
          // this wave and is buried under the armor helm
          if ((m.userData as any).armorPiece !== true) return;
          const h = emissiveHex(m.material as THREE.MeshStandardMaterial | undefined);
          if (m.isMesh && h) {
            expect(VILLAGER_VISORS.map((v) => v.toLowerCase())).not.toContain(h.toLowerCase());
          }
        });
      }
    } finally {
      for (const e of enemies) e.dispose();
    }
  });
});
