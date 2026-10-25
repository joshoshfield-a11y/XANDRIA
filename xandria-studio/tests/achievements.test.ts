/**
 * Achievements wave: unit tests.
 * - ACHIEVEMENT_DEFS: 25 defs, unique ids, valid triggers/rewards, all six
 *   categories covered, all tuning in the one table.
 * - AchievementManager: kill/craft/quest/portal/level/distance triggers,
 *   unlock fanfare (toast), rewards (XP via addXpEx, score via addScore),
 *   cross-run profile persistence, stale-id filtering, portal
 *   snapshot/restore round-trip + corrupt clamps, dispose, re-entrant
 *   reward level-ups, determinism (same events -> same unlocks).
 * - AchievementsPanel (fake DOM, crafting-panel.test.ts pattern):
 *   show/hide/toggle, chip, J/Esc keys, 25 cards with unlocked/locked
 *   states + progress bars, live refresh on unlock.
 * - Perf honesty: per-tick + evaluate() cost measured, not modeled.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Modding } from '../src/engine/game/Modding';
import type { Engine } from '../src/engine/Engine';
import {
  ACHIEVEMENT_DEFS,
  ACHIEVEMENT_IDS,
  achievementDef,
  AchievementManager,
  tappedHookNames,
  type AchievementManagerOpts,
} from '../src/engine/game/achievements';
import { AchievementsPanel } from '../src/engine/ui/AchievementsPanel';
import {
  loadProfile,
  _setProfileStorage,
} from '../src/engine/game/Profile';

// ---------------------------------------------------------------- fakes

function fakeHooks(): Modding {
  return new Modding({} as Engine);
}

interface FakeProg {
  level: number;
  xpGranted: number;
  levelUpCalls: number;
}

function fakeProg(level = 1): FakeProg {
  return { level, xpGranted: 0, levelUpCalls: 0 };
}

interface FakeQuests {
  defs: Array<{ id: string; side?: boolean }>;
  statuses: Record<string, string>;
  statusOf: (id: string) => string;
}

function fakeQuests(defs: Array<{ id: string; side?: boolean }> = []): FakeQuests {
  const statuses: Record<string, string> = Object.fromEntries(defs.map((d) => [d.id, 'available']));
  return {
    defs,
    statuses,
    statusOf: (id: string) => statuses[id] ?? 'unknown',
  };
}

interface Harness {
  mgr: AchievementManager;
  hooks: Modding;
  toasts: Array<{ msg: string; seconds?: number }>;
  prog: FakeProg;
  quests: FakeQuests;
  portalHooks: { onAfterTransition?: (ctx: any) => void | Promise<void> };
  pos: { x: number; y: number; z: number } | null;
  score: number;
  levelUpGains: unknown[];
  store: Map<string, string>;
}

/**
 * save-slots: profiles persist in the active slot of xandria.slots.v1.
 * Reads the active slot's profile back out of the injected storage.
 */
function activeSlotProfile(store: Map<string, string>): Record<string, any> {
  const st = JSON.parse(store.get('xandria.slots.v1')!);
  return (st.slots.find((s: any) => s.id === st.activeSlotId) ?? st.slots[0]).profile;
}

function makeHarness(overrides: Partial<{
  progLevel: number;
  questDefs: Array<{ id: string; side?: boolean }>;
  withPortals: boolean;
}> = {}): Harness {  const store = new Map<string, string>();
  _setProfileStorage({
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, v); },
  });
  const hooks = fakeHooks();
  const toasts: Harness['toasts'] = [];
  const prog = fakeProg(overrides.progLevel ?? 1);
  const quests = fakeQuests(overrides.questDefs ?? []);
  const portalHooks: Harness['portalHooks'] = {};
  const h: Harness = {
    mgr: null as unknown as AchievementManager,
    hooks, toasts, prog, quests, portalHooks,
    pos: { x: 0, y: 0, z: 0 },
    score: 0,
    levelUpGains: [],
    store,
  };
  const opts: AchievementManagerOpts = {
    hooks,
    toast: (msg, seconds) => { toasts.push({ msg, seconds }); },
    progression: () => h.prog as unknown as import('../src/engine/game/Progression').Progression,
    quests: () => h.quests as unknown as import('../src/engine/game/quests').QuestManager,
    portalHooks: () => (overrides.withPortals === false ? null : h.portalHooks as never),
    avatarPos: () => h.pos,
    addScore: (n) => { h.score += n; },
    onLevelUp: (gain) => { h.levelUpGains.push(gain); },
  };
  // progression stub: additive XP only, like the real addXpEx contract.
  // By default no level-ups; tests opt into the re-entrant path explicitly.
  (h.prog as unknown as { addXpEx: (n: number) => { leveled: boolean; gain: null } }).addXpEx =
    (n: number) => {
      h.prog.xpGranted += n;
      return { leveled: false, gain: null };
    };
  h.mgr = new AchievementManager(opts);
  return h;
}

