/**
 * Campaign-layer engine tests: stage sequencer (Objectives), XP/progression,
 * upgrade application, HUD story cards. DOM is stubbed (no jsdom here).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Objectives } from '../src/engine/game/Objectives';
import { Progression, type UpgradeId } from '../src/engine/game/Progression';
import { HUD, type RunStats } from '../src/engine/game/HUD';
import { Rng } from '../src/engine/core/Rng';
import type { Engine } from '../src/engine/Engine';
import type { GameSpec, ObjectiveSpec } from '../src/spec/schema';
import type { PlayerAvatar } from '../src/blueprints/common';

/* ---------------- minimal DOM stub ---------------- */
function makeEl(tag = 'div'): any {
  const listeners: Record<string, Function[]> = {};
  const el: any = {
    tag,
    children: [] as any[],
    removed: false,
    style: {} as Record<string, string>,
    textContent: '',
    innerHTML: '',
    className: '',
    dataset: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c: any) {
      el.children.push(c);
      return c;
    },
    append(...cs: any[]) {
      el.children.push(...cs);
    },
    remove() {
      el.removed = true;
    },
    addEventListener(t: string, fn: Function) {
      (listeners[t] ??= []).push(fn);
    },
    querySelector() {
      return makeEl();
    },
    querySelectorAll() {
      return [];
    },
    __fire(t: string, e: any = {}) {
      (listeners[t] ?? []).forEach((fn) => fn(e));
    },
  };
  return el;
}

function installDom() {
  const head = makeEl('head');
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head,
  };
}

const legacyEliminate = (count = 3): ObjectiveSpec =>
  ({ type: 'eliminate', count, timeLimit: 0, description: 'Kill them' }) as ObjectiveSpec;

const stagedSpec = (): ObjectiveSpec =>
  ({
    type: 'eliminate',
    count: 99,
    timeLimit: 0,
    description: 'legacy fallback',
    stages: [
      { type: 'eliminate', count: 2, timeLimit: 0, description: 'Chapter I — Thin the patrols' },
      { type: 'reach', count: 0, timeLimit: 0, description: 'Chapter II — Reach the beacon' },
    ],
  }) as ObjectiveSpec;

function fakeEngine() {
  return {
    state: 'playing' as const,
    elapsed: 0,
    score: 0,
    win: vi.fn(),
    lose: vi.fn(),
    hud: { setProgress: vi.fn(), setTimer: vi.fn() },
    hooks: { emit: vi.fn(), tap: vi.fn(), tapCount: () => 0 },
  };
}

describe('Objectives — legacy single objective (unchanged behavior)', () => {
  it('wins when eliminate count is reached, passes stats', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, legacyEliminate(3));
    expect(o.inStageMode).toBe(false);
    expect(o.stageCount).toBe(0);
    o.addProgress(2);
    expect(eng.win).not.toHaveBeenCalled();
    o.addProgress(1);
    expect(o.done).toBe(true);
    expect(eng.win).toHaveBeenCalledWith({ kills: 3, stagesCleared: 0, level: 1 });
    // progress text identical to legacy format
    expect(eng.hud.setProgress).toHaveBeenLastCalledWith('3 / 3 defeated');
  });

  it('passes the level provider value through to win stats', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, legacyEliminate(2), undefined, () => 4);
    o.addProgress(2);
    expect(eng.win).toHaveBeenCalledWith({ kills: 2, stagesCleared: 0, level: 4 });
  });

  it('reach objective wins via reachedGoal only', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, {
      type: 'reach',
      count: 0,
      timeLimit: 0,
      description: 'Go',
    } as ObjectiveSpec);
    o.addProgress(99); // no-op for reach
    expect(eng.win).not.toHaveBeenCalled();
    o.reachedGoal();
    expect(eng.win).toHaveBeenCalled();
  });

  it('survive wins when the timer expires', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, {
      type: 'survive',
      count: 0,
      timeLimit: 10,
      description: 'Survive',
    } as ObjectiveSpec);
    o.update(4);
    expect(eng.win).not.toHaveBeenCalled();
    o.update(6.5);
    expect(o.done).toBe(true);
    expect(eng.win).toHaveBeenCalled();
  });

  it('loses on timeLimit expiry with reason', () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, {
      type: 'collect',
      count: 5,
      timeLimit: 30,
      description: 'Collect',
    } as ObjectiveSpec);
    o.update(31);
    expect(eng.lose).toHaveBeenCalledWith('Time ran out.', { kills: 0, stagesCleared: 0, level: 1 });
  });
});

