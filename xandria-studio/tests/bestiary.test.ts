/**
 * bestiary.test.ts — bestiary / enemy codex wave.
 *
 * - Registry: data-driven defs over the existing enemy kinds (no new art,
 *   no behavior defs invented beyond the presentation layer).
 * - Tier thresholds: defaults + spec overrides + clamps.
 * - BestiaryManager: onKill unlock/tier flow (observe-only, hook-driven),
 *   boss kills aggregate under 'boss', disabled no-op, unknown-kind
 *   no-op, profile persistence, portal snapshot/restore round-trip.
 * - Loot surface: codex tables derive from the same DROP_TABLES the
 *   roller uses; unknown kinds fall back like rollLoot.
 * - Determinism: same kill sequence -> same counts/events, no RNG.
 * - BestiaryPanel: show/hide/chip/keys/modal-block, locked vs unlocked
 *   cards, weakness + loot rows (fake DOM, the skills-panel pattern).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Engine } from '../src/engine/Engine';
import type { EnemyKind } from '../src/spec/schema';
import { lootItemDefs } from '../src/engine/game/loot';
import {
  BestiaryManager,
  BESTIARY_DEFS,
  BESTIARY_TIER_NAMES,
  BESTIARY_BOSS_ID,
  tierForKills,
  resolveBestiaryTiers,
  resolveBestiaryEnabled,
} from '../src/engine/game/bestiary';
import {
  lootTableForBestiary,
  bossLootForBestiary,
} from '../src/engine/game/loot';
import { _setProfileStorage } from '../src/engine/game/Profile';
import { BestiaryPanel } from '../src/engine/ui/BestiaryPanel';

// ---------------------------------------------------------------- fakes

function fakeEngine(customBestiary?: Record<string, unknown>): Engine {
  const taps = new Map<string, Array<(p: unknown) => void>>();
  return {
    spec: { custom: customBestiary ? { bestiary: customBestiary } : {} },
    audio: { play(_id: string) {} },
    hooks: {
      tap: (name: string, fn: (p: unknown) => void) => {
        const arr = taps.get(name) ?? [];
        arr.push(fn);
        taps.set(name, arr);
        return () => {
          taps.set(name, (taps.get(name) ?? []).filter((f) => f !== fn));
        };
      },
      emit: (name: string, payload: unknown) => {
        for (const fn of taps.get(name) ?? []) fn(payload);
      },
    },
  } as unknown as Engine;
}

function killOf(kind: EnemyKind, isBoss = false) {
  return { isBoss, spec: { kind } };
}

function memStorage(): Map<string, string> {
  const m = new Map<string, string>();
  _setProfileStorage({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } });
  return m;
}

// ---------------------------------------------------------------- registry

describe('bestiary registry', () => {
  it('covers the five combat kinds plus the boss aggregator', () => {
    const ids = BESTIARY_DEFS.map((d) => d.id);
    expect(ids).toEqual(['walker', 'brute', 'drone', 'flyer', 'turret', BESTIARY_BOSS_ID]);
    expect(BESTIARY_BOSS_ID).toBe('boss');
  });

  it('every entry has display metadata and weakness notes', () => {
    for (const d of BESTIARY_DEFS) {
      expect(d.name.length, `${d.id} name`).toBeGreaterThan(0);
      expect(d.lore.length, `${d.id} lore`).toBeGreaterThan(0);
      expect(d.weaknesses.length, `${d.id} weaknesses`).toBeGreaterThanOrEqual(2);
      expect(['walker', 'brute', 'drone', 'flyer', 'turret', 'boss']).toContain(d.silhouette);
    }
  });

  it('tier names are stable', () => {
    expect(BESTIARY_TIER_NAMES).toEqual(['LOCKED', 'SEEN', 'STUDIED', 'MASTERED']);
  });
});

// ---------------------------------------------------------------- tiers

describe('tier thresholds', () => {
  it('default 1/10/50 boundaries', () => {
    const t = resolveBestiaryTiers({ custom: {} });
    expect(t).toEqual({ seen: 1, studied: 10, mastered: 50 });
    expect(tierForKills(0, t)).toBe(0);
    expect(tierForKills(1, t)).toBe(1);
    expect(tierForKills(9, t)).toBe(1);
    expect(tierForKills(10, t)).toBe(2);
    expect(tierForKills(49, t)).toBe(2);
    expect(tierForKills(50, t)).toBe(3);
    expect(tierForKills(5000, t)).toBe(3);
  });

  it('spec overrides studied/mastered; seen stays 1', () => {
    const t = resolveBestiaryTiers({ custom: { bestiary: { tierThresholds: { studied: 2, mastered: 3 } } } });
    expect(t).toEqual({ seen: 1, studied: 2, mastered: 3 });
    expect(tierForKills(1, t)).toBe(1);
    expect(tierForKills(2, t)).toBe(2);
    expect(tierForKills(3, t)).toBe(3);
  });

  it('clamps garbage thresholds; seen never overridable', () => {
    const t = resolveBestiaryTiers({ custom: { bestiary: { tierThresholds: { studied: 0, mastered: 1e12 } } } });
    expect(t.seen).toBe(1);
    expect(t.studied).toBe(2);
    expect(t.mastered).toBe(10000);
  });

  it('resolveBestiaryEnabled defaults true, honors explicit false', () => {
    expect(resolveBestiaryEnabled({ custom: {} })).toBe(true);
    expect(resolveBestiaryEnabled({ custom: { bestiary: { enabled: false } } })).toBe(false);
    expect(resolveBestiaryEnabled({ custom: { bestiary: { enabled: true } } })).toBe(true);
  });
});

// ---------------------------------------------------------------- manager

describe('BestiaryManager', () => {
  beforeEach(() => {
    memStorage();
  });

  it('first kill unlocks SEEN and fires onUnlocked; counts accrue silently until the next tier', () => {
    const eng = fakeEngine();
    const ups: Array<[string, number, number]> = [];
    const m = new BestiaryManager(eng, { onUnlocked: (d, t, k) => ups.push([d.id, t, k]) });
    const e1 = m.onKill(killOf('walker'));
    expect(e1).toEqual({ id: 'walker', tier: 1, kills: 1 });
    expect(m.tierOf('walker')).toBe(1);
    expect(ups).toEqual([['walker', 1, 1]]);
    expect(m.killsToNext('walker')).toBe(9);

    for (let i = 0; i < 8; i++) expect(m.onKill(killOf('walker'))).toBeNull();
    expect(ups).toHaveLength(1);
    const up = m.onKill(killOf('walker'));
    expect(up).toEqual({ id: 'walker', tier: 2, kills: 10 });
    expect(ups).toEqual([['walker', 1, 1], ['walker', 2, 10]]);
    expect(m.killsToNext('walker')).toBe(40);

    for (let i = 0; i < 39; i++) m.onKill(killOf('walker'));
    const up3 = m.onKill(killOf('walker'));
    expect(up3).toEqual({ id: 'walker', tier: 3, kills: 50 });
    expect(m.tierOf('walker')).toBe(3);
    expect(m.killsToNext('walker')).toBeNull();
    expect(m.countOf('walker')).toBe(50);
  });

  it('boss kills aggregate under the boss entry, never under their base kind', () => {
    const m = new BestiaryManager(fakeEngine());
    const e = m.onKill(killOf('brute', true));
    expect(e).toEqual({ id: 'boss', tier: 1, kills: 1 });
    expect(m.countOf('boss')).toBe(1);
    expect(m.countOf('brute')).toBe(0);
    expect(m.tierOf('boss')).toBe(1);
  });

  it('kinds are tracked independently', () => {
    const m = new BestiaryManager(fakeEngine());
    m.onKill(killOf('drone'));
    m.onKill(killOf('flyer'));
    m.onKill(killOf('flyer'));
    expect(m.tierOf('drone')).toBe(1);
    expect(m.tierOf('flyer')).toBe(1);
    expect(m.tierOf('walker')).toBe(0);
    expect(m.countOf('turret')).toBe(0);
  });

  it('disabled manager no-ops and never taps onKill', () => {
    const m = new BestiaryManager(fakeEngine({ enabled: false }));
    expect(m.enabled).toBe(false);
    expect(m.onKill(killOf('walker'))).toBeNull();
    expect(m.countOf('walker')).toBe(0);
  });

  it('unknown kinds are ignored', () => {
    const m = new BestiaryManager(fakeEngine());
    expect(m.onKill({ isBoss: false, spec: { kind: 'stalker' as EnemyKind } })).toBeNull();
    expect(m.countOf('stalker')).toBe(0);
  });

  it('the hook path feeds the same onKill (observe-only integration)', () => {
    const eng = fakeEngine();
    const m = new BestiaryManager(eng);
    (eng.hooks as { emit(n: string, p: unknown): void }).emit('onKill', { enemy: killOf('turret') });
    expect(m.countOf('turret')).toBe(1);
    expect(m.tierOf('turret')).toBe(1);
    m.dispose();
  });

  it('counts persist to the profile and restore in a new manager', () => {
    const store = memStorage();
    const m1 = new BestiaryManager(fakeEngine());
    m1.onKill(killOf('walker'));
    m1.onKill(killOf('walker'));
    m1.onKill(killOf('drone'));
    const raw = store.get('xandria.profile.v1');
    expect(raw, 'profile written on unlock').toBeTruthy();
    const saved = JSON.parse(raw!).bestiaryKills;
    expect(saved).toEqual({ walker: 2, drone: 1 });

    const m2 = new BestiaryManager(fakeEngine());
    expect(m2.countOf('walker')).toBe(2);
    expect(m2.countOf('drone')).toBe(1);
    expect(m2.tierOf('walker')).toBe(1);
  });

  it('kills after the last tier transition persist (no silent count loss)', () => {
    // Regression: the manager used to persist only on tier transitions, so
    // e2e saw 4 kills restore as 3 after reload.
    const store = memStorage();
    const eng = fakeEngine({ tierThresholds: { studied: 2, mastered: 3 } });
    const m1 = new BestiaryManager(eng);
    for (let k = 0; k < 4; k++) m1.onKill(killOf('walker'));
    expect(m1.countOf('walker')).toBe(4);
    expect(m1.tierOf('walker')).toBe(3);
    const saved = JSON.parse(store.get('xandria.profile.v1')!).bestiaryKills;
    expect(saved).toEqual({ walker: 4 });

    const m2 = new BestiaryManager(fakeEngine({ tierThresholds: { studied: 2, mastered: 3 } }));
    expect(m2.countOf('walker')).toBe(4);
    expect(m2.tierOf('walker')).toBe(3);
  });

  it('portalSnapshot / portalRestore round-trips; corrupt input clamps', () => {
    const m = new BestiaryManager(fakeEngine());
    m.onKill(killOf('walker'));
    m.onKill(killOf('brute'));
    const snap = m.portalSnapshot();
    expect(snap).toEqual({ counts: { walker: 1, brute: 1 } });

    const m2 = new BestiaryManager(fakeEngine());
    m2.portalRestore(snap);
    expect(m2.countOf('walker')).toBe(1);
    expect(m2.countOf('brute')).toBe(1);

    m2.portalRestore({ counts: { walker: 'x', brute: NaN, drone: -5 } } as unknown as { counts: Record<string, number> });
    expect(m2.countOf('walker')).toBe(0);
    expect(m2.countOf('brute')).toBe(0);
    m2.portalRestore(null);
    expect(m2.countOf('drone')).toBe(0);
  });

  it('same kill sequence twice -> identical counts (no RNG)', () => {
    const run = () => {
      memStorage();
      const m = new BestiaryManager(fakeEngine());
      const seq: Array<'walker' | 'brute' | 'drone'> = ['walker', 'brute', 'walker', 'drone', 'walker'];
      for (const k of seq) m.onKill(killOf(k));
      return m.portalSnapshot();
    };
    expect(run()).toEqual(run());
  });

  it('custom thresholds drive tiers end to end', () => {
    const m = new BestiaryManager(fakeEngine({ tierThresholds: { studied: 2, mastered: 3 } }));
    expect(m.tierThresholds).toEqual({ seen: 1, studied: 2, mastered: 3 });
    m.onKill(killOf('walker'));
    expect(m.tierOf('walker')).toBe(1);
    m.onKill(killOf('walker'));
    expect(m.tierOf('walker')).toBe(2);
    m.onKill(killOf('walker'));
    expect(m.tierOf('walker')).toBe(3);
  });
});

// ---------------------------------------------------------------- loot surface

describe('bestiary loot surface', () => {
  it('codex tables expose every rolled entry with honest chances', () => {
    const t = lootTableForBestiary('walker');
    expect(t.materials.length).toBe(2);
    expect(t.gear.length).toBe(3);
    // same item set the roller draws from
    expect(t.materials.map((e) => e.itemId)).toContain('mat_ember_shard');
    expect(t.gear.map((e) => e.itemId)).toContain('loot_ironfang_blade');
    for (const e of [...t.materials, ...t.gear]) {
      expect(e.chancePct).toBeGreaterThan(0);
      expect(e.chancePct).toBeLessThan(100);
      expect(e.min).toBeGreaterThanOrEqual(1);
      expect(e.max).toBeGreaterThanOrEqual(e.min);
    }
    // walker table: nothing=20, weights 40+30+12+6+4 -> entry chances sum to 92/112
    const sum = [...t.materials, ...t.gear].reduce((s, e) => s + e.chancePct, 0);
    expect(sum).toBeCloseTo((92 / 112) * 100, 6);
  });

  it('unknown kinds fall back to the walker table, like rollLoot', () => {
    const a = lootTableForBestiary('stalker');
    const b = lootTableForBestiary('walker');
    expect(a).toEqual(b);
  });

  it('boss loot: guaranteed epic+ gear + two material rolls', () => {
    const b = bossLootForBestiary();
    expect(b.gear).toEqual(['loot_void_edge', 'loot_star_aegis']);
    expect(b.materialRolls).toBe(2);
  });
});

// ---------------------------------------------------------------- panel

function makeEl(tag = 'div'): any {
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as any,
    textContent: '',
    innerHTML: '',
    parentNode: null,
    _listeners: {} as Record<string, Array<(e: any) => void>>,
    appendChild(c: any) { c.parentNode = el; el.children.push(c); return c; },
    append(...cs: any[]) { for (const c of cs) el.appendChild(c); },
    remove() {
      if (el.parentNode) {
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
        el.parentNode = null;
      }
    },
    setAttribute() {},
    addEventListener(t: string, fn: (e: any) => void) { (el._listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: (e: any) => void) {
      el._listeners[t] = (el._listeners[t] ?? []).filter((f: (e: any) => void) => f !== fn);
    },
    click() { for (const fn of el._listeners['click'] ?? []) fn({}); },
  };
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] ?? null });
  return el;
}

function makeWindow(): any {
  return {
    _listeners: {} as Record<string, Array<(e: any) => void>>,
    addEventListener(t: string, fn: (e: any) => void) { (this._listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: (e: any) => void) {
      this._listeners[t] = (this._listeners[t] ?? []).filter((f: (e: any) => void) => f !== fn);
    },
    keydown(code: string, target?: any) {
      const e = { code, target, stopPropagation() {}, preventDefault() {} };
      for (const fn of this._listeners['keydown'] ?? []) fn(e);
      return e;
    },
  };
}

function texts(root: any): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (typeof n.textContent === 'string' && n.textContent) out.push(n.textContent);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

function makeHarness(mgr?: BestiaryManager, extra: Record<string, unknown> = {}) {
  const win = makeWindow();
  const doc: any = {
    createElement: (t: string) => makeEl(t),
    createTextNode: (t: string) => { const e = makeEl('#text'); e.textContent = t; return e; },
    defaultView: win,
  };
  const container = makeEl('div');
  const defs = lootItemDefs();
  const panel = new BestiaryPanel({
    container,
    doc,
    bestiary: () => mgr ?? null,
    defs: () => defs,
    ...extra,
  });
  return { panel, doc, win, container };
}

describe('BestiaryPanel', () => {
  beforeEach(() => {
    memStorage();
  });

  it('chip click toggles; shows locked entries and the unlock count', () => {
    const mgr = new BestiaryManager(fakeEngine());
    const { panel, container } = makeHarness(mgr);
    expect(panel.isOpen).toBe(false);
    const chip = container.children.find((c: any) => c.tag === 'button');
    chip.click();
    expect(panel.isOpen).toBe(true);
    const t = texts(container);
    expect(t).toContain('??? — unknown foe');
    expect(t).toContain('Defeat one to identify it.');
    expect(t.some((x) => x.includes('0 / 6 identified'))).toBe(true);
    chip.click();
    expect(panel.isOpen).toBe(false);
  });

  it('unlocked entries show name, tier badge, weaknesses, and honest loot rows', () => {
    const mgr = new BestiaryManager(fakeEngine());
    for (let i = 0; i < 10; i++) mgr.onKill(killOf('walker'));
    const { panel, container } = makeHarness(mgr);
    panel.show();
    const t = texts(container).join('\n');
    expect(t).toContain('Ashen Walker');
    expect(t).toContain('STUDIED');
    expect(t).toContain('Melee reach is short (2.2m)');
    expect(t).toContain('Ember Shard');
    expect(t).toContain('Ironfang Blade');
    expect(t).toContain('1 / 6 identified');
  });

  it('B opens, Esc closes; isModalOpen blocks B; typing guard respected', () => {
    const mgr = new BestiaryManager(fakeEngine());
    const { panel, win } = makeHarness(mgr);
    win.keydown('KeyB');
    expect(panel.isOpen).toBe(true);
    win.keydown('Escape');
    expect(panel.isOpen).toBe(false);

    const blocked = makeHarness(mgr, { isModalOpen: () => true });
    blocked.win.keydown('KeyB');
    expect(blocked.panel.isOpen).toBe(false);

    const { panel: p3, win: w3 } = makeHarness(mgr);
    w3.keydown('KeyB', { tagName: 'INPUT' });
    expect(p3.isOpen).toBe(false);
  });

  it('null manager renders the empty state', () => {
    const { panel, container } = makeHarness(undefined);
    panel.show();
    expect(texts(container)).toContain('No bestiary data in this scene.');
  });

  it('dispose removes the panel and chip', () => {
    const mgr = new BestiaryManager(fakeEngine());
    const { panel, container } = makeHarness(mgr);
    panel.dispose();
    expect(container.children).toHaveLength(0);
  });
});
