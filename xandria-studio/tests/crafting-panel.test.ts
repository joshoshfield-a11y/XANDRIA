/**
 * Crafting wave (workstream C): CraftingPanel unit tests (fake DOM).
 * - show/hide/isOpen; station name lands in the header
 * - recipe rows mirror checkCraft(): available vs missing-ingredients vs
 *   missing-station states, honest reason text
 * - one-click craft -> queue -> timed completion grants the output and
 *   consumes ingredients; failure toasts; queue cap
 * - stale queue (ingredients spent mid-queue) fails honestly, consumes nothing
 * - Esc/E closes the panel (capture-phase handler)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import {
  buildRecipePool,
  ensureCraftingItemDefs,
  STATION_IDS,
  type CraftingRecipe,
} from '../src/engine/game/crafting';
import { ensureLootItemDefs } from '../src/engine/game/loot';
import { CraftingPanel, type CraftingPanelOpts } from '../src/engine/ui/CraftingPanel';

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
    getAttribute: () => null,
    addEventListener(t: string, fn: (e: any) => void) { (el._listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: (e: any) => void) {
      el._listeners[t] = (el._listeners[t] ?? []).filter((f: (e: any) => void) => f !== fn);
    },
    createTextNode: (t: string) => ({ textContent: t, parentNode: null, remove() {} }),
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
      const e = { code, stopped: false, prevented: false, stopPropagation() { e.stopped = true; }, preventDefault() { e.prevented = true; } };
      for (const fn of this._listeners['keydown'] ?? []) fn(e);
      return e;
    },
  };
}

function makeInv() {
  const m = new Map<string, number>();
  return {
    add: (id: string, n = 1) => { m.set(id, (m.get(id) ?? 0) + n); return 0; },
    remove: (id: string, n = 1) => {
      const have = m.get(id) ?? 0;
      const r = Math.min(have, n);
      m.set(id, have - r);
      return r;
    },
    count: (id: string) => m.get(id) ?? 0,
  };
}

interface Harness {
  panel: CraftingPanel;
  doc: any;
  win: any;
  inv: ReturnType<typeof makeInv>;
  toasts: string[];
  pool: CraftingRecipe[];
  rowsEl: any;
}

function makeHarness(opts: Partial<CraftingPanelOpts> = {}): Harness {
  const spec = defaultSpec(4242) as GameSpec;
  ensureCraftingItemDefs(spec);
  // master recipes consume loot materials — mirror the real blueprint
  // boot, which runs both ensure calls (loot's is additive and
  // non-destructive here since custom.items already exists)
  ensureLootItemDefs(spec);
  const defs = spec.custom!.items!.defs!;
  const pool = buildRecipePool(spec);
  const inv = makeInv();
  const toasts: string[] = [];
  const win = makeWindow();
  const doc: any = {
    createElement: (t: string) => makeEl(t),
    createTextNode: (t: string) => makeEl('#text'),
    defaultView: win,
  };
  const container = makeEl('div');
  const panel = new CraftingPanel({
    container,
    doc,
    inventory: () => inv,
    defs: () => defs,
    recipes: () => pool,
    stationIds: () => new Set<string>(STATION_IDS),
    playerLevel: () => 1,
    toast: (m) => toasts.push(m),
    ...opts,
  });
  const rowsEl = (panel as any).rowsEl;
  return { panel, doc, win, inv, toasts, pool, rowsEl };
}

/** all row elements currently rendered */
function rows(h: Harness): any[] {
  return [...(h.rowsEl.children as any[])];
}
/** the CRAFT button of a row */
function craftButton(row: any): any {
  const bottom = row.children[2];
  return bottom.children[1];
}
/** all text under a row */
function rowText(row: any): string {
  const out: string[] = [];
  const walk = (e: any) => {
    if (typeof e.textContent === 'string' && e.textContent) out.push(e.textContent);
    for (const c of e.children ?? []) walk(c);
  };
  walk(row);
  return out.join(' | ');
}

