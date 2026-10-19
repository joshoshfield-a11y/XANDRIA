/**
 * Crafting wave (workstream C): StationManager + StationEntity + session.
 * - spawnForMap deterministic from mapSeed alone (two engines, same seed):
 *   kinds, positions, names identical
 * - one station per contract id (STATION_IDS order), genre-appropriate names
 * - portal round-trip regenerates the identical roster
 * - despawnAll leaves zero payloads (scene children + instancer baseline, idempotent)
 * - shared-singleton safety: despawnAll never reset()s the shared instancer
 * - requires/produces stay undefined on every station interactable (quest seam)
 * - session: openFor dispatches station ids only (pass-through otherwise),
 *   stale-session replacement, panel owned headless-safe
 * - instancing: the 4-station layer collapses into a small bucket count;
 *   no new emissive roles (amber reuses the clasp role)
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
import {
  StationManager,
  StationEntity,
  CraftingInteractionSession,
  STATION_SALT,
  STATION_IDS,
  stationDisplayName,
  stationShortLabel,
  registerStationInteractables,
  unregisterStationInteractables,
} from '../src/engine/game/stations';
import { STATION_WORKBENCH, STATION_ANVIL, STATION_FORGE, STATION_ALCHEMY } from '../src/engine/game/crafting';
import { GatheringManager } from '../src/engine/game/gathering';

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

function makeEngine(genre?: string): Engine {
  const spec = defaultSpec(99) as GameSpec;
  if (genre) (spec.meta as any).genre = genre;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

function frame(engine: Engine, mgr: StationManager, dt = 1 / 60): void {
  const inst = NpcInstancer.for(engine);
  inst.beginFrame(dt);
  mgr.update(dt);
  inst.endFrame();
}

function signature(mgr: StationManager): string {
  return mgr.stations
    .map((s) => `${s.stationId}:${s.name}@${s.root.position.x.toFixed(4)},${s.root.position.y.toFixed(4)},${s.root.position.z.toFixed(4)}`)
    .join('|');
}

const POIS = [{ x: 20, z: 20, r: 3 }, { x: -15, z: 25, r: 2 }];

describe('StationManager determinism', () => {
  it('same mapSeed on two engines -> identical roster (ids, positions, names)', () => {
    const a = makeEngine(); const b = makeEngine();
    const ma = new StationManager(a, { pois: POIS });
    const mb = new StationManager(b, { pois: POIS });
    ma.spawnForMap(4242); mb.spawnForMap(4242);
    expect(signature(ma)).toBe(signature(mb));
    expect(ma.stations.map((s) => s.stationId)).toEqual([...STATION_IDS]);
    expect(mb.stations.map((s) => s.stationId)).toEqual([...STATION_IDS]);
  });

  it('different seeds diverge', () => {
    const engine = makeEngine();
    const m1 = new StationManager(engine, { pois: POIS });
    const m2 = new StationManager(engine, { pois: POIS });
    m1.spawnForMap(1); m2.spawnForMap(2);
    expect(signature(m1)).not.toBe(signature(m2));
  });

  it('STATION_SALT isolates the roster stream: perturbing Math.random changes nothing', () => {
    const engine = makeEngine();
    const m1 = new StationManager(engine, { pois: POIS });
    m1.spawnForMap(99);
    const sig = signature(m1);
    for (let i = 0; i < 100; i++) Math.random();
    const m2 = new StationManager(engine, { pois: POIS });
    m2.spawnForMap(99);
    expect(signature(m2)).toBe(sig);
    expect(STATION_SALT).not.toBe(0xc0a57); // distinct from CRAFT_SALT
    expect(STATION_SALT).not.toBe(0x43524146); // distinct from GATHER_SALT
  });

  it('one station per contract id, in STATION_IDS order', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(7);
    expect(mgr.stations).toHaveLength(4);
    expect(mgr.stationIds()).toEqual([STATION_WORKBENCH, STATION_ANVIL, STATION_FORGE, STATION_ALCHEMY]);
  });

  it('names are genre-appropriate and deterministic per (seed, index)', () => {
    const arcane = makeEngine('third-person-action');
    const industrial = makeEngine('fps-arena');
    const ma = new StationManager(arcane, { pois: POIS });
    const mi = new StationManager(industrial, { pois: POIS });
    ma.spawnForMap(555); mi.spawnForMap(555);
    const arcaneNames = ma.stations.map((s) => s.name);
    const industrialNames = mi.stations.map((s) => s.name);
    // same (seed,index) stream -> same variant pick in both genres...
    // ...but the variant TABLES differ per genre class, so names differ
    expect(arcaneNames).not.toEqual(industrialNames);
    // determinism: rebuild -> identical names
    const ma2 = new StationManager(arcane, { pois: POIS });
    ma2.spawnForMap(555);
    expect(ma2.stations.map((s) => s.name)).toEqual(arcaneNames);
    // direct helper is pure
    expect(stationDisplayName(STATION_FORGE, 'third-person-action', 555, 2))
      .toBe(stationDisplayName(STATION_FORGE, 'third-person-action', 555, 2));
    expect(stationShortLabel(STATION_FORGE)).toBe('Forge');
    expect(stationShortLabel(STATION_ALCHEMY)).toBe('Alchemy Table');
  });

  it('spawnForMap is self-cleaning: re-spawn never double-registers', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(11);
    const regSize = engine.npcInteractions.size;
    mgr.spawnForMap(11);
    expect(mgr.stations).toHaveLength(4);
    expect(engine.npcInteractions.size).toBe(regSize);
    expect(signature(mgr)).toBe(signature(mgr));
  });
});

describe('StationManager lifecycle', () => {
  it('despawnAll returns scene + instancer + registry to baseline; idempotent', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const sceneBefore = engine.scene.children.length;
    const regBefore = engine.npcInteractions.size;
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(2024);
    frame(engine, mgr);
    expect(inst.registeredNpcCount).toBe(4);
    expect(engine.scene.children.length).toBeGreaterThan(sceneBefore);
    mgr.despawnAll();
    expect(mgr.stations).toHaveLength(0);
    expect(inst.registeredNpcCount).toBe(0);
    expect(engine.scene.children.length).toBe(sceneBefore);
    expect(engine.npcInteractions.size).toBe(regBefore);
    expect(() => mgr.despawnAll()).not.toThrow(); // idempotent
    expect(engine.npcInteractions.size).toBe(regBefore);
  });

  it('portal round-trip: despawn then same-seed spawn regenerates the identical roster', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(31415);
    const sig = signature(mgr);
    mgr.despawnAll();
    expect(mgr.stations).toHaveLength(0);
    mgr.spawnForMap(31415);
    expect(signature(mgr)).toBe(sig);
    expect(mgr.stations.every((s) => s.interactable.enabled)).toBe(true);
  });

  it('despawnAll never reset()s the shared instancer: a dummy registrant survives', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const dummy = { renderRoot: new THREE.Group() };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), engine.mats.flat('#ffffff', { roughness: 0.9 }));
    dummy.renderRoot.add(mesh);
    engine.scene.add(dummy.renderRoot);
    inst.registerEnemy(dummy);
    expect(inst.isRegistered(dummy)).toBe(true);
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(9);
    mgr.despawnAll();
    expect(inst.isRegistered(dummy)).toBe(true); // reset() would have dropped it
    inst.unregister(dummy);
    engine.scene.remove(dummy.renderRoot);
  });

  it('stations have no physics bodies (static, non-colliding — like nodes)', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    const bodiesBefore = engine.physics.world.bodies.length;
    mgr.spawnForMap(5);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
  });
});

describe('station interactables + the requires/produces seam', () => {
  it('interactables are type station with [E] Use <name> prompts', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(77);
    for (const s of mgr.stations) {
      const i = s.interactable;
      expect(i.type).toBe('station');
      expect(i.prompt).toBe(`Use ${s.name}`);
      expect(i.radius).toBe(3.5);
      expect(i.enabled).toBe(true);
      expect(engine.npcInteractions.get(i.id)).toBe(i);
    }
  });

  it('requires/produces stay undefined on every station interactable (quest seam)', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(78);
    for (const s of mgr.stations) {
      expect(s.interactable.requires).toBeUndefined();
      expect(s.interactable.produces).toBeUndefined();
    }
  });

  it('register/unregister helpers are idempotent and ignore missing ids', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(79);
    const size = engine.npcInteractions.size;
    registerStationInteractables(engine, mgr.stations);
    expect(engine.npcInteractions.size).toBe(size);
    unregisterStationInteractables(engine, mgr.stations);
    expect(engine.npcInteractions.size).toBe(size - 4);
    expect(() => unregisterStationInteractables(engine, mgr.stations)).not.toThrow();
  });
});

describe('CraftingInteractionSession', () => {
  function sessionOpts() {
    return {
      enableUi: false,
      recipes: () => [],
      defs: () => ({}),
      inventory: () => null,
      playerLevel: () => 1,
      toast: () => {},
    };
  }

  it('openFor dispatches station ids only; false passes through to other handlers', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(2024);
    const session = new CraftingInteractionSession(engine, mgr, sessionOpts());
    const st = mgr.stations[2];
    expect(session.openFor(st.interactable.id)).toBe(true);
    expect(session.openFor('node-ore-deadbeef-0')).toBe(false);
    expect(session.openFor('bogus')).toBe(false);
    session.dispose();
  });

  it('openFor anchors the panel to the station contract id (missing-station check narrows)', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(2024);
    const session = new CraftingInteractionSession(engine, mgr, { ...sessionOpts(), enableUi: true });
    const panel = session.ownedPanel;
    expect(panel).toBeTruthy();
    const wb = mgr.stations.find((s) => s.stationId === STATION_WORKBENCH)!;
    const fg = mgr.stations.find((s) => s.stationId === STATION_FORGE)!;
    expect(session.openFor(wb.interactable.id)).toBe(true);
    expect(panel!.anchoredStationId).toBe(STATION_WORKBENCH);
    // re-opening at another station re-anchors (no stale station id)
    expect(session.openFor(fg.interactable.id)).toBe(true);
    expect(panel!.anchoredStationId).toBe(STATION_FORGE);
    session.dispose();
  });

  it('stale-session guard: a second session disposes the first', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(2024);
    const s1 = new CraftingInteractionSession(engine, mgr, sessionOpts());
    expect(CraftingInteractionSession.liveFor(engine)).toBe(true);
    const s2 = new CraftingInteractionSession(engine, mgr, sessionOpts());
    expect(CraftingInteractionSession.liveFor(engine)).toBe(true);
    s2.dispose();
    expect(CraftingInteractionSession.liveFor(engine)).toBe(false);
    expect(() => s1.dispose()).not.toThrow(); // idempotent
  });

  it('dispose is idempotent and safe on an empty roster', () => {
    const engine = makeEngine();
    const mgr = new StationManager(engine, { pois: POIS });
    const session = new CraftingInteractionSession(engine, mgr, sessionOpts());
    expect(() => { session.dispose(); session.dispose(); }).not.toThrow();
  });
});

describe('instancing', () => {
  it('the 4-station layer collapses into a small bucket count', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(777);
    frame(engine, mgr);
    const stats = inst.stats();
    expect(stats.instances).toBeGreaterThan(0);
    // 4 stations x ~5-8 parts each; quantized dims + shared roles must
    // collapse — the layer stays in the low tens of buckets, not ~26
    expect(inst.bucketCount).toBeLessThanOrEqual(20);
  });

  it('stations share geometry buckets with nodes for identical dims (shared VoxelGeoCache)', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const stations = new StationManager(engine, { pois: POIS });
    stations.spawnForMap(313);
    const stationBuckets = inst.bucketCount;
    // the alchemy station's amber bubble (0.12^3) is the same geometry
    // object as the salvage cache's amber marker — no new bucket
    const nodes = new GatheringManager(engine, { count: 30 });
    nodes.spawnForMap(313);
    // a 30-node roster on its own is <= 24 buckets (workstream B's bound);
    // layered on the stations it must add FEWER than 24 new buckets
    // because shared dims/roles collapse across the two layers
    expect(inst.bucketCount - stationBuckets).toBeLessThan(24);
  });

  it('no new emissive roles: a second identical roster adds instances, not buckets', () => {
    const engine = makeEngine();
    const inst = NpcInstancer.for(engine);
    const mgr = new StationManager(engine, { pois: POIS });
    mgr.spawnForMap(313);
    const before = inst.bucketCount;
    mgr.spawnForMap(314);
    expect(inst.bucketCount).toBe(before);
  });
});
