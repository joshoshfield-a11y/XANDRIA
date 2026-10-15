/**
 * Workstream D — cross-map state tests (Open World Portals wave).
 *
 * 1. PlayerStateSnapshot round-trip: capture → mutate everything → apply →
 *    every field restored (health/inventory/progression/buffs/velocity).
 * 2. PortalMapCache: hits refresh recency, misses evict LRU with full
 *    dispose, capacity validation, clear().
 * 3. MapEntityRegistry: ordering, idempotent double-despawn, a throwing
 *    system never strands the others, id-dedupe on re-register.
 * 4. 10-transition soak on a REAL Engine + REAL Terrain: bounce A→B→C
 *    across 10 crossings (capacity 2 → constant eviction), asserting after
 *    every crossing: physics bodies and scene children return to the same
 *    map's first-visit counts, player state intact, evicted contexts fully
 *    disposed, heap flat (GC'd) from before to after.
 * 5. Instant-revisit path: capacity 3, A→B→A→B — revisits are cache hits,
 *    chunk geometry is reused (no rebuild), entity spawns deterministic.
 *
 * DOM/WebGL are stubbed (same pattern as engine-perf.test.ts); no GL calls.
 * Run with --expose-gc for the heap assertions (NODE_OPTIONS=--expose-gc).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const listeners: Record<string, Function[]> = {};
    const el: any = {
      tag,
      children: [] as any[],
      style: {} as Record<string, string>,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '',
      className: '',
      id: '',
      value: '',
      checked: false,
      innerHTML: '',
      appendChild(c: any) { c.parent = el; el.children.push(c); return c; },
      append(...cs: any[]) { for (const c of cs) { c.parent = el; el.children.push(c); } },
      remove() {
        const p = (el as any).parent;
        if (p && Array.isArray(p.children)) {
          const i = p.children.indexOf(el);
          if (i >= 0) p.children.splice(i, 1);
        }
      },
      setAttribute() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener(t: string, fn: Function) { (listeners[t] ??= []).push(fn); },
      removeEventListener(t: string, fn: Function) {
        const l = listeners[t];
        if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
      },
      querySelector() { return makeEl(); },
      querySelectorAll() { return []; },
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
      __listeners: listeners,
    };
    return el;
  }
  class FakeWebGLRenderer {
    domElement: any = makeEl('canvas');
    shadowMap: any = {};
    toneMapping: any = null;
    toneMappingExposure = 1;
    info: any = {
      autoReset: true,
      render: { calls: 0, frame: 0, lines: 0, points: 0, triangles: 0 },
      memory: { geometries: 0, textures: 0 },
      programs: null,
      reset() { this.render.calls = 0; this.render.triangles = 0; this.render.points = 0; this.render.lines = 0; },
    };
    setPixelRatio() {}
    setSize() {}
    getPixelRatio() { return 1; }
    getSize() { return { width: 800, height: 600 }; }
    dispose() {}
    render() {}
  }
  return { makeEl, FakeWebGLRenderer };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Engine } from '../src/engine/Engine';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics, GROUP } from '../src/engine/core/Physics';
import { Rng } from '../src/engine/core/Rng';
import { Inventory } from '../src/engine/game/items/Inventory';
import { Progression } from '../src/engine/game/Progression';
import { PlayerAvatar } from '../src/blueprints/common';
import {
  capturePlayerState,
  applyPlayerState,
  PortalTransition,
  type MapCoord,
  type PortalParts,
  type PlayerStateSnapshot,
} from '../src/engine/world/PortalState';
import { PortalMapCache, TerrainMapContext, mapKey, type CachedMap } from '../src/engine/world/MapCache';
import { MapEntityRegistry, type MapLocalEntitySystem } from '../src/engine/world/MapEntities';
import { generateSpec } from '../src/generator/generate';
import { _setProfileStorage } from '../src/engine/game/Profile';
import type { ItemDef } from '../src/spec/schema';

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

beforeEach(() => {
  const head = makeEl('head');
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head,
    body: makeEl('body'),
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as any).localStorage = memStore();
  (globalThis as any).window = {
    addEventListener() {},
    removeEventListener() {},
    setInterval: vi.fn(() => 42),
    clearInterval: vi.fn(),
  };
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1;
  (globalThis as any).innerWidth = 800;
  (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0;
  (globalThis as any).cancelAnimationFrame = () => {};
  _setProfileStorage(memStore() as any);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const defs: Record<string, ItemDef> = {
  'iron-sword': { name: 'Iron Sword', type: 'weapon', slot: 'weapon', rarity: 'common', stats: { damage: 5 }, stack: 1 },
  'leather-helm': { name: 'Leather Helm', type: 'armor', slot: 'head', stats: { defense: 2 }, stack: 1 },
  'health-potion': { name: 'Health Potion', type: 'consumable', behavior: { effect: 'heal', amount: 25 }, stack: 10 },
  'iron-ore': { name: 'Iron Ore', type: 'material', stack: 99 },
};

/* ------------------------------------------------------------------ */
/* 1. snapshot round-trip                                              */
/* ------------------------------------------------------------------ */

