/**
 * UPGRADE LOOP (new-game-plus phase): New Game+ / prestige run cycles.
 * - the NG+ table is well-formed (cycles 0..8, cycle 0 = identity,
 *   strictly increasing hp/damage/xp/loot with cycle)
 * - ngPlusByCycle guards + clamps (unknown/negative/NaN -> 0, above -> last)
 * - applyNgPlusScaling: exact per-table math, deterministic
 * - EnemyManager.spawnOne wiring: stats scale per cycle additively on top
 *   of the level bands AND difficulty, authored spec never mutated, same
 *   (seed, cycle) -> identical encounters, positions/kinds cycle-invariant
 * - Profile: ngPlusCycle persisted + migrated (invalid -> 0)
 * - HUD: setNgPlus chip (hidden at 0, cached repeat calls) + showEnd NG+
 *   offer button (absent without an offer, so the old RESTART/TITLE row
 *   contract is unchanged)
 * - Engine.enterNgPlus guard: refused outside a completed run
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const listeners: Record<string, Function[]> = {};
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '', width: 0, height: 0,
      appendChild(c: any) { el.children.push(c); if (c && typeof c === 'object') c.parent = el; return c; },
      append(...cs: any[]) { for (const c of cs) { el.children.push(c); if (c && typeof c === 'object') c.parent = el; } },
      remove() {
        el.removed = true;
        const p = (el as any).parent;
        if (p && Array.isArray(p.children)) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
      },
      setAttribute() {}, getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener(t: string, fn: Function) { (listeners[t] ??= []).push(fn); },
      removeEventListener() {},
      querySelector() { return makeEl(); }, querySelectorAll() { return []; },
      getContext: () => ({ createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
      __fire(t: string, e: any = {}) { (listeners[t] ?? []).forEach((fn) => fn(e)); },
      __listeners: listeners,
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
import { HUD } from '../src/engine/game/HUD';
import {
  NG_PLUS_TABLE,
  MAX_NG_PLUS_CYCLE,
  ngPlusByCycle,
  applyNgPlusScaling,
} from '../src/engine/game/newGamePlus';
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

function makeManager(engine: Engine, ngPlus: () => number) {
  return new EnemyManager(engine, null, {}, {
    pois: POIS, specs: [{ ...WALKER }], playerLevel: () => 1,
    difficulty: () => 'normal', ngPlus,
  });
}

const statsOf = (m: EnemyManager) =>
  m.enemies.map((e) => ({ hp: e.maxHealth, dmg: e.spec.damage, xp: e.xpMult }));

describe('NG+ table', () => {
  it('has cycles 0..8, cycle 0 is the identity row', () => {
    expect(NG_PLUS_TABLE.map((d) => d.cycle)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(MAX_NG_PLUS_CYCLE).toBe(8);
    const base = ngPlusByCycle(0);
    expect(base.enemyHpMult).toBe(1);
    expect(base.enemyDmgMult).toBe(1);
    expect(base.enemyXpMult).toBe(1);
    expect(base.lootChanceMult).toBe(1);
  });
  it('multipliers strictly increase with cycle on every axis', () => {
    for (let c = 1; c < NG_PLUS_TABLE.length; c++) {
      const prev = NG_PLUS_TABLE[c - 1];
      const cur = NG_PLUS_TABLE[c];
      expect(cur.enemyHpMult).toBeGreaterThan(prev.enemyHpMult);
      expect(cur.enemyDmgMult).toBeGreaterThan(prev.enemyDmgMult);
      expect(cur.enemyXpMult).toBeGreaterThan(prev.enemyXpMult);
      expect(cur.lootChanceMult).toBeGreaterThan(prev.lootChanceMult);
    }
  });
  it('ngPlusByCycle guards and clamps, never throws', () => {
    expect(ngPlusByCycle('bogus').cycle).toBe(0);
    expect(ngPlusByCycle(undefined).cycle).toBe(0);
    expect(ngPlusByCycle(NaN).cycle).toBe(0);
    expect(ngPlusByCycle(-3).cycle).toBe(0);
    expect(ngPlusByCycle(2.7).cycle).toBe(2);
    expect(ngPlusByCycle(99).cycle).toBe(8);
    expect(ngPlusByCycle(1).label).toBe('NG+ 1');
  });
  it('applyNgPlusScaling is exact per-table math', () => {
    const r = applyNgPlusScaling(30, 10, 1, 1, ngPlusByCycle(1));
    expect(r).toEqual({ health: 37.5, damage: 11.5, xpMult: 1.25, lootChanceMult: 1.15 });
    const r2 = applyNgPlusScaling(30, 10, 2, 0.85, ngPlusByCycle(2));
    expect(r2).toEqual({ health: 46.5, damage: 13, xpMult: 3, lootChanceMult: 1.105 });
    // cycle 0 is the identity, including on an already difficulty-scaled chance
    expect(applyNgPlusScaling(30, 10, 1, 0.85, ngPlusByCycle(0))).toEqual(
      { health: 30, damage: 10, xpMult: 1, lootChanceMult: 0.85 });
  });
});

describe('spawn wiring (band -> difficulty -> NG+)', () => {
  it('cycle 0 is byte-identical to a manager without the ngPlus opt', () => {
    const engine = makeEngine();
    const withOpt = makeManager(engine, () => 0);
    const noOpt = new EnemyManager(engine, null, {}, {
      pois: POIS, specs: [{ ...WALKER }], playerLevel: () => 1, difficulty: () => 'normal',
    });
    withOpt.spawnForMap(4242);
    noOpt.spawnForMap(4242);
    expect(statsOf(withOpt)).toEqual(statsOf(noOpt));
  });
  it('NG+1 and NG+2 scale exactly per table on a band-0 / normal roster', () => {
    const engine = makeEngine();
    const ng1 = makeManager(engine, () => 1);
    const ng2 = makeManager(engine, () => 2);
    ng1.spawnForMap(777);
    ng2.spawnForMap(777);
    // level 1 = band 0 (mults 1.0, variance 0), normal difficulty = identity
    for (const e of statsOf(ng1)) {
      expect(e.hp).toBe(30 * 1.25);
      expect(e.dmg).toBe(10 * 1.15);
      expect(e.xp).toBe(1.25);
    }
    for (const e of statsOf(ng2)) {
      expect(e.hp).toBe(30 * 1.55);
      expect(e.dmg).toBe(10 * 1.3);
      expect(e.xp).toBe(1.5);
    }
  });
  it('same (seed, cycle) twice -> identical encounters', () => {
    const engine = makeEngine();
    const a = makeManager(engine, () => 2);
    const b = makeManager(engine, () => 2);
    a.spawnForMap(777);
    b.spawnForMap(777);
    expect(statsOf(a)).toEqual(statsOf(b));
  });
  it('the authored spec object is never mutated', () => {
    const engine = makeEngine();
    const authored = { ...WALKER };
    const m = new EnemyManager(engine, null, {}, {
      pois: POIS, specs: [authored], playerLevel: () => 1,
      difficulty: () => 'normal', ngPlus: () => 3,
    });
    m.spawnForMap(99);
    expect(authored.health).toBe(30);
    expect(authored.damage).toBe(10);
  });
  it('positions/kinds are identical across cycles (only stats move)', () => {
    const engine = makeEngine();
    const c0 = makeManager(engine, () => 0);
    const c2 = makeManager(engine, () => 2);
    c0.spawnForMap(555);
    c2.spawnForMap(555);
    const pos = (m: EnemyManager) => m.enemies.map((e) => [e.position.x, e.position.z, e.spec.kind]);
    expect(pos(c0)).toEqual(pos(c2));
  });
});

describe('profile cycle', () => {
  it('defaults to 0; migrate guards invalid values and clamps negatives', () => {
    expect(defaultProfile().ngPlusCycle).toBe(0);
    expect(migrateProfile({ ngPlusCycle: 3 }).ngPlusCycle).toBe(3);
    expect(migrateProfile({ ngPlusCycle: 'bogus' }).ngPlusCycle).toBe(0);
    expect(migrateProfile({ ngPlusCycle: -2 }).ngPlusCycle).toBe(0);
    expect(migrateProfile({}).ngPlusCycle).toBe(0);
  });
  it('save/load round-trips the cycle with the rest of the profile', () => {
    const store: Record<string, string> = {};
    _setProfileStorage({
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
    const p = loadProfile();
    p.ngPlusCycle = 2;
    p.merit = 50;
    p.owned = ['vitality'];
    p.loadout = ['vitality'];
    saveProfile(p);
    const reloaded = loadProfile();
    expect(reloaded.ngPlusCycle).toBe(2);
    expect(reloaded.merit).toBe(50);
    expect(reloaded.loadout).toEqual(['vitality']);
  });
});

describe('HUD NG+ chip + end-screen offer', () => {
  const hudSpec = () => ({ meta: { name: 'Test' }, objective: { description: 'Do it' } }) as unknown as GameSpec;
  function makeHud() {
    const container = makeEl();
    const hud = new HUD(container, hudSpec());
    return { hud, root: (hud as any).root };
  }
  it('setNgPlus hides at 0, shows NG+ N above 0, repeat calls no-op', () => {
    const { hud } = makeHud();
    const chip = (hud as any).ngplusEl;
    hud.setNgPlus(0);
    expect(chip.style.display).toBe('none');
    expect(chip.textContent).toBe('');
    hud.setNgPlus(2);
    expect(chip.style.display).toBe('');
    expect(chip.textContent).toBe('NG+ 2');
    chip.textContent = 'TAMPERED';
    hud.setNgPlus(2); // same cycle -> cached, no rewrite
    expect(chip.textContent).toBe('TAMPERED');
    hud.setNgPlus(3);
    expect(chip.textContent).toBe('NG+ 3');
  });
  it('showEnd without an offer renders exactly RESTART/TITLE', () => {
    const { hud, root } = makeHud();
    hud.showEnd(true, { score: 100, time: 60, kills: 5, level: 3, stagesCleared: 2 });
    const ov = root.children.find((c: any) => typeof c.className === 'string' && c.className.includes('overlay'));
    const btnWrap = ov.children[ov.children.length - 1];
    expect(btnWrap.children.map((b: any) => b.textContent)).toEqual(['RESTART', 'TITLE']);
  });
  it('showEnd with an offer appends NEW GAME+ N and fires onEnter', () => {
    const { hud, root } = makeHud();
    let entered = 0;
    hud.showEnd(true, { score: 100, time: 60, kills: 5, level: 3, stagesCleared: 2 }, undefined,
      { targetCycle: 3, onEnter: () => { entered++; } });
    const ov = root.children.find((c: any) => typeof c.className === 'string' && c.className.includes('overlay'));
    const btnWrap = ov.children[ov.children.length - 1];
    expect(btnWrap.children.map((b: any) => b.textContent)).toEqual(['RESTART', 'TITLE', 'NEW GAME+ 3']);
    const ng = btnWrap.children[2];
    expect(ng.className).toBe('ngplus-btn');
    ng.__fire('click');
    expect(entered).toBe(1);
  });
});

describe('Engine.enterNgPlus guard', () => {
  function mapStore() {
    const store: Record<string, string> = {};
    _setProfileStorage({
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  }
  it('refuses outside a completed run and leaves the profile untouched', () => {
    mapStore();
    const engine = makeEngine();
    const p = loadProfile();
    p.ngPlusCycle = 1;
    saveProfile(p);
    (engine as any).state = 'playing';
    expect(engine.enterNgPlus()).toEqual({ ok: false, reason: 'no completed run' });
    expect(loadProfile().ngPlusCycle).toBe(1);
  });
  it('getNgPlusCycle reads the live profile, 0 on garbage', () => {
    mapStore();
    const engine = makeEngine();
    expect(engine.getNgPlusCycle()).toBe(0);
    const p = loadProfile();
    p.ngPlusCycle = 4;
    saveProfile(p);
    expect(engine.getNgPlusCycle()).toBe(4);
  });
});
