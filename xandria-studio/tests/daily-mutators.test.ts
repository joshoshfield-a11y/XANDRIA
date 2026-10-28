/**
 * UPGRADE LOOP (daily-mutators phase): data-driven daily challenge mutators.
 * - the MUTATOR_TABLE is well-formed (the 4 briefed mutators, exact tuning)
 * - mutatorSeed = challengeSeed ^ MUTATOR_SALT (the brief's DATE_SALT ^
 *   yyyymmdd ^ MUTATOR_SALT, since challengeSeed IS DATE_SALT ^ yyyymmdd)
 * - mutatorsForDate: pure, 2 distinct ids, deep-equal to an independent
 *   replication (own mulberry32 + shuffle copy) for several dates
 * - combineMutatorEffects: exact per-table products, identity for [],
 *   unknown ids ignored
 * - EnemyManager.spawnOne wiring: mutators apply LAST on the scaled copy
 *   (glass-cannon damage x2 / dealt x1.5 via damageTakenMult, iron-skin
 *   armor x0.5, swarm roster density x2, no-mutators byte-identical,
 *   authored spec never mutated)
 * - Engine: no daily run -> no mutators, identity effect
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

import { Engine } from '../src/engine/Engine';
import { defaultSpec, type GameSpec, type EnemySpec } from '../src/spec/schema';
import { EnemyManager } from '../src/engine/game/EnemyAI';
import { challengeSeed } from '../src/engine/game/dailyChallenges';
import {
  DAILY_MUTATOR_COUNT,
  MUTATOR_IDS,
  MUTATOR_SALT,
  MUTATOR_TABLE,
  combineMutatorEffects,
  mutatorById,
  mutatorLabel,
  mutatorScoreMult,
  mutatorSeed,
  mutatorsForDate,
} from '../src/engine/game/dailyMutators';
import {
  _setProfileStorage,
} from '../src/engine/game/Profile';

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
  _setProfileStorage(undefined);
});

const WALKER: EnemySpec = { kind: 'walker', count: 3, health: 30, speed: 4, damage: 10, weapon: 'melee' };
const POIS = [{ x: 0, z: 0, r: 0 }];

function makeManager(engine: Engine, mutators: () => readonly string[]) {
  return new EnemyManager(engine, null, {}, { pois: POIS, specs: [{ ...WALKER }], playerLevel: () => 1, mutators });
}

// Independent replication of the mutator selection (own mulberry32 copy).
function replicateMutators(dateStr: string): string[] {
  const seed = (challengeSeed(dateStr) ^ MUTATOR_SALT) >>> 0;
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = [...MUTATOR_IDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, DAILY_MUTATOR_COUNT);
}

describe('mutator table', () => {
  it('has exactly the 4 briefed mutators, unique ids', () => {
    expect(MUTATOR_IDS).toEqual(['glass-cannon', 'swarm', 'miser', 'iron-skin']);
    expect(MUTATOR_TABLE.map((m) => m.id)).toEqual([...MUTATOR_IDS]);
  });
  it('every mutator charges score for its hardship (scoreMult > 1)', () => {
    for (const m of MUTATOR_TABLE) expect(m.scoreMult).toBeGreaterThan(1);
  });
  it('exact per-brief tuning', () => {
    const g = mutatorById('glass-cannon')!;
    expect(g.playerDamageTakenMult).toBe(2);
    expect(g.playerDamageDealtMult).toBe(1.5);
    expect(g.scoreMult).toBe(1.25);
    const s = mutatorById('swarm')!;
    expect(s.spawnDensityMult).toBe(2);
    expect(s.scoreMult).toBe(1.3);
    const m = mutatorById('miser')!;
    expect(m.lootChanceMult).toBe(0.5);
    expect(m.scoreMult).toBe(1.5);
    const i = mutatorById('iron-skin')!;
    expect(i.enemyDamageTakenMult).toBe(0.5);
    expect(i.scoreMult).toBe(1.25);
  });
  it('mutatorById returns null for unknown ids; label joins names', () => {
    expect(mutatorById('bogus')).toBeNull();
    expect(mutatorLabel([])).toBe('no mutators');
    expect(mutatorLabel(['glass-cannon', 'swarm'])).toBe('Glass Cannon + Swarm');
  });
});

describe('mutator selection', () => {
  it('mutatorSeed is challengeSeed ^ MUTATOR_SALT', () => {
    for (const d of ['2026-10-26', '2026-01-01', '2030-12-31']) {
      expect(mutatorSeed(d)).toBe((challengeSeed(d) ^ MUTATOR_SALT) >>> 0);
    }
  });
  it('same date -> same ids; 2 distinct ids from the table', () => {
    for (const d of ['2026-10-26', '2026-10-27', '2027-02-03']) {
      const a = mutatorsForDate(d);
      const b = mutatorsForDate(d);
      expect(a).toEqual(b);
      expect(a).toHaveLength(DAILY_MUTATOR_COUNT);
      expect(new Set(a).size).toBe(a.length);
      for (const id of a) expect(MUTATOR_IDS).toContain(id);
    }
  });
  it('deep-equal to the independent replication for several dates', () => {
    for (const d of ['2026-10-26', '2026-10-27', '2026-11-25', '2027-01-15']) {
      expect(mutatorsForDate(d)).toEqual(replicateMutators(d));
    }
  });
  it('different dates usually differ (the selection actually varies)', () => {
    const seen = new Set<string>();
    for (let day = 1; day <= 28; day++) {
      seen.add(mutatorsForDate(`2026-10-${String(day).padStart(2, '0')}`).join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('combineMutatorEffects', () => {
  it('identity for no mutators', () => {
    expect(combineMutatorEffects([])).toEqual({
      playerDamageTakenMult: 1, playerDamageDealtMult: 1, enemyDamageTakenMult: 1,
      spawnDensityMult: 1, lootChanceMult: 1, scoreMult: 1,
    });
    expect(mutatorScoreMult([])).toBe(1);
  });
  it('exact products for glass-cannon + iron-skin', () => {
    const e = combineMutatorEffects(['glass-cannon', 'iron-skin']);
    expect(e.playerDamageTakenMult).toBe(2);
    expect(e.playerDamageDealtMult).toBe(1.5);
    expect(e.enemyDamageTakenMult).toBe(0.5);
    expect(e.spawnDensityMult).toBe(1);
    expect(e.lootChanceMult).toBe(1);
    expect(e.scoreMult).toBeCloseTo(1.25 * 1.25, 10);
    expect(mutatorScoreMult(['glass-cannon', 'iron-skin'])).toBeCloseTo(1.5625, 10);
  });
  it('miser + swarm: loot halved, density doubled, score 1.5 * 1.3', () => {
    const e = combineMutatorEffects(['miser', 'swarm']);
    expect(e.lootChanceMult).toBe(0.5);
    expect(e.spawnDensityMult).toBe(2);
    expect(e.scoreMult).toBeCloseTo(1.95, 10);
  });
  it('unknown ids are ignored, never throw', () => {
    expect(combineMutatorEffects(['bogus'])).toEqual(combineMutatorEffects([]));
    expect(combineMutatorEffects(['glass-cannon', 'bogus']).scoreMult).toBe(1.25);
  });
});

describe('EnemyManager mutator wiring', () => {
  it('no-mutators manager is byte-identical to a manager without the mutators opt', () => {
    const engine = makeEngine();
    const withOpt = makeManager(engine, () => []);
    const noOpt = new EnemyManager(engine, null, {}, { pois: POIS, specs: [{ ...WALKER }], playerLevel: () => 1 });
    withOpt.spawnForMap(4242);
    noOpt.spawnForMap(4242);
    const stats = (m: EnemyManager) => m.enemies.map((e) => ({ hp: e.maxHealth, dmg: e.spec.damage, taken: e.damageTakenMult }));
    expect(stats(withOpt)).toEqual(stats(noOpt));
  });
  it('glass-cannon: enemy damage x2, dealt x1.5 via damageTakenMult, hp untouched', () => {
    const engine = makeEngine();
    const m = makeManager(engine, () => ['glass-cannon']);
    m.spawnForMap(12345);
    expect(m.enemies).toHaveLength(3);
    for (const e of m.enemies) {
      expect(e.spec.damage).toBeCloseTo(20, 10); // 10 * taken 2
      expect(e.damageTakenMult).toBeCloseTo(1.5, 10); // dealt 1.5
      expect(e.maxHealth).toBeCloseTo(30, 10);
    }
  });
  it('iron-skin: damageTakenMult x0.5, damage and hp untouched', () => {
    const engine = makeEngine();
    const m = makeManager(engine, () => ['iron-skin']);
    m.spawnForMap(12345);
    for (const e of m.enemies) {
      expect(e.damageTakenMult).toBeCloseTo(0.5, 10);
      expect(e.spec.damage).toBeCloseTo(10, 10);
      expect(e.maxHealth).toBeCloseTo(30, 10);
    }
  });
  it('glass-cannon + iron-skin compose: damage x2, damageTakenMult 1.5 * 0.5 = 0.75', () => {
    const engine = makeEngine();
    const m = makeManager(engine, () => ['glass-cannon', 'iron-skin']);
    m.spawnForMap(12345);
    for (const e of m.enemies) {
      expect(e.spec.damage).toBeCloseTo(20, 10);
      expect(e.damageTakenMult).toBeCloseTo(0.75, 10);
    }
  });
  it('damage() lands through the mutator multiplier: glass 10 -> 15 hp, iron 10 -> 5 hp', () => {
    const engine = makeEngine();
    const g = makeManager(engine, () => ['glass-cannon']);
    g.spawnForMap(12345);
    g.enemies[0].damage(10);
    expect(g.enemies[0].health).toBeCloseTo(15, 10); // 30 - 10*1.5
    const iron = makeManager(engine, () => ['iron-skin']);
    iron.spawnForMap(12345);
    iron.enemies[0].damage(10);
    expect(iron.enemies[0].health).toBeCloseTo(25, 10); // 30 - 10*0.5
  });
  it('swarm: spawnForMap roster density x2 (3 -> 6), positions still deterministic', () => {
    const engine = makeEngine();
    const base = makeManager(engine, () => []);
    const swarm = makeManager(engine, () => ['swarm']);
    base.spawnForMap(12345);
    swarm.spawnForMap(12345);
    expect(base.enemies).toHaveLength(3);
    expect(swarm.enemies).toHaveLength(6);
    // the first 3 swarm spawns share the base roster's positions (same stream prefix)
    for (let i = 0; i < 3; i++) {
      expect(swarm.enemies[i].position.x).toBeCloseTo(base.enemies[i].position.x, 10);
      expect(swarm.enemies[i].position.z).toBeCloseTo(base.enemies[i].position.z, 10);
    }
  });
  it('same (seed, mutators) twice -> identical encounters', () => {
    const engine = makeEngine();
    const a = makeManager(engine, () => ['glass-cannon', 'swarm']);
    const b = makeManager(engine, () => ['glass-cannon', 'swarm']);
    a.spawnForMap(777);
    b.spawnForMap(777);
    const stats = (m: EnemyManager) => m.enemies.map((e) => ({ hp: e.maxHealth, dmg: e.spec.damage, taken: e.damageTakenMult }));
    expect(stats(a)).toEqual(stats(b));
    expect(a.enemies).toHaveLength(6);
  });
  it('the authored spec object is never mutated', () => {
    const engine = makeEngine();
    const authored = { ...WALKER };
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: [authored], playerLevel: () => 1, mutators: () => ['glass-cannon', 'swarm'] });
    m.spawnForMap(99);
    expect(authored.health).toBe(30);
    expect(authored.damage).toBe(10);
    expect(authored.count).toBe(3);
  });
});

describe('Engine daily mutators (no run)', () => {
  it('outside a daily run there are no mutators and the effect is identity', () => {
    const engine = makeEngine();
    expect(engine.getDailyMutators()).toEqual([]);
    expect(engine.getDailyMutatorEffect()).toEqual({
      playerDamageTakenMult: 1, playerDamageDealtMult: 1, enemyDamageTakenMult: 1,
      spawnDensityMult: 1, lootChanceMult: 1, scoreMult: 1,
    });
  });
});