beforeEach(() => {
  (globalThis as any).window = makeWindow();
});

describe('CraftingPanel open/close', () => {
  it('show() opens with the station name; hide() closes; isOpen tracks', () => {
    const h = makeHarness();
    expect(h.panel.isOpen).toBe(false);
    h.panel.show('Ember Forge');
    expect(h.panel.isOpen).toBe(true);
    expect(((h.panel as any).headEl as any).textContent).toContain('Ember Forge');
    expect(rows(h)).toHaveLength(h.pool.length);
    h.panel.hide();
    expect(h.panel.isOpen).toBe(false);
    expect((h.panel as any).root.style.display).toBe('none');
    h.panel.dispose();
  });

  it('Escape and E close the panel via the capture-phase handler', () => {
    const h = makeHarness();
    h.panel.show('Ember Forge');
    const e = h.win.keydown('Escape');
    expect(e.stopped).toBe(true);
    expect(h.panel.isOpen).toBe(false);
    // closed: the handler ignores keys
    h.panel.show('Ember Forge');
    h.win.keydown('KeyE');
    expect(h.panel.isOpen).toBe(false);
    h.panel.dispose();
  });

  it('dispose removes the root and the key listener', () => {
    const h = makeHarness();
    const container = (h.panel as any).root.parentNode;
    h.panel.show('Ember Forge');
    h.panel.dispose();
    expect(container.children).toHaveLength(0);
    expect(h.win._listeners['keydown'] ?? []).toHaveLength(0);
    expect(() => h.panel.show('x')).not.toThrow(); // no-op after dispose
    expect(h.panel.isOpen).toBe(false);
  });
});

describe('CraftingPanel recipe states', () => {
  it('empty inventory: every row is honestly blocked, buttons disabled', () => {
    const h = makeHarness();
    h.panel.show('Ember Forge');
    for (const row of rows(h)) {
      expect(craftButton(row).disabled).toBe(true);
      // check order is min-level BEFORE missing-skill BEFORE
      // missing-ingredients (crafting.ts documents it); any of the three
      // is an honest block
      expect(rowText(row)).toMatch(/Missing ingredients\.|Requires level \d+|Requires \w+ rank \d+/);
    }
    h.panel.dispose();
  });

  it('funded recipe: its button enables; others stay disabled', () => {
    const h = makeHarness();
    const target = h.pool.find((r) => !r.stationId && !r.minLevel)!;
    for (const ing of target.ingredients) h.inv.add(ing.itemId, ing.count);
    h.panel.show('Ember Forge');
    const enabled = rows(h).filter((r) => !craftButton(r).disabled);
    expect(enabled).toHaveLength(1);
    expect(rowText(enabled[0])).toContain(target.name);
    h.panel.dispose();
  });

  it('missing-station: station-gated recipe names its station when none are present', () => {
    // skills wave + items-expansion: pass max skill ranks so neither
    // the skill gate nor a tier-2 minLevel gate is what fires — this
    // test exercises the missing-station row state only.
    const maxSkills = () => ({ rankOf: (_id: string) => 3, skillName: (id: string) => id });
    const h = makeHarness({ stationIds: () => new Set<string>(), skills: maxSkills });
    const target = h.pool.find((r) => r.stationId && !r.minLevel)!;
    for (const ing of target.ingredients) h.inv.add(ing.itemId, ing.count);
    h.panel.show('Ember Forge');
    const row = rows(h).find((r) => rowText(r).includes(target.name))!;
    expect(craftButton(row).disabled).toBe(true);
    expect(rowText(row)).toContain('Needs a');
    h.panel.dispose();
  });
  it('show(name, id) narrows the missing-station check to that station', () => {
    // the opts set has EVERY station, but the panel is open at the workbench:
    // a forge-gated recipe must be blocked, a workbench one must be open.
    // (max skill ranks + no minLevel-gated recipes, so neither the skill
    // gate nor the level gate is what fires — station narrowing only.)
    const maxSkills = () => ({ rankOf: (_id: string) => 3, skillName: (id: string) => id });
    const h = makeHarness({ skills: maxSkills });
    const forgeRecipe = h.pool.find((r) => r.stationId === 'station_forge' && !r.minLevel)!;
    const benchRecipe = h.pool.find((r) => r.stationId === 'station_workbench' && !r.minLevel)!;
    for (const r of [forgeRecipe, benchRecipe])
      for (const ing of r.ingredients) h.inv.add(ing.itemId, ing.count);
    h.panel.show("Tinker's Bench", 'station_workbench');
    const forgeRow = rows(h).find((r) => rowText(r).includes(forgeRecipe.name))!;
    const benchRow = rows(h).find((r) => rowText(r).includes(benchRecipe.name))!;
    expect(craftButton(forgeRow).disabled).toBe(true);
    expect(rowText(forgeRow)).toContain('Needs a Forge');
    expect(craftButton(benchRow).disabled).toBe(false);
    h.panel.dispose();
  });

  it('min-level: gated recipe shows the level requirement', () => {
    const h = makeHarness({ playerLevel: () => 1 });
    const target = h.pool.find((r) => (r.minLevel ?? 0) > 1)!;
    for (const ing of target.ingredients) h.inv.add(ing.itemId, ing.count);
    h.panel.show('Ember Forge');
    const row = rows(h).find((r) => rowText(r).includes(target.name))!;
    expect(craftButton(row).disabled).toBe(true);
    expect(rowText(row)).toContain(`Requires level ${target.minLevel}`);
    h.panel.dispose();
  });

  it('no inventory: rows say so honestly, buttons disabled', () => {
    const h = makeHarness({ inventory: () => null });
    h.panel.show('Ember Forge');
    for (const row of rows(h)) {
      expect(craftButton(row).disabled).toBe(true);
      expect(rowText(row)).toContain('No inventory in this scene.');
    }
    h.panel.dispose();
  });
});

