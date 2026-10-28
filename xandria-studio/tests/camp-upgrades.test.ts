/**
 * UPGRADE LOOP (camp-upgrades): structure upgrade tiers, chest capacity
 * tiers, workbench buff tiers, rest-point bonus tiers, atomic upgrades,
 * tier persistence, and the camp-anchor derivation.
 * - tier table: data-driven, tier-1 materials only, monotonic effects
 * - upgrade: refused when unbuilt / at max / missing materials (nothing
 *   consumed on any failure), exact costs per tier
 * - chest: base capacity 100, deposits clamp to remaining room, tiers
 *   raise the cap (300 / 800)
 * - workbench: tier multipliers/durations snapshotted at activation
 *   (1.1x/600s, 1.2x/900s, 1.35x/1200s)
 * - rest: tier 0 = HP only; tiers 1/2 add a timed rested melee bonus
 *   (1.05x/300s, 1.1x/600s), expired by game time
 * - persistence: tiers survive a fresh manager via the profile, per map
 * - anchors: discovered maps with a built camp (by derived map seed)
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
  CAMP_CHEST_BASE_CAPACITY,
  CAMP_STRUCTURE_TIERS,
  CampManager,
  campAnchorCoords,
  campChestCapacity,
  campRestTier,
  campStructureMaxTier,
  campStructureTierOf,
  campWorkbenchTier,
} from '../src/engine/game/camp';
import { deriveMapSeed } from '../src/engine/world/MapGraph';
import {
  _setProfileStorage,
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
  const defs: Record<string, any> = {};
  for (const id of ids) defs[id] = { name: id, type: 'consumable', stack: 9999 };
  return new Inventory(defs);
}

function grant(inv: Inventory, n = 999): void {
  inv.add('mat_ore', n); inv.add('mat_fiber', n); inv.add('mat_scrap', n);
}

function makeManager(engine: Engine, inv?: Inventory) {
  const inventory = inv ?? makeInventory();
  const restored: number[] = [];
  const mgr = new CampManager(engine, {
    inventory: () => inventory,
    restoreHealth: () => { restored.push(1); },
    toast: () => {},
  });
  return { mgr, inv: inventory, restored };
}

const SEED = 20261012;

describe('tier table', () => {
  it('three structures, tiers 1..2 sequential, tier-1 materials only, monotonic effects', () => {
    expect(Object.keys(CAMP_STRUCTURE_TIERS).sort()).toEqual(['chest', 'rest', 'workbench']);
    for (const [id, tiers] of Object.entries(CAMP_STRUCTURE_TIERS)) {
      expect(tiers.map((t) => t.tier)).toEqual([1, 2]);
      expect(campStructureMaxTier(id)).toBe(2);
      for (const t of tiers) {
        for (const c of t.cost) {
          expect(['mat_ore', 'mat_fiber', 'mat_scrap']).toContain(c.itemId);
          expect(c.count).toBeGreaterThan(0);
        }
      }
    }
    expect(campStructureTierOf('chest', 0)).toBeUndefined();
    expect(campStructureTierOf('chest', 3)).toBeUndefined();
    expect(campStructureTierOf('nope', 1)).toBeUndefined();
    expect(CAMP_CHEST_BASE_CAPACITY).toBe(100);
    expect(campChestCapacity(0)).toBe(100);
    expect(campChestCapacity(1)).toBe(300);
    expect(campChestCapacity(2)).toBe(800);
    expect(campWorkbenchTier(0)).toEqual({ damageMult: 1.1, buffDurationS: 600 });
    expect(campWorkbenchTier(1)).toEqual({ damageMult: 1.2, buffDurationS: 900 });
    expect(campWorkbenchTier(2)).toEqual({ damageMult: 1.35, buffDurationS: 1200 });
    expect(campRestTier(0)).toEqual({ damageMult: 1, buffDurationS: 0 });
    expect(campRestTier(1)).toEqual({ damageMult: 1.05, buffDurationS: 300 });
    expect(campRestTier(2)).toEqual({ damageMult: 1.1, buffDurationS: 600 });
  });
});

describe('upgradeStructure atomicity', () => {
  it('refused when unbuilt, unknown, or at max — nothing consumed', () => {
    const engine = makeEngine();
    const { mgr, inv } = makeManager(engine);
    mgr.spawnForMap(SEED);
    grant(inv);
    expect(mgr.upgradeStructure('chest').ok).toBe(false); // not built
    expect(mgr.upgradeStructure('castle').ok).toBe(false);
    expect(mgr.buildStructure('chest').ok).toBe(true);
    expect(mgr.upgradeStructure('chest').ok).toBe(true);
    expect(mgr.upgradeStructure('chest').ok).toBe(true);
    expect(mgr.tierOf('chest')).toBe(2);
    const counts = { ore: inv.count('mat_ore'), fiber: inv.count('mat_fiber'), scrap: inv.count('mat_scrap') };
    expect(mgr.upgradeStructure('chest').ok).toBe(false); // max tier
    expect({ ore: inv.count('mat_ore'), fiber: inv.count('mat_fiber'), scrap: inv.count('mat_scrap') }).toEqual(counts);
  });

  it('missing materials fail with nothing consumed; exact costs per tier', () => {
    const engine = makeEngine();
    const { mgr, inv } = makeManager(engine);
    mgr.spawnForMap(SEED);
    inv.add('mat_scrap', 1);
    expect(mgr.buildStructure('chest').ok).toBe(false);
    grant(inv);
    expect(mgr.buildStructure('chest').ok).toBe(true);
    // chest build: 4 scrap + 2 fiber; remaining from 999+1 scrap / 999 fiber
    const before = { ore: inv.count('mat_ore'), fiber: inv.count('mat_fiber'), scrap: inv.count('mat_scrap') };
    // drain fiber so tier 1 (6 scrap + 4 fiber) cannot be paid
    inv.remove('mat_fiber', inv.count('mat_fiber'));
    expect(mgr.upgradeStructure('chest').ok).toBe(false);
    expect(mgr.tierOf('chest')).toBe(0);
    expect(inv.count('mat_scrap')).toBe(before.scrap);
    // pay tier 1 exactly, then tier 2 exactly
    inv.add('mat_fiber', 999);
    expect(mgr.upgradeStructure('chest').ok).toBe(true);
    expect(mgr.tierOf('chest')).toBe(1);
    expect(inv.count('mat_scrap')).toBe(before.scrap - 6);
    expect(mgr.upgradeStructure('chest').ok).toBe(true);
    expect(mgr.tierOf('chest')).toBe(2);
    // tier 2 cost: 10 scrap + 6 fiber + 4 ore on top of tier 1's
    expect(inv.count('mat_scrap')).toBe(before.scrap - 16);
    expect(inv.count('mat_ore')).toBe(before.ore - 4);
  });

  it('upgrade without a live site refused', () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);
    expect(mgr.upgradeStructure('chest').ok).toBe(false);
  });
});

describe('chest capacity tiers', () => {
  it('base 100 clamps deposits; upgrades raise the cap', () => {
    const engine = makeEngine();
    const { mgr, inv } = makeManager(engine);
    mgr.spawnForMap(SEED);
    grant(inv);
    expect(mgr.buildStructure('chest').ok).toBe(true);
    expect(mgr.chestCapacity()).toBe(100);
    expect(mgr.deposit('mat_ore', 150)).toBe(100); // clamped to room
    expect(mgr.chestUsed()).toBe(100);
    expect(mgr.deposit('mat_ore', 50)).toBe(0); // full
    expect(mgr.upgradeStructure('chest').ok).toBe(true);
    expect(mgr.chestCapacity()).toBe(300);
    expect(mgr.deposit('mat_ore', 150)).toBe(150);
    expect(mgr.chestUsed()).toBe(250);
    expect(mgr.upgradeStructure('chest').ok).toBe(true);
    expect(mgr.chestCapacity()).toBe(800);
  });
});

describe('workbench + rest tiers', () => {
  it('workbench multipliers/durations snapshot at activation per tier', () => {
    const engine = makeEngine();
    const { mgr, inv } = makeManager(engine);
    mgr.spawnForMap(SEED);
    grant(inv);
    expect(mgr.buildStructure('workbench').ok).toBe(true);
    expect(mgr.activateWorkbench().ok).toBe(true);
    expect(mgr.workbenchDamageMult()).toBe(1.1);
    expect(mgr.workbenchBuffRemaining()).toBe(600);
    expect(mgr.upgradeStructure('workbench').ok).toBe(true);
    expect(mgr.activateWorkbench().ok).toBe(true);
    expect(mgr.workbenchDamageMult()).toBe(1.2);
    expect(mgr.workbenchBuffRemaining()).toBe(900);
    // upgrading mid-buff does NOT retroactively change the live buff
    expect(mgr.upgradeStructure('workbench').ok).toBe(true);
    expect(mgr.workbenchDamageMult()).toBe(1.2);
    expect(mgr.activateWorkbench().ok).toBe(true);
    expect(mgr.workbenchDamageMult()).toBe(1.35);
    expect(mgr.workbenchBuffRemaining()).toBe(1200);
    engine.time = 1200;
    expect(mgr.workbenchDamageMult()).toBe(1);
  });

  it('rest tier 0 = HP only; tiers add a timed rested melee bonus', () => {
    const engine2 = makeEngine();
    const inv2 = makeInventory();
    const restored2: number[] = [];
    const mgr2 = new CampManager(engine2, {
      inventory: () => inv2,
      restoreHealth: () => { restored2.push(1); },
      toast: () => {},
    });
    mgr2.spawnForMap(SEED);
    grant(inv2);
    expect(mgr2.buildStructure('rest').ok).toBe(true);
    expect(mgr2.rest().ok).toBe(true);
    expect(restored2).toEqual([1]);
    expect(mgr2.restedDamageMult()).toBe(1);
    expect(mgr2.upgradeStructure('rest').ok).toBe(true);
    expect(mgr2.rest().ok).toBe(true);
    expect(mgr2.restedDamageMult()).toBe(1.05);
    expect(mgr2.restedBuffRemaining()).toBe(300);
    expect(mgr2.upgradeStructure('rest').ok).toBe(true);
    expect(mgr2.rest().ok).toBe(true);
    expect(mgr2.restedDamageMult()).toBe(1.1);
    expect(mgr2.restedBuffRemaining()).toBe(600);
    engine2.time = 600;
    expect(mgr2.restedDamageMult()).toBe(1);
    expect(mgr2.restedBuffRemaining()).toBe(0);
  });
});

describe('tier persistence + profile migration', () => {
  it('tiers survive a fresh manager via the profile, per map', () => {
    const engineA = makeEngine();
    const invA = makeInventory();
    const mgrA = new CampManager(engineA, { inventory: () => invA, restoreHealth: () => {}, toast: () => {} });
    mgrA.spawnForMap(SEED);
    grant(invA);
    expect(mgrA.buildStructure('chest').ok).toBe(true);
    expect(mgrA.upgradeStructure('chest').ok).toBe(true);
    expect(mgrA.upgradeStructure('chest').ok).toBe(true);
    expect(mgrA.tierOf('chest')).toBe(2);

    const engineB = makeEngine();
    const mgrB = new CampManager(engineB, { inventory: () => makeInventory(), restoreHealth: () => {}, toast: () => {} });
    mgrB.spawnForMap(SEED);
    expect(mgrB.built).toEqual(['chest']);
    expect(mgrB.tierOf('chest')).toBe(2);
    expect(mgrB.chestCapacity()).toBe(800);
    mgrB.spawnForMap(SEED + 77);
    expect(mgrB.built).toEqual([]);
    expect(mgrB.tierOf('chest')).toBe(0);
    mgrB.spawnForMap(SEED);
    expect(mgrB.tierOf('chest')).toBe(2);
  });

  it('profile round-trips campTiers; migrateProfile drops malformed tiers', () => {
    const p = loadProfile();
    p.campTiers = { '123': { chest: 2, workbench: 1 } };
    saveProfile(p);
    expect(loadProfile().campTiers).toEqual({ '123': { chest: 2, workbench: 1 } });
    const m = migrateProfile({
      version: 1,
      campTiers: { '9': { chest: 2, junk: 'nope', workbench: -1, rest: 1.5 }, broken: 'no' },
    });
    expect(m.campTiers).toEqual({ '9': { chest: 2 } });
    expect(migrateProfile({ version: 1 }).campTiers).toEqual({});
  });
});

describe('campAnchorCoords', () => {
  it('maps with a built camp anchor; empty builds and unknown seeds do not', () => {
    const ws = 20261014;
    const discovered = [{ mx: 0, my: 0 }, { mx: 0, my: 1 }, { mx: 1, my: 0 }];
    const built: Record<string, string[]> = {
      [String(deriveMapSeed(ws, 0, 0))]: ['chest'],
      [String(deriveMapSeed(ws, 1, 0))]: [],
      '999999': ['chest'],
    };
    expect(campAnchorCoords(discovered, built, ws)).toEqual([{ mx: 0, my: 0 }]);
    expect(campAnchorCoords(discovered, {}, ws)).toEqual([]);
    expect(campAnchorCoords(discovered, null, ws)).toEqual([]);
    expect(campAnchorCoords([], built, ws)).toEqual([]);
  });
});
