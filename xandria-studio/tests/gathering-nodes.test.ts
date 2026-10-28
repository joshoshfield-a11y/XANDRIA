/**
 * Upgrade loop, gathering-nodes phase:
 * - NODE_DEFS is the single tuning table (5 kinds incl. herb + crystal)
 * - seeded roster matches an INDEPENDENT replication (hand-rolled
 *   mulberry32 below — not the game's Rng import)
 * - per-node yields match an independent replication of the node rng
 *   draw order (rotation, scale, then yield)
 * - nodes deplete and regrow per the table (respawnScale accelerates)
 * - portal re-entry preserves the remaining respawn wait
 * - minimap markers: live + fog-revealed only, observe-only
 * - instancing census: buckets collapse across the 5-kind roster
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
  GATHER_SALT,
  MATERIAL_IDS,
  NODE_DEFS,
} from '../src/engine/game/gathering';
import { Minimap } from '../src/engine/ui/Minimap';

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
    mat_herb: { name: 'Herbs', type: 'material' },
    mat_crystal: { name: 'Crystal', type: 'material' },
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

// ---------------------------------------------------------------------------
// Independent oracle: mulberry32 re-implemented here from the algorithm,
// NOT imported from the game — so a drift in the game's Rng (or in the
// spawn draw order) fails this test instead of being replicated.
// ---------------------------------------------------------------------------
function oracleRng(seed: number) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min: number, max: number) => min + (max - min) * next(),
    int: (min: number, max: number) => Math.floor(min + (max + 1 - min) * next()),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
  };
}

const ORACLE_KINDS = ['ore', 'fiber', 'herb', 'crystal', 'scrap'] as const;

/**
 * Replicate spawnForMap's draw sequence exactly (no-terrain mode):
 * anchors from their own salt stream, then per node: kind pick, anchor
 * pick, one angle + one distance (first try always lands: no terrain).
 */
function replicateRoster(mapSeed: number, count: number): Array<{ kind: string; x: number; z: number }> {
  const GATHER_POI_SALT = 0x90c;
  const arng = oracleRng((mapSeed ^ GATHER_SALT ^ GATHER_POI_SALT) >>> 0);
  const anchors = POIS.map((p) => {
    const a = arng.range(0, Math.PI * 2);
    const d = (p.r ?? 0) + 4 + arng.range(0, 6);
    return { x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d };
  });
  const rng = oracleRng((mapSeed ^ GATHER_SALT) >>> 0);
  const out: Array<{ kind: string; x: number; z: number }> = [];
  for (let i = 0; i < count; i++) {
    const kind = rng.pick(ORACLE_KINDS);
    const a = rng.pick(anchors);
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(2, 12);
    out.push({ kind, x: a.x + Math.cos(ang) * dist, z: a.z + Math.sin(ang) * dist });
  }
  return out;
}

