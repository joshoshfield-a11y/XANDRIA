/**
 * UPGRADE LOOP (hardcore-ironman): hardcore / ironman permadeath mode.
 * - the score-bonus table is well-formed (cycles 0..8, strictly
 *   increasing, cycle 0 = 2.0x) with safe guards + clamps
 * - per-slot ironman/dead flags: defaults, one-way marking, strict
 *   booleans on hand-edited stores, per-slot isolation, no un-mark
 * - the run journal records the ironman flag and migrates old entries
 * - HUD: IRONMAN chip (hidden when inactive, cached repeat calls),
 *   end screen hides RESTART + NG+ offer and shows the dead line when
 *   the slot died, title picker confirm step + dead-slot start block
 * (The death branch itself + the run-completion marking are covered by
 * tests/e2e/ironman.spec.ts through the real death path.)
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

import { HUD } from '../src/engine/game/HUD';
import type { GameSpec } from '../src/spec/schema';
import {
  IRONMAN_TABLE,
  ironmanBonusText,
  ironmanRowByCycle,
  ironmanScoreMult,
} from '../src/engine/game/ironman';
import {
  _setProfileStorage,
  createSlot,
  getActiveSlot,
  isActiveSlotDead,
  isActiveSlotIronman,
  loadProfile,
  loadSlots,
  markActiveSlotDead,
  markActiveSlotIronman,
  recordJournalEntry,
  saveProfile,
  setActiveSlotId,
  slotSummaries,
  SLOTS_KEY,
  type SlotStore,
} from '../src/engine/game/Profile';

// Minimal DOM stub (mirrors new-game-plus.test.ts): HUD builds all of its
// elements through document.createElement, so the stub must exist before
// any HUD construction in this file.
(globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
(globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
(globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    _map: m,
  };
}

let mem: ReturnType<typeof memStore>;
beforeEach(() => {
  mem = memStore();
  _setProfileStorage(mem);
});

function rawStore(): SlotStore {
  return JSON.parse(mem._map.get(SLOTS_KEY)!);
}

describe('ironman tuning table', () => {
  it('covers cycles 0..8 with cycle 0 at 2.0x and strictly increasing multipliers', () => {
    expect(IRONMAN_TABLE.map((r) => r.cycle)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(IRONMAN_TABLE[0].scoreMult).toBe(2.0);
    for (let i = 1; i < IRONMAN_TABLE.length; i++) {
      expect(IRONMAN_TABLE[i].scoreMult).toBeGreaterThan(IRONMAN_TABLE[i - 1].scoreMult);
    }
  });
  it('guards + clamps: unknown/negative/NaN -> cycle 0, above -> cycle 8', () => {
    expect(ironmanScoreMult(0)).toBe(2.0);
    expect(ironmanScoreMult(3)).toBe(2.75);
    expect(ironmanScoreMult(-2)).toBe(2.0);
    expect(ironmanScoreMult(NaN)).toBe(2.0);
    expect(ironmanScoreMult(99)).toBe(4.0);
    expect(ironmanRowByCycle(8).scoreMult).toBe(4.0);
    expect(ironmanRowByCycle(8.9).scoreMult).toBe(4.0);
  });
  it('bonus text formats whole and fractional multipliers', () => {
    expect(ironmanBonusText(2.0)).toBe('IRONMAN ×2.0');
    expect(ironmanBonusText(2.25)).toBe('IRONMAN ×2.25');
    expect(ironmanBonusText(NaN)).toBe('IRONMAN ×2.0');
  });
});

describe('per-slot ironman/dead flags', () => {
  it('fresh slots are normal and alive', () => {
    const st = loadSlots();
    expect(st.slots.every((s) => s.ironman === false && s.dead === false)).toBe(true);
    expect(isActiveSlotIronman()).toBe(false);
    expect(isActiveSlotDead()).toBe(false);
    expect(slotSummaries().every((s) => s.ironman === false && s.dead === false)).toBe(true);
  });
  it('marking ironman persists and is per-slot; marking dead persists and is never cleared by reload', () => {
    markActiveSlotIronman();
    expect(isActiveSlotIronman()).toBe(true);
    expect(rawStore().slots[0].ironman).toBe(true);
    markActiveSlotDead();
    expect(isActiveSlotDead()).toBe(true);
    expect(rawStore().slots[0].dead).toBe(true);
    // reload + slot switch round-trip: flags ride with their own slot
    setActiveSlotId('slot-2');
    expect(isActiveSlotIronman()).toBe(false);
    expect(isActiveSlotDead()).toBe(false);
    setActiveSlotId('slot-1');
    expect(isActiveSlotIronman()).toBe(true);
    expect(isActiveSlotDead()).toBe(true);
    // a fresh slot is unaffected
    createSlot('Fresh');
    expect(isActiveSlotIronman()).toBe(false);
    expect(isActiveSlotDead()).toBe(false);
  });
  it('hand-edited stores: only strict true counts (no truthy resurrection/kill)', () => {
    loadSlots(); // seed the store before hand-editing it
    const st = rawStore();
    (st.slots[0] as any).ironman = 'yes';
    (st.slots[0] as any).dead = 1;
    (st.slots[1] as any).ironman = 1;
    mem._map.set(SLOTS_KEY, JSON.stringify(st));
    const reloaded = loadSlots();
    expect(reloaded.slots[0].ironman).toBe(false);
    expect(reloaded.slots[0].dead).toBe(false);
    expect(reloaded.slots[1].ironman).toBe(false);
  });
  it('profile save/load never touches the slot flags', () => {
    markActiveSlotIronman();
    const p = loadProfile();
    p.merit = 42;
    saveProfile(p);
    expect(getActiveSlot().ironman).toBe(true);
    expect(loadProfile().merit).toBe(42);
  });
});

describe('journal ironman flag', () => {
  it('an ironman entry round-trips; a legacy entry migrates to ironman:false', () => {
    const p = loadProfile();
    recordJournalEntry(p, {
      startUtc: '2026-10-26T00:00:00.000Z', seed: 7, genre: 'fps-arena',
      duration: 60, kills: 3, deaths: 1, portals: 0, xpGained: 0,
      bossesKilled: 0, result: 'lost', ironman: true,
    });
    saveProfile(p);
    const reloaded = loadProfile();
    expect(reloaded.journal[0].ironman).toBe(true);
    // legacy entry (no flag) fed through migration reads false, never throws
    const legacy = loadProfile();
    legacy.journal = [{ startUtc: '2026-10-25T00:00:00.000Z', seed: 1, genre: 'fps-arena',
      duration: 30, kills: 1, deaths: 0, portals: 0, xpGained: 0,
      bossesKilled: 0, result: 'won' } as any, ...legacy.journal];
    saveProfile(legacy);
    expect(loadProfile().journal[0].ironman).toBe(false);
    expect(loadProfile().journal[1].ironman).toBe(true);
  });
});

describe('HUD ironman chip + end screen + title picker', () => {
  const hudSpec = () => ({ meta: { name: 'Test' }, objective: { description: 'Do it' } }) as unknown as GameSpec;
  function makeHud() {
    const container = makeEl();
    const hud = new HUD(container, hudSpec());
    return { hud, root: (hud as any).root };
  }
  const findByClass = (el: any, cls: string): any =>
    el.children.find((c: any) => typeof c.className === 'string' && c.className.split(' ').includes(cls));
  const findById = (el: any, id: string): any => {
    if (el.id === id) return el;
    for (const c of el.children ?? []) {
      const hit = findById(c, id);
      if (hit) return hit;
    }
    return null;
  };
  const stopEv = () => ({ stopPropagation() {} });

  it('setIronman hides when inactive, shows IRONMAN when active, repeat calls no-op', () => {
    const { hud } = makeHud();
    const chip = (hud as any).ironmanEl;
    hud.setIronman(false);
    expect(chip.style.display).toBe('none');
    expect(chip.textContent).toBe('');
    hud.setIronman(true);
    expect(chip.style.display).toBe('');
    expect(chip.textContent).toBe('IRONMAN');
    chip.textContent = 'TAMPERED';
    hud.setIronman(true); // cached — no rewrite
    expect(chip.textContent).toBe('TAMPERED');
    hud.setIronman(false);
    expect(chip.style.display).toBe('none');
  });
  it('showEnd with ironmanDead hides RESTART + NG+ offer and shows the dead line', () => {
    const { hud, root } = makeHud();
    hud.showEnd(false, {
      score: 100, time: 60, kills: 2, level: 1, stagesCleared: 0,
      deaths: 1, portals: 0, xpGained: 0, bossesKilled: 0, seed: 7,
      ironman: true, ironmanMult: 2.0, ironmanDead: true,
    }, undefined, { targetCycle: 1, onEnter: () => { throw new Error('NG+ must not be offered to a dead slot'); } });
    const ov = root.children.find((c: any) => typeof c.className === 'string' && c.className.includes('overlay'));
    const btnWrap = ov.children.find((c: any) => c.children?.some((b: any) => b.textContent === 'TITLE'));
    expect(btnWrap.children.map((b: any) => b.textContent)).toEqual(['TITLE']);
    expect(findById(ov, 'xandria-ironman-dead')?.textContent).toContain('NO RESPAWN');
    const recap = findById(ov, 'xandria-run-recap');
    expect(recap.textContent).toContain('IRONMAN ×2.0');
    expect(recap.textContent).toContain('DEATHS 1');
  });
  it('showEnd ironman win keeps RESTART + NG+ and shows the bonus bit', () => {
    const { hud, root } = makeHud();
    hud.showEnd(true, {
      score: 2000, time: 60, kills: 2, level: 1, stagesCleared: 0,
      deaths: 0, portals: 0, xpGained: 0, bossesKilled: 0, seed: 7,
      ironman: true, ironmanMult: 2.0,
    }, undefined, { targetCycle: 1, onEnter: () => {} });
    const ov = root.children.find((c: any) => typeof c.className === 'string' && c.className.includes('overlay'));
    const btnWrap = ov.children.find((c: any) => c.children?.some((b: any) => b.textContent === 'TITLE'));
    expect(btnWrap.children.map((b: any) => b.textContent)).toEqual(['RESTART', 'TITLE', 'NEW GAME+ 1']);
    expect(findById(ov, 'xandria-ironman-dead')).toBe(null);
  });
  it('title picker: IRONMAN button opens the confirm step; confirm fires onStartIronman, cancel closes', () => {
    const { hud, root } = makeHud();
    let confirmed = 0;
    hud.showTitle({
      name: 'Test', premise: 'Go', controls: ['WASD'],
      onStart: () => { throw new Error('normal start must not fire from the picker confirm path'); },
      slots: [{ id: 'slot-1', name: 'Slot 1', active: true, merit: 0, runs: 0, playtimeMin: 0, updatedAt: 0, ironman: false, dead: false }],
      ironmanActive: false, slotDead: false,
      onStartIronman: () => { confirmed++; },
    });
    const ov = root.children.find((c: any) => typeof c.className === 'string' && c.className.includes('overlay'));
    const picker = findByClass(ov, 'mode-picker');
    expect(picker).toBeTruthy();
    const btn = findById(ov, 'xandria-ironman-btn');
    const confirm = findById(ov, 'xandria-ironman-confirm');
    expect(confirm.style.display).toBe('none');
    btn.__fire('click', stopEv());
    expect(confirm.style.display).toBe('');
    const ok = findByClass(confirm, 'ironman-confirm-ok');
    ok.__fire('click', stopEv());
    expect(confirmed).toBe(1);
    // cancel path: reopen, then cancel hides the dialog without confirming
    btn.__fire('click', stopEv());
    const cancel = findByClass(confirm, 'ironman-confirm-cancel');
    cancel.__fire('click', stopEv());
    expect(confirm.style.display).toBe('none');
    expect(confirmed).toBe(1);
  });
  it('title picker on an ironman slot starts directly; on a dead slot blocks start entirely', () => {
    const { hud, root } = makeHud();
    let started = 0;
    hud.showTitle({
      name: 'Test', premise: 'Go', controls: ['WASD'],
      onStart: () => { started++; },
      slots: [{ id: 'slot-1', name: 'Slot 1', active: true, merit: 0, runs: 0, playtimeMin: 0, updatedAt: 0, ironman: true, dead: false }],
      ironmanActive: true, slotDead: false,
      onStartIronman: () => {},
    });
    let ov = root.children.find((c: any) => typeof c.className === 'string' && c.className.includes('overlay'));
    const btn = findById(ov, 'xandria-ironman-btn');
    expect(btn.textContent).toContain('✓');
    btn.__fire('click', stopEv());
    expect(started).toBe(1);

    // dead slot: notice present, start button disabled, no overlay click-to-start
    hud.showTitle({
      name: 'Test', premise: 'Go', controls: ['WASD'],
      onStart: () => { started++; },
      slots: [{ id: 'slot-1', name: 'Slot 1', active: true, merit: 0, runs: 1, playtimeMin: 5, updatedAt: 0, ironman: true, dead: true }],
      ironmanActive: true, slotDead: true,
      onStartIronman: () => {},
    });
    ov = root.children.find((c: any) => typeof c.className === 'string' && c.className.includes('overlay'));
    expect(findById(ov, 'xandria-slot-dead-notice')?.textContent).toContain('DEAD');
    expect(findByClass(ov, 'mode-picker')).toBeFalsy();
    const startBtn = ov.children.find((c: any) => c.className === 'start-btn');
    expect(startBtn.disabled).toBe(true);
    expect(ov.__listeners.click).toBeFalsy();
    const slotRow = ov.children.flatMap((c: any) => c.children ?? [])
      .find((c: any) => typeof c.className === 'string' && c.className.includes('slot-row'));
    expect(slotRow.className).toContain('dead');
  });
});