describe('Objectives — stage sequencer', () => {
  it('walks stages in order, firing onStageComplete, final wins', () => {
    const eng = fakeEngine();
    const seen: Array<[number, string]> = [];
    const o = new Objectives(eng as unknown as Engine, stagedSpec(), (i, s) =>
      seen.push([i, s.type]),
    );
    expect(o.inStageMode).toBe(true);
    expect(o.stageCount).toBe(2);
    expect(o.currentStageIndex).toBe(0);

    o.addProgress(2); // complete stage 0 (eliminate 2)
    expect(seen).toEqual([[0, 'eliminate']]);
    expect(o.done).toBe(false);
    expect(o.currentStageIndex).toBe(1);
    expect(o.progress).toBe(0); // counter reset for the new stage
    expect(o.stagesCleared).toBe(1);
    expect(eng.win).not.toHaveBeenCalled();
    // progress HUD shows the stage tag
    expect(eng.hud.setProgress).toHaveBeenLastCalledWith('Reach the beacon [2/2]');

    o.reachedGoal(); // complete final stage
    expect(o.done).toBe(true);
    expect(eng.win).toHaveBeenCalledWith({ kills: 2, stagesCleared: 2, level: 1 });
    expect(seen).toEqual([[0, 'eliminate']]); // no callback for the final stage
  });

  it('each stage gets its own timeLimit', () => {
    const eng = fakeEngine();
    const spec = stagedSpec();
    const o = new Objectives(eng as unknown as Engine, spec, () => {});
    o.addProgress(2); // advance to stage 1 (reach, timeLimit 0)
    // give stage 1 a limit via a fresh sequencer to test per-stage timers
    const timed = {
      ...stagedSpec(),
      stages: [
        { type: 'collect', count: 5, timeLimit: 10, description: 'S1' },
        { type: 'collect', count: 5, timeLimit: 0, description: 'S2' },
      ],
    } as unknown as ObjectiveSpec;
    const eng2 = fakeEngine();
    const o2 = new Objectives(eng2 as unknown as Engine, timed, () => {});
    o2.update(11); // stage 1 timer expires → lose (not win)
    expect(eng2.lose).toHaveBeenCalledWith('Time ran out.', { kills: 0, stagesCleared: 0, level: 1 });
    expect(o2.done).toBe(true);
  });

  it('kills accumulate across stages', () => {
    const eng = fakeEngine();
    const spec = {
      type: 'eliminate',
      count: 0,
      timeLimit: 0,
      description: 'x',
      stages: [
        { type: 'eliminate', count: 2, timeLimit: 0, description: 'S1' },
        { type: 'eliminate', count: 3, timeLimit: 0, description: 'S2' },
      ],
    } as unknown as ObjectiveSpec;
    const o = new Objectives(eng as unknown as Engine, spec, () => {});
    o.addProgress(2);
    o.addProgress(3);
    expect(o.kills).toBe(5);
    expect(eng.win).toHaveBeenCalledWith({ kills: 5, stagesCleared: 2, level: 1 });
  });

  it('ignores empty stages array (legacy fallback)', () => {
    const eng = fakeEngine();
    const spec = { ...legacyEliminate(2), stages: [] } as unknown as ObjectiveSpec;
    const o = new Objectives(eng as unknown as Engine, spec);
    expect(o.inStageMode).toBe(false);
    o.addProgress(2);
    expect(eng.win).toHaveBeenCalled();
  });
});

