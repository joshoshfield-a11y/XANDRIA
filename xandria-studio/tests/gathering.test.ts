/**
 * Crafting wave (workstream B): GatheringManager + GatherNode + session.
 * - spawnForMap deterministic from mapSeed alone (two engines, same seed)
 * - portal round-trip regenerates the identical roster (kinds + positions)
 * - despawnAll leaves zero payloads (scene children + instancer baseline, idempotent)
 * - harvest yields the right material ids (mat_ore/mat_fiber/mat_scrap)
 * - depletion collapses (no pop) and retires the node
 * - depleted state is NOT persisted across portals (re-entry respawns live nodes)
 * - shared-singleton safety: despawnAll never reset()s the shared instancer
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '', width: 0, height: 600,
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
import { NpcInstancer } from '../src/engine/game/npcInstancing';
import { Inventory } from '../src/engine/game/items/Inventory';
import {
  GatheringManager,
  GatheringInteractionSession,
  GatherNode,
  GATHER_SALT,
  MATERIAL_IDS,
  DEFAULT_NODE_COUNT,
  registerGatheringInteractables,
  unregisterGatheringInteractables,
} from '../src/engine/game/gathering';

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

function makeEngine(env?: string): Engine {
  const spec = defaultSpec(99) as GameSpec;
  if (env) (spec.theme as any).environment = env;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

function makeInventory() {
  return new Inventory({
    mat_ore: { name: 'Ore', type: 'material' },
    mat_fiber: { name: 'Fiber', type: 'material' },
    mat_scrap: { name: 'Scrap', type: 'material' },
  } as any);
}

const POIS = [{ x: 20, z: 20, r: 3 }, { x: -15, z: 25, r: 2 }];

/** drive one shared-instancer frame around the manager update (the blueprint pattern) */
function frame(engine: Engine, mgr: GatheringManager, dt = 1 / 60): void {
  const inst = NpcInstancer.for(engine);
  inst.beginFrame(dt);
  mgr.update(dt);
  inst.endFrame();
}

function signature(mgr: GatheringManager): string {
  return mgr.nodes
    .map((n) => `${n.kind}:${n.root.position.x.toFixed(4)},${n.root.position.y.toFixed(4)},${n.root.position.z.toFixed(4)}`)
    .join('|');
}

describe('GatheringManager determinism', () => {
  it('same mapSeed -> identical roster (kinds + positions) on two engines', () => {
    const e1 = makeEngine(), e2 = makeEngine();
    const m1 = new GatheringManager(e1, { pois: POIS });
    const m2 = new GatheringManager(e2, { pois: POIS });
    m1.spawnForMap(20261018);
    m2.spawnForMap(20261018);
    expect(m1.nodes.length).toBeGreaterThan(0);
    expect(signature(m1)).toBe(signature(m2));
  });

  it('different mapSeed -> different roster', () => {
    const e1 = makeEngine(), e2 = makeEngine();
    const m1 = new GatheringManager(e1, { pois: POIS });
    const m2 = new GatheringManager(e2, { pois: POIS });
    m1.spawnForMap(111);
    m2.spawnForMap(222);
    expect(signature(m1)).not.toBe(signature(m2));
  });

  it('uses the GATHER_SALT stream (not engine.rng): respawn after other activity is identical', () => {
    const e = makeEngine();
    const m = new GatheringManager(e, { pois: POIS });
    m.spawnForMap(777001);
    const sig = signature(m);
    // simulate engine.rng advancing + other managers spawning between transitions
    m.spawnForMap(999);
    m.spawnForMap(777001);
    expect(signature(m)).toBe(sig);
  });

  it('default count and density/count opts', () => {
    const e = makeEngine();
    const m = new GatheringManager(e);
    m.spawnForMap(5);
    expect(m.nodes.length).toBe(DEFAULT_NODE_COUNT);
    const m2 = new GatheringManager(e, { count: 7 });
    m2.spawnForMap(5);
    expect(m2.nodes.length).toBe(7);
    const m3 = new GatheringManager(e, { density: 0.5 });
    m3.spawnForMap(5);
    expect(m3.nodes.length).toBe(Math.round(DEFAULT_NODE_COUNT * 0.5));
  });

  it('per-biome palettes: same kind reads different rock colors in desert vs arctic', () => {
    const e1 = makeEngine('desert'), e2 = makeEngine('arctic');
    const m1 = new GatheringManager(e1, { count: 30 });
    const m2 = new GatheringManager(e2, { count: 30 });
    m1.spawnForMap(4242);
    m2.spawnForMap(4242);
    const rockColor = (m: GatheringManager) => {
      const ore = m.nodes.find((n) => n.kind === 'ore')!;
      const base = ore.root.children[0] as THREE.Mesh;
      return ((base.material as THREE.MeshStandardMaterial).color.getHexString());
    };
    expect(rockColor(m1)).not.toBe(rockColor(m2));
  });
});

