/**
 * Round-4 regression tests (vitest, real HUD + real Objectives, stubbed DOM).
 *
 * R4-M1: a level-up earned on the same tick as a branch-choice completion
 * must QUEUE behind the choice modal, never preempt it (preemption used to
 * abandon the choice, resume the game, and freeze quest progress forever).
 * And a torn-down choice modal settles with CHOICE_ABANDONED, releasing the
 * quest sequencer instead of freezing it.
 *
 * R4-N1: difficulty-relevant chapter counting uses stagesCleared
 * (branch-aware), not the quest-graph array index.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Objectives } from '../src/engine/game/Objectives';
import { HUD, CHOICE_ABANDONED } from '../src/engine/game/HUD';
import type { Engine } from '../src/engine/Engine';
import type { GameSpec, ObjectiveSpec } from '../src/spec/schema';

/* ---------------- minimal DOM stub (mirrors campaign.test.ts) ---------------- */
function makeEl(tag = 'div'): any {
  const listeners: Record<string, Function[]> = {};
  const el: any = {
    tag,
    children: [] as any[],
    removed: false,
    style: {} as Record<string, string>,
    textContent: '',
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
    removeEventListener(t: string, fn: Function) {
      listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
    },
    querySelector() {
      return makeEl();
    },
    querySelectorAll() {
      return [];
    },
    __fire(t: string, e: any = {}) {
      [...(listeners[t] ?? [])].forEach((fn) => fn(e));
    },
    __listeners(t: string) {
      return listeners[t] ?? [];
    },
  };
  return el;
}

const docListeners: Record<string, Function[]> = {};
function installDom() {
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head: makeEl('head'),
    addEventListener: (t: string, fn: Function) => ((docListeners[t] ??= []).push(fn), undefined),
    removeEventListener: (t: string, fn: Function) => {
      docListeners[t] = (docListeners[t] ?? []).filter((f) => f !== fn);
    },
  };
}
function fireDocKey(key: string) {
  [...(docListeners['keydown'] ?? [])].forEach((fn) => fn({ key }));
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/* ---------------- fixtures ---------------- */
const st = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'eliminate', count: 1, timeLimit: 0, description: id, ...extra });

function branchedSpec(): ObjectiveSpec {
  return {
    type: 'eliminate',
    count: 99,
    timeLimit: 0,
    description: 'root',
    stages: [
      st('s0', { choices: [{ label: 'Dawn', next: 's1' }, { label: 'Dusk', next: 's2' }] }),
      st('s1', { count: 2 }),
      st('s2', { count: 2 }),
    ],
  } as unknown as ObjectiveSpec;
}

function wire() {
  installDom();
  const container = makeEl();
  const gameSpec = { objective: { description: 'root' } } as GameSpec;
  const hud = new HUD(container, gameSpec);
  const engine: any = {
    state: 'playing' as const,
    elapsed: 0,
    pause: vi.fn(() => { engine.state = 'paused'; }),
    resume: vi.fn(() => { engine.state = 'playing'; }),
    win: vi.fn(),
    lose: vi.fn(),
    hooks: { emit: vi.fn() },
    audio: null,
    hud,
  };
  hud.attachEngine(engine as Engine);
  const objectives = new Objectives(engine as Engine, branchedSpec());
  return { hud, engine, objectives };
}

/** h1 text of the currently tracked modal, or null. */
function activeModalTitle(hud: HUD): string | null {
  const m = (hud as any).activeModal;
  return m ? (m.el.children[0]?.textContent ?? null) : null;
}
/** Click the first .lvlopt-style button of the active modal. */
function clickFirstModalButton(hud: HUD) {
  const m = (hud as any).activeModal;
  const opts = m.el.children.find((c: any) => c.children.length > 0 && c !== m.el.children[0]);
  const btn = opts.children[0];
  btn.__fire('click');
}