describe('Progression — XP curve and level-ups', () => {
  const progEngine = (seed = 42) =>
    ({ rng: new Rng(seed), spec: { custom: {} }, hooks: { emit() {}, tap() {}, tapCount: () => 0, enemyKinds: new Map(), upgrades: new Map(), customUpgradeDefs: () => [] } }) as unknown as Engine;
  const opts = { enabled: true, xpPerKill: 20, xpPerPickup: 5 };

  it('xpForNext follows 100 * level^1.5', () => {
    const p = new Progression(progEngine(), opts);
    expect(p.xpForNext(1)).toBe(100);
    expect(p.xpForNext(2)).toBe(Math.round(100 * Math.pow(2, 1.5)));
    expect(p.xpForNext(2)).toBe(283);
    expect(p.xpForNext(3)).toBe(Math.round(100 * Math.pow(3, 1.5)));
  });

  it('addXp returns true only on level-up, carries remainder', () => {
    const p = new Progression(progEngine(), opts);
    expect(p.addXp(50)).toBe(false);
    expect(p.level).toBe(1);
    expect(p.xp).toBe(50);
    expect(p.addXp(60)).toBe(true); // 110 >= 100
    expect(p.level).toBe(2);
    expect(p.xp).toBe(10);
  });

  it('handles multi-level jumps', () => {
    const p = new Progression(progEngine(), opts);
    expect(p.addXp(500)).toBe(true);
    // 100 (→2) + 283 (→3) = 383 ≤ 500; next needs 520
    expect(p.level).toBe(3);
    expect(p.xp).toBe(117);
  });

  it('no-ops when disabled', () => {
    const p = new Progression(progEngine(), { ...opts, enabled: false });
    expect(p.addXp(1000)).toBe(false);
    expect(p.level).toBe(1);
    expect(p.xp).toBe(0);
    expect(p.onKill()).toBe(false);
  });

  it('onKill/onPickup use configured rates', () => {
    const p = new Progression(progEngine(), opts);
    expect(p.onPickup()).toBe(false); // +5
    expect(p.xp).toBe(5);
    for (let i = 0; i < 4; i++) p.onKill(); // +80 → 85
    expect(p.level).toBe(1);
    expect(p.onKill()).toBe(true); // 105 ≥ 100
    expect(p.level).toBe(2);
  });

  it('reads defaults from spec.progression when no opts given', () => {
    const eng = {
      rng: new Rng(1),
      spec: { custom: {}, progression: { enabled: true, xpPerKill: 20, xpPerPickup: 5 } },
    } as unknown as Engine;
    const p = new Progression(eng);
    expect(p.enabled).toBe(true);
    expect(p.onKill()).toBe(false);
    expect(p.xp).toBe(20);
  });
});

describe('Progression — upgrade choices and application', () => {
  const progEngine = (seed = 7) =>
    ({ rng: new Rng(seed), spec: { custom: {} }, hooks: { emit() {}, tap() {}, tapCount: () => 0, enemyKinds: new Map(), upgrades: new Map(), customUpgradeDefs: () => [] } }) as unknown as Engine;
  const opts = { enabled: true, xpPerKill: 20, xpPerPickup: 5 };
  const fakeAvatar = () => {
    const a: any = {
      maxHealth: 100,
      health: 60,
      heal(n: number) {
        a.health = Math.min(a.maxHealth, n);
      },
    };
    return a as PlayerAvatar;
  };

  it('getUpgradeChoices returns 3 distinct upgrades, deterministic per seed', () => {
    const a = new Progression(progEngine(7), opts).getUpgradeChoices();
    const b = new Progression(progEngine(7), opts).getUpgradeChoices();
    expect(a).toHaveLength(3);
    expect(new Set(a.map((c) => c.id)).size).toBe(3);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    const c = new Progression(progEngine(99), opts).getUpgradeChoices();
    // different seed → (almost surely) different ordering
    expect(c.map((x) => x.id)).not.toEqual(a.map((x) => x.id));
  });

  it('pool has at least 6 upgrades', () => {
    const ids = new Set<string>();
    for (let s = 0; s < 20; s++) {
      for (const c of new Progression(progEngine(s), opts).getUpgradeChoices()) ids.add(c.id);
    }
    expect(ids.size).toBeGreaterThanOrEqual(6);
  });

  it('maxhp: +15% max health and full heal', () => {
    const p = new Progression(progEngine(), opts);
    const av = fakeAvatar();
    p.applyUpgrade('maxhp', av);
    expect(av.maxHealth).toBe(115);
    expect(av.health).toBe(115);
    expect(p.upgradeCount('maxhp')).toBe(1);
  });

  it('firerate: flows through spec.custom.weaponMods', () => {
    const eng = progEngine();
    const p = new Progression(eng, opts);
    p.applyUpgrade('firerate', fakeAvatar());
    expect((eng.spec as any).custom.weaponMods.rateOfFire).toBeCloseTo(1.2, 5);
    p.applyUpgrade('firerate', fakeAvatar());
    expect((eng.spec as any).custom.weaponMods.rateOfFire).toBeCloseTo(1.44, 5);
  });

  it('damage/speed/magnet/dash stack as multipliers', () => {
    const p = new Progression(progEngine(), opts);
    const av = fakeAvatar();
    expect(p.damageMult()).toBe(1);
    p.applyUpgrade('damage', av);
    p.applyUpgrade('damage', av);
    expect(p.damageMult()).toBeCloseTo(1.5625, 5);
    p.applyUpgrade('speed', av);
    expect(p.speedMult()).toBeCloseTo(1.12, 5);
    p.applyUpgrade('magnet', av);
    expect(p.magnetMult()).toBeCloseTo(1.5, 5);
    p.applyUpgrade('dash', av);
    expect(p.dashCdMult()).toBeCloseTo(0.75, 5);
  });

  it('applyUpgrade no-ops when disabled', () => {
    const p = new Progression(progEngine(), { ...opts, enabled: false });
    const av = fakeAvatar();
    p.applyUpgrade('maxhp', av);
    expect(av.maxHealth).toBe(100);
    expect(p.upgradeCount('maxhp')).toBe(0);
  });
});