/** Replicate one node's yield: rotation draw, scale draw, then yield int. */
function replicateYield(mapSeed: number, index: number, kind: string): number {
  const rng = oracleRng((mapSeed ^ GATHER_SALT ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  rng.range(0, Math.PI * 2);
  rng.range(0.9, 1.15);
  const def = NODE_DEFS[kind as keyof typeof NODE_DEFS];
  return def.yieldBase + rng.int(0, def.yieldVariance);
}

describe('NODE_DEFS — the single tuning table', () => {
  it('covers exactly the five brief kinds with complete, unique tuning', () => {
    const kinds = Object.keys(NODE_DEFS);
    expect(kinds.sort()).toEqual(['crystal', 'fiber', 'herb', 'ore', 'scrap']);
    const materials = new Set<string>();
    const colors = new Set<string>();
    for (const k of kinds) {
      const d = NODE_DEFS[k as keyof typeof NODE_DEFS];
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.yieldBase).toBeGreaterThan(0);
      expect(d.yieldVariance).toBeGreaterThanOrEqual(0);
      expect(d.respawnSeconds).toBeGreaterThan(0);
      expect(d.minimapColor).toMatch(/^#[0-9a-f]{6}$/);
      expect(materials.has(d.materialId)).toBe(false);
      expect(colors.has(d.minimapColor)).toBe(false);
      materials.add(d.materialId);
      colors.add(d.minimapColor);
    }
    // the kind->material map never drifts from the table
    expect(MATERIAL_IDS).toEqual({
      ore: 'mat_ore', fiber: 'mat_fiber', herb: 'mat_herb', crystal: 'mat_crystal', scrap: 'mat_scrap',
    });
  });

  it('brief labels: ore vein, fiber thicket, herb patch, crystal cluster', () => {
    expect(NODE_DEFS.ore.label).toBe('ore vein');
    expect(NODE_DEFS.fiber.label).toBe('fiber thicket');
    expect(NODE_DEFS.herb.label).toBe('herb patch');
    expect(NODE_DEFS.crystal.label).toBe('crystal cluster');
    expect(NODE_DEFS.scrap.label).toBe('salvage cache');
  });

  it('respawn ordering follows rarity: herb fastest, crystal slowest', () => {
    expect(NODE_DEFS.herb.respawnSeconds).toBeLessThan(NODE_DEFS.fiber.respawnSeconds);
    expect(NODE_DEFS.fiber.respawnSeconds).toBeLessThan(NODE_DEFS.ore.respawnSeconds);
    expect(NODE_DEFS.crystal.respawnSeconds).toBeGreaterThan(NODE_DEFS.ore.respawnSeconds);
  });
});

describe('herb + crystal harvest', () => {
  it('grants the exact table materials and lands them in inventory', () => {
    const engine = makeEngine();
    const inv = makeInventory();
    const mgr = new GatheringManager(engine, { count: 40, inventory: inv });
    mgr.spawnForMap(424242);
    for (const kind of ['herb', 'crystal'] as const) {
      const node = mgr.nodes.find((n) => n.kind === kind);
      expect(node, `a ${kind} node spawns`).toBeDefined();
      const before = inv.count(NODE_DEFS[kind].materialId);
      const grant = mgr.harvestById(node!.interactable.id)!;
      expect(grant.materialId).toBe(NODE_DEFS[kind].materialId);
      expect(grant.count).toBeGreaterThanOrEqual(NODE_DEFS[kind].yieldBase);
      expect(grant.count).toBeLessThanOrEqual(NODE_DEFS[kind].yieldBase + NODE_DEFS[kind].yieldVariance);
      expect(inv.count(NODE_DEFS[kind].materialId)).toBe(before + grant.count);
    }
  });
});

describe('independent replication', () => {
  it('seeded roster matches the oracle (kinds + positions, no terrain)', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { pois: POIS, count: 18 });
    mgr.spawnForMap(20261018);
    const expected = replicateRoster(20261018, 18);
    expect(mgr.nodes.length).toBe(18);
    mgr.nodes.forEach((n, i) => {
      expect(n.kind).toBe(expected[i].kind);
      expect(n.root.position.x).toBeCloseTo(expected[i].x, 4);
      expect(n.root.position.z).toBeCloseTo(expected[i].z, 4);
    });
  });

  it('per-node yields match the oracle draw order', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { pois: POIS, count: 18 });
    mgr.spawnForMap(777001);
    mgr.nodes.forEach((n, i) => {
      const grant = n.harvest()!;
      expect(grant.materialId).toBe(NODE_DEFS[n.kind].materialId);
      expect(grant.count).toBe(replicateYield(777001, i, n.kind));
    });
  });
});

describe('deplete + regrow per table', () => {
  it('collapse progress, retire, regrow, re-harvest (herb, fastest table)', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const mgr = new GatheringManager(engine, { count: 30, inventory: makeInventory(), respawnScale: 0.01 });
    mgr.spawnForMap(99);
    const node = mgr.nodes.find((n) => n.kind === 'herb')!;
    expect(node).toBeDefined();
    expect(node.depleteProgress).toBe(0);
    mgr.harvestById(node.interactable.id);
    frame(engine, mgr, 0.3);
    expect(node.depleteProgress).toBeGreaterThan(0);
    expect(node.depleteProgress).toBeLessThan(1);
    for (let i = 0; i < 30; i++) frame(engine, mgr, 1 / 60);
    expect(node.depleteProgress).toBe(1);
    expect(node.retired).toBe(true);
    expect(node.regrowRemaining).toBeGreaterThan(0);
    expect(node.regrowRemaining).toBeLessThanOrEqual(NODE_DEFS.herb.respawnSeconds * 0.01 + 1e-6);
    expect(inst.isRegistered(node)).toBe(false);
    // regrow: scale climbs back, node becomes live + harvestable again
    const total = node.regrowRemaining + 0.7;
    const steps = Math.ceil(total / (1 / 60));
    for (let i = 0; i < steps; i++) frame(engine, mgr, 1 / 60);
    expect(node.isDepleted).toBe(false);
    expect(node.interactable.enabled).toBe(true);
    expect(inst.isRegistered(node)).toBe(true);
    expect(mgr.harvestById(node.interactable.id)).not.toBeNull();
  });

  it('double-harvest stays a no-op through collapse, wait and regrow', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { count: 5, inventory: makeInventory(), respawnScale: 0.01 });
    mgr.spawnForMap(7);
    const node = mgr.nodes[0];
    expect(mgr.harvestById(node.interactable.id)).not.toBeNull();
    expect(mgr.harvestById(node.interactable.id)).toBeNull();
    for (let i = 0; i < 30; i++) frame(engine, mgr, 1 / 60);
    expect(mgr.harvestById(node.interactable.id)).toBeNull(); // awaiting
    for (let i = 0; i < 300; i++) frame(engine, mgr, 1 / 60);
    expect(mgr.harvestById(node.interactable.id)).not.toBeNull(); // regrown
  });
});

