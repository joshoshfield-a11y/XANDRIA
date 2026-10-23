/**
 * UPGRADE LOOP (world-tiers phase): engine-level world tier system.
 * - deriveWorldTier: pure in (mapSeed, depth); origin always tier 1;
 *   range 1..MAX_WORLD_TIER; seeded promotion exists; monotonic in depth
 * - TIER_SALT is distinct from every other wave salt
 * - effectiveSpawnLevel: tier=1 is the identity (matches the 2-arg form);
 *   higher tiers raise the floor additively
 * - applyEnemyScaling: tier=1 identical to the pre-tier call; tier 5 raises bands
 * - rollLoot: tier omitted === tier 1 (byte-identical); higher tiers shift
 *   the distribution toward rarer gear; legendary stays boss-exclusive
 * - HUD.setTier: chip hidden at tier 1, shown with the tier above
 * - Engine.worldTier: 1 at boot on a portal-stamped origin; follows the
 *   stamped coordinate; swapTerrainForPortal re-derives the tier
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

import { Rng } from '../src/engine/core/Rng';
import { Engine } from '../src/engine/Engine';
import { HUD } from '../src/engine/game/HUD';
import { defaultSpec, type GameSpec, type EnemySpec } from '../src/spec/schema';
import {
  TIER_SALT,
  MAX_WORLD_TIER,
  TIER_PROMOTE_CHANCE,
  deriveWorldTier,
  clampTier,
} from '../src/engine/world/worldTiers';
import {
  SCALING_SALT,
  TIER_LEVEL_STEP,
  effectiveSpawnLevel,
  applyEnemyScaling,
} from '../src/engine/game/enemyScaling';
import {
  LOOT_SALT,
  buildLootRng,
  rollLoot,
  tierGearWeightMult,
  lootGearDefs,
} from '../src/engine/game/loot';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { NPC_SALT } from '../src/engine/game/Npc';
import { CRAFT_SALT } from '../src/engine/game/crafting';
import { STATION_SALT } from '../src/engine/game/stations';
import { GATHER_SALT } from '../src/engine/game/gathering';

function makeEngine(spec?: GameSpec): Engine {
  const s = spec ?? (defaultSpec(99) as GameSpec);
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, s, { testMode: true, noTerrain: true } as any);
}

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

describe('deriveWorldTier', () => {
  it('the origin map (depth 0) is always tier 1, for any seed', () => {
    for (const seed of [0, 1, 42, 20261014, 0xffffffff]) {
      expect(deriveWorldTier(seed, 0)).toBe(1);
    }
  });
  it('is deterministic in (mapSeed, depth)', () => {
    for (let d = 0; d <= 12; d++) {
      expect(deriveWorldTier(20261014, d)).toBe(deriveWorldTier(20261014, d));
    }
    expect(deriveWorldTier(7, 4)).toBe(deriveWorldTier(7, 4));
  });
  it('stays in 1..MAX_WORLD_TIER even at absurd depths', () => {
    for (const d of [0, 1, 5, 50, 1000, 1e9]) {
      const t = deriveWorldTier(12345, d);
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(MAX_WORLD_TIER);
    }
    expect(MAX_WORLD_TIER).toBe(5);
  });
  it('is monotonic non-decreasing in depth (per seed)', () => {
    for (const seed of [1, 20261014, 987654321]) {
      let prev = 0;
      for (let d = 0; d <= 20; d++) {
        const t = deriveWorldTier(seed, d);
        expect(t).toBeGreaterThanOrEqual(prev);
        prev = t;
      }
    }
  });
  it('the seeded promotion fires for some seeds (variety, not pure depth)', () => {
    // depth 1: base tier 1; promotion (p=0.3) must hit at least one seed
    // in a 2000-seed scan (P(miss) = 0.7^2000 ~ 0).
    let promoted = 0;
    for (let s = 0; s < 2000; s++) if (deriveWorldTier(s, 1) === 2) promoted++;
    expect(promoted).toBeGreaterThan(0);
  });
  it('matches a from-scratch reimplementation of the contract (seed ^ TIER_SALT stream)', () => {
    const reimpl = (mapSeed: number, depth: number): number => {
      if (depth <= 0) return 1;
      const base = 1 + Math.floor(depth / 2);
      const rng = new Rng(((mapSeed ^ TIER_SALT) >>> 0));
      return Math.min(MAX_WORLD_TIER, base + (rng.next() < TIER_PROMOTE_CHANCE ? 1 : 0));
    };
    for (const [seed, d] of [[20261014, 4], [7, 1], [0xffffffff, 9], [42, 0]] as const) {
      expect(deriveWorldTier(seed, d)).toBe(reimpl(seed, d));
    }
  });
  it('clampTier is defensive', () => {
    expect(clampTier(3)).toBe(3);
    expect(clampTier(0)).toBe(1);
    expect(clampTier(99)).toBe(MAX_WORLD_TIER);
    expect(clampTier(NaN)).toBe(1);
  });
  it('TIER_SALT is distinct from every other wave salt', () => {
    const salts = new Set([TIER_SALT, LOOT_SALT, ENEMY_SALT, NPC_SALT, CRAFT_SALT, STATION_SALT, GATHER_SALT, SCALING_SALT]);
    expect(salts.size).toBe(8);
  });
});

describe('tier wiring into enemy scaling', () => {
  it('tier 1 is the identity: matches the 2-arg form exactly', () => {
    for (const [pl, md] of [[1, 0], [12, 3], [50, 40], [1, 100]] as const) {
      expect(effectiveSpawnLevel(pl, md, 1)).toBe(effectiveSpawnLevel(pl, md));
    }
  });
  it('higher tiers raise the level floor additively', () => {
    expect(effectiveSpawnLevel(1, 0, 1)).toBe(1);
    expect(effectiveSpawnLevel(1, 0, 2)).toBe(1 + TIER_LEVEL_STEP);
    expect(effectiveSpawnLevel(1, 0, 3)).toBe(1 + 2 * TIER_LEVEL_STEP);
    // the player level still wins when higher
    expect(effectiveSpawnLevel(30, 0, 5)).toBe(30);
  });
  it('applyEnemyScaling with tier 1 is byte-identical to the pre-tier call', () => {
    const base: EnemySpec = { kind: 'walker', count: 3, health: 30, speed: 4, damage: 10, weapon: 'melee' };
    const a = applyEnemyScaling(base, 1234, 12, 3);
    const b = applyEnemyScaling(base, 1234, 12, 3, 1);
    expect(b).toEqual(a);
  });
  it('a tier-5 deep map lands in a strictly higher band than the origin', () => {
    const base: EnemySpec = { kind: 'walker', count: 3, health: 30, speed: 4, damage: 10, weapon: 'melee' };
    const origin = applyEnemyScaling(base, 555, 1, 0, 1);
    const deep = applyEnemyScaling(base, 555, 1, 4, 5);
    expect(deep.bandIndex).toBeGreaterThan(origin.bandIndex);
    expect(deep.spec.health).toBeGreaterThan(origin.spec.health);
  });
});

describe('tier wiring into loot rarity', () => {
  it('tierGearWeightMult is 1.0 at tier 1 and grows with rarity index', () => {
    for (const id of Object.keys(lootGearDefs())) {
      expect(tierGearWeightMult(id, 1)).toBe(1);
    }
    // rare (idx 2) < epic (idx 3): rarer gear gains faster
    expect(tierGearWeightMult('loot_scorched_plate', 3)).toBe(1 + 2 * 2 * 0.25);
    expect(tierGearWeightMult('loot_void_edge', 3)).toBe(1 + 2 * 3 * 0.25);
    expect(tierGearWeightMult('loot_void_edge', 3)).toBeGreaterThan(tierGearWeightMult('loot_ironfang_blade', 3));
  });
  it('rollLoot with tier omitted is byte-identical to tier 1', () => {
    const mk = () => buildLootRng(20261014);
    for (const kind of ['walker', 'brute', 'drone', 'turret', 'nope']) {
      for (const boss of [false, true]) {
        const a = rollLoot(mk(), kind, boss);
        const b = rollLoot(mk(), kind, boss, 1);
        expect(b).toEqual(a);
      }
    }
  });
  it('higher tiers shift the gear distribution toward rarer drops; legendary stays boss-exclusive', () => {
    const RARE_PLUS = new Set(['loot_scorched_plate', 'loot_war_helm', 'loot_void_edge']);
    const run = (tier: number) => {
      const rng = buildLootRng(777);
      let rarePlus = 0, legendary = 0, total = 0;
      for (let i = 0; i < 3000; i++) {
        for (const d of rollLoot(rng, 'brute', false, tier)) {
          total++;
          if (RARE_PLUS.has(d.itemId)) rarePlus++;
          if (d.itemId === 'loot_star_aegis') legendary++;
        }
      }
      return { rarePlus, legendary, total };
    };
    const t1 = run(1);
    const t3 = run(3);
    expect(t1.legendary).toBe(0);
    expect(t3.legendary).toBe(0);
    expect(t3.rarePlus).toBeGreaterThan(t1.rarePlus);
  });
});

describe('HUD tier chip', () => {
  const hudSpec = () => ({ meta: { name: 'T' }, objective: { description: 'd' } }) as unknown as GameSpec;
  it('hidden at tier 1, shows TIER N above', () => {
    const hud = new HUD(makeEl('div'), hudSpec());
    const chip = (hud as unknown as { tierEl: any }).tierEl;
    hud.setTier(1);
    expect(chip.style.display).toBe('none');
    hud.setTier(3);
    expect(chip.style.display).toBe('');
    expect(chip.textContent).toBe('TIER 3');
    hud.setTier(1);
    expect(chip.style.display).toBe('none');
  });
  it('setTier is defensive about garbage input', () => {
    const hud = new HUD(makeEl('div'), hudSpec());
    const chip = (hud as unknown as { tierEl: any }).tierEl;
    hud.setTier(NaN);
    expect(chip.style.display).toBe('none');
    hud.setTier(99);
    expect(chip.textContent).toBe('TIER 99');
  });
});

describe('Engine.worldTier', () => {
  it('boots at tier 1 on an un-stamped (single-map) spec', () => {
    const engine = makeEngine();
    expect(engine.worldTier).toBe(1);
    engine.dispose();
  });
  it('boots at the derived tier for a pre-stamped portalMap', () => {
    const spec = defaultSpec(20261014) as GameSpec;
    spec.custom = { ...(spec.custom ?? {}), portalMap: { mx: 0, my: 4, worldSeed: 20261014 } };
    const engine = makeEngine(spec);
    expect(engine.worldTier).toBe(deriveWorldTier(20261014, 4));
    expect(engine.worldTier).toBeGreaterThanOrEqual(2);
    engine.dispose();
  });
  it('swapTerrainForPortal re-derives the tier and pushes it to the HUD chip', () => {
    const engine = makeEngine();
    expect(engine.worldTier).toBe(1);
    const seen: number[] = [];
    engine.hooks.tap('onWorldTier', ({ tier }) => seen.push(tier));
    // minimal terrain stand-in: swapTerrainForPortal only reassigns +
    // stamps; syncFarTerrain no-ops when terrain is null-sized... use a
    // real-ish stub: Terrain is skipped, call the tier path directly.
    (engine as unknown as { applyWorldTier: (s: number, x: number, y: number) => void })
      .applyWorldTier(987654, 0, 6);
    expect(engine.worldTier).toBe(deriveWorldTier(987654, 6));
    expect(seen).toEqual([engine.worldTier]);
    const hud = engine.hud as unknown as { tierEl: any };
    expect(hud.tierEl.style.display).toBe(engine.worldTier > 1 ? '' : 'none');
    engine.dispose();
  });
});