describe('GatheringManager portal lifecycle', () => {
  it('despawnAll returns scene + instancer + registry to baseline; idempotent', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const sceneBase = engine.scene.children.length;
    const regBase = inst.registeredNpcCount;
    const mgr = new GatheringManager(engine, { pois: POIS });
    mgr.spawnForMap(31337);
    expect(mgr.nodes.length).toBeGreaterThan(0);
    expect(inst.registeredNpcCount).toBeGreaterThan(regBase);
    expect(engine.npcInteractions.size).toBe(mgr.nodes.length);
    mgr.despawnAll();
    expect(engine.scene.children.length).toBe(sceneBase);
    expect(inst.registeredNpcCount).toBe(regBase);
    expect(engine.npcInteractions.size).toBe(0);
    expect(mgr.nodes.length).toBe(0);
    // idempotent: second call is a no-op, never an error
    mgr.despawnAll();
    expect(engine.scene.children.length).toBe(sceneBase);
    expect(inst.registeredNpcCount).toBe(regBase);
  });

  it('portal round-trip respawns the identical roster', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { pois: POIS });
    engine.portalEntities.register(mgr);
    mgr.spawnForMap(60606);
    const sig = signature(mgr);
    engine.portalEntities.despawnAll(); // departure
    expect(mgr.nodes.length).toBe(0);
    mgr.spawnForMap(60606); // arrival
    expect(signature(mgr)).toBe(sig);
  });

  it('spawnForMap self-cleans (no double-spawn after an aborted transition)', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { pois: POIS });
    mgr.spawnForMap(1);
    const n = mgr.nodes.length;
    mgr.spawnForMap(1);
    expect(mgr.nodes.length).toBe(n);
    expect(engine.npcInteractions.size).toBe(n);
  });

  it('despawnAll never reset()s the shared instancer (other registrants survive)', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const dummyRoot = new THREE.Group();
    engine.scene.add(dummyRoot);
    const dummy = { renderRoot: dummyRoot };
    inst.registerEnemy(dummy as any);
    expect(inst.isRegistered(dummy)).toBe(true);
    const mgr = new GatheringManager(engine, { pois: POIS });
    mgr.spawnForMap(42);
    expect(inst.isRegistered(dummy)).toBe(true);
    mgr.despawnAll();
    // the enemies-wave-C lesson: per-entity unregister, never reset()
    expect(inst.isRegistered(dummy)).toBe(true);
    inst.unregister(dummy);
  });
});

