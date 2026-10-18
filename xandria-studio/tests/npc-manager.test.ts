/**
 * NPC workstream B: NpcManager (map-local lifecycle) + rig sharing.
 * - spawnForMap deterministic from mapSeed alone (two engines, same seed)
 * - portal round-trip regenerates the identical roster
 * - despawnAll leaves zero payloads (physics bodies + scene children baseline, idempotent)
 * - rig sharing: same-look NPCs share geometries AND materials (unique counts collapse)
 * - manager.update(dt) ticks the roster
 * - portalEntities registry drives the manager
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import { Npc } from '../src/engine/game/Npc';
import { NpcManager } from '../src/engine/game/NpcManager';
import { NpcRigCache } from '../src/engine/game/npcRigSharing';

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

const POIS = [
  { x: 100, z: 100, r: 8 },
  { x: -150, z: 60, r: 6 },
  { x: 40, z: -200, r: 10 },
];

function rosterSig(m: NpcManager) {
  return m.npcs.map((n) => [
    n.name,
    n.palette.cloth, n.palette.pants, n.palette.armorSet, n.palette.visor,
    n.home.x.toFixed(4), n.home.y.toFixed(4), n.home.z.toFixed(4),
  ].join('|'));
}

function gpuCensus(engine: Engine) {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  let meshes = 0;
  engine.scene.traverse((o: any) => {
    if (!o.isMesh) return;
    meshes++;
    geos.add(o.geometry);
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) mats.add(m);
  });
  return { meshes, geos: geos.size, mats: mats.size };
}

describe('NpcManager determinism', () => {
  it('same mapSeed on two engines -> identical roster (names, palettes, positions)', () => {
    const e1 = makeEngine(), e2 = makeEngine();
    const m1 = new NpcManager(e1, { pois: POIS, density: 1 });
    const m2 = new NpcManager(e2, { pois: POIS, density: 1 });
    m1.spawnForMap(20261012);
    m2.spawnForMap(20261012);
    expect(m1.npcs.length).toBe(m2.npcs.length);
    expect(m1.npcs.length).toBeGreaterThan(0);
    expect(rosterSig(m1)).toEqual(rosterSig(m2));
    m1.despawnAll(); m2.despawnAll();
    e1.dispose(); e2.dispose();
  });

  it('different mapSeed -> different roster', () => {
    const engine = makeEngine();
    const m = new NpcManager(engine, { pois: POIS });
    m.spawnForMap(111);
    const a = rosterSig(m);
    m.spawnForMap(222);
    const b = rosterSig(m);
    expect(a).not.toEqual(b);
    m.despawnAll();
    engine.dispose();
  });

  it('portal round-trip regenerates identically: spawn(s) -> despawn -> spawn(s)', () => {
    const engine = makeEngine();
    const m = new NpcManager(engine, { pois: POIS });
    m.spawnForMap(777001);
    const first = rosterSig(m);
    m.despawnAll();
    expect(m.npcs.length).toBe(0);
    m.spawnForMap(777001);
    expect(rosterSig(m)).toEqual(first);
    m.despawnAll();
    engine.dispose();
  });

  it('count follows GameSpec npcs roster when present, density otherwise', () => {
    const engine = makeEngine();
    const specs = [{ role: 'villager', count: 3 }, { role: 'elder', count: 2 }];
    const m = new NpcManager(engine, { pois: POIS, specs });
    m.spawnForMap(5);
    expect(m.npcs.length).toBe(5);
    expect(m.npcs.filter((n) => n.role === 'elder').length).toBe(2);
    m.despawnAll();
    const m2 = new NpcManager(engine, { pois: POIS, density: 0.5 });
    m2.spawnForMap(5);
    expect(m2.npcs.length).toBe(4); // round(8 * 0.5)
    m2.despawnAll();
    engine.dispose();
  });
});

describe('NpcManager lifecycle (zero-leak)', () => {
  it('despawnAll returns physics bodies + scene graph to baseline; idempotent', () => {
    const engine = makeEngine();
    const bodiesBefore = engine.physics.world.bodies.length;
    const sceneBefore = engine.scene.children.length;
    const m = new NpcManager(engine, { pois: POIS });
    m.spawnForMap(424242);
    expect(m.npcs.length).toBeGreaterThan(0);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore + m.npcs.length);
    const groups = m.npcs.map((n) => (n as any).rig.group);
    for (const g of groups) expect(engine.scene.children).toContain(g);
    m.despawnAll();
    expect(m.npcs.length).toBe(0);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    for (const g of groups) expect(engine.scene.children).not.toContain(g);
    expect(engine.scene.children.length).toBe(sceneBefore);
    expect(() => m.despawnAll()).not.toThrow(); // idempotent
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    // shared rig cache fully released by the manager
    const st = NpcRigCache.for(engine).stats();
    expect(st.geoRefs).toBe(0);
    expect(st.matRefs).toBe(0);
    engine.dispose();
  });

  it('spawnForMap is self-cleaning: re-spawn never double-counts bodies', () => {
    const engine = makeEngine();
    const bodiesBefore = engine.physics.world.bodies.length;
    const m = new NpcManager(engine, { pois: POIS });
    m.spawnForMap(1);
    m.spawnForMap(2);
    m.spawnForMap(3);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore + m.npcs.length);
    m.despawnAll();
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    engine.dispose();
  });
});

describe('NpcManager update + portal registry', () => {
  it('update(dt) ticks every NPC without errors; interactables track', () => {
    const engine = makeEngine();
    const m = new NpcManager(engine, { pois: POIS });
    m.spawnForMap(31337);
    const before = m.npcs.map((n) => n.position.clone());
    for (let i = 0; i < 120; i++) {
      m.update(1 / 60);
      engine.physics.step(1 / 60);
    }
    // villagers wander: at least one moved meaningfully
    const moved = m.npcs.some((n, i) => n.position.distanceTo(before[i]) > 0.05);
    expect(moved).toBe(true);
    for (const n of m.npcs) {
      expect(n.interactable.position.distanceTo(n.position)).toBeLessThan(2);
    }
    m.despawnAll();
    expect(() => m.update(1 / 60)).not.toThrow(); // empty roster tick is safe
    engine.dispose();
  });

  it('drives through engine.portalEntities like PortalTransition does', () => {
    const engine = makeEngine();
    const m = new NpcManager(engine, { pois: POIS });
    engine.portalEntities.register(m);
    expect(engine.portalEntities.ids()).toContain('npcs');
    const bodiesBefore = engine.physics.world.bodies.length;
    engine.portalEntities.spawnForMap(60606);
    expect(m.npcs.length).toBeGreaterThan(0);
    const first = rosterSig(m);
    engine.portalEntities.despawnAll();
    expect(m.npcs.length).toBe(0);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    engine.portalEntities.spawnForMap(60606);
    expect(rosterSig(m)).toEqual(first); // revisit regenerates identically
    engine.portalEntities.despawnAll();
    engine.dispose();
  });
});

describe('rig sharing (workstream B hard requirement)', () => {
  const LOOK = {
    name: 'Same Look',
    armorSet: 'nomad',
    palette: { cloth: '#7a5c3a', pants: '#3a342e', accent: '#ffb545', visor: '#ffb545' },
  };

  it('same-armor NPCs share geometries AND materials across instances', () => {
    const engine = makeEngine();
    const npcs = Array.from({ length: 6 }, (_, i) =>
      new Npc(engine, LOOK, new THREE.Vector3(i * 9, 0, 0), 5000 + i));
    // per-NPC draw cost unchanged (one draw per mesh, no instancing)
    let meshes = 0;
    for (const n of npcs) (n as any).rig.group.traverse((o: any) => { if (o.isMesh) meshes++; });
    const perNpc = meshes / npcs.length;
    console.log(`[npc-sharing] meshes per NPC: ${perNpc.toFixed(1)} (draw calls, unchanged by sharing)`);
    expect(perNpc).toBeLessThanOrEqual(60);

    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    for (const n of npcs) {
      (n as any).rig.group.traverse((o: any) => {
        if (!o.isMesh) return;
        geos.add(o.geometry);
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const mm of ms) mats.add(mm);
      });
    }
    console.log(`[npc-sharing] 6 same-armor NPCs: ${meshes} meshes -> ${geos.size} unique geometries, ${mats.size} unique materials`);
    // unshared, 6 NPCs would carry ~6x the unique geometries (one per mesh);
    // sharing must collapse well below the mesh count (12 body variants max:
    // 3 armor sets x 4 bulk buckets; materials share globally by signature)
    expect(geos.size).toBeLessThan(meshes / 2);
    expect(mats.size).toBeLessThanOrEqual(24);
    for (const n of npcs) n.dispose();
    engine.dispose();
  });

  it('cache refcount releases canonical resources when the last holder disposes', () => {
    const engine = makeEngine();
    const cache = NpcRigCache.for(engine);
    const a = new Npc(engine, LOOK, new THREE.Vector3(0, 0, 0), 7001);
    const b = new Npc(engine, LOOK, new THREE.Vector3(9, 0, 0), 7002);
    expect(cache.stats().geoRefs).toBeGreaterThan(0);
    const geosBoth = cache.stats().geometries;
    expect(geosBoth).toBeGreaterThan(0);
    a.dispose();
    expect(cache.stats().geoRefs).toBeGreaterThan(0); // b still holds them
    expect(cache.stats().geometries).toBeLessThanOrEqual(geosBoth);
    b.dispose();
    const st = cache.stats();
    expect(st.geoRefs).toBe(0);
    expect(st.matRefs).toBe(0);
    expect(st.geometries).toBe(0); // zero GPU payloads left
    expect(st.materials).toBe(0);
    engine.dispose();
  });

  it('varied roster: 8 default NPCs share heavily; census sane', () => {
    const engine = makeEngine();
    const beforeSpawn = gpuCensus(engine);
    const m = new NpcManager(engine, { pois: POIS });
    m.spawnForMap(20261012);
    expect(m.npcs.length).toBe(8);
    const { meshes, geos, mats } = gpuCensus(engine);
    const st = NpcRigCache.for(engine).stats();
    console.log(`[npc-sharing] 8-NPC roster: ${meshes} meshes/draws, ${geos} unique geometries, ${mats} unique materials (cache: ${JSON.stringify(st)})`);
    // hard bound: sharing must collapse the unique geometry count well below
    // the mesh count (unshared, every mesh carries its own geometry, so
    // unique ≈ meshes; 3 canonical body variants + content-keyed armor/clasp
    // sharing drive it far lower)
    expect(geos).toBeLessThan(meshes / 2);
    // Instancing pass: +1 canonical material per material role (13 roles
    // measured: white-diffuse for instance-tinting, baked emissive for
    // visor/clasp). These are tiny program-shared wrappers, not texture
    // payloads — B's sharing bound (40) still holds for the rig materials.
    expect(mats).toBeLessThanOrEqual(56);
    m.despawnAll();
    const after = gpuCensus(engine);
    // scene census returns to exactly the pre-spawn counts (zero leak)
    expect(after.meshes).toBe(beforeSpawn.meshes);
    expect(after.geos).toBe(beforeSpawn.geos);
    engine.dispose();
  });
});
