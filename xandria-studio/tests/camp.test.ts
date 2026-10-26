/**
 * UPGRADE LOOP (player-camp): camp site placement, data-driven structures,
 * player-scoped storage chest, rest point, workbench buff, profile
 * persistence, portal lifecycle.
 * - site: deterministic per map seed, in-bounds, grounded
 * - build: costs enforced atomically (no consume on failure, no double build)
 * - chest: deposit/withdraw exact, backpack-full withdraw refunds to chest
 * - rest: restores HP exactly (via the restoreHealth callback)
 * - workbench: +10% melee damage for 600s game time, survives despawnAll
 * - persistence: chest contents + per-map built lists survive a fresh
 *   manager via the save-slot profile; per-map isolation by map seed
 * - lifecycle: despawnAll idempotent, respawn reproduces the identical site
 * - profile migration: campChest/campBuilt round-trip, malformed dropped
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

import { Engine } from '../src/engine/Engine';
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import { Inventory } from '../src/engine/game/items/Inventory';
import {
  CAMP_STRUCTURE_DEFS,
  CampManager,
  campSitePosition,
  campStructureDefOf,
  WORKBENCH_DAMAGE_MULT,
  WORKBENCH_BUFF_DURATION_S,
} from '../src/engine/game/camp';
import {
  _setProfileStorage,
  defaultProfile,
  loadProfile,
  migrateProfile,
  saveProfile,
} from '../src/engine/game/Profile';

function fakeStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
  _setProfileStorage(fakeStorage());
});

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

function makeInventory(ids: string[] = ['mat_ore', 'mat_fiber', 'mat_scrap']): Inventory {
  // NOTE: stack must be set — Inventory.stackSize() defaults to 1 when
  // def.stack is undefined, so stack-less defs fill all 24 slots with the
  // first material and starve the rest (found by a failing build test).
  const defs: Record<string, any> = {};
  for (const id of ids) defs[id] = { name: id, type: 'consumable', stack: 999 };
  return new Inventory(defs);
}

function grant(inv: Inventory, n = 99): void {
  inv.add('mat_ore', n); inv.add('mat_fiber', n); inv.add('mat_scrap', n);
}

interface MgrOpts {
  inventory?: Inventory;
  restored?: number[];
}

function makeManager(engine: Engine, o: MgrOpts = {}) {
  const inv = o.inventory !== undefined ? o.inventory : makeInventory();
  const restored = o.restored ?? [];
  const mgr = new CampManager(engine, {
    inventory: () => inv,
    restoreHealth: () => { restored.push(1); },
    toast: () => {},
  });
  return { mgr, inv, restored };
}

const SEED = 20261012;

describe('camp defs', () => {
  it('three structures, tier-1 material costs only', () => {
    expect(CAMP_STRUCTURE_DEFS.map((d) => d.id)).toEqual(['chest', 'workbench', 'rest']);
    for (const d of CAMP_STRUCTURE_DEFS) {
      for (const c of d.cost) {
        expect(['mat_ore', 'mat_fiber', 'mat_scrap']).toContain(c.itemId);
        expect(c.count).toBeGreaterThan(0);
      }
    }
    expect(campStructureDefOf('chest')?.name).toBe('Storage Chest');
    expect(campStructureDefOf('nope')).toBeUndefined();
  });
});

describe('campSitePosition', () => {
  it('deterministic per seed, in-bounds, grounded', () => {
    const terrain = {
      size: 512,
      inBounds: (x: number, z: number) => Math.abs(x) < 256 && Math.abs(z) < 256,
      heightAt: (x: number, z: number) => 10 + (x + z) * 0.001,
    };
    const a = campSitePosition(SEED, terrain);
    const b = campSitePosition(SEED, terrain);
    expect(a.equals(b)).toBe(true);
    expect(Math.abs(a.x)).toBeLessThan(256);
    expect(Math.abs(a.z)).toBeLessThan(256);
    expect(a.y).toBeCloseTo(terrain.heightAt(a.x, a.z));
    // ringed away from spawn: outside the 30m spawn exclusion
    expect(Math.hypot(a.x, a.z)).toBeGreaterThanOrEqual(30);
    const other = campSitePosition(SEED + 1, terrain);
    expect(other.equals(a)).toBe(false);
  });

  it('works without terrain (headless)', () => {
    const a = campSitePosition(SEED, null);
    const b = campSitePosition(SEED, undefined);
    expect(a.equals(b)).toBe(true);
    expect(a.y).toBe(0);
  });
});

describe('CampManager lifecycle', () => {
  it('spawnForMap places the site, registers the interactable, respawn reproduces it', () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);
    mgr.spawnForMap(SEED);
    expect(mgr.site).not.toBeNull();
    expect(mgr.discovered).toBe(true);
    const first = mgr.site!.clone();
    expect(engine.npcInteractions.get(`camp-${SEED}`)?.prompt).toBe('Visit camp');
    mgr.spawnForMap(SEED);
    expect(mgr.site!.equals(first)).toBe(true);
  });

  it('despawnAll is idempotent and clears the site + interactable', () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);
    mgr.spawnForMap(SEED);
    mgr.despawnAll();
    mgr.despawnAll();
    expect(mgr.site).toBeNull();
    expect(mgr.discovered).toBe(false);
    expect(engine.npcInteractions.get(`camp-${SEED}`)).toBeUndefined();
  });
});

describe('CampManager structures', () => {
  it('build refuses honestly with missing materials and consumes nothing', () => {
    const engine = makeEngine();
    const { mgr, inv } = makeManager(engine);
    mgr.spawnForMap(SEED);
    inv.add('mat_scrap', 1);
    const r = mgr.buildStructure('chest');
    expect(r.ok).toBe(false);
    expect(mgr.built).toEqual([]);
    expect(inv.count('mat_scrap')).toBe(1);
  });

  it('build consumes exact costs, double build refused without double consume', () => {
    const engine = makeEngine();
    const { mgr, inv } = makeManager(engine);
    mgr.spawnForMap(SEED);
    grant(inv);
    const r = mgr.buildStructure('chest');
    expect(r.ok).toBe(true);
    expect(mgr.built).toEqual(['chest']);
    // chest costs 4 scrap + 2 fiber
    expect(inv.count('mat_scrap')).toBe(99 - 4);
    expect(inv.count('mat_fiber')).toBe(99 - 2);
    const r2 = mgr.buildStructure('chest');
    expect(r2.ok).toBe(false);
    expect(inv.count('mat_scrap')).toBe(99 - 4);
  });

  it('unknown structure refused', () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);
    mgr.spawnForMap(SEED);
    expect(mgr.buildStructure('castle').ok).toBe(false);
  });

  it('build without a live site refused', () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);
    expect(mgr.buildStructure('chest').ok).toBe(false);
  });
});

describe('CampManager chest', () => {
  it('deposit/withdraw exact, withdraw clamps to stored', () => {
    const engine = makeEngine();
    const { mgr, inv } = makeManager(engine);
    mgr.spawnForMap(SEED);
    grant(inv);
    expect(mgr.deposit('mat_ore', 5)).toBe(0); // no chest yet
    expect(mgr.buildStructure('chest').ok).toBe(true);
    expect(mgr.deposit('mat_ore', 5)).toBe(5);
    expect(mgr.chestContents).toEqual({ mat_ore: 5 });
    expect(inv.count('mat_ore')).toBe(99 - 5);
    expect(mgr.withdraw('mat_ore', 2)).toBe(2);
    expect(mgr.chestContents).toEqual({ mat_ore: 3 });
    expect(mgr.withdraw('mat_ore', 99)).toBe(3);
    expect(mgr.chestContents).toEqual({});
  });

  it('withdraw into a full backpack refunds to the chest, nothing lost', () => {
    const engine = makeEngine();
    const ids = ['mat_ore', 'mat_fiber', 'mat_scrap'];
    for (let i = 0; i < 24; i++) ids.push(`filler_${i}`);
    const inv = makeInventory(ids);
    const { mgr } = makeManager(engine, { inventory: inv });
    mgr.spawnForMap(SEED);
    grant(inv);
    expect(mgr.buildStructure('chest').ok).toBe(true);
    expect(mgr.deposit('mat_ore', 10)).toBe(10);
    // empty the material stacks, then fill all 24 slots with distinct
    // fillers so no mat_ore stack exists and nothing new fits
    inv.remove('mat_ore', inv.count('mat_ore'));
    inv.remove('mat_fiber', inv.count('mat_fiber'));
    inv.remove('mat_scrap', inv.count('mat_scrap'));
    for (let i = 0; i < 24; i++) inv.add(`filler_${i}`, 1);
    expect(inv.add('mat_ore', 1)).toBe(1); // proves full: nothing fits
    expect(mgr.withdraw('mat_ore', 4)).toBe(0);
    expect(mgr.chestContents).toEqual({ mat_ore: 10 });
  });
});

describe('CampManager rest + workbench', () => {
  it('rest refused without the rest point, restores via callback with it', () => {
    const engine = makeEngine();
    const restored: number[] = [];
    const { mgr } = makeManager(engine, { restored });
    mgr.spawnForMap(SEED);
    expect(mgr.rest().ok).toBe(false);
    expect(restored).toEqual([]);
  });

  it('rest calls restoreHealth exactly once when built', () => {
    const engine = makeEngine();
    const inv = makeInventory();
    const restored: number[] = [];
    const { mgr } = makeManager(engine, { inventory: inv, restored });
    mgr.spawnForMap(SEED);
    grant(inv);
    expect(mgr.buildStructure('rest').ok).toBe(true);
    expect(mgr.rest().ok).toBe(true);
    expect(restored).toEqual([1]);
  });

  it('workbench buff: 1.1x for 600s game time, then 1.0; survives despawnAll', () => {
    const engine = makeEngine();
    const inv = makeInventory();
    const { mgr } = makeManager(engine, { inventory: inv });
    mgr.spawnForMap(SEED);
    grant(inv);
    expect(mgr.activateWorkbench().ok).toBe(false);
    expect(mgr.workbenchDamageMult()).toBe(1);
    expect(mgr.buildStructure('workbench').ok).toBe(true);
    expect(mgr.activateWorkbench().ok).toBe(true);
    expect(mgr.workbenchBuffActive()).toBe(true);
    expect(mgr.workbenchDamageMult()).toBe(WORKBENCH_DAMAGE_MULT);
    expect(mgr.workbenchBuffRemaining()).toBe(WORKBENCH_BUFF_DURATION_S);
    mgr.despawnAll(); // portal departure must NOT clear the player buff
    expect(mgr.workbenchBuffActive()).toBe(true);
    engine.time = WORKBENCH_BUFF_DURATION_S;
    expect(mgr.workbenchBuffActive()).toBe(false);
    expect(mgr.workbenchDamageMult()).toBe(1);
    expect(mgr.workbenchBuffRemaining()).toBe(0);
  });
});

describe('CampManager profile persistence', () => {
  it('chest + built structures survive a fresh manager via the profile, per map', () => {
    const engine = makeEngine();
    const inv = makeInventory();
    const { mgr } = makeManager(engine, { inventory: inv });
    mgr.spawnForMap(SEED);
    grant(inv);
    expect(mgr.buildStructure('chest').ok).toBe(true);
    expect(mgr.deposit('mat_ore', 7)).toBe(7);

    // fresh engine + manager, same profile storage: same map restores all
    const engine2 = makeEngine();
    const { mgr: mgr2 } = makeManager(engine2, { inventory: makeInventory() });
    mgr2.spawnForMap(SEED);
    expect(mgr2.built).toEqual(['chest']);
    expect(mgr2.chestContents).toEqual({ mat_ore: 7 });

    // a different map starts empty (chest is player-scoped, structures are not)
    mgr2.spawnForMap(SEED + 77);
    expect(mgr2.built).toEqual([]);
    expect(mgr2.chestContents).toEqual({ mat_ore: 7 });

    // back to the first map: structures restored again
    mgr2.spawnForMap(SEED);
    expect(mgr2.built).toEqual(['chest']);
  });

  it('profile round-trips camp fields through load/save', () => {
    const p = defaultProfile();
    p.campChest = { mat_ore: 3 };
    p.campBuilt = { '123': ['chest', 'rest'] };
    saveProfile(p);
    const back = loadProfile();
    expect(back.campChest).toEqual({ mat_ore: 3 });
    expect(back.campBuilt).toEqual({ '123': ['chest', 'rest'] });
  });

  it('migrateProfile drops malformed camp fields, keeps valid ones', () => {
    const m = migrateProfile({
      version: 1,
      campChest: { mat_ore: 5, junk: 'nope' },
      campBuilt: { '9': ['chest'], broken: 'not-an-array', '10': ['rest', 42 as never] },
    });
    expect(m.campChest).toEqual({ mat_ore: 5 });
    expect(m.campBuilt).toEqual({ '9': ['chest'], '10': ['rest'] });
    const fresh = migrateProfile({ version: 1 });
    expect(fresh.campChest).toEqual({});
    expect(fresh.campBuilt).toEqual({});
  });
});