describe('PlayerStateSnapshot round-trip', () => {
  function fakeEngine(): any {
    const setHealth = vi.fn();
    const setLives = vi.fn();
    return {
      hud: { setHealth, setLives },
      spec: { custom: {} },
      _setHealth: setHealth,
      _setLives: setLives,
    };
  }

  function fakeAvatar() {
    const body = new CANNON.Body({ mass: 70 });
    body.position.set(11, 22, 33);
    body.velocity.set(4, -2, 7);
    return {
      health: 63, maxHealth: 120, ammo: 37, lives: 2,
      ctrl: { yaw: 1.23, speedBoostT: 4.5, body },
    } as any;
  }

  function fakeProgression() {
    const stubEngine: any = {
      spec: { progression: { enabled: true, xpPerKill: 20, xpPerPickup: 5 } },
      audio: { play() {} },
      hooks: { emit() {} },
    };
    const p = new Progression(stubEngine);
    p.addXp(250); // level-ups
    p.applyUpgrade('damage', { maxHealth: 100, heal() {} } as any);
    p.applyUpgrade('damage', { maxHealth: 100, heal() {} } as any);
    return p;
  }

  it('capture → mutate → apply restores every field', () => {
    const engine = fakeEngine();
    const inv = new Inventory(defs);
    inv.add('iron-sword', 1);
    inv.add('health-potion', 7);
    inv.add('iron-ore', 40);
    inv.equip('iron-sword');
    const prog = fakeProgression();
    let buff: { until: number; mult: number } | null = { until: 123.5, mult: 1.25 };
    const parts: PortalParts = {
      avatar: fakeAvatar(),
      inventory: inv,
      progression: prog,
      getBuff: () => buff,
      setBuff: (b) => { buff = b; },
    };
    (engine.spec.custom!.weaponMods as any) = { rateOfFire: 1.44 };

    const before = inv.serialize();
    const snap: PlayerStateSnapshot = capturePlayerState(engine, parts);
    expect(snap.version).toBe(1);
    expect(snap.health).toBe(63);
    expect(snap.velocity).toEqual([4, -2, 7]);

    // mutate EVERYTHING the snapshot covers
    const a = parts.avatar!;
    a.health = 1; a.maxHealth = 50; a.ammo = 0; a.lives = 0;
    a.ctrl.yaw = 0; a.ctrl.speedBoostT = 0;
    a.ctrl.body.velocity.set(0, 0, 0);
    inv.remove('health-potion', 7);
    inv.add('leather-helm', 1);
    prog.portalRestore({ level: 1, xp: 0, counts: {} });
    (engine.spec.custom!.weaponMods as any) = { rateOfFire: 999 };
    buff = null;

    applyPlayerState(engine, parts, snap);

    expect(a.health).toBe(63);
    expect(a.maxHealth).toBe(120);
    expect(a.ammo).toBe(37);
    expect(a.lives).toBe(2);
    expect(a.ctrl.yaw).toBe(1.23);
    expect(a.ctrl.speedBoostT).toBe(4.5);
    expect([a.ctrl.body.velocity.x, a.ctrl.body.velocity.y, a.ctrl.body.velocity.z]).toEqual([4, -2, 7]);
    expect(inv.serialize()).toBe(before);
    expect(prog.portalSnapshot().level).toBeGreaterThan(1);
    expect(prog.upgradeCount('damage')).toBe(2);
    expect((engine.spec.custom!.weaponMods as any).rateOfFire).toBe(1.44);
    expect(buff).toEqual({ until: 123.5, mult: 1.25 });
    expect(engine._setHealth).toHaveBeenCalledWith(63 / 120);
    expect(engine._setLives).toHaveBeenCalledWith(2);
  });

  it('is JSON-serializable and rejects bad snapshots without mutating', () => {
    const engine = fakeEngine();
    const inv = new Inventory(defs);
    inv.add('iron-ore', 3);
    const parts: PortalParts = {
      avatar: fakeAvatar(), inventory: inv, progression: null,
      getBuff: () => null, setBuff: () => {},
    };
    const snap = capturePlayerState(engine, parts);
    const revived = JSON.parse(JSON.stringify(snap)) as PlayerStateSnapshot;
    const before = inv.serialize();
    applyPlayerState(engine, parts, revived);
    expect(inv.serialize()).toBe(before);
    // bad snapshot: ignored, live state untouched
    const h = parts.avatar!.health;
    applyPlayerState(engine, parts, { version: 999 } as any);
    applyPlayerState(engine, parts, null as any);
    expect(parts.avatar!.health).toBe(h);
  });

  it('null avatar/inventory degrades gracefully (arena genres)', () => {
    const engine = fakeEngine();
    const parts: PortalParts = {
      avatar: null, inventory: null, progression: null,
      getBuff: () => null, setBuff: () => {},
    };
    const snap = capturePlayerState(engine, parts);
    expect(() => applyPlayerState(engine, parts, snap)).not.toThrow();
    expect(snap.health).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. LRU cache behavior                                               */
/* ------------------------------------------------------------------ */

describe('PortalMapCache', () => {
  function stubMap(coord: MapCoord): CachedMap & { disposed: boolean; parks: number } {
    return {
      coord,
      disposed: false,
      parks: 0,
      park() { this.parks++; },
      unpark() {},
      dispose() { this.disposed = true; },
      liveBodies() { return 0; },
    };
  }

  it('miss → hit, hits refresh recency', () => {
    const cache = new PortalMapCache(2);
    const built: MapCoord[] = [];
    const r1 = cache.acquire({ mx: 0, my: 0 }, (c) => { built.push(c); return stubMap(c); });
    expect(r1.hit).toBe(false);
    expect(r1.evicted).toBeNull();
    const r2 = cache.acquire({ mx: 0, my: 0 }, (c) => { built.push(c); return stubMap(c); });
    expect(r2.hit).toBe(true);
    expect(r2.map).toBe(r1.map);
    expect(built).toHaveLength(1);
  });

  it('evicts least-recently-used with full dispose', () => {
    const cache = new PortalMapCache(2);
    const a = cache.acquire({ mx: 0, my: 0 }, stubMap).map as unknown as { disposed: boolean };
    const b = cache.acquire({ mx: 1, my: 0 }, stubMap).map as unknown as { disposed: boolean };
    cache.acquire({ mx: 0, my: 0 }, stubMap); // refresh A → B is now LRU
    const r = cache.acquire({ mx: 0, my: 1 }, stubMap);
    expect(r.evicted).toEqual({ mx: 1, my: 0 });
    expect(b.disposed).toBe(true);
    expect(a.disposed).toBe(false);
    expect(cache.has({ mx: 1, my: 0 })).toBe(false);
    expect(cache.coords()).toEqual([{ mx: 0, my: 0 }, { mx: 0, my: 1 }]);
  });

  it('a throwing factory leaves the cache under capacity (evict-first), self-heals on retry', () => {
    const cache = new PortalMapCache(1);
    const good = cache.acquire({ mx: 0, my: 0 }, stubMap);
    // eviction runs BEFORE the build: a throwing factory can't leave the
    // cache over capacity, and the freed slot self-heals on retry.
    expect(() => cache.acquire({ mx: 9, my: 9 }, () => { throw new Error('boom'); })).toThrow('boom');
    expect(cache.size).toBe(0);
    expect((good.map as unknown as { disposed: boolean }).disposed).toBe(true);
    const r = cache.acquire({ mx: 9, my: 9 }, stubMap);
    expect(r.hit).toBe(false);
    expect(r.evicted).toBeNull();
    expect(cache.size).toBe(1);
  });

  it('clear() disposes everything; bad capacity throws', () => {
    const cache = new PortalMapCache(3);
    const maps = [
      cache.acquire({ mx: 0, my: 0 }, stubMap).map,
      cache.acquire({ mx: 1, my: 0 }, stubMap).map,
    ] as unknown as Array<{ disposed: boolean }>;
    cache.clear();
    expect(cache.size).toBe(0);
    expect(maps.every((m) => m.disposed)).toBe(true);
    expect(() => new PortalMapCache(0)).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 3. entity registry                                                  */
/* ------------------------------------------------------------------ */

describe('MapEntityRegistry', () => {
  it('despawn/spawn run in registration order; throwers never strand others', () => {
    const reg = new MapEntityRegistry();
    const log: string[] = [];
    const bad: MapLocalEntitySystem = {
      id: 'bad',
      despawnAll() { log.push('bad-despawn'); throw new Error('x'); },
      spawnForMap() { log.push('bad-spawn'); throw new Error('y'); },
    };
    reg.register({ id: 'a', despawnAll: () => { log.push('a-d'); }, spawnForMap: () => { log.push('a-s'); } });
    reg.register(bad);
    reg.register({ id: 'c', despawnAll: () => { log.push('c-d'); }, spawnForMap: () => { log.push('c-s'); } });
    reg.despawnAll();
    expect(log).toEqual(['a-d', 'bad-despawn', 'c-d']);
    log.length = 0;
    reg.spawnForMap(123);
    expect(log).toEqual(['a-s', 'bad-spawn', 'c-s']);
  });

  it('despawn is idempotent-safe and unregister works; re-register replaces by id', () => {
    const reg = new MapEntityRegistry();
    let n = 0;
    const un = reg.register({ id: 'x', despawnAll: () => { n++; }, spawnForMap: () => {} });
    reg.despawnAll(); reg.despawnAll();
    expect(n).toBe(2);
    un();
    expect(reg.count).toBe(0);
    reg.register({ id: 'dup', despawnAll: () => {}, spawnForMap: () => {} });
    reg.register({ id: 'dup', despawnAll: () => {}, spawnForMap: () => {} });
    expect(reg.count).toBe(1);
    expect(reg.ids()).toEqual(['dup']);
  });
});

/* ------------------------------------------------------------------ */
/* 4+5. transition soak on a REAL Engine + REAL Terrain                */
/* ------------------------------------------------------------------ */

const WORLD_SIZE = 2000;
const HALF = WORLD_SIZE / 2;

function specForSeed(seed: number) {
  const s = generateSpec('a heroic knight adventure', { seed });
  s.world.terrain.size = WORLD_SIZE;
  s.world.terrain.type = 'mountains' as any;
  return s;
}

/** stand-in for C's deriveMapSeed(worldSeed, mx, my) — C owns the real one */
function mapSeedFor(mx: number, my: number): number {
  return 77000 + mx * 131 + my * 1009;
}

const ORIGIN: MapCoord = { mx: 0, my: 0 };

function makeEngineWithTerrain(): Engine {
  const s = specForSeed(mapSeedFor(0, 0));
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, s, { testMode: true });
  engine.state = 'playing';
  return engine;
}

/** deterministic per-map entity system: 12 bodies + 12 meshes from mapSeed */
class FakeEntities implements MapLocalEntitySystem {
  readonly id = 'fake-entities';
  private bodies: CANNON.Body[] = [];
  private meshes: THREE.Mesh[] = [];
  /** seed → spawn positions per visit (determinism audit) */
  readonly visits = new Map<number, Array<[number, number, number][]>>();
  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: Physics,
  ) {}
  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    const rng = new Rng((mapSeed ^ 0xe7711) >>> 0);
    const pos: Array<[number, number, number]> = [];
    for (let i = 0; i < 12; i++) {
      const x = (rng.next() - 0.5) * 1600;
      const z = (rng.next() - 0.5) * 1600;
      const y = 60;
      this.bodies.push(this.physics.sphere(1, [x, y, z], { mass: 0, group: GROUP.WORLD }));
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshBasicMaterial({ color: 0xff0000 }),
      );
      m.position.set(x, y, z);
      this.scene.add(m);
      this.meshes.push(m);
      pos.push([x, y, z]);
    }
    const list = this.visits.get(mapSeed) ?? [];
    list.push(pos);
    this.visits.set(mapSeed, list);
  }
  despawnAll(): void {
    for (const b of this.bodies) this.physics.remove(b);
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.bodies = [];
    this.meshes = [];
  }
}

interface SoakParts {
  parts: PortalParts;
  avatar: PlayerAvatar;
  inventory: Inventory;
  progression: Progression;
  buffBox: { b: { until: number; mult: number } | null };
}

function makeSoakParts(engine: Engine): SoakParts {
  const avatar = new PlayerAvatar(engine, engine.spec, new THREE.Vector3(0, 60, 0), null, null);
  const inventory = new Inventory(defs);
  inventory.add('iron-sword', 1);
  inventory.add('health-potion', 5);
  inventory.add('iron-ore', 12);
  inventory.equip('iron-sword');
  const stubEngine: any = {
    spec: { progression: { enabled: true, xpPerKill: 20, xpPerPickup: 5 } },
    audio: { play() {} },
    hooks: { emit() {} },
  };
  const progression = new Progression(stubEngine);
  const buffBox: { b: { until: number; mult: number } | null } = { b: { until: 500, mult: 1.2 } };
  const parts: PortalParts = {
    avatar,
    inventory,
    progression,
    getBuff: () => buffBox.b,
    setBuff: (b) => { buffBox.b = b; },
  };
  return { parts, avatar, inventory, progression, buffBox };
}

function gcHeapMB(): number {
  (globalThis as any).gc?.();
  return Math.round(process.memoryUsage().heapUsed / 1048576);
}

describe('10-transition soak (real Engine + real Terrain)', () => {
  it('capacity 2, 3 rotating maps: counts return to baseline, state intact, heap flat', () => {
    const engine = makeEngineWithTerrain();
    const transition = new PortalTransition(engine);
    engine.portalCache = new PortalMapCache(2);
    // the constructor-built origin map enters the cache as the live context
    const originCtx = new TerrainMapContext(ORIGIN, engine.terrain, engine.scene, engine.physics);
    engine.portalCache.acquire(ORIGIN, () => originCtx);
    const contexts = new Map<string, TerrainMapContext>();
    contexts.set(mapKey(ORIGIN), originCtx);

    const fake = new FakeEntities(engine.scene, engine.physics);
    engine.portalEntities.register(fake);
    fake.spawnForMap(mapSeedFor(0, 0)); // entities live on the starting map

    const { parts, avatar, inventory, progression, buffBox } = makeSoakParts(engine);
    const buildTerrain = (c: MapCoord, seed: number) => {
      const t = new Terrain(specForSeed(seed), engine.physics, engine.mats, engine.scene);
      const ctx = new TerrainMapContext(c, t, engine.scene, engine.physics);
      contexts.set(mapKey(c), ctx);
      return t;
    };

    const route: MapCoord[] = [
      { mx: 1, my: 0 }, { mx: 0, my: 1 }, { mx: 0, my: 0 },
      { mx: 1, my: 0 }, { mx: 0, my: 1 }, { mx: 0, my: 0 },
      { mx: 1, my: 0 }, { mx: 0, my: 1 }, { mx: 0, my: 0 },
      { mx: 1, my: 0 },
    ];
    const arrival = new THREE.Vector3(0, 0, -HALF + 150);
    const firstVisitBodies = new Map<string, number>();
    const firstVisitScene = new Map<string, number>();
    let parkedBodies = -1;
    let parkedScene = -1;
    const heapSamples: number[] = [];
    const t0 = performance.now();

    route.forEach((coord, i) => {
      // earn things before crossing — all of it must survive
      avatar.health = Math.max(1, avatar.health - 3);
      avatar.ctrl.yaw += 0.1;
      avatar.ctrl.body.velocity.set(i, -i, i * 2);
      inventory.add('iron-ore', i + 1);
      progression.addXp(15);
      const expectHealth = avatar.health;
      const expectYaw = avatar.ctrl.yaw;
      const expectInv = inventory.serialize();
      const expectLevel = progression.portalSnapshot().level;

      const snap = transition.begin(parts);
      // parked: every terrain body + every entity body gone; player body stays
      const pb = engine.physics.world.bodies.length;
      const ps = engine.scene.children.length;
      if (parkedBodies < 0) { parkedBodies = pb; parkedScene = ps; }
      expect(pb).toBe(parkedBodies);
      expect(ps).toBe(parkedScene);

      const seed = mapSeedFor(coord.mx, coord.my);
      const res = transition.finish(parts, snap, coord, seed, arrival, buildTerrain);
      if (i === 0) {
        // first crossing: cache goes 1 → 2, nothing to evict yet
        expect(res.hit).toBe(false);
        expect(res.evicted).toBeNull();
      } else {
        // capacity 2 + 3 rotating maps → every later crossing is a miss + eviction
        expect(res.hit).toBe(false);
        expect(res.evicted).not.toBeNull();
        // the evicted context was FULLY disposed (geometry gone, not just parked)
        const evCtx = contexts.get(mapKey(res.evicted!))!;
        expect((evCtx.terrain as any).chunkMeshByKey.size).toBe(0);
        expect(evCtx.liveBodies()).toBe(0);
      }

      const key = mapKey(coord);
      const bodies = engine.physics.world.bodies.length;
      const sceneN = engine.scene.children.length;
      if (!firstVisitBodies.has(key)) {
        firstVisitBodies.set(key, bodies);
        firstVisitScene.set(key, sceneN);
      } else {
        // same map rebuilt from the same seed → identical paged set
        expect(bodies).toBe(firstVisitBodies.get(key));
        expect(sceneN).toBe(firstVisitScene.get(key));
      }

      // player state intact across the crossing
      expect(avatar.health).toBe(expectHealth);
      expect(avatar.ctrl.yaw).toBeCloseTo(expectYaw, 10);
      expect([avatar.ctrl.body.velocity.x, avatar.ctrl.body.velocity.y, avatar.ctrl.body.velocity.z])
        .toEqual([i, -i, i * 2]);
      expect(inventory.serialize()).toBe(expectInv);
      expect(progression.portalSnapshot().level).toBe(expectLevel);
      expect(buffBox.b).toEqual({ until: 500, mult: 1.2 });

      heapSamples.push(gcHeapMB());
    });

    const dt = Math.round(performance.now() - t0);
    // eslint-disable-next-line no-console
    console.log(`[soak] 10 crossings in ${dt}ms; heap MB: ${heapSamples.join(' → ')}`);
    // The heap-ratio assertion is only meaningful with explicit GC (see the
    // header: NODE_OPTIONS=--expose-gc). Without it, uncollected garbage
    // makes the ratio noisy; the body/mesh count assertions above are the
    // deterministic leak gate and always run.
    if (typeof (globalThis as any).gc === 'function') {
      const heapGrowth = heapSamples[heapSamples.length - 1] / heapSamples[0];
      expect(heapGrowth).toBeLessThan(1.6);
    }
    // determinism note: with capacity 2 there are no revisits, so entity
    // determinism is covered by the capacity-3 test below
  }, 120000);

  it('capacity 3: revisits are instant cache hits, geometry reused, entities deterministic', () => {
    const engine = makeEngineWithTerrain();
    const transition = new PortalTransition(engine);
    engine.portalCache = new PortalMapCache(3);
    engine.portalCache.acquire(ORIGIN, (c) => new TerrainMapContext(c, engine.terrain, engine.scene, engine.physics));

    const fake = new FakeEntities(engine.scene, engine.physics);
    engine.portalEntities.register(fake);
    fake.spawnForMap(mapSeedFor(0, 0));

    const { parts, avatar, inventory } = makeSoakParts(engine);
    const contexts = new Map<string, TerrainMapContext>();
    const buildTerrain = (c: MapCoord, seed: number) => {
      const t = new Terrain(specForSeed(seed), engine.physics, engine.mats, engine.scene);
      const ctx = new TerrainMapContext(c, t, engine.scene, engine.physics);
      contexts.set(mapKey(c), ctx);
      return t;
    };

    const arrival = new THREE.Vector3(0, 0, -HALF + 150);
    const route: MapCoord[] = [
      { mx: 1, my: 0 }, { mx: 0, my: 0 }, { mx: 1, my: 0 },
      { mx: 0, my: 0 }, { mx: 1, my: 0 }, { mx: 0, my: 0 },
    ];
    const geoSizes = new Map<string, number[]>();
    const bodyCounts = new Map<string, number[]>();
    const hits: boolean[] = [];

    route.forEach((coord) => {
      avatar.health = Math.max(1, avatar.health - 2);
      inventory.add('iron-ore', 1);
      const expectHealth = avatar.health;
      const expectInv = inventory.serialize();

      const snap = transition.begin(parts);
      const seed = mapSeedFor(coord.mx, coord.my);
      const key = mapKey(coord);
      const before = contexts.get(key);
      const geoBefore = before ? (before.terrain as any).chunkMeshByKey.size : -1;
      const res = transition.finish(parts, snap, coord, seed, arrival, buildTerrain);
      hits.push(res.hit);
      expect(res.evicted).toBeNull(); // capacity 3, only 2 maps — nothing evicted

      const ctx = contexts.get(key) as TerrainMapContext | undefined;
      if (ctx) {
        const geoAfter = (ctx.terrain as any).chunkMeshByKey.size;
        const arr = geoSizes.get(key) ?? [];
        arr.push(geoAfter);
        geoSizes.set(key, arr);
        if (res.hit) {
          // revisit: the geometry cache only grows (arrival neighborhood may
          // cover chunks the first visit never built) — it never rebuilds
          // what it already holds. The convergence check below proves the
          // second identical revisit builds zero new geometry.
          expect(geoAfter).toBeGreaterThanOrEqual(geoBefore);
        }
        const bc = engine.physics.world.bodies.length;
        const barr = bodyCounts.get(key) ?? [];
        barr.push(bc);
        bodyCounts.set(key, barr);
      }

      expect(avatar.health).toBe(expectHealth);
      expect(inventory.serialize()).toBe(expectInv);
    });

    // crossing 1 builds (1,0); crossing 2 revisits the pre-acquired origin;
    // the rest are hits
    expect(hits).toEqual([false, true, true, true, true, true]);
    // hit revisits page identically (teleport sync-build from parked state)
    for (const [, arr] of bodyCounts) {
      const hitCounts = arr.slice(1); // skip the fresh-build visit
      for (const n of hitCounts) expect(n).toBe(hitCounts[0]);
    }
    // entity spawns deterministic per map seed across revisits
    for (const [, visits] of fake.visits) {
      for (const v of visits.slice(1)) expect(v).toEqual(visits[0]);
    }
    // geometry cache is monotone across hits (never rebuilt, never leaked)
    for (const [, arr] of geoSizes) {
      for (let i = 1; i < arr.length; i++) expect(arr[i]).toBeGreaterThanOrEqual(arr[i - 1]);
    }

    // convergence: park + unpark the live map at the same focus — a revisit
    // to an already-seen neighborhood must build ZERO new chunk geometry
    // (this is the "instant restore" the LRU exists for)
    const live = engine.terrain as any;
    const buildsBefore = (live.chunkMeshByKey as Map<string, unknown>).size;
    let geoBuilds = 0;
    const origBuild = live.buildChunkGeometry.bind(live);
    live.buildChunkGeometry = (...args: any[]) => { geoBuilds++; return origBuild(...args); };
    const bodiesBefore = engine.physics.world.bodies.length;
    engine.parkWorldForPortal();
    expect(engine.physics.world.bodies.length).toBeLessThan(bodiesBefore);
    live.unparkPortals(engine.scene, engine.physics);
    live.update(arrival);
    live.refreshPortalAliases(arrival);
    expect(geoBuilds).toBe(0);
    expect((live.chunkMeshByKey as Map<string, unknown>).size).toBe(buildsBefore);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
  }, 120000);
});
