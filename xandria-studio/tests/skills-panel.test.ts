/**
 * skills-panel.test.ts — skills wave (SkillsPanel unit tests, fake DOM).
 * - show/hide/toggle/isOpen; chip click toggles (touch entry point)
 * - skill cards: names, RANK n/3, XP bar, per-rank effect lines
 * - gated recipes: LOCKED vs UNLOCKED from live skill ranks
 * - K toggles, Esc closes; isModalOpen blocks K-open; typing guard
 * - dispose removes listeners + elements
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { defaultSpec } from '../src/spec/schema';
import {
  buildRecipePool,
  ensureCraftingItemDefs,
  STATION_IDS,
  type CraftingRecipe,
} from '../src/engine/game/crafting';
import { SkillSystem, SKILL_SMITHING } from '../src/engine/game/skills';
import type { Engine } from '../src/engine/Engine';
import { SkillsPanel, type SkillsPanelOpts } from '../src/engine/ui/SkillsPanel';

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

function fakeEngine(): Engine {
  return { spec: { custom: {} }, audio: undefined } as unknown as Engine;
}

/** collect all textContent in the subtree */
function texts(root: any): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (typeof n.textContent === 'string' && n.textContent) out.push(n.textContent);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

interface Harness {
  panel: SkillsPanel;
  doc: any;
  win: any;
  container: any;
  skills: SkillSystem;
  pool: CraftingRecipe[];
  root: any;
}

function makeHarness(opts: Partial<SkillsPanelOpts> = {}): Harness {
  const spec = defaultSpec(4242);
  ensureCraftingItemDefs(spec);
  const defs = spec.custom!.items!.defs!;
  const pool = buildRecipePool(spec);
  const skills = new SkillSystem(fakeEngine());
  const win = makeWindow();
  const doc: any = {
    createElement: (t: string) => makeEl(t),
    createTextNode: (t: string) => { const e = makeEl('#text'); e.textContent = t; return e; },
    defaultView: win,
  };
  const container = makeEl('div');
  const panel = new SkillsPanel({
    container,
    doc,
    skills: () => skills,
    recipes: () => pool,
    defs: () => defs,
    inventory: () => null,
    stationIds: () => new Set(STATION_IDS),
    playerLevel: () => 1,
    ...opts,
  });
  const root = container.children.find((c: any) => c.id === 'xandria-skills-panel');
  return { panel, doc, win, container, skills, pool, root };
}

describe('SkillsPanel', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('starts closed; show/hide/toggle flip isOpen', () => {
    expect(h.panel.isOpen).toBe(false);
    h.panel.show();
    expect(h.panel.isOpen).toBe(true);
    expect(h.root.style.display).toBe('flex');
    h.panel.hide();
    expect(h.panel.isOpen).toBe(false);
    expect(h.root.style.display).toBe('none');
    h.panel.toggle();
    expect(h.panel.isOpen).toBe(true);
    h.panel.toggle();
    expect(h.panel.isOpen).toBe(false);
  });

  it('renders one card per skill with name, rank and xp label', () => {
    h.panel.show();
    const t = texts(h.root).join('\n');
    expect(t).toContain('Foraging');
    expect(t).toContain('Smithing');
    expect(t).toContain('Alchemy');
    expect(t).toContain('RANK 1/3');
    expect(t).toContain('0 / 60 XP to rank 2'); // foraging thresholds
  });

  it('rank and xp label update after XP gains + refresh', () => {
    h.panel.show();
    h.skills.addXp('foraging', 60);
    h.panel.refresh();
    const t = texts(h.root).join('\n');
    expect(t).toContain('RANK 2/3');
    expect(t).toContain('60 / 180 XP to rank 3');
  });

  it('gated recipes show LOCKED at rank 1 and UNLOCKED after ranking up', () => {
    const gated = h.pool.filter((r) => r.skillId === SKILL_SMITHING && (r.minSkillRank ?? 1) >= 2);
    expect(gated.length).toBeGreaterThan(0);
    h.panel.show();
    let t = texts(h.root).join('\n');
    for (const r of gated) {
      expect(t).toContain(`LOCKED — ${r.name}`);
    }
    h.skills.addXp(SKILL_SMITHING, 80); // rank 2
    h.panel.refresh();
    t = texts(h.root).join('\n');
    for (const r of gated.filter((r) => (r.minSkillRank ?? 1) <= 2)) {
      expect(t).toContain(`UNLOCKED — ${r.name}`);
    }
  });

  it('K toggles, Esc closes (capture-phase handler)', () => {
    h.win.keydown('KeyK');
    expect(h.panel.isOpen).toBe(true);
    h.win.keydown('KeyK');
    expect(h.panel.isOpen).toBe(false);
    h.win.keydown('KeyK');
    expect(h.panel.isOpen).toBe(true);
    h.win.keydown('Escape');
    expect(h.panel.isOpen).toBe(false);
  });

  it('K does not open while another modal owns input, or while typing', () => {
    const h2 = makeHarness({ isModalOpen: () => true });
    h2.win.keydown('KeyK');
    expect(h2.panel.isOpen).toBe(false);
    h2.panel.dispose();
    const input = makeEl('input');
    input.tagName = 'INPUT';
    h.win.keydown('KeyK', input);
    expect(h.panel.isOpen).toBe(false);
  });

  it('chip click toggles; chip hides while open', () => {
    const chip = h.panel.chipEl;
    expect(chip.style.display).not.toBe('none');
    chip.click();
    expect(h.panel.isOpen).toBe(true);
    expect(chip.style.display).toBe('none');
    chip.click();
    expect(h.panel.isOpen).toBe(false);
    expect(chip.style.display).not.toBe('none');
  });

  it('null skills render the honest empty state', () => {
    const h2 = makeHarness({ skills: () => null });
    h2.panel.show();
    expect(texts(h2.root).join('\n')).toContain('No skill data in this scene.');
    h2.panel.dispose();
  });

  it('dispose removes the keydown listener and the DOM nodes', () => {
    h.panel.show();
    const before = h.win._listeners['keydown'].length;
    expect(before).toBeGreaterThan(0);
    h.panel.dispose();
    expect(h.win._listeners['keydown'].length).toBe(before - 1);
    expect(h.container.children.includes(h.root)).toBe(false);
    expect(h.container.children.includes(h.panel.chipEl)).toBe(false);
    // second dispose is a no-op
    expect(() => h.panel.dispose()).not.toThrow();
  });
});