describe('harvest + depletion', () => {
  it('harvest yields the right material ids and lands in inventory', () => {
    const engine = makeEngine();
    const inv = makeInventory();
    const mgr = new GatheringManager(engine, { count: 30, inventory: inv });
    mgr.spawnForMap(808);
    for (const kind of ['ore', 'fiber', 'scrap'] as const) {
      const node = mgr.nodes.find((n) => n.kind === kind)!;
      expect(node).toBeDefined();
      const before = inv.count(MATERIAL_IDS[kind]);
      const grant = mgr.harvestById(node.interactable.id)!;
      expect(grant).not.toBeNull();
      expect(grant.materialId).toBe(MATERIAL_IDS[kind]);
      expect(grant.count).toBeGreaterThanOrEqual(kind === 'scrap' ? 1 : 2);
      // the grant actually lands in the inventory
      expect(inv.count(MATERIAL_IDS[kind])).toBe(before + grant.count);
    }
    expect(inv.getDef('mat_ore')).toBeDefined();
  });

  it('harvest is deterministic per (mapSeed, index): same seed -> same grants', () => {
    const mk = () => {
      const engine = makeEngine();
      const inv = makeInventory();
      const mgr = new GatheringManager(engine, { count: 12, inventory: inv });
      mgr.spawnForMap(5150);
      return mgr;
    };
    const g1 = mk().nodes.map((n) => ({ ...n.harvest() }));
    const g2 = mk().nodes.map((n) => ({ ...n.harvest() }));
    expect(g1).toEqual(g2);
  });

  it('double-harvest is a no-op', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { count: 5, inventory: makeInventory() });
    mgr.spawnForMap(99);
    const node = mgr.nodes[0];
    expect(mgr.harvestById(node.interactable.id)).not.toBeNull();
    expect(mgr.harvestById(node.interactable.id)).toBeNull();
    expect(mgr.harvestById('nope')).toBeNull();
  });

  it('depletion collapses (no pop) then retires the node', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const mgr = new GatheringManager(engine, { count: 5, inventory: makeInventory() });
    mgr.spawnForMap(1234);
    const node = mgr.nodes[0];
    const id = node.interactable.id;
    const before = node.root.scale.x;
    mgr.harvestById(id);
    expect(node.isDepleted).toBe(true);
    expect(node.interactable.enabled).toBe(false);
    // one tiny tick: shrink starts gradually — never an instant pop to 0
    frame(engine, mgr, 0.001);
    const s1 = node.root.scale.x;
    expect(s1).toBeLessThan(before);
    expect(s1).toBeGreaterThan(0.9);
    // run past the collapse: node retires from instancer + registry
    for (let i = 0; i < 60; i++) frame(engine, mgr, 1 / 60);
    expect(node.retired).toBe(true);
    expect(inst.isRegistered(node)).toBe(false);
    expect(engine.npcInteractions.get(id)).toBeUndefined();
    // the rest of the roster keeps submitting
    expect(inst.registeredNpcCount).toBe(mgr.nodes.length - 1);
  });

  it('portal re-entry preserves node state: depleted nodes resume their respawn wait', () => {
    // Gathering-nodes phase: timed respawn supersedes the crafting wave's
    // "depleted state is NOT persisted" note — under a respawn table,
    // non-persistence would let portal-hopping refresh nodes early.
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, {
      count: 10, inventory: makeInventory(), respawnScale: 0.01,
    });
    mgr.spawnForMap(2468);
    const sig = signature(mgr);
    const victim = mgr.nodes[3];
    mgr.harvestById(victim.interactable.id);
    for (let i = 0; i < 60; i++) frame(engine, mgr, 1 / 60);
    expect(victim.retired).toBe(true);
    mgr.despawnAll();
    mgr.spawnForMap(2468); // arrival regenerates the identical roster
    expect(signature(mgr)).toBe(sig);
    // the harvested node is still depleted (its wait preserved); every
    // other node is live, and the roster itself is unchanged
    const back = mgr.nodes[3];
    expect(back.isDepleted).toBe(true);
    expect(back.interactable.enabled).toBe(false);
    expect(mgr.nodes.filter((n, i) => i !== 3).every((n) => !n.isDepleted)).toBe(true);
    // the preserved wait still elapses in-map: the node regrows and is
    // harvestable again (same material, same id)
    for (let i = 0; i < 240; i++) frame(engine, mgr, 1 / 60);
    expect(back.isDepleted).toBe(false);
    expect(back.interactable.enabled).toBe(true);
    expect(mgr.harvestById(back.interactable.id)).not.toBeNull();
  });
});

