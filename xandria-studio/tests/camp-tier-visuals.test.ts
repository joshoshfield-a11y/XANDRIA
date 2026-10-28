/**
 * UPGRADE LOOP (camp-tier-visuals): tiered visuals for camp structures.
 * - visual table: campTierVisualParts is data-driven (base + cumulative
 *   tier extras); every tier renders a distinct part/amber count and a
 *   strictly taller prop. Tier 0 geometry is the pre-phase prop exactly.
 * - CampProp geometry matches the table exactly for every kind x tier,
 *   deterministically: same (seed, kind, tier) -> identical descriptor.
 * - manager: upgrading rebuilds the prop in place (no respawn), visuals
 *   track tierOf exactly, failed upgrades change nothing, visuals
 *   survive a fresh manager (profile tiers) and a despawn/respawn cycle
 *   with identical descriptors. Presentation-only: the capability tier
 *   table is untouched (covered by camp-upgrades.test.ts); here the
 *   visual tier is asserted to equal the capability tier after upgrades.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';

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
  CampManager,
  CampProp,
  campChestCapacity,
  campTierVisualParts,
  campWorkbenchTier,
} from '../src/engine/game/camp';
import { _setProfileStorage } from '../src/engine/game/Profile';

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
  const mgr = new CampManager(engine, {
    inventory: () => inventory,
    restoreHealth: () => {},
    toast: () => {},
  });
  return { mgr, inv: inventory };
}

const SEED = 20261012;
const POS = new THREE.Vector3(10, 0, -5);

// Expected visual table: [parts, amberParts] per tier 0/1/2.
const EXPECTED: Record<string, [number, number][]> = {
  chest: [[4, 0], [8, 0], [13, 0]],
  workbench: [[7, 1], [11, 2], [16, 3]],
  rest: [[3, 0], [6, 1], [11, 2]],
};

describe('visual table', () => {
  it('exact part + amber counts per structure and tier, clamped out of range', () => {
    for (const [kind, tiers] of Object.entries(EXPECTED)) {
      tiers.forEach(([parts, amberParts], tier) => {
        expect(campTierVisualParts(kind, tier)).toEqual({ parts, amberParts });
      });
    }
    expect(campTierVisualParts('chest', 3)).toEqual({ parts: 13, amberParts: 0 });
    expect(campTierVisualParts('chest', 99)).toEqual({ parts: 13, amberParts: 0 });
    expect(campTierVisualParts('chest', -1)).toEqual({ parts: 4, amberParts: 0 });
    expect(campTierVisualParts('site', 0)).toEqual({ parts: 10, amberParts: 1 });
    expect(campTierVisualParts('site', 2)).toEqual({ parts: 10, amberParts: 1 });
    expect(CAMP_CHEST_BASE_CAPACITY).toBe(100);
  });
});

describe('CampProp geometry', () => {
  it('matches the visual table exactly, height strictly increases per tier', () => {
    const engine = makeEngine();
    for (const [kind, tiers] of Object.entries(EXPECTED)) {
      let prevHeight = -1;
      tiers.forEach(([parts, amberParts], tier) => {
        const prop = new CampProp(engine, kind, POS, SEED, tier);
        expect(prop.kind).toBe(kind);
        expect(prop.visualTier).toBe(tier);
        expect(prop.partCount).toBe(parts);
        expect(prop.amberPartCount).toBe(amberParts);
        expect(prop.visualDescriptor()).toEqual({
          kind, tier, parts, amberParts, height: prop.visualHeight,
        });
        expect(prop.visualHeight).toBeGreaterThan(prevHeight);
        prevHeight = prop.visualHeight;
      });
    }
  });

  it('tier is clamped in the prop; site ignores tiers', () => {
    const engine = makeEngine();
    const over = new CampProp(engine, 'chest', POS, SEED, 7);
    expect(over.visualTier).toBe(2);
    expect(over.partCount).toBe(13);
    const site = new CampProp(engine, 'site', POS, SEED, 2);
    expect(site.visualTier).toBe(0);
    expect(site.partCount).toBe(10);
    expect(site.amberPartCount).toBe(1);
  });

  it('deterministic: same seed/kind/tier -> identical descriptor; tiers differ', () => {
    const engine = makeEngine();
    for (const kind of Object.keys(EXPECTED)) {
      for (let tier = 0; tier <= 2; tier++) {
        const a = new CampProp(engine, kind, POS, SEED, tier);
        const b = new CampProp(engine, kind, POS, SEED, tier);
        expect(a.visualDescriptor()).toEqual(b.visualDescriptor());
        expect(a.root.position.equals(b.root.position)).toBe(true);
      }
      const t0 = new CampProp(engine, kind, POS, SEED, 0);
      const t2 = new CampProp(engine, kind, POS, SEED, 2);
      expect(t0.visualDescriptor()).not.toEqual(t2.visualDescriptor());
      // Same tier on another seed: same counts, only jitter differs.
      const other = new CampProp(engine, kind, POS, SEED + 5, 2);
      expect(other.partCount).toBe(t2.partCount);
      expect(other.amberPartCount).toBe(t2.amberPartCount);
    }
  });
});

describe('manager visual lifecycle', () => {
  it('upgrade rebuilds the prop in place: visuals track tierOf, no duplicate props', () => {
    const engine = makeEngine();
    const { mgr, inv } = makeManager(engine);
    mgr.spawnForMap(SEED);
    grant(inv);
    for (const id of ['chest', 'workbench', 'rest']) expect(mgr.buildStructure(id).ok).toBe(true);
    const atTier = (tier: number) => {
      const visuals = mgr.propVisuals();
      expect(visuals).toHaveLength(3);
      for (const v of visuals) {
        expect(v.tier).toBe(tier);
        expect(mgr.tierOf(v.kind)).toBe(tier);
        const [parts, amberParts] = EXPECTED[v.kind][tier];
        expect(v.parts).toBe(parts);
        expect(v.amberParts).toBe(amberParts);
      }
      return visuals;
    };
    const v0 = atTier(0);
    expect(mgr.upgradeStructure('chest').ok).toBe(true);
    const afterChest = mgr.propVisuals();
    expect(afterChest.find((v) => v.kind === 'chest')!.tier).toBe(1);
    expect(afterChest.find((v) => v.kind === 'workbench')!.tier).toBe(0);
    expect(afterChest).toHaveLength(3);
    // The other two props are untouched: identical descriptors.
    expect(afterChest.find((v) => v.kind === 'workbench')).toEqual(v0.find((v) => v.kind === 'workbench'));
    expect(afterChest.find((v) => v.kind === 'rest')).toEqual(v0.find((v) => v.kind === 'rest'));
    for (const id of ['workbench', 'rest']) {
      expect(mgr.upgradeStructure(id).ok).toBe(true);
      expect(mgr.upgradeStructure(id).ok).toBe(true);
    }
    expect(mgr.upgradeStructure('chest').ok).toBe(true);
    const v2 = atTier(2);
    expect(v2.find((v) => v.kind === 'chest')!.height).toBeGreaterThan(v0.find((v) => v.kind === 'chest')!.height);
    // Visual tier == capability tier, and capabilities still come from the tier table.
    expect(campChestCapacity(mgr.tierOf('chest'))).toBe(800);
    expect(mgr.chestCapacity()).toBe(800);
    expect(campWorkbenchTier(mgr.tierOf('workbench'))).toEqual({ damageMult: 1.35, buffDurationS: 1200 });
  });

  it('failed upgrade changes nothing visually', () => {
    const engine = makeEngine();
    const { mgr, inv } = makeManager(engine);
    mgr.spawnForMap(SEED);
    grant(inv);
    expect(mgr.buildStructure('chest').ok).toBe(true);
    expect(mgr.upgradeStructure('chest').ok).toBe(true);
    expect(mgr.upgradeStructure('chest').ok).toBe(true);
    const before = mgr.propVisuals();
    expect(mgr.upgradeStructure('chest').ok).toBe(false); // max tier
    expect(mgr.upgradeStructure('workbench').ok).toBe(false); // unbuilt
    expect(mgr.propVisuals()).toEqual(before);
  });

  it('visuals persist across a fresh manager and across despawn/respawn', () => {
    const engineA = makeEngine();
    const invA = makeInventory();
    const mgrA = new CampManager(engineA, { inventory: () => invA, restoreHealth: () => {}, toast: () => {} });
    mgrA.spawnForMap(SEED);
    grant(invA);
    for (const id of ['chest', 'workbench', 'rest']) {
      expect(mgrA.buildStructure(id).ok).toBe(true);
      expect(mgrA.upgradeStructure(id).ok).toBe(true);
    }
    const built = mgrA.propVisuals();
    expect(built.every((v) => v.tier === 1)).toBe(true);
    // Fresh manager, same profile storage: arrival rebuilds at tier 1.
    const engineB = makeEngine();
    const mgrB = new CampManager(engineB, { inventory: () => makeInventory(), restoreHealth: () => {}, toast: () => {} });
    mgrB.spawnForMap(SEED);
    expect(mgrB.propVisuals()).toEqual(built);
    // Portal lifecycle on the same manager: despawn clears, respawn restores identically.
    mgrB.despawnAll();
    expect(mgrB.propVisuals()).toEqual([]);
    mgrB.spawnForMap(SEED);
    expect(mgrB.propVisuals()).toEqual(built);
  });
});
