/**
 * ItemWorld unit tests (inventory wave, items-runtime crew):
 *  - wireItems returns null without custom.items; feeds starting inventory
 *  - drop → tumble → settle → sleep → presentation mode
 *  - magnet collect fires onPickup (+ engine 'onPickup' hook)
 *  - chest open returns loot + spills physics drops; locked chests skip interact
 *  - damageChest smashes at 0 hp and spills loot
 *  - same seed → identical presentation phases (determinism)
 *  - BasicItemMeshes builds a mesh per item type, deterministically
 *
 * Headless harness (no jsdom): same stub pattern as tests/engine.test.ts —
 * real Engine, stubbed WebGLRenderer, hand-stubbed DOM. cannon-es + three run
 * fully in-process.
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
      value: '',
      checked: false,
      innerHTML: '',
      appendChild(c: any) { el.children.push(c); return c; },
      append(...cs: any[]) { for (const c of cs) el.children.push(c); },
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
        const l = listeners[t]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
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
import { Engine } from '../src/engine/Engine';
import { GROUP } from '../src/engine/core/Physics';
import { defaultSpec } from '../src/spec/schema';
import type { GameSpec } from '../src/spec/schema';
import { ItemWorld, BasicItemMeshes, RARITY_GLOW } from '../src/engine/game/items/ItemWorld';
import { wireItems, type InventoryLike } from '../src/engine/game/items/wireItems';
import type { ItemDef } from '../src/spec/schema';

/* ---------------- harness ---------------- */

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
});

function makeEngine(spec?: GameSpec): Engine {
  const s = spec ?? defaultSpec(99);
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, s, { testMode: true, noTerrain: true });
  (engine as any).postfx = { render() {}, resize() {}, dispose() {} };
  return engine;
}

/** flat static ground at y=0 for drop/settle tests */
function addGround(engine: Engine) {
  engine.physics.box(new THREE.Vector3(60, 1, 60), new THREE.Vector3(0, -0.5, 0), { mass: 0, group: GROUP.WORLD });
}

function itemSpec(seed = 99): GameSpec {
  const s = defaultSpec(seed);
  s.custom = {
    ...(s.custom ?? {}),
    items: {
      defs: {
        ironSword: { name: 'Iron Sword', type: 'weapon', slot: 'weapon', rarity: 'common', stats: { damage: 12 }, stack: 1, value: 50 },
        potion: { name: 'Healing Potion', type: 'consumable', behavior: { effect: 'heal', amount: 40 }, stack: 9 },
        helm: { name: 'Guard Helm', type: 'armor', slot: 'head', rarity: 'rare', stats: { defense: 4 } },
        starShard: { name: 'Star Shard', type: 'material', rarity: 'legendary', stack: 99 },
      },
      loot: [{ item: 'ironSword', pos: [4, 1.2, 0] }],
      chests: [{ pos: [8, 0, 0], loot: ['potion', 'helm'] }],
      starting: ['ironSword', 'potion'],
    },
  };
  return s;
}

function makeInventory(cap = 999): InventoryLike & { map: Map<string, number> } {
  const map = new Map<string, number>();
  return {
    map,
    add(itemId: string, count = 1) {
      const cur = map.get(itemId) ?? 0;
      const take = Math.max(0, Math.min(count, cap - cur));
      map.set(itemId, cur + take);
      return count - take;
    },
  };
}

function step(engine: Engine, world: ItemWorld, playerPos: THREE.Vector3, dt = 1 / 60) {
  engine.physics.step(dt);
  world.update(dt, playerPos);
}

const FAR = () => new THREE.Vector3(100, 0, 100);

/* ---------------- tests ---------------- */

describe('wireItems', () => {
  it('returns null when spec.custom.items is absent', () => {
    const engine = makeEngine();
    expect(wireItems(engine, defaultSpec(7), makeInventory())).toBeNull();
    engine.dispose();
  });

  it('feeds starting inventory and spawns loot + chests', () => {
    const engine = makeEngine(itemSpec());
    const inv = makeInventory();
    const world = wireItems(engine, itemSpec(), inv)!;
    expect(world).not.toBeNull();
    expect(inv.map.get('ironSword')).toBe(1);
    expect(inv.map.get('potion')).toBe(1);
    expect(world.liveItems).toHaveLength(1); // one loot spot
    expect(world.liveChests).toHaveLength(1);
    const loot = world.liveItems[0];
    expect(loot.id).toBe('ironSword');
    expect(loot.mode).toBe('presentation');
    expect(loot.body).toBeNull();
    world.dispose();
    engine.dispose();
  });

  it('throws on a starting id that is not in defs', () => {
    const s = itemSpec();
    (s.custom!.items as any).starting = ['ghost'];
    const engine = makeEngine(s);
    expect(() => wireItems(engine, s, makeInventory())).toThrow(/ghost/);
    engine.dispose();
  });

  it('overflow from a full inventory is re-dropped at the player anchor', () => {
    const s = itemSpec();
    (s.custom!.items as any).starting = ['ironSword'];
    const engine = makeEngine(s);
    const inv = makeInventory(0); // nothing fits
    const world = wireItems(engine, s, inv)!;
    expect(world).not.toBeNull();
    expect(inv.map.get('ironSword') ?? 0).toBe(0);
    expect(world.liveItems.some((i) => i.id === 'ironSword' && i.mode === 'physics')).toBe(true);
    world.dispose();
    engine.dispose();
  });
});