describe('instancing', () => {
  it('node meshes ride the shared instancer buckets (collapse, single digits per node)', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const mgr = new GatheringManager(engine, { count: 30 });
    mgr.spawnForMap(777);
    frame(engine, mgr);
    const stats = inst.stats();
    expect(stats.instances).toBeGreaterThan(0);
    // ~6-8 meshes per node; buckets must collapse across the roster —
    // the whole node layer stays in the low tens of buckets, not hundreds.
    // Gathering-nodes phase: 5 kinds (herb + crystal part geometries)
    // measure 25 buckets for 30 nodes; the bound allows headroom for
    // part-geometry growth, never for node-count growth.
    expect(inst.bucketCount).toBeLessThanOrEqual(32);
    expect(inst.bucketCount).toBeLessThan(30 * 6);
  });

  it('no new emissive roles: amber accents share the existing amber-clasp role', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const mgr = new GatheringManager(engine, { count: 30 });
    mgr.spawnForMap(313);
    const before = inst.bucketCount;
    // spawning a second identical roster adds instances, not buckets
    mgr.spawnForMap(314);
    expect(inst.bucketCount).toBe(before);
  });
});

describe('GatheringInteractionSession', () => {
  it('registers interactables headless; harvest dispatches by id', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { count: 5, inventory: makeInventory() });
    mgr.spawnForMap(2024);
    const session = new GatheringInteractionSession(engine, mgr, { enableUi: false });
    const node = mgr.nodes[1];
    expect(engine.npcInteractions.get(node.interactable.id)).toBeDefined();
    expect(session.harvest(node.interactable.id)).toBe(true);
    expect(node.isDepleted).toBe(true);
    expect(session.harvest(node.interactable.id)).toBe(false); // already harvested
    expect(session.harvest('bogus-id')).toBe(false);
    session.dispose();
    session.dispose(); // idempotent
  });

  it('register/unregister module functions are idempotent', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { count: 4 });
    mgr.spawnForMap(55);
    registerGatheringInteractables(engine, mgr.nodes);
    registerGatheringInteractables(engine, mgr.nodes);
    expect(engine.npcInteractions.size).toBe(4);
    unregisterGatheringInteractables(engine, mgr.nodes);
    unregisterGatheringInteractables(engine, mgr.nodes);
    expect(engine.npcInteractions.size).toBe(0);
  });

  it('a second session replaces the stale one (one prompt pill per engine)', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { count: 3 });
    mgr.spawnForMap(7);
    const s1 = new GatheringInteractionSession(engine, mgr, { enableUi: false });
    expect(GatheringInteractionSession.liveFor(engine)).toBe(true);
    const s2 = new GatheringInteractionSession(engine, mgr, { enableUi: false });
    expect(GatheringInteractionSession.liveFor(engine)).toBe(true);
    s1.dispose();
    s2.dispose();
    expect(GatheringInteractionSession.liveFor(engine)).toBe(false);
  });

  it('node type filter: promptedNode is null for non-node targets', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { count: 3 });
    mgr.spawnForMap(9);
    const session = new GatheringInteractionSession(engine, mgr, { enableUi: false });
    expect(session.promptedNode).toBeNull();
    session.dispose();
  });
});

describe('GatherNode unit', () => {
  it('exposes renderRoot for the owner-agnostic instancer path', () => {
    const engine = makeEngine();
    const node = new GatherNode(engine, 'ore', new THREE.Vector3(1, 2, 3), 0, 100);
    expect(node.renderRoot).toBe(node.root);
    expect(node.root.children.length).toBeGreaterThanOrEqual(5);
    expect(node.interactable.type).toBe('node');
    expect(node.interactable.radius).toBe(3);
  });
});
