/**
 * UPGRADE LOOP (difficulty-modes phase): data-driven difficulty modes
 * (story / normal / hard).
 * - the difficulty table is well-formed (3 modes, normal = identity,
 *   story easier, hard harder)
 * - applyDifficultyScaling: exact per-table math, deterministic
 * - EnemyManager.spawnOne wiring: stats scale per difficulty additively on
 *   top of the level bands, authored spec never mutated, same
 *   (seed, difficulty) -> identical encounters
 * - rollLoot chanceMult: m=1 byte-identical, deterministic, m=0 -> no
 *   drops, huge m -> always a drop
 * - Profile: difficulty persisted + migrated (invalid -> 'normal')
 * - Engine.getDifficultyMode / setDifficultyMode / inCombat: combat locks
 *   changes, non-combat changes persist
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
import { Rng } from '../src/engine/core/Rng';
import { rollLoot } from '../src/engine/game/loot';
import {
  DIFFICULTY_TABLE,
  DIFFICULTY_IDS,
  difficultyById,
  isDifficultyId,
  applyDifficultyScaling,
  type DifficultyId,
} from '../src/engine/game/difficulty';
import {
  defaultProfile,
  migrateProfile,
  loadProfile,
  saveProfile,
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
  _setProfileStorage(undefined); // back to the real (mocked) localStorage
});

const WALKER: EnemySpec = { kind: 'walker', count: 3, health: 30, speed: 4, damage: 10, weapon: 'melee' };
const POIS = [{ x: 0, z: 0, r: 0 }];

function makeManager(engine: Engine, difficulty: () => DifficultyId) {
  return new EnemyManager(engine, null, {}, { pois: POIS, specs: [{ ...WALKER }], playerLevel: () => 1, difficulty });
}

const statsOf = (m: EnemyManager) =>
  m.enemies.map((e) => ({ hp: e.maxHealth, dmg: e.spec.damage, xp: e.xpMult }));

describe('difficulty table', () => {
  it('has exactly story / normal / hard, unique ids', () => {
    expect(DIFFICULTY_IDS).toEqual(['story', 'normal', 'hard']);
    expect(DIFFICULTY_TABLE.map((d) => d.id)).toEqual(['story', 'normal', 'hard']);
  });
  it('normal is the identity mode (all multipliers 1.0)', () => {
    const n = difficultyById('normal');
    expect(n.enemyHpMult).toBe(1);
    expect(n.enemyDmgMult).toBe(1);
    expect(n.enemyXpMult).toBe(1);
    expect(n.lootChanceMult).toBe(1);
    expect(n.playerDamageTakenMult).toBe(1);
  });
  it('story is easier on every axis', () => {
    const s = difficultyById('story');
    expect(s.enemyHpMult).toBeLessThan(1);
    expect(s.enemyDmgMult).toBeLessThan(1);
    expect(s.playerDamageTakenMult).toBeLessThan(1);
    expect(s.lootChanceMult).toBeGreaterThan(1); // more generous drops
  });
  it('hard is harder on every axis (loot leaner, XP faster)', () => {
    const h = difficultyById('hard');
    expect(h.enemyHpMult).toBeGreaterThan(1);
    expect(h.enemyDmgMult).toBeGreaterThan(1);
    expect(h.playerDamageTakenMult).toBeGreaterThan(1);
    expect(h.enemyXpMult).toBeGreaterThan(1);
    expect(h.lootChanceMult).toBeLessThan(1);
  });
  it('difficultyById falls back to normal for unknown ids; isDifficultyId guards storage input', () => {
    expect(difficultyById('bogus').id).toBe('normal');
    expect(difficultyById(undefined).id).toBe('normal');
    expect(isDifficultyId('story')).toBe(true);
    expect(isDifficultyId('normal')).toBe(true);
    expect(isDifficultyId('hard')).toBe(true);
    expect(isDifficultyId('easy')).toBe(false);
    expect(isDifficultyId(null)).toBe(false);
    expect(isDifficultyId(42)).toBe(false);
  });
});

describe('applyDifficultyScaling', () => {
  it('applies the exact per-table math (damage folds enemyDmgMult * playerDamageTakenMult)', () => {
    const hard = difficultyById('hard');
    const out = applyDifficultyScaling(30, 10, 1.25, hard);
    expect(out.health).toBeCloseTo(30 * 1.5, 10);
    expect(out.damage).toBeCloseTo(10 * 1.4 * 1.3, 10);
    expect(out.xpMult).toBeCloseTo(1.25 * 1.25, 10);
  });
  it('story math', () => {
    const out = applyDifficultyScaling(30, 10, 1.0, difficultyById('story'));
    expect(out.health).toBeCloseTo(21, 10);
    expect(out.damage).toBeCloseTo(10 * 0.6 * 0.6, 10);
    expect(out.xpMult).toBe(1);
  });
  it('normal is identity', () => {
    const out = applyDifficultyScaling(30, 10, 1.1, difficultyById('normal'));
    expect(out).toEqual({ health: 30, damage: 10, xpMult: 1.1 });
  });
  it('deterministic: same inputs -> same outputs', () => {
    const a = applyDifficultyScaling(30, 10, 1, difficultyById('hard'));
    const b = applyDifficultyScaling(30, 10, 1, difficultyById('hard'));
    expect(a).toEqual(b);
  });
});

describe('EnemyManager difficulty wiring', () => {
  it('story vs hard on the same seed: exact stat bands per the table (level 1 = band 0, variance 0)', () => {
    const engine = makeEngine();
    const story = makeManager(engine, () => 'story');
    const hard = makeManager(engine, () => 'hard');
    story.spawnForMap(12345);
    hard.spawnForMap(12345);
    const s = statsOf(story), h = statsOf(hard);
    expect(s).toHaveLength(3);
    expect(h).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      // story: hp 30*0.7=21, dmg 10*0.6*0.6=3.6, xp 1*1=1
      expect(s[i].hp).toBeCloseTo(21, 10);
      expect(s[i].dmg).toBeCloseTo(3.6, 10);
      expect(s[i].xp).toBeCloseTo(1, 10);
      // hard: hp 30*1.5=45, dmg 10*1.4*1.3=18.2, xp 1*1.25=1.25
      expect(h[i].hp).toBeCloseTo(45, 10);
      expect(h[i].dmg).toBeCloseTo(18.2, 10);
      expect(h[i].xp).toBeCloseTo(1.25, 10);
      // exact inter-mode ratios per the table
      expect(h[i].hp / s[i].hp).toBeCloseTo(1.5 / 0.7, 10);
      expect(h[i].dmg / s[i].dmg).toBeCloseTo((1.4 * 1.3) / (0.6 * 0.6), 10);
      expect(h[i].xp / s[i].xp).toBeCloseTo(1.25, 10);
    }
  });
  it('same (seed, difficulty) twice -> identical encounters', () => {
    const engine = makeEngine();
    const a = makeManager(engine, () => 'hard');
    const b = makeManager(engine, () => 'hard');
    a.spawnForMap(777);
    b.spawnForMap(777);
    expect(statsOf(a)).toEqual(statsOf(b));
  });
  it('normal mode is byte-identical to a manager without the difficulty opt', () => {
    const engine = makeEngine();
    const withOpt = makeManager(engine, () => 'normal');
    const noOpt = new EnemyManager(engine, null, {}, { pois: POIS, specs: [{ ...WALKER }], playerLevel: () => 1 });
    withOpt.spawnForMap(4242);
    noOpt.spawnForMap(4242);
    expect(statsOf(withOpt)).toEqual(statsOf(noOpt));
  });
  it('the authored spec object is never mutated', () => {
    const engine = makeEngine();
    const authored = { ...WALKER };
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: [authored], playerLevel: () => 1, difficulty: () => 'hard' });
    m.spawnForMap(99);
    expect(authored.health).toBe(30);
    expect(authored.damage).toBe(10);
  });
  it('positions/kinds are identical across difficulties (only stats move)', () => {
    const engine = makeEngine();
    const story = makeManager(engine, () => 'story');
    const hard = makeManager(engine, () => 'hard');
    story.spawnForMap(555);
    hard.spawnForMap(555);
    const pos = (m: EnemyManager) => m.enemies.map((e) => [e.position.x, e.position.z, e.spec.kind]);
    expect(pos(story)).toEqual(pos(hard));
  });
  it('anyHostile: false on a fresh idle roster, true once an enemy is hostile', () => {
    const engine = makeEngine();
    const m = makeManager(engine, () => 'normal');
    expect(m.anyHostile()).toBe(false);
    m.spawnForMap(31337);
    expect(m.anyHostile()).toBe(false);
    (m.enemies[0] as any).state = 'chase';
    expect(m.anyHostile()).toBe(true);
    m.despawnAll();
    expect(m.anyHostile()).toBe(false);
  });
});

describe('rollLoot chanceMult', () => {
  // Merge note (difficulty-modes x world-tiers): rollLoot's signature is
  // (rng, kind, isBoss, tier, chanceMult) — these calls pin tier = 1 so the
  // 4th-position value exercises chanceMult exactly as the branch wrote it.
  it('chanceMult = 1 is byte-identical to the default call', () => {
    const run = (m: number | undefined) => {
      const rng = new Rng(20261021);
      return Array.from({ length: 40 }, () => JSON.stringify(rollLoot(rng, 'walker', false, 1, m as number)));
    };
    expect(run(1)).toEqual(run(undefined));
  });
  it('deterministic: same (rng seed, chanceMult) -> same drops', () => {
    const run = (m: number) => {
      const rng = new Rng(31337);
      return Array.from({ length: 30 }, () => JSON.stringify(rollLoot(rng, 'brute', false, 1, m)));
    };
    expect(run(1.3)).toEqual(run(1.3));
    expect(run(0.85)).toEqual(run(0.85));
  });
  it('chanceMult = 0 -> never a drop; huge mult -> always a drop', () => {
    const rng0 = new Rng(99);
    let zeroDrops = 0;
    for (let i = 0; i < 50; i++) zeroDrops += rollLoot(rng0, 'walker', false, 1, 0).length;
    expect(zeroDrops).toBe(0);
    const rngH = new Rng(99);
    for (let i = 0; i < 50; i++) {
      expect(rollLoot(rngH, 'walker', false, 1, 1e9).length).toBeGreaterThan(0);
    }
  });
});

describe('Profile difficulty persistence', () => {
  it('defaultProfile is normal; migrate keeps valid, resets invalid', () => {
    expect(defaultProfile().difficulty).toBe('normal');
    expect(migrateProfile({ difficulty: 'hard' }).difficulty).toBe('hard');
    expect(migrateProfile({ difficulty: 'easy' }).difficulty).toBe('normal');
    expect(migrateProfile({}).difficulty).toBe('normal');
    expect(migrateProfile(null).difficulty).toBe('normal');
  });
  it('saveProfile/loadProfile round-trips the difficulty', () => {
    const mem = new Map<string, string>();
    _setProfileStorage({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); } });
    const p = loadProfile();
    expect(p.difficulty).toBe('normal');
    p.difficulty = 'hard';
    saveProfile(p);
    expect(loadProfile().difficulty).toBe('hard');
    _setProfileStorage(undefined);
  });
});

describe('Engine difficulty accessors', () => {
  it('getDifficultyMode reads the profile, defaults to normal', () => {
    expect(Engine.prototype.getDifficultyMode.call({})).toBe('normal');
  });
  it('setDifficultyMode persists when not in combat; refuses in combat', () => {
    const mem = new Map<string, string>();
    _setProfileStorage({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); } });
    const peaceful = { inCombat: () => false };
    const res = Engine.prototype.setDifficultyMode.call(peaceful, 'hard');
    expect(res).toEqual({ ok: true });
    expect(Engine.prototype.getDifficultyMode.call({})).toBe('hard');
    const fighting = { inCombat: () => true };
    const refused = Engine.prototype.setDifficultyMode.call(fighting, 'story');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/combat/);
    expect(Engine.prototype.getDifficultyMode.call({})).toBe('hard'); // unchanged
    const bad = Engine.prototype.setDifficultyMode.call(peaceful, 'easy' as DifficultyId);
    expect(bad.ok).toBe(false);
    _setProfileStorage(undefined);
  });
  it('inCombat reads the enemies system; false when absent or peaceful', () => {
    const none = { portalEntities: { byId: () => undefined } };
    expect(Engine.prototype.inCombat.call(none)).toBe(false);
    const peaceful = { portalEntities: { byId: (id: string) => (id === 'enemies' ? { anyHostile: () => false } : undefined) } };
    expect(Engine.prototype.inCombat.call(peaceful)).toBe(false);
    const fighting = { portalEntities: { byId: (id: string) => (id === 'enemies' ? { anyHostile: () => true } : undefined) } };
    expect(Engine.prototype.inCombat.call(fighting)).toBe(true);
  });
});