afterEach(() => {
  _setProfileStorage(undefined);
});

/** Drive n ticks through the private per-tick handler (same path onTick uses). */
function ticks(h: Harness, n: number): void {
  const m = h.mgr as unknown as { handleTick(): void };
  for (let i = 0; i < n; i++) m.handleTick();
}

function kill(h: Harness, kind = 'walker', boss = false): void {
  h.hooks.emit('onKill', { enemy: { isBoss: boss, spec: { kind } } } as never);
}

// ---------------------------------------------------------------- defs

describe('ACHIEVEMENT_DEFS table', () => {
  it('has 15-25 defs with unique ids, names, descriptions', () => {
    expect(ACHIEVEMENT_DEFS.length).toBeGreaterThanOrEqual(15);
    expect(ACHIEVEMENT_DEFS.length).toBeLessThanOrEqual(25);
    const ids = ACHIEVEMENT_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of ACHIEVEMENT_DEFS) {
      expect(d.id.length).toBeGreaterThan(0);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it('covers kills, crafting, quests, portals, leveling, exploration', () => {
    const cats = new Set(ACHIEVEMENT_DEFS.map((d) => d.category));
    for (const c of ['kills', 'crafting', 'quests', 'portals', 'leveling', 'exploration']) {
      expect(cats.has(c as never), `category ${c}`).toBe(true);
    }
  });

  it('triggers are well-formed and rewards are non-negative', () => {
    for (const d of ACHIEVEMENT_DEFS) {
      const t = d.trigger;
      switch (t.kind) {
        case 'kills': case 'crafts': case 'quests': case 'portals': case 'maps':
          expect(t.count).toBeGreaterThan(0);
          break;
        case 'level': expect(t.level).toBeGreaterThan(1); break;
        case 'distance': expect(t.meters).toBeGreaterThan(0); break;
      }
      expect(d.reward.xp ?? 0).toBeGreaterThanOrEqual(0);
      expect(d.reward.score ?? 0).toBeGreaterThanOrEqual(0);
    }
  });

  it('achievementDef resolves ids; unknown ids are undefined', () => {
    expect(achievementDef('first-blood')?.name).toBe('First Blood');
    expect(achievementDef('nope')).toBeUndefined();
    expect(ACHIEVEMENT_IDS.has('wayfarer')).toBe(true);
  });

  it('only taps hooks that exist on the bus', () => {
    for (const name of tappedHookNames()) {
      const hooks = fakeHooks();
      expect(() => hooks.tap(name, () => {})).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------- kills

describe('kill triggers', () => {
  it('first kill unlocks First Blood: toast + XP + profile save', () => {
    const h = makeHarness();
    kill(h);
    expect(h.mgr.isUnlocked('first-blood')).toBe(true);
    expect(h.mgr.unlockedIds()).toEqual(['first-blood']);
    expect(h.toasts.length).toBe(1);
    expect(h.toasts[0].msg).toContain('First Blood');
    expect(h.prog.xpGranted).toBe(25);
    const saved = activeSlotProfile(h.store);
    expect(saved.achievements).toContain('first-blood');
  });

  it('10 kills unlock the Hunter tier (and First Blood), once each', () => {
    const h = makeHarness();
    for (let i = 0; i < 10; i++) kill(h);
    expect(h.mgr.isUnlocked('first-blood')).toBe(true);
    expect(h.mgr.isUnlocked('hunter-10')).toBe(true);
    expect(h.mgr.isUnlocked('slayer-50')).toBe(false);
    expect(h.toasts.length).toBe(2);
  });

  it('boss kills count separately for Giant Slayer', () => {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) kill(h, 'brute');
    expect(h.mgr.isUnlocked('giant-slayer')).toBe(false);
    kill(h, 'brute', true);
    expect(h.mgr.isUnlocked('giant-slayer')).toBe(true);
    expect(h.mgr.debugCounters().bossKills).toBe(1);
  });

  it('kind-specific trigger: 25 drones unlock Bug Zapper, walkers do not', () => {
    const h = makeHarness();
    for (let i = 0; i < 30; i++) kill(h, 'walker');
    expect(h.mgr.isUnlocked('bug-zapper')).toBe(false);
    for (let i = 0; i < 25; i++) kill(h, 'drone');
    expect(h.mgr.isUnlocked('bug-zapper')).toBe(true);
  });

  it('score rewards land via addScore', () => {
    const h = makeHarness();
    for (let i = 0; i < 50; i++) kill(h);
    expect(h.mgr.isUnlocked('slayer-50')).toBe(true);
    expect(h.score).toBe(50); // slayer-50 reward.score
  });
});

// ---------------------------------------------------------------- crafts

describe('craft triggers', () => {
  it('first craft unlocks Maker', () => {
    const h = makeHarness();
    h.mgr.onCraft({ id: 'recipe_1', stationId: 'station_workbench' });
    expect(h.mgr.isUnlocked('maker')).toBe(true);
    expect(h.mgr.debugCounters().crafts).toBe(1);
  });

  it('station-scoped trigger: 5 alchemy crafts unlock Alchemist', () => {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) h.mgr.onCraft({ id: 'r', stationId: 'station_workbench' });
    expect(h.mgr.isUnlocked('alchemist')).toBe(false);
    for (let i = 0; i < 5; i++) h.mgr.onCraft({ id: 'r', stationId: 'station_alchemy' });
    expect(h.mgr.isUnlocked('alchemist')).toBe(true);
  });
});

// ---------------------------------------------------------------- quests

describe('quest completion polling', () => {
  it('a quest reaching complete unlocks Errand Runner', () => {
    const h = makeHarness({ questDefs: [{ id: 'q1' }] });
    ticks(h, 29);
    expect(h.mgr.isUnlocked('errand-runner')).toBe(false);
    h.quests.statuses['q1'] = 'complete';
    ticks(h, 30);
    expect(h.mgr.isUnlocked('errand-runner')).toBe(true);
    expect(h.mgr.debugCounters().questsDone).toBe(1);
  });

  it('turned-in counts too; side quests feed Helping Hand only', () => {
    const h = makeHarness({ questDefs: [{ id: 's1', side: true }, { id: 's2', side: true }, { id: 's3', side: true }] });
    h.quests.statuses['s1'] = 'turned-in';
    h.quests.statuses['s2'] = 'complete';
    h.quests.statuses['s3'] = 'turned-in';
    ticks(h, 30);
    expect(h.mgr.isUnlocked('helping-hand')).toBe(true);
    expect(h.mgr.debugCounters().sideQuestsDone).toBe(3);
    expect(h.mgr.debugCounters().questsDone).toBe(3);
  });

  it('no double-count: complete -> turned-in is one completion', () => {
    const h = makeHarness({ questDefs: [{ id: 'q1' }] });
    h.quests.statuses['q1'] = 'complete';
    ticks(h, 30);
    h.quests.statuses['q1'] = 'turned-in';
    ticks(h, 30);
    expect(h.mgr.debugCounters().questsDone).toBe(1);
  });

  it('portal restores do not double-count (seeded statuses)', () => {
    const h = makeHarness({ questDefs: [{ id: 'q1' }] });
    h.quests.statuses['q1'] = 'turned-in';
    ticks(h, 30);
    expect(h.mgr.debugCounters().questsDone).toBe(1);
    // restore sets the same status — poll sees no transition
    ticks(h, 60);
    expect(h.mgr.debugCounters().questsDone).toBe(1);
  });
});

// ---------------------------------------------------------------- portals

describe('portal travel', () => {
  it('first transition unlocks Wayfarer and records the map', () => {
    const h = makeHarness();
    expect(typeof h.portalHooks.onAfterTransition).toBe('function');
    (h.portalHooks.onAfterTransition as (ctx: unknown) => void)({ to: { mx: 0, my: 1 } });
    expect(h.mgr.isUnlocked('wayfarer')).toBe(true);
    expect(h.mgr.debugCounters().portals).toBe(1);
    expect(h.mgr.debugCounters().mapsVisited).toBe(1);
  });

  it('5 distinct maps unlock Globetrotter; revisits do not inflate', () => {
    const h = makeHarness();
    const go = (mx: number, my: number) =>
      (h.portalHooks.onAfterTransition as (ctx: unknown) => void)({ to: { mx, my } });
    go(0, 1); go(0, 1); go(1, 1); go(1, 0); go(0, 0);
    expect(h.mgr.debugCounters().mapsVisited).toBe(4);
    expect(h.mgr.isUnlocked('globetrotter')).toBe(false);
    go(2, 0);
    expect(h.mgr.isUnlocked('globetrotter')).toBe(true);
  });

  it('dispose restores a previously-installed onAfterTransition', () => {
    const store = new Map<string, string>();
    _setProfileStorage({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } });
    const hooks = fakeHooks();
    const portalHooks: { onAfterTransition?: (ctx: unknown) => void | Promise<void> } = {};
    const prev = () => {};
    portalHooks.onAfterTransition = prev; // foreign hook installed BEFORE us
    const mgr = new AchievementManager({
      hooks,
      toast: () => {},
      progression: () => null,
      quests: () => null,
      portalHooks: () => portalHooks as never,
      avatarPos: () => null,
      addScore: () => {},
    });
    expect(portalHooks.onAfterTransition).not.toBe(prev); // we chained over it
    mgr.dispose();
    expect(portalHooks.onAfterTransition).toBe(prev); // restored, not clobbered
  });

  it('dispose never clobbers a hook installed after us', () => {
    const h = makeHarness();
    const foreign = () => {};
    h.portalHooks.onAfterTransition = foreign; // replaces our wrapper
    h.mgr.dispose();
    expect(h.portalHooks.onAfterTransition).toBe(foreign);
  });
});

// ---------------------------------------------------------------- level

describe('level triggers', () => {
  it('level 5 unlocks Getting Started + Rising Star via onLevelUp', () => {
    const h = makeHarness({ progLevel: 5 });
    h.hooks.emit('onLevelUp', { level: 5, progression: null } as never);
    expect(h.mgr.isUnlocked('getting-started')).toBe(true);
    expect(h.mgr.isUnlocked('rising-star')).toBe(true);
    expect(h.mgr.isUnlocked('veteran')).toBe(false);
  });
});

// ---------------------------------------------------------------- distance

describe('distance accumulator', () => {
  it('1000m of walking unlocks Wanderer', () => {
    const h = makeHarness();
    for (let i = 0; i <= 100; i++) {
      h.pos = { x: i * 10, y: 0, z: 0 };
      ticks(h, 1);
    }
    expect(h.mgr.debugCounters().distanceM).toBe(1000);
    expect(h.mgr.isUnlocked('wanderer')).toBe(true);
  });

  it('teleports (>50m in one tick) do not inflate distance', () => {
    const h = makeHarness();
    ticks(h, 1);
    h.pos = { x: 8000, y: 0, z: 0 }; // portal arrival 8km away
    ticks(h, 1);
    expect(h.mgr.debugCounters().distanceM).toBe(0);
  });
});

// ---------------------------------------------------------------- rewards & re-entrancy

describe('rewards', () => {
  it('reward XP that levels up mid-unlock does not double-unlock or hang', () => {
    const h = makeHarness();
    // Faithful to the real Progression: addXpEx emits onLevelUp synchronously.
    (h.prog as unknown as { addXpEx: (n: number) => { leveled: boolean; gain: null } }).addXpEx =
      (n: number) => {
        h.prog.xpGranted += n;
        h.hooks.emit('onLevelUp', { level: 2, progression: null } as never);
        return { leveled: true, gain: null };
      };
    (h.prog as unknown as { level: number }).level = 2;
    kill(h); // first-blood (25 xp) -> level-up -> getting-started (25 xp)
    expect(h.mgr.isUnlocked('first-blood')).toBe(true);
    expect(h.mgr.isUnlocked('getting-started')).toBe(true);
    expect(h.toasts.length).toBe(2);
    expect(h.levelUpGains.length).toBe(2); // onLevelUp fired for both rewards
  });
});

// ---------------------------------------------------------------- persistence

describe('profile persistence', () => {
  it('unlocks survive a fresh manager via the profile (cross-run)', () => {
    const h = makeHarness();
    kill(h);
    expect(h.mgr.isUnlocked('first-blood')).toBe(true);

    const h2 = makeHarness();
    // same storage backend content, fresh manager
    h2.store.clear();
    for (const [k, v] of h.store) h2.store.set(k, v);
    const mgr2 = new AchievementManager({
      hooks: fakeHooks(),
      toast: () => {},
      progression: () => null,
      quests: () => null,
      portalHooks: () => null,
      avatarPos: () => null,
      addScore: () => {},
    });
    expect(mgr2.isUnlocked('first-blood')).toBe(true);
    expect(mgr2.unlockedIds()).toEqual(['first-blood']);
  });

  it('stale ids in the profile are dropped on load', () => {
    const store = new Map<string, string>();
    store.set('xandria.profile.v1', JSON.stringify({ achievements: ['first-blood', 'retired-achievement'] }));
    _setProfileStorage({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } });
    const mgr = new AchievementManager({
      hooks: fakeHooks(),
      toast: () => {},
      progression: () => null,
      quests: () => null,
      portalHooks: () => null,
      avatarPos: () => null,
      addScore: () => {},
    });
    expect(mgr.isUnlocked('first-blood')).toBe(true);
    expect(mgr.isUnlocked('retired-achievement')).toBe(false);
    expect(loadProfile().achievements).toContain('first-blood');
  });
});

// ---------------------------------------------------------------- snapshot

describe('portal snapshot/restore', () => {
  it('round-trips counters; corrupt input clamps instead of throwing', () => {
    const h = makeHarness();
    for (let i = 0; i < 7; i++) kill(h, 'drone');
    h.mgr.onCraft({ id: 'r', stationId: 'station_forge' });
    const snap = h.mgr.portalSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.kills).toBe(7);

    const h2 = makeHarness();
    h2.mgr.portalRestore(snap);
    expect(h2.mgr.debugCounters().kills).toBe(7);
    expect(h2.mgr.debugCounters().crafts).toBe(1);
    // JSON round-trip like the real transition envelope
    const h3 = makeHarness();
    h3.mgr.portalRestore(JSON.parse(JSON.stringify(snap)));
    expect(h3.mgr.debugCounters().kills).toBe(7);

    const h4 = makeHarness();
    expect(() => h4.mgr.portalRestore({ version: 1, kills: -5, distanceM: NaN } as never)).not.toThrow();
    expect(h4.mgr.debugCounters().kills).toBe(0);
    expect(h4.mgr.debugCounters().distanceM).toBe(0);
    const h5 = makeHarness();
    expect(() => h5.mgr.portalRestore(null)).not.toThrow();
    expect(() => h5.mgr.portalRestore({ version: 2 } as never)).not.toThrow();
  });
});

// ---------------------------------------------------------------- lifecycle

describe('dispose', () => {
  it('untaps all hooks and clears listeners', () => {
    const h = makeHarness();
    expect(h.hooks.tapCount('onKill')).toBe(1);
    expect(h.hooks.tapCount('onTick')).toBe(1);
    h.mgr.dispose();
    expect(h.hooks.tapCount('onKill')).toBe(0);
    expect(h.hooks.tapCount('onTick')).toBe(0);
    kill(h);
    expect(h.mgr.isUnlocked('first-blood')).toBe(false);
  });
});

// ---------------------------------------------------------------- determinism

describe('determinism', () => {
  it('same event sequence -> same unlocks (no RNG anywhere)', () => {
    const run = (): string[] => {
      const h = makeHarness({ questDefs: [{ id: 'q1' }, { id: 'q2', side: true }] });
      for (let i = 0; i < 12; i++) kill(h, i % 3 === 0 ? 'drone' : 'walker');
      for (let i = 0; i < 3; i++) h.mgr.onCraft({ id: 'r', stationId: 'station_alchemy' });
      h.quests.statuses['q1'] = 'turned-in';
      ticks(h, 30);
      return h.mgr.unlockedIds();
    };
    expect(run()).toEqual(run());
  });
});

// ---------------------------------------------------------------- perf

describe('perf', () => {
  it('per-tick cost is trivial (measured, 20k ticks)', () => {
    const h = makeHarness({ questDefs: [{ id: 'q1' }, { id: 'q2' }] });
    const t0 = performance.now();
    ticks(h, 20_000);
    const ms = performance.now() - t0;
    console.log(`[achievements-perf] 20000 ticks: ${ms.toFixed(1)}ms (${(ms / 20000 * 1000).toFixed(1)}µs/tick)`);
    expect(ms / 20000).toBeLessThan(0.05); // 50µs/tick budget — generous
  });
});

// ---------------------------------------------------------------- panel

function makeEl(tag = 'div'): any {
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as any,
    textContent: '',
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
    setAttribute(k: string, v: string) { el[`attr_${k}`] = v; },
    getAttribute: (k: string) => el[`attr_${k}`] ?? null,
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
    keydown(code: string) {
      const e = { code, stopPropagation() {}, preventDefault() {}, target: { tagName: 'BODY' } };
      for (const fn of this._listeners['keydown'] ?? []) fn(e);
      return e;
    },
  };
}

describe('AchievementsPanel', () => {
  function makePanelHarness() {
    const h = makeHarness();
    const win = makeWindow();
    const doc: any = { createElement: (t: string) => makeEl(t), defaultView: win };
    const container = makeEl('div');
    const panel = new AchievementsPanel({
      container,
      doc,
      achievements: () => h.mgr,
    });
    return { h, win, doc, container, panel };
  }

  const cards = (p: AchievementsPanel): any[] => {
    const root = (p as unknown as { root: any }).root;
    return root.children[1].children;
  };

  it('renders one card per def with locked state + progress bars', () => {
    const { panel } = makePanelHarness();
    panel.show();
    expect(panel.isOpen).toBe(true);
    const cs = cards(panel);
    expect(cs.length).toBe(ACHIEVEMENT_DEFS.length);
    expect(cs[0]['attr_data-achievement-id']).toBe('first-blood');
    expect(cs[0]['attr_data-achievement-state']).toBe('locked');
    // progress text present for a countable locked achievement
    expect(cs[0].children[2].textContent).toContain('0 / 1');
  });

  it('unlocked cards flip state; header counts; live refresh on unlock', () => {
    const { h, panel } = makePanelHarness();
    panel.show();
    kill(h); // first-blood unlocks while the panel is open
    const cs = cards(panel);
    const first = cs.find((c: any) => c['attr_data-achievement-id'] === 'first-blood');
    expect(first['attr_data-achievement-state']).toBe('unlocked');
    const root = (panel as unknown as { root: any }).root;
    expect(root.children[0].children[1].children[0].textContent).toBe(`1 / ${ACHIEVEMENT_DEFS.length}`);
  });

  it('chip toggles; J opens, J/Esc close; isModalOpen blocks open', () => {
    const { panel, win } = makePanelHarness();
    panel.chipEl.click();
    expect(panel.isOpen).toBe(true);
    panel.chipEl.click();
    expect(panel.isOpen).toBe(false);
    win.keydown('KeyJ');
    expect(panel.isOpen).toBe(true);
    win.keydown('KeyJ');
    expect(panel.isOpen).toBe(false);
    win.keydown('KeyJ');
    win.keydown('Escape');
    expect(panel.isOpen).toBe(false);
  });

  it('isModalOpen blocks the J open', () => {
    const h = makeHarness();
    const win = makeWindow();
    const doc: any = { createElement: (t: string) => makeEl(t), defaultView: win };
    const panel = new AchievementsPanel({
      container: makeEl('div'),
      doc,
      achievements: () => h.mgr,
      isModalOpen: () => true,
    });
    win.keydown('KeyJ');
    expect(panel.isOpen).toBe(false);
    panel.dispose();
  });

  it('dispose removes DOM + key listener', () => {
    const { panel, win, container } = makePanelHarness();
    panel.show();
    panel.dispose();
    expect(container.children.length).toBe(0);
    expect(win._listeners['keydown'] ?? []).toHaveLength(0);
  });

  it('null manager shows the honest empty state', () => {
    const win = makeWindow();
    const doc: any = { createElement: (t: string) => makeEl(t), defaultView: win };
    const panel = new AchievementsPanel({
      container: makeEl('div'),
      doc,
      achievements: () => null,
    });
    panel.show();
    expect(panel.isOpen).toBe(true);
    panel.dispose();
  });
});

describe('profile storage', () => {
  it('beforeEach isolation: fresh storage per harness', () => {
    const h = makeHarness();
    expect(loadProfile().achievements).toEqual([]);
    kill(h);
    expect(loadProfile().achievements).toEqual(['first-blood']);
  });
});