describe('R4-M1: level-up queues behind an active choice modal', () => {
  beforeEach(() => {});

  it('does not preempt the choice modal; level-up shows after the pick', async () => {
    const { hud, engine, objectives } = wire();
    // branch-completing kill: choice modal opens synchronously...
    objectives.addProgress(1, 'kill');
    expect(activeModalTitle(hud)).toBe('CHOOSE YOUR PATH');
    expect(engine.state).toBe('paused');
    // ...then the level-up microtask fires (grantKillXp ran before addProgress)
    const lvl = hud.showLevelUp([{ id: 'vigor', name: 'Vigor', desc: '+hp' } as any]);
    let lvlSettled = false;
    void lvl.then(() => { lvlSettled = true; });
    await tick();
    // queued, not preempted: choice still up, level-up not shown
    expect(activeModalTitle(hud)).toBe('CHOOSE YOUR PATH');
    expect((hud as any).modalQueue.length).toBe(1);
    expect(lvlSettled).toBe(false);
    // player picks a path via keyboard
    fireDocKey('1');
    await tick();
    expect(objectives.currentStageId).toBe('s1');
    // the queued level-up now shows
    expect(activeModalTitle(hud)).toBe('LEVEL UP');
    clickFirstModalButton(hud);
    await tick();
    expect(lvlSettled).toBe(true);
    expect((hud as any).activeModal).toBeNull();
    expect(engine.state).toBe('playing');
  });

  it('abandoning the choice modal settles CHOICE_ABANDONED and releases the sequencer', async () => {
    const { hud, engine, objectives } = wire();
    // count showChoice invocations via the keydown listener registrations
    let choiceOpens = 0;
    const origAdd = (globalThis as any).document.addEventListener;
    (globalThis as any).document.addEventListener = (t: string, fn: Function) => {
      if (t === 'keydown') choiceOpens++;
      return origAdd(t, fn);
    };
    objectives.addProgress(1, 'kill');
    expect(choiceOpens).toBe(1);
    // teardown (restart / clearOverlays) abandons the modal mid-run
    hud.clearOverlays();
    await tick();
    await tick();
    // sequencer released, not frozen: nothing advanced, run not done...
    expect(objectives.done).toBe(false);
    expect(objectives.currentStageIndex).toBe(0);
    // ...and completing the stage again re-opens the choice (no soft-lock)
    objectives.addProgress(1, 'kill');
    expect(choiceOpens).toBe(2);
    expect(engine.win).not.toHaveBeenCalled();
  });

  it('R5-N1: drains a queue deeper than one, in order, with every promise settled', async () => {
    const { hud, engine, objectives } = wire();
    objectives.addProgress(1, 'kill');
    expect(activeModalTitle(hud)).toBe('CHOOSE YOUR PATH');
    const l1 = hud.showLevelUp([{ id: 'a', name: 'A', desc: 'd' } as any]);
    const l2 = hud.showLevelUp([{ id: 'b', name: 'B', desc: 'd' } as any]);
    const settled: string[] = [];
    void l1.then((id) => { settled.push(id); });
    void l2.then((id) => { settled.push(id); });
    await tick();
    expect((hud as any).modalQueue.length).toBe(2);
    fireDocKey('1'); // pick the branch
    await tick();
    expect(activeModalTitle(hud)).toBe('LEVEL UP');
    clickFirstModalButton(hud); // first queued upgrade
    await tick();
    // the second queued modal surfaces — not wiped by trackModal (R5-N1)
    expect(activeModalTitle(hud)).toBe('LEVEL UP');
    expect(settled).toEqual(['a']);
    clickFirstModalButton(hud);
    await tick();
    expect(settled).toEqual(['a', 'b']);
    expect((hud as any).activeModal).toBeNull();
    expect((hud as any).modalQueue.length).toBe(0);
    expect(engine.state).toBe('playing');
  });

  it('queued level-ups are dropped on clearOverlays, never leak into the next run', async () => {
    const { hud, objectives } = wire();
    objectives.addProgress(1, 'kill');
    const lvl = hud.showLevelUp([{ id: 'vigor', name: 'Vigor', desc: '+hp' } as any]);
    let lvlSettled = false;
    void lvl.then(() => { lvlSettled = true; });
    await tick();
    expect((hud as any).modalQueue.length).toBe(1);
    hud.clearOverlays();
    await tick();
    expect((hud as any).modalQueue.length).toBe(0);
    expect((hud as any).activeModal).toBeNull();
    expect(lvlSettled).toBe(false);
  });
});

describe('R4-N1: stagesCleared is branch-aware', () => {
  it('cleared counts completed chapters, not quest-graph array positions', async () => {
    const { objectives } = wire();
    objectives.addProgress(1, 'kill'); // completes s0 (choice)
    fireDocKey('2'); // pick Dusk -> s2 (array index 2)
    await tick();
    expect(objectives.currentStageId).toBe('s2');
    expect(objectives.currentStageIndex).toBe(2);
    // one chapter cleared — the difficulty metric must NOT read 2
    expect(objectives.stagesCleared).toBe(1);
  });

  it('both branches report the same cleared count per chapter', async () => {
    const w1 = wire();
    w1.objectives.addProgress(1, 'kill');
    fireDocKey('1');
    await tick();
    const w2 = wire();
    w2.objectives.addProgress(1, 'kill');
    fireDocKey('2');
    await tick();
    expect(w1.objectives.stagesCleared).toBe(w2.objectives.stagesCleared);
    expect(w1.objectives.stagesCleared).toBe(1);
  });
});