describe('portal-preserved respawn state', () => {
  it('a mid-wait node resumes its remaining wait after a portal trip', () => {
    const engine = makeEngine();
    const mgr = new GatheringManager(engine, { count: 10, inventory: makeInventory(), respawnScale: 0.01 });
    mgr.spawnForMap(555);
    const victim = mgr.nodes[2];
    mgr.harvestById(victim.interactable.id);
    for (let i = 0; i < 60; i++) frame(engine, mgr, 1 / 60);
    expect(victim.retired).toBe(true);
    const remainingBefore = victim.regrowRemaining;
    expect(remainingBefore).toBeGreaterThan(0);
    // burn part of the wait, then trip
    for (let i = 0; i < 12; i++) frame(engine, mgr, 1 / 60);
    const remainingMid = victim.regrowRemaining;
    expect(remainingMid).toBeLessThan(remainingBefore);
    mgr.despawnAll();
    mgr.spawnForMap(555);
    const back = mgr.nodes[2];
    expect(back.isDepleted).toBe(true);
    // preserved, not reset to full and not instantly live
    expect(back.regrowRemaining).toBeCloseTo(remainingMid, 4);
    // the wait still completes after the trip
    const steps = Math.ceil((back.regrowRemaining + 0.7) / (1 / 60));
    for (let i = 0; i < steps; i++) frame(engine, mgr, 1 / 60);
    expect(back.isDepleted).toBe(false);
  });
});

describe('minimap markers (observe-only, fog-gated)', () => {
  function makeMinimap(nodes: any[]) {
    let tickCb: ((arg: { dt: number }) => void) | null = null;
    const engine: any = {
      hooks: { tap: (_e: string, cb: any) => { tickCb = cb; return null; } },
      portalEntities: { byId: (id: string) => (id === 'gathering' ? { nodes } : undefined) },
      portalManager: { coord: { mx: 0, my: 0 } },
      terrain: { size: 8000, heightAt: () => 0, waterLevelAt: () => null },
      portalsPlayerAvatar: { ctrl: { body: { position: { x: 0, y: 0, z: 0 } }, camYaw: 0 } },
    };
    const mm = new Minimap(makeEl('div') as any, engine);
    return { mm, runTick: (dt: number) => tickCb?.({ dt }) };
  }

  it('marks live nodes on revealed tiles only; never retired/awaiting ones', () => {
    const nodes = [
      { kind: 'ore', retired: false, nodeState: 'live', interactable: { id: 'node-ore-1-0' }, root: { position: { x: 10, z: 10 } } },
      { kind: 'herb', retired: false, nodeState: 'live', interactable: { id: 'node-herb-1-1' }, root: { position: { x: 3000, z: 3000 } } },
      { kind: 'crystal', retired: true, nodeState: 'awaiting', interactable: { id: 'node-crystal-1-2' }, root: { position: { x: 20, z: -10 } } },
      { kind: 'fiber', retired: true, nodeState: 'regrowing', interactable: { id: 'node-fiber-1-3' }, root: { position: { x: -20, z: 5 } } },
    ];
    const { mm, runTick } = makeMinimap(nodes);
    runTick(0.6); // arrive + reveal around the avatar at the origin
    const marks = mm.gatheringMarkers();
    expect(marks.map((m) => m.kind)).toEqual(['ore']);
    expect(marks[0].color).toBe(NODE_DEFS.ore.minimapColor);
    expect(marks[0].id).toBe('node-ore-1-0'); // markers carry node identity (e2e asserts by id, not proximity)
    // harvesting the marked node removes its marker (observe-only: the
    // minimap never touches the node, it just re-reads the roster)
    nodes[0].retired = true;
    runTick(0.6);
    expect(mm.gatheringMarkers()).toEqual([]);
  });

  it('marks every live node once its tile is revealed', () => {
    const nodes = [
      { kind: 'herb', retired: false, nodeState: 'live', interactable: { id: 'node-herb-1-0' }, root: { position: { x: 5, z: 5 } } },
      { kind: 'crystal', retired: false, nodeState: 'live', interactable: { id: 'node-crystal-1-1' }, root: { position: { x: -8, z: 12 } } },
    ];
    const { mm, runTick } = makeMinimap(nodes);
    runTick(0.6);
    expect(mm.gatheringMarkers().map((m) => m.kind).sort()).toEqual(['crystal', 'herb']);
    expect(mm.gatheringMarkers().map((m) => m.id).sort()).toEqual(['node-crystal-1-1', 'node-herb-1-0']);
  });
});

describe('instancing census (5-kind roster)', () => {
  it('buckets collapse across the roster; draws stay in single digits per node', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const mgr = new GatheringManager(engine, { count: 30 });
    mgr.spawnForMap(777);
    frame(engine, mgr);
    const stats = inst.stats();
    expect(stats.instances).toBeGreaterThan(0);
    // buckets grow with DISTINCT part geometries (herb + crystal add
    // theirs), never with node count — 30 nodes still fit in the 30s
    expect(inst.bucketCount).toBeLessThanOrEqual(40);
    expect(inst.bucketCount).toBeLessThan(30 * 6);
  });

  it('no new emissive roles: a second roster adds instances, not buckets', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const mgr = new GatheringManager(engine, { count: 30 });
    mgr.spawnForMap(313);
    const before = inst.bucketCount;
    mgr.spawnForMap(314);
    expect(inst.bucketCount).toBe(before);
  });
});