describe('CraftingPanel queue', () => {
  it('one click -> queue -> timed completion grants output, consumes ingredients', () => {
    const h = makeHarness({ queueSeconds: 1.0 });
    const target = h.pool.find((r) => !r.stationId && !r.minLevel)!;
    for (const ing of target.ingredients) h.inv.add(ing.itemId, ing.count + 2); // keep a surplus
    h.panel.show('Ember Forge');
    const row = rows(h).find((r) => rowText(r).includes(target.name))!;
    craftButton(row).click();
    expect(h.panel.queuedIds).toEqual([target.id]);
    h.panel.update(0.6);
    expect(h.panel.queuedIds).toEqual([target.id]); // not done yet
    expect(h.inv.count(target.output.itemId)).toBe(0);
    h.panel.update(0.5); // t = 1.1 >= 1.0
    expect(h.panel.queuedIds).toEqual([]);
    expect(h.inv.count(target.output.itemId)).toBe(target.output.count);
    for (const ing of target.ingredients) {
      expect(h.inv.count(ing.itemId)).toBe(2); // surplus minus consumed
    }
    expect(h.toasts.some((t) => t.startsWith('Crafted'))).toBe(true);
    h.panel.dispose();
  });

  it('stale queue (ingredients spent mid-queue) fails honestly and consumes nothing', () => {
    const h = makeHarness({ queueSeconds: 1.0 });
    const target = h.pool.find((r) => !r.stationId && !r.minLevel)!;
    for (const ing of target.ingredients) h.inv.add(ing.itemId, ing.count);
    h.panel.show('Ember Forge');
    const row = rows(h).find((r) => rowText(r).includes(target.name))!;
    craftButton(row).click();
    // spend the ingredients elsewhere before the timer completes
    for (const ing of target.ingredients) h.inv.remove(ing.itemId, ing.count);
    h.panel.update(1.5);
    expect(h.inv.count(target.output.itemId)).toBe(0);
    expect(h.toasts.some((t) => t.includes('Missing ingredients'))).toBe(true);
    h.panel.dispose();
  });

  it('queue cap: the 6th craft toasts instead of queuing', () => {
    const h = makeHarness({ queueSeconds: 60, queueCap: 5 });
    const target = h.pool.find((r) => !r.stationId && !r.minLevel)!;
    for (const ing of target.ingredients) h.inv.add(ing.itemId, ing.count * 10);
    h.panel.show('Ember Forge');
    const row = rows(h).find((r) => rowText(r).includes(target.name))!;
    const btn = craftButton(row);
    for (let i = 0; i < 6; i++) btn.click();
    expect(h.panel.queuedIds).toHaveLength(5);
    expect(h.toasts.some((t) => t.includes('Queue full'))).toBe(true);
    h.panel.dispose();
  });

  it('onCrafted fires with the completed recipe (skill-XP hook)', () => {
    const crafted: string[] = [];
    const h = makeHarness({ queueSeconds: 1.0, onCrafted: (r) => crafted.push(r.id) });
    const target = h.pool.find((r) => !r.stationId && !r.minLevel)!;
    for (const ing of target.ingredients) h.inv.add(ing.itemId, ing.count + 2);
    h.panel.show('Ember Forge');
    const row = rows(h).find((r) => rowText(r).includes(target.name))!;
    craftButton(row).click();
    h.panel.update(0.5);
    expect(crafted).toEqual([]); // not done yet
    h.panel.update(0.6); // t = 1.1 >= 1.0
    expect(crafted).toEqual([target.id]);
    h.panel.dispose();
  });

  it('onCrafted does NOT fire when the queue completion fails re-validation', () => {
    const crafted: string[] = [];
    const h = makeHarness({ queueSeconds: 1.0, onCrafted: (r) => crafted.push(r.id) });
    const target = h.pool.find((r) => !r.stationId && !r.minLevel)!;
    for (const ing of target.ingredients) h.inv.add(ing.itemId, ing.count);
    h.panel.show('Ember Forge');
    const row = rows(h).find((r) => rowText(r).includes(target.name))!;
    craftButton(row).click();
    for (const ing of target.ingredients) h.inv.remove(ing.itemId, ing.count);
    h.panel.update(1.5);
    expect(crafted).toEqual([]);
    h.panel.dispose();
  });

  it('craftTimeMult scales the queue duration at enqueue time', () => {
    const h = makeHarness({ queueSeconds: 1.0, craftTimeMult: () => 0.5 });
    const target = h.pool.find((r) => !r.stationId && !r.minLevel)!;
    for (const ing of target.ingredients) h.inv.add(ing.itemId, ing.count + 2);
    h.panel.show('Ember Forge');
    const row = rows(h).find((r) => rowText(r).includes(target.name))!;
    craftButton(row).click();
    h.panel.update(0.5); // t = 0.5 >= 1.0 * 0.5 -> completes early
    expect(h.panel.queuedIds).toEqual([]);
    expect(h.inv.count(target.output.itemId)).toBe(target.output.count);
    h.panel.dispose();
  });

  it('update() is a no-op when closed; rows refresh on show and queue completion', () => {
    const h = makeHarness();
    const target = h.pool.find((r) => !r.stationId && !r.minLevel)!;
    h.panel.show('Ember Forge');
    let row = rows(h).find((r) => rowText(r).includes(target.name))!;
    expect(craftButton(row).disabled).toBe(true);
    // no timer re-render: update() ticks the queue but leaves rows alone
    for (const ing of target.ingredients) h.inv.add(ing.itemId, ing.count);
    h.panel.update(10);
    row = rows(h).find((r) => rowText(r).includes(target.name))!;
    expect(craftButton(row).disabled).toBe(true); // stale until re-show/completion
    h.panel.show('Ember Forge'); // re-open refreshes
    row = rows(h).find((r) => rowText(r).includes(target.name))!;
    expect(craftButton(row).disabled).toBe(false);
    h.panel.hide();
    expect(() => h.panel.update(10)).not.toThrow();
    h.panel.dispose();
  });
});