describe('ItemWorld drop physics', () => {
  it('drop → tumble → settle → sleep → presentation mode (body removed)', () => {
    const engine = makeEngine();
    addGround(engine);
    const world = new ItemWorld(engine, itemSpec().custom!.items!.defs!);
    const item = world.drop('ironSword', new THREE.Vector3(0, 5, 0));
    expect(item.mode).toBe('physics');
    expect(item.body).not.toBeNull();
    const body = item.body!;
    expect(body.mass).toBeCloseTo(0.5, 5);
    expect(body.allowSleep).toBe(true);

    // fell and bounced at least once
    let bounced = false;
    for (let i = 0; i < 900; i++) {
      step(engine, world, FAR());
      if (item.mode === 'presentation') break;
      if (body.velocity.y > 0.5) bounced = true; // upward = post-impact
    }
    expect(bounced).toBe(true);
    expect(item.mode).toBe('presentation');
    expect(item.body).toBeNull();
    expect(world.liveItems).toContain(item);
    expect(engine.scene.children).toContain(item.mesh);
    world.dispose();
    engine.dispose();
  });

  it('drop with explicit velocity throws in that direction', () => {
    const engine = makeEngine();
    addGround(engine);
    const world = new ItemWorld(engine, itemSpec().custom!.items!.defs!);
    const item = world.drop('potion', new THREE.Vector3(0, 2, 0), new THREE.Vector3(6, 2, 0));
    expect(item.body!.velocity.x).toBeCloseTo(6, 5);
    expect(item.body!.velocity.y).toBeCloseTo(2, 5);
    world.dispose();
    engine.dispose();
  });
});

describe('magnet + collect', () => {
  it('magnet pulls a settled item and collect fires onPickup (id + count)', () => {
    const engine = makeEngine();
    addGround(engine);
    const inv = makeInventory();
    const world = new ItemWorld(engine, itemSpec().custom!.items!.defs!);
    world.onPickup = (id, count) => { inv.add(id, count); };

    const hookCalls: unknown[] = [];
    engine.hooks.tap('onPickup', (p) => { hookCalls.push(p); });

    const item = world.drop('potion', new THREE.Vector3(0, 3, 0), undefined, 3);
    // let it settle first
    for (let i = 0; i < 600 && item.mode === 'physics'; i++) step(engine, world, FAR());
    expect(item.mode).toBe('presentation');

    const playerPos = new THREE.Vector3(2, 0.5, 0);
    for (let i = 0; i < 400 && !item.taken; i++) step(engine, world, playerPos);

    expect(item.taken).toBe(true);
    expect(inv.map.get('potion')).toBe(3); // count preserved through onPickup
    expect(hookCalls).toHaveLength(1);
    expect(world.liveItems).not.toContain(item);
    expect(engine.scene.children).not.toContain(item.mesh);
    world.dispose();
    engine.dispose();
  });

  it('magnet also grabs tumbling (physics-mode) items mid-flight', () => {
    const engine = makeEngine();
    addGround(engine);
    const picked: Array<[string, number]> = [];
    const world = new ItemWorld(engine, itemSpec().custom!.items!.defs!);
    world.onPickup = (id, count) => { picked.push([id, count]); };
    const item = world.drop('starShard', new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 1, 0));
    const playerPos = new THREE.Vector3(1.5, 1, 0);
    for (let i = 0; i < 300 && !item.taken; i++) step(engine, world, playerPos);
    expect(item.taken).toBe(true);
    expect(picked).toEqual([['starShard', 1]]);
    world.dispose();
    engine.dispose();
  });
});