describe('HUD — story cards', () => {
  let container: any;
  let spec: GameSpec;
  /** the .xhud root element HUD appends overlays/cards to */
  const hudRoot = () => container.children[0];
  const findInRoot = (cls: string) =>
    hudRoot().children.find((c: any) => c.className === cls);
  beforeEach(() => {
    installDom();
    container = makeEl('div');
    spec = {
      meta: { name: 'Test Game' },
      objective: { description: 'Do the thing' },
      narrative: { premise: 'P', winText: 'You won, hero.', loseText: 'You fell, hero.' },
    } as unknown as GameSpec;
  });

  it('showCard renders and resolves on click', async () => {
    const hud = new HUD(container, spec);
    const p = hud.showCard('Chapter I', 'Thin the patrols.');
    const card = findInRoot('card');
    expect(card).toBeDefined();
    expect(card.children[0].textContent).toBe('Chapter I');
    card.__fire('click');
    await p;
    expect(card.removed).toBe(true);
  });

  it('showCard auto-dismisses after 3.5s', async () => {
    vi.useFakeTimers();
    try {
      const hud = new HUD(container, spec);
      const p = hud.showCard('T', 'B');
      const card = findInRoot('card');
      vi.advanceTimersByTime(3500);
      await p;
      expect(card.removed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('showLevelUp pauses, resolves the chosen id, resumes', async () => {
    const eng: any = {
      state: 'playing',
      pause: vi.fn(() => (eng.state = 'paused')),
      resume: vi.fn(() => (eng.state = 'playing')),
    };
    const hud = new HUD(container, spec);
    hud.attachEngine(eng as Engine);
    const choices: Array<{ id: UpgradeId; name: string; desc: string }> = [
      { id: 'damage', name: 'Heavy Rounds', desc: '+25% damage' },
      { id: 'maxhp', name: 'Plating', desc: '+15% hp' },
      { id: 'speed', name: 'Servos', desc: '+12% speed' },
    ];
    const p = hud.showLevelUp(choices);
    expect(eng.pause).toHaveBeenCalled();
    expect(eng.state).toBe('paused');
    const overlay = findInRoot('overlay');
    expect(overlay).toBeDefined();
    const opts = overlay.children.find((c: any) => c.className === 'lvlopts');
    expect(opts.children).toHaveLength(3);
    opts.children[1].__fire('click');
    await expect(p).resolves.toBe('maxhp');
    expect(eng.resume).toHaveBeenCalled();
    expect(eng.state).toBe('playing');
  });

  it('showEnd victory uses narrative winText and full stats', () => {
    const hud = new HUD(container, spec);
    const stats: RunStats = { score: 1234, time: 125, kills: 17, level: 4, stagesCleared: 2 };
    hud.showEnd(true, stats);
    const overlay = findInRoot('overlay');
    expect(overlay).toBeDefined();
    const h = overlay.children.find((c: any) => c.tag === 'h1');
    expect(h.textContent).toBe('VICTORY');
    const sub = overlay.children.find((c: any) => c.className === 'sub');
    expect(sub.textContent).toBe('You won, hero.');
    const statsEl = overlay.children.find((c: any) => c.className === 'stats');
    expect(statsEl.textContent).toContain('KILLS 17');
    expect(statsEl.textContent).toContain('LEVEL 4');
    expect(statsEl.textContent).toContain('STAGES 2');
    expect(statsEl.textContent).toContain('2:05');
  });

  it('showEnd defeat uses reason, then narrative loseText, then fallback', () => {
    const hud = new HUD(container, spec);
    const base: RunStats = { score: 10, time: 30, kills: 1, level: 1, stagesCleared: 0 };
    hud.showEnd(false, { ...base, reason: 'Time ran out.' });
    let overlay = hudRoot().children.filter((c: any) => c.className === 'overlay').pop();
    expect(overlay.children.find((c: any) => c.className === 'sub').textContent).toBe('Time ran out.');

    const hud2 = new HUD(container, spec);
    hud2.showEnd(false, base);
    // hud2 appended a second .xhud root — its overlay lives there
    const lastRoot = container.children[container.children.length - 1];
    overlay = lastRoot.children.filter((c: any) => c.className === 'overlay').pop();
    expect(overlay.children.find((c: any) => c.className === 'sub').textContent).toBe('You fell, hero.');
  });
});
