/**
 * Round-2 QA fixes — worker C (HUD/objectives/modals/merit shop).
 *
 * R2-M2: boot must not overwrite the blueprint's staged objective text.
 * R2-N6: the kill that wins the run must not pop a level-up modal over the
 *         victory screen; XP awards stay intact.
 * R2-N5: clearOverlays() dismisses live level-up/choice modals — element +
 *         document keydown listener removed, promise settled.
 * R2-N10: merit shop gives visible feedback on insufficient-funds purchase.
 *
 * DOM is stubbed (no jsdom here), following the pattern in campaign.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { HUD, CHOICE_ABANDONED } from '../src/engine/game/HUD';
import { Progression } from '../src/engine/game/Progression';
import { Rng } from '../src/engine/core/Rng';
import { makeCampaignObjectives, grantKillXp } from '../src/blueprints/campaign';
import type { Engine } from '../src/engine/Engine';
import type { GameSpec, ObjectiveStage } from '../src/spec/schema';
import type { UpgradeDef } from '../src/engine/game/Progression';

/* ---------------- DOM stub (classList + document listeners tracked) ---------------- */
function makeEl(tag = 'div'): any {
  const listeners: Record<string, Function[]> = {};
  const classes = new Set<string>();
  const el: any = {
    tag,
    children: [] as any[],
    removed: false,
    style: {} as Record<string, string>,
    textContent: '',
    innerHTML: '',
    className: '',
    dataset: {} as Record<string, string>,
    classList: {
      add: (...cs: string[]) => cs.forEach((c) => classes.add(c)),
      remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
      toggle: (c: string, f?: boolean) => {
        const on = f ?? !classes.has(c);
        if (on) classes.add(c); else classes.delete(c);
      },
      contains: (c: string) => classes.has(c),
    },
    appendChild(c: any) { el.children.push(c); return c; },
    append(...cs: any[]) { el.children.push(...cs); },
    remove() { el.removed = true; },
    addEventListener(t: string, fn: Function) { (listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: Function) {
      listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
    },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    __fire(t: string, e: any = {}) { (listeners[t] ?? []).forEach((fn) => fn(e)); },
    __listeners: listeners,
  };
  return el;
}

function installDom() {
  const docListeners: Record<string, Function[]> = {};
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head: makeEl('head'),
    addEventListener(t: string, fn: Function) { (docListeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: Function) {
      docListeners[t] = (docListeners[t] ?? []).filter((f) => f !== fn);
    },
    __listeners: docListeners,
    __fire(t: string, e: any = {}) { (docListeners[t] ?? []).forEach((fn) => fn(e)); },
  };
}

const doc = () => (globalThis as any).document;

const hudSpec = () =>
  ({
    meta: { name: 'Test Game' },
    objective: { description: 'Do the thing' },
  }) as unknown as GameSpec;

const findChild = (el: any, cls: string): any =>
  el.children.find((c: any) => (c.className ?? '').split(' ').includes(cls));

beforeEach(() => {
  installDom();
});

/* ---------------- R2-M2 ---------------- */
describe('R2-M2 — boot keeps the blueprint staged objective text', () => {
  const src = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('main.ts boot() no longer calls hud.setObjective (blueprint owns the line)', () => {
    const main = src('../src/runtime/main.ts');
    expect(main).not.toMatch(/hud\.setObjective/);
    // the title-card toast stays
    expect(main).toMatch(/hud\.toast/);
  });

  it('makeCampaignObjectives sets the staged first-stage description per genre', () => {
    const genres = ['tp-action', 'fps-arena', 'racing', 'platformer', 'topdown'];
    for (const genre of genres) {
      installDom();
      const container = makeEl('div');
      const hud = new HUD(container, hudSpec());
      const engineStub = { hud } as unknown as Engine;
      const stage: ObjectiveStage = {
        description: `Chapter I — stage one (${genre})`,
        type: 'eliminate',
        count: 6,
      } as ObjectiveStage;
      const spec = {
        meta: { name: `${genre} quest` },
        objective: { description: 'LEGACY TEXT', stages: [stage] },
      } as unknown as GameSpec;
      makeCampaignObjectives(engineStub, spec);
      const priv = hud as unknown as {
        objTitle: { textContent: string };
        objDesc: { textContent: string };
      };
      expect(priv.objTitle.textContent).toBe(`${genre} quest`.toUpperCase());
      expect(priv.objDesc.textContent).toBe(`Chapter I — stage one (${genre})`);
      expect(priv.objDesc.textContent).not.toBe('LEGACY TEXT');
    }
  });

  it('legacy specs without stages still show the objective description', () => {
    installDom();
    const container = makeEl('div');
    const hud = new HUD(container, hudSpec());
    const engineStub = { hud } as unknown as Engine;
    const spec = {
      meta: { name: 'legacy game' },
      objective: { description: 'Eliminate 6 hostiles' },
    } as unknown as GameSpec;
    makeCampaignObjectives(engineStub, spec);
    const priv = hud as unknown as { objDesc: { textContent: string } };
    expect(priv.objDesc.textContent).toBe('Eliminate 6 hostiles');
  });
});

/* ---------------- R2-N6 ---------------- */
describe('R2-N6 — no level-up modal over the victory/defeat screen', () => {
  const choices: UpgradeDef[] = [
    { id: 'damage', name: 'Heavy Rounds', desc: '+25% damage' },
    { id: 'maxhp', name: 'Plating', desc: '+15% hp' },
  ];
  const wonEng = () => ({
    state: 'won',
    pause: vi.fn(),
    resume: vi.fn(),
  });
  const lostEng = () => ({
    state: 'lost',
    pause: vi.fn(),
    resume: vi.fn(),
  });

  it("won run: showLevelUp resolves the first choice without opening a modal", async () => {
    const container = makeEl('div');
    const hud = new HUD(container, hudSpec());
    const eng: any = wonEng();
    hud.attachEngine(eng as Engine);
    const rootBefore = container.children.length;
    await expect(hud.showLevelUp(choices)).resolves.toBe('damage');
    expect(eng.pause).not.toHaveBeenCalled();
    // no modal element appended
    expect(container.children.length).toBe(rootBefore);
  });

  it("lost run: showLevelUp resolves the first choice without opening a modal", async () => {
    const container = makeEl('div');
    const hud = new HUD(container, hudSpec());
    const eng: any = lostEng();
    hud.attachEngine(eng as Engine);
    const rootBefore = container.children.length;
    await expect(hud.showLevelUp(choices)).resolves.toBe('damage');
    expect(eng.pause).not.toHaveBeenCalled();
    expect(container.children.length).toBe(rootBefore);
  });

  it('playing run: showLevelUp still opens the modal (no behavior change)', () => {
    const container = makeEl('div');
    const hud = new HUD(container, hudSpec());
    const eng: any = { state: 'playing', pause: vi.fn(), resume: vi.fn() };
    hud.attachEngine(eng as Engine);
    hud.showLevelUp(choices);
    expect(eng.pause).toHaveBeenCalled();
    const overlay = findChild(container.children[0], 'overlay');
    expect(overlay).toBeDefined();
  });

  it('grantKillXp still notifies on level-up (XP awards intact)', () => {
    const progEngine = () =>
      ({
        rng: new Rng(7),
        spec: { custom: {} },
        hooks: { emit() {}, tap() {}, tapCount: () => 0, enemyKinds: new Map(), upgrades: new Map(), customUpgradeDefs: () => [] },
      }) as unknown as Engine;
    // 120 xp >= 100 needed for level 2 → level-up on the kill
    const p = new Progression(progEngine(), { enabled: true, xpPerKill: 120, xpPerPickup: 5 });
    let notified = 0;
    grantKillXp(p, () => notified++);
    expect(notified).toBe(1);
    expect(p.level).toBe(2);
    // no level-up → no notify
    const q = new Progression(progEngine(), { enabled: true, xpPerKill: 20, xpPerPickup: 5 });
    let notified2 = 0;
    grantKillXp(q, () => notified2++);
    expect(notified2).toBe(0);
  });

  it('blueprints grant XP before recording the kill (4 combat blueprints)', () => {
    for (const f of ['fpsArena', 'tpAction', 'topdown', 'platformer']) {
      const text = readFileSync(
        new URL(`../src/blueprints/${f}.ts`, import.meta.url),
        'utf8',
      );
      const xpAt = text.indexOf('grantKillXp(prog, notifyLevelUp)');
      const progAt = text.indexOf("objectives.addProgress(1, 'kill')");
      expect(xpAt, `${f}.ts has grantKillXp`).toBeGreaterThan(-1);
      expect(progAt, `${f}.ts has addProgress kill`).toBeGreaterThan(-1);
      expect(xpAt, `${f}.ts: XP granted before the win check`).toBeLessThan(progAt);
    }
  });
});

/* ---------------- R2-N5 ---------------- */
describe('R2-N5 — clearOverlays() tears down live modals', () => {
  const choices: UpgradeDef[] = [
    { id: 'damage', name: 'Heavy Rounds', desc: '+25% damage' },
    { id: 'maxhp', name: 'Plating', desc: '+15% hp' },
  ];

  it('showChoice: teardown removes the element and the document keydown listener', async () => {
    const container = makeEl('div');
    const hud = new HUD(container, hudSpec());
    const eng: any = { state: 'playing', pause: vi.fn(), resume: vi.fn() };
    hud.attachEngine(eng as Engine);
    let settled: string | null = null;
    const p = hud.showChoice('CHOOSE', 'Pick one', ['A', 'B']).then(
      (i) => { settled = `resolved:${i}`; },
      () => { settled = 'rejected'; },
    );
    const overlay = findChild(container.children[0], 'overlay');
    expect(overlay).toBeDefined();
    const keyListenersBefore: Function[] = doc().__listeners['keydown'] ?? [];
    expect(keyListenersBefore.length).toBe(1);

    hud.clearOverlays();

    expect(overlay.removed).toBe(true);
    expect((doc().__listeners['keydown'] ?? []).length).toBe(0);
    // stale number-key presses reach nothing
    doc().__fire('keydown', { key: '1' });
    await p;
    // R4-M1: teardown settles with the abandoned sentinel instead of leaving
    // the promise pending forever — Objectives releases awaitingChoice on it
    // without advancing (the run is being torn down).
    expect(settled).toBe(`resolved:${CHOICE_ABANDONED}`);
  });

  it('showLevelUp: teardown removes the element and settles the promise', async () => {
    const container = makeEl('div');
    const hud = new HUD(container, hudSpec());
    const eng: any = { state: 'playing', pause: vi.fn(), resume: vi.fn() };
    hud.attachEngine(eng as Engine);
    const p = hud.showLevelUp(choices);
    const overlay = findChild(container.children[0], 'overlay');
    expect(overlay).toBeDefined();

    hud.clearOverlays();

    expect(overlay.removed).toBe(true);
    // '' = abandoned pick: applyUpgrade('') is a no-op, so the queued
    // level-up chain resolves without mutating the torn-down run
    await expect(p).resolves.toBe('');
  });

  it('clearOverlays with no modal open is a no-op', () => {
    const container = makeEl('div');
    const hud = new HUD(container, hudSpec());
    expect(() => hud.clearOverlays()).not.toThrow();
  });
});

/* ---------------- R2-N10 ---------------- */
describe('R2-N10 — merit shop insufficient-funds feedback', () => {
  const mods = (merit: number) => ({
    name: 'Test Game',
    premise: 'P',
    controls: [] as string[],
    onStart: () => {},
    merit,
    modifiers: [
      { id: 'vitality', name: 'Vitality', desc: '+25 max HP', cost: 50, owned: false, equipped: false },
    ],
    onToggleModifier: vi.fn(),
    onBuyModifier: vi.fn(),
  });

  /** the clickable .mod card + its .ma action label */
  const modCard = (container: any) => {
    const overlay = findChild(container.children[0], 'overlay');
    const modsEl = findChild(overlay, 'mods');
    const card = modsEl.children[0];
    return { card, action: findChild(card, 'ma') };
  };

  it('unaffordable click: no purchase, shake class + NEED label', () => {
    vi.useFakeTimers();
    try {
      const container = makeEl('div');
      const hud = new HUD(container, hudSpec());
      const opts = mods(10); // 10 merit < 50 cost
      hud.showTitle(opts);
      const { card, action } = modCard(container);
      expect(action.textContent).toBe('BUY ◆50');
      card.__fire('click', { stopPropagation() {} });
      expect(opts.onBuyModifier).not.toHaveBeenCalled();
      expect(card.classList.contains('denied')).toBe(true);
      expect(action.textContent).toBe('NEED ◆40 MORE');
      // label restores after the flash
      vi.advanceTimersByTime(900);
      expect(card.classList.contains('denied')).toBe(false);
      expect(action.textContent).toBe('BUY ◆50');
    } finally {
      vi.useRealTimers();
    }
  });

  it('affordable click still buys (no behavior change)', () => {
    const container = makeEl('div');
    const hud = new HUD(container, hudSpec());
    const opts = mods(100); // 100 merit >= 50 cost
    hud.showTitle(opts);
    const { card } = modCard(container);
    card.__fire('click', { stopPropagation() {} });
    expect(opts.onBuyModifier).toHaveBeenCalledWith('vitality');
    expect(card.classList.contains('denied')).toBe(false);
  });

  it('owned/equipped click still toggles (no behavior change)', () => {
    const container = makeEl('div');
    const hud = new HUD(container, hudSpec());
    const opts = mods(0);
    opts.modifiers = [
      { id: 'vitality', name: 'Vitality', desc: '+25 max HP', cost: 50, owned: true, equipped: false },
    ];
    hud.showTitle(opts);
    const { card } = modCard(container);
    card.__fire('click', { stopPropagation() {} });
    expect(opts.onToggleModifier).toHaveBeenCalledWith('vitality');
    expect(opts.onBuyModifier).not.toHaveBeenCalled();
    expect(card.classList.contains('denied')).toBe(false);
  });
});