describe('chests', () => {
  it('tryInteract finds the nearest unopened chest; openChest returns loot ids and spills drops', () => {
    const engine = makeEngine();
    const inv = makeInventory();
    const world = wireItems(engine, itemSpec(), inv)!;
    const chest = world.tryInteract(new THREE.Vector3(8, 0, 0));
    expect(chest).not.toBeNull();
    const ids = world.openChest(chest!);
    expect(ids).toEqual(['potion', 'helm']);
    expect(chest!.opened).toBe(true);
    expect(chest!.lidTarget).toBeLessThan(0);
    // loot spilled as physics drops
    expect(world.liveItems.filter((i) => i.mode === 'physics')).toHaveLength(2);
    // opening twice returns nothing
    expect(world.openChest(chest!)).toEqual([]);
    // no longer interactable
    expect(world.tryInteract(new THREE.Vector3(8, 0, 0))).toBeNull();
    world.dispose();
    engine.dispose();
  });

  it('locked chests are skipped by tryInteract and refuse openChest', () => {
    const s = itemSpec();
    (s.custom!.items as any).chests = [{ pos: [8, 0, 0], loot: ['potion'], locked: true }];
    const engine = makeEngine(s);
    const world = wireItems(engine, s, makeInventory())!;
    const chest = world.liveChests[0];
    expect(chest.locked).toBe(true);
    expect(world.tryInteract(new THREE.Vector3(8, 0, 0))).toBeNull();
    expect(world.openChest(chest)).toEqual([]);
    expect(chest.opened).toBe(false);
    world.dispose();
    engine.dispose();
  });

  it('damageChest smashes at 0 hp: debris, loot spill, body removed', () => {
    const engine = makeEngine();
    const world = wireItems(engine, itemSpec(), makeInventory())!;
    const chest = world.liveChests[0];
    world.damageChest(chest, 1);
    expect(chest.broken).toBe(false);
    expect(chest.hp).toBe(2);
    world.damageChest(chest, 2);
    expect(chest.broken).toBe(true);
    expect(chest.opened).toBe(true);
    expect(chest.body).toBeNull();
    expect(world.liveItems.filter((i) => i.mode === 'physics')).toHaveLength(2);
    // further damage is a no-op
    world.damageChest(chest, 5);
    expect(world.liveItems.filter((i) => i.mode === 'physics')).toHaveLength(2);
    world.dispose();
    engine.dispose();
  });
});

describe('determinism', () => {
  it('same seed → identical presentation phases, spins and hover anchors', () => {
    const snap = (seed: number) => {
      const engine = makeEngine(itemSpec(seed));
      const world = wireItems(engine, itemSpec(seed), makeInventory())!;
      world.drop('starShard', new THREE.Vector3(0, 3, 0));
      world.drop('helm', new THREE.Vector3(1, 3, 0));
      const out = world.liveItems.map((i) => ({
        id: i.id, phase: i.phase, spin: i.spin, baseY: i.baseY, shimmerT: i.shimmerT,
      }));
      world.dispose();
      engine.dispose();
      return out;
    };
    const a = snap(1234);
    const b = snap(1234);
    expect(a).toEqual(b);
    const c = snap(9999);
    expect(c).not.toEqual(a);
  });
});

describe('BasicItemMeshes', () => {
  const defs: Record<string, ItemDef> = {
    w: { name: 'Sword', type: 'weapon', slot: 'weapon' },
    a: { name: 'Plate', type: 'armor', slot: 'torso' },
    c: { name: 'Tonic', type: 'consumable' },
    m: { name: 'Ore', type: 'material' },
    k: { name: 'Cellar Key', type: 'key' },
    t: { name: 'Charm', type: 'trinket' },
  };

  it('builds a non-empty mesh for every item type', () => {
    const f = new BasicItemMeshes();
    for (const def of Object.values(defs)) {
      const mesh = f.meshFor(def);
      expect(mesh).toBeInstanceOf(THREE.Object3D);
      let meshes = 0;
      mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
      expect(meshes).toBeGreaterThan(1); // body parts + rarity ring
    }
  });

  it('is deterministic: same def → same structure', () => {
    const f = new BasicItemMeshes();
    const count = (d: ItemDef) => {
      let n = 0;
      f.meshFor(d).traverse((o) => { if ((o as THREE.Mesh).isMesh) n++; });
      return n;
    };
    expect(count(defs.w)).toBe(count(defs.w));
    expect(count(defs.m)).toBe(count({ ...defs.m }));
  });

  it('rarity glow matches RARITY_GLOW for all five rarities', () => {
    expect(Object.keys(RARITY_GLOW).sort()).toEqual(['common', 'epic', 'legendary', 'rare', 'uncommon']);
    for (const v of Object.values(RARITY_GLOW)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
});
