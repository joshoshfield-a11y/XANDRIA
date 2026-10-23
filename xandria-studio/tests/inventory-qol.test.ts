/**
 * Inventory-qol wave unit tests.
 *
 * Model (Inventory): junk marking (per item id), acquisition order
 * (deterministic event counter), serialize/deserialize/restore round-trips.
 * View helpers (inventoryView): tier derivation, power score, filter/sort
 * projection. HUD (fake DOM): toolbar renders, filter/sort drive the
 * visible cells, junk-mode + right-click toggling, mark-shown, sell-junk
 * (exact scrap math + confirm), destroy-junk (confirm), touch targets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Inventory } from '../src/engine/game/items/Inventory';
import {
  ITEM_TIERS,
  itemTierOf,
  rarityIndex,
  powerScore,
  NO_FILTER,
  SORT_MODE_LABELS,
  applyInventoryView,
  type InventoryFilter,
  type InventorySortMode,
} from '../src/engine/game/items/inventoryView';
import { InventoryHUD } from '../src/engine/ui/InventoryHUD';
import type { ItemDef } from '../src/spec/schema';

const defs: Record<string, ItemDef> = {
  'loot_ironfang_blade': {
    name: 'Ironfang Blade', type: 'weapon', slot: 'weapon', rarity: 'rare',
    stats: { damage: 9 }, stack: 1, value: 120,
  },
  'loot_scorched_plate': {
    name: 'Scorched Plate', type: 'armor', slot: 'torso', rarity: 'uncommon',
    stats: { defense: 4 }, stack: 1, value: 60,
  },
  'loot_surge_tonic': {
    name: 'Surge Tonic', type: 'consumable', rarity: 'common',
    behavior: { effect: 'heal', amount: 30 }, stack: 5, value: 20,
  },
  'mat_ore': { name: 'Ore', type: 'material', rarity: 'common', stack: 99, value: 4 },
  'craft_ember_blade': {
    name: 'Ember Blade', type: 'weapon', slot: 'weapon', rarity: 'epic',
    stats: { damage: 14, crit: 3 }, stack: 1, value: 320,
  },
  'quest_bloodied_token': {
    name: 'Bloodied Token', type: 'key', rarity: 'common', stack: 1,
  }, // no value -> unsellable
};

let inv: Inventory;
beforeEach(() => {
  inv = new Inventory(defs);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

// ------------------------------------------------------------ junk marking

describe('Inventory junk marking', () => {
  it('setJunk/isJunk round-trips per item id', () => {
    expect(inv.isJunk('mat_ore')).toBe(false);
    inv.setJunk('mat_ore', true);
    expect(inv.isJunk('mat_ore')).toBe(true);
    expect(inv.junkItemIds()).toEqual(['mat_ore']);
    inv.setJunk('mat_ore', false);
    expect(inv.isJunk('mat_ore')).toBe(false);
    expect(inv.junkItemIds()).toEqual([]);
  });

  it('setJunk twice is idempotent; unknown ids are ignored', () => {
    inv.setJunk('mat_ore', true);
    inv.setJunk('mat_ore', true);
    expect(inv.junkItemIds()).toEqual(['mat_ore']);
    inv.setJunk('nope', true);
    expect(inv.junkItemIds()).toEqual(['mat_ore']);
  });

  it('clearJunk drops all marks', () => {
    inv.setJunk('mat_ore', true);
    inv.setJunk('loot_ironfang_blade', true);
    inv.clearJunk();
    expect(inv.junkItemIds()).toEqual([]);
  });

  it('pruneJunk drops marks for items that no longer exist', () => {
    inv.add('mat_ore', 5);
    inv.setJunk('mat_ore', true);
    inv.remove('mat_ore', 5);
    expect(inv.count('mat_ore')).toBe(0);
    inv.pruneJunk();
    expect(inv.junkItemIds()).toEqual([]);
  });

  it('pruneJunk keeps marks while an equipped unit of the id exists', () => {
    inv.add('loot_ironfang_blade', 1);
    expect(inv.equip('loot_ironfang_blade')).not.toBeNull();
    inv.setJunk('loot_ironfang_blade', true);
    inv.pruneJunk();
    expect(inv.junkItemIds()).toEqual(['loot_ironfang_blade']);
  });

  it('junk marks do not change equip semantics', () => {
    inv.add('loot_ironfang_blade', 1);
    inv.setJunk('loot_ironfang_blade', true);
    expect(inv.equip('loot_ironfang_blade')).not.toBeNull();
    expect(inv.getEquipped('weapon')).toBe('loot_ironfang_blade');
  });
});

// ------------------------------------------------------------ acquisition order

describe('Inventory acquisition order', () => {
  it('acquiredOrder is 0 for never-added items, increasing with adds', () => {
    expect(inv.acquiredOrder('mat_ore')).toBe(0);
    inv.add('mat_ore', 1);
    const first = inv.acquiredOrder('mat_ore');
    expect(first).toBeGreaterThan(0);
    inv.add('loot_ironfang_blade', 1);
    expect(inv.acquiredOrder('loot_ironfang_blade')).toBeGreaterThan(first);
  });

  it('re-adding an id bumps it to newest', () => {
    inv.add('mat_ore', 1);
    inv.add('loot_ironfang_blade', 1);
    const before = inv.acquiredOrder('mat_ore');
    inv.add('mat_ore', 1);
    expect(inv.acquiredOrder('mat_ore')).toBeGreaterThan(before);
    expect(inv.acquiredOrder('mat_ore')).toBeGreaterThan(inv.acquiredOrder('loot_ironfang_blade'));
  });

  it('a full backpack add that fits nothing does not bump the order', () => {
    for (let i = 0; i < 24; i++) inv.add('loot_ironfang_blade', 1); // stack=1, 24 slots
    inv.add('mat_ore', 1);
    const oreOrder = inv.acquiredOrder('mat_ore');
    expect(inv.add('loot_surge_tonic', 1)).toBe(1); // leftover: nothing fit
    expect(inv.acquiredOrder('loot_surge_tonic')).toBe(0);
    expect(inv.acquiredOrder('mat_ore')).toBe(oreOrder);
  });
});

// ------------------------------------------------------------ serialize / restore

describe('Inventory serialize/deserialize/restore with junk + order', () => {
  it('round-trips junk marks and acquisition order', () => {
    inv.add('mat_ore', 3);
    inv.add('loot_ironfang_blade', 1);
    inv.setJunk('mat_ore', true);
    const json = inv.serialize();
    const fresh = Inventory.deserialize(defs, json);
    expect(fresh.isJunk('mat_ore')).toBe(true);
    expect(fresh.acquiredOrder('loot_ironfang_blade'))
      .toBeGreaterThan(fresh.acquiredOrder('mat_ore'));
    expect(fresh.count('mat_ore')).toBe(3);
  });

  it('drops junk marks for unknown ids, keeps the rest', () => {
    const json = JSON.stringify({
      version: 1,
      slots: [{ itemId: 'mat_ore', count: 2 }],
      equipped: {},
      junk: ['mat_ore', 'bogus_id'],
      acq: [['mat_ore', 7], ['bogus_id', 9], 'garbage'],
      acqSeq: 9,
    });
    const fresh = Inventory.deserialize(defs, json);
    expect(fresh.junkItemIds()).toEqual(['mat_ore']);
    expect(fresh.acquiredOrder('mat_ore')).toBe(7);
  });

  it('restore() copies junk + order onto a live inventory (portal path)', () => {
    inv.add('mat_ore', 3);
    inv.add('loot_ironfang_blade', 1);
    inv.setJunk('mat_ore', true);
    const json = inv.serialize();
    const live = new Inventory(defs);
    live.add('loot_surge_tonic', 2);
    live.restore(json);
    expect(live.count('mat_ore')).toBe(3);
    expect(live.count('loot_surge_tonic')).toBe(0); // wholesale replace
    expect(live.isJunk('mat_ore')).toBe(true);
    expect(live.acquiredOrder('loot_ironfang_blade'))
      .toBeGreaterThan(live.acquiredOrder('mat_ore'));
  });

  it('old saves without junk/acq fields still deserialize', () => {
    const json = JSON.stringify({
      version: 1,
      slots: [{ itemId: 'mat_ore', count: 2 }],
      equipped: {},
    });
    const fresh = Inventory.deserialize(defs, json);
    expect(fresh.count('mat_ore')).toBe(2);
    expect(fresh.junkItemIds()).toEqual([]);
    expect(fresh.acquiredOrder('mat_ore')).toBe(0);
  });
});

// ------------------------------------------------------------ view helpers

describe('inventoryView helpers', () => {
  it('itemTierOf follows the id-namespace convention', () => {
    expect(itemTierOf('mat_ore')).toBe('raw');
    expect(itemTierOf('mat_ember_shard')).toBe('raw');
    expect(itemTierOf('craft_ember_blade')).toBe('crafted');
    expect(itemTierOf('loot_ironfang_blade')).toBe('found');
    expect(itemTierOf('quest_bloodied_token')).toBe('found');
    expect(itemTierOf('weird_id')).toBe('found');
    expect(ITEM_TIERS).toEqual(['raw', 'crafted', 'found']);
  });

  it('rarityIndex pins the ladder', () => {
    expect(rarityIndex('common')).toBe(0);
    expect(rarityIndex('legendary')).toBe(4);
    expect(rarityIndex(undefined)).toBe(0);
  });

  it('powerScore = rarity weight + positive stats only', () => {
    // epic(3)*100 + 14 + 3
    expect(powerScore(defs['craft_ember_blade'])).toBe(317);
    // rare(2)*100 + 9
    expect(powerScore(defs['loot_ironfang_blade'])).toBe(209);
    expect(powerScore(defs['mat_ore'])).toBe(0);
    expect(powerScore({ name: 'x', type: 'key', stats: { damage: -5, crit: NaN } })).toBe(0);
  });

  it('SORT_MODE_LABELS covers all four modes', () => {
    expect(Object.keys(SORT_MODE_LABELS).sort()).toEqual(['default', 'newest', 'power', 'rarity']);
  });
});

describe('applyInventoryView', () => {
  beforeEach(() => {
    inv.add('loot_ironfang_blade', 1); // slot 0, rare
    inv.add('mat_ore', 5); // slot 1, common raw
    inv.add('craft_ember_blade', 1); // slot 2, epic crafted
    inv.add('loot_surge_tonic', 2); // slot 3, common consumable
  });

  const ids = (rows: Array<{ entry: { itemId: string } }>) =>
    rows.map((r) => r.entry.itemId);

  it('default: slot order, everything shown', () => {
    const rows = applyInventoryView(inv, NO_FILTER, 'default');
    expect(ids(rows)).toEqual([
      'loot_ironfang_blade', 'mat_ore', 'craft_ember_blade', 'loot_surge_tonic',
    ]);
    expect(rows.map((r) => r.slot)).toEqual([0, 1, 2, 3]);
  });

  it('filters by type', () => {
    const f: InventoryFilter = { ...NO_FILTER, type: 'weapon' };
    expect(ids(applyInventoryView(inv, f, 'default'))).toEqual([
      'loot_ironfang_blade', 'craft_ember_blade',
    ]);
  });

  it('filters by rarity', () => {
    const f: InventoryFilter = { ...NO_FILTER, rarity: 'epic' };
    expect(ids(applyInventoryView(inv, f, 'default'))).toEqual(['craft_ember_blade']);
  });

  it('filters by tier', () => {
    expect(ids(applyInventoryView(inv, { ...NO_FILTER, tier: 'raw' }, 'default')))
      .toEqual(['mat_ore']);
    expect(ids(applyInventoryView(inv, { ...NO_FILTER, tier: 'crafted' }, 'default')))
      .toEqual(['craft_ember_blade']);
    expect(ids(applyInventoryView(inv, { ...NO_FILTER, tier: 'found' }, 'default')))
      .toEqual(['loot_ironfang_blade', 'loot_surge_tonic']);
  });

  it('filters combine (AND)', () => {
    const f: InventoryFilter = { ...NO_FILTER, type: 'weapon', tier: 'crafted' };
    expect(ids(applyInventoryView(inv, f, 'default'))).toEqual(['craft_ember_blade']);
  });

  it('sorts by rarity descending, ties break on slot', () => {
    inv.add('quest_bloodied_token', 1); // slot 4, common
    const rows = applyInventoryView(inv, NO_FILTER, 'rarity');
    expect(ids(rows)).toEqual([
      'craft_ember_blade', // epic
      'loot_ironfang_blade', // rare
      'mat_ore', // common, slot 1
      'loot_surge_tonic', // common, slot 3
      'quest_bloodied_token', // common, slot 4
    ]);
  });

  it('sorts by power descending', () => {
    const rows = applyInventoryView(inv, NO_FILTER, 'power');
    expect(ids(rows)).toEqual([
      'craft_ember_blade', // 317
      'loot_ironfang_blade', // 209
      'mat_ore', // 0, slot 1
      'loot_surge_tonic', // 0, slot 3
    ]);
  });

  it('sorts by newest (last-acquired first)', () => {
    inv.add('mat_ore', 1); // re-add bumps ore to newest
    const rows = applyInventoryView(inv, NO_FILTER, 'newest');
    expect(ids(rows)[0]).toBe('mat_ore');
    expect(ids(rows)[1]).toBe('loot_surge_tonic');
  });

  it('unknown defs are skipped, never thrown on', () => {
    const rows = applyInventoryView(inv, NO_FILTER, 'default');
    expect(rows).toHaveLength(4);
  });
});

// ------------------------------------------------------------ HUD (fake DOM)

function makeEl(tag = 'div'): any {
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as any,
    className: '',
    textContent: '',
    dataset: {} as any,
    value: '',
    title: '',
    _innerHTML: '',
    _listeners: {} as Record<string, Array<(e: any) => void>>,
    _classes: new Set<string>(),
    classList: {
      toggle: (c: string, force?: boolean) => {
        if (force === undefined) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); }
        else if (force) el._classes.add(c);
        else el._classes.delete(c);
      },
      add: (c: string) => el._classes.add(c),
      remove: (c: string) => el._classes.delete(c),
      contains: (c: string) => el._classes.has(c),
    },
    appendChild(c: any) { el.children.push(c); return c; },
    append(...cs: any[]) { for (const c of cs) el.appendChild(c); },
    remove() {},
    setAttribute(_k: string, _v: string) {},
    addEventListener(t: string, fn: (e: any) => void) { (el._listeners[t] ??= []).push(fn); },
    removeEventListener() {},
    fire(t: string, e: any = {}) {
      for (const fn of el._listeners[t] ?? []) fn({ preventDefault() {}, ...e });
    },
    click() { el.fire('click'); },
    queryAll(pred: (e: any) => boolean, acc: any[] = []): any[] {
      if (pred(el)) acc.push(el);
      for (const c of el.children) c.queryAll?.(pred, acc);
      return acc;
    },
  };
  // innerHTML = '' must clear children like the real DOM (the HUD uses it
  // to wipe cells before re-rendering).
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._innerHTML,
    set: (v: string) => {
      el._innerHTML = v;
      if (v === '') el.children = [];
    },
  });
  return el;
}

interface HudHarness {
  hud: InventoryHUD;
  container: any;
  doc: any;
  win: any;
  added: number[];
}

function makeHudHarness(withSell: boolean): HudHarness {
  const win: any = {
    _listeners: {} as Record<string, Array<(e: any) => void>>,
    addEventListener(t: string, fn: (e: any) => void) { (this._listeners[t] ??= []).push(fn); },
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
  };
  const doc: any = {
    createElement: (t: string) => makeEl(t),
    head: makeEl('head'),
  };
  const container = makeEl('div');
  const added: number[] = [];
  const prevDoc = (globalThis as any).document;
  const prevWin = (globalThis as any).window;
  (globalThis as any).document = doc;
  (globalThis as any).window = win;
  const hud = new InventoryHUD(container, inv, {
    sell: withSell ? { addScrap: (n: number) => added.push(n), sellMult: 0.3 } : null,
  });
  return {
    hud, container, doc, win, added,
    // restore hooks live on the harness via closure; tests call hud.dispose()
    // then restore globals explicitly
    _prevDoc: prevDoc,
    _prevWin: prevWin,
  } as unknown as HudHarness;
}

function restoreGlobals(h: any): void {
  (globalThis as any).document = h._prevDoc;
  (globalThis as any).window = h._prevWin;
}

/** find buttons by exact text */
function buttons(h: HudHarness, text: string): any[] {
  return h.container.queryAll((e: any) => e.tag === 'button' && e.textContent === text);
}

/** visible pack cells (display !== 'none') with their item names */
function visibleCells(h: HudHarness): Array<{ name: string; junk: boolean; el: any }> {
  const hud: any = h.hud;
  return hud.packCells
    .filter((c: any) => c.style.display !== 'none')
    .map((c: any) => ({
      name: c.queryAll((e: any) => e.className === 'nm')[0]?.textContent ?? '',
      junk: c.classList.contains('isjunk'),
      el: c,
    }));
}

function seedBackpack(): void {
  inv.add('loot_ironfang_blade', 1); // slot 0
  inv.add('mat_ore', 5); // slot 1
  inv.add('craft_ember_blade', 1); // slot 2
  inv.add('loot_surge_tonic', 2); // slot 3
  inv.add('quest_bloodied_token', 1); // slot 4 (unsellable)
}

describe('InventoryHUD toolbar', () => {
  let h: HudHarness;
  beforeEach(() => { seedBackpack(); h = makeHudHarness(true); });
  afterEach(() => { h.hud.dispose(); restoreGlobals(h); });

  it('renders 4 filter/sort selects and the action buttons incl. sell', () => {
    const selects = h.container.queryAll((e: any) => e.tag === 'select');
    expect(selects).toHaveLength(4);
    expect(buttons(h, 'Mark junk: off')).toHaveLength(1);
    expect(buttons(h, 'Mark shown junk')).toHaveLength(1);
    expect(buttons(h, 'Sell junk')).toHaveLength(1);
    expect(buttons(h, 'Destroy junk')).toHaveLength(1);
  });

  it('hides the sell button when no sell hooks are wired', () => {
    const h2 = makeHudHarness(false);
    try {
      expect(buttons(h2, 'Sell junk')).toHaveLength(0);
      expect(buttons(h2, 'Destroy junk')).toHaveLength(1);
    } finally {
      h2.hud.dispose();
      restoreGlobals(h2);
    }
  });

  it('type filter narrows the visible cells (client-side, model untouched)', () => {
    const sel = h.container.queryAll((e: any) => e.tag === 'select')[0];
    sel.value = 'weapon';
    sel.fire('change');
    const names = visibleCells(h).map((c) => c.name);
    expect(names).toEqual(['Ironfang Blade', 'Ember Blade']);
    expect(inv.count('mat_ore')).toBe(5); // model untouched
  });

  it('rarity + tier filters combine', () => {
    const sels = h.container.queryAll((e: any) => e.tag === 'select');
    sels[1].value = 'epic'; sels[1].fire('change');
    sels[2].value = 'crafted'; sels[2].fire('change');
    expect(visibleCells(h).map((c) => c.name)).toEqual(['Ember Blade']);
  });

  it('sort modes reorder the visible cells', () => {
    const sortSel = h.container.queryAll((e: any) => e.tag === 'select')[3];
    sortSel.value = 'rarity'; sortSel.fire('change');
    expect(visibleCells(h).map((c) => c.name)).toEqual([
      'Ember Blade', 'Ironfang Blade', 'Ore', 'Surge Tonic', 'Bloodied Token',
    ]);
    sortSel.value = 'power'; sortSel.fire('change');
    expect(visibleCells(h).map((c) => c.name)[0]).toBe('Ember Blade');
    sortSel.value = 'newest'; sortSel.fire('change');
    expect(visibleCells(h).map((c) => c.name)[0]).toBe('Bloodied Token');
  });

  it('junk mode: clicking a cell toggles junk instead of equipping', () => {
    buttons(h, 'Mark junk: off')[0].click();
    expect(buttons(h, 'Mark junk: on')).toHaveLength(1);
    // display index 0 = Ironfang Blade; junk-mode click must NOT equip it
    visibleCells(h)[0].el.click();
    expect(inv.isJunk('loot_ironfang_blade')).toBe(true);
    expect(inv.getEquipped('weapon')).toBeNull();
    expect(visibleCells(h)[0].junk).toBe(true);
    // toggle off again
    visibleCells(h)[0].el.click();
    expect(inv.isJunk('loot_ironfang_blade')).toBe(false);
  });

  it('Enter in junk mode toggles junk via keyboard', () => {
    h.hud.open(); // keyboard input requires the HUD to be open
    buttons(h, 'Mark junk: off')[0].click(); // junk mode on
    const win = h.win;
    const fireKey = (code: string) => {
      for (const fn of win._listeners['keydown'] ?? []) {
        fn({ code, target: null, preventDefault() {} });
      }
    };
    // cursor starts at pack index 0 (Ironfang Blade); Enter toggles junk
    fireKey('Enter');
    expect(inv.isJunk('loot_ironfang_blade')).toBe(true);
    fireKey('Enter');
    expect(inv.isJunk('loot_ironfang_blade')).toBe(false);
  });

  it('right-click toggles junk outside junk mode', () => {
    visibleCells(h)[1].el.fire('contextmenu');
    expect(inv.isJunk('mat_ore')).toBe(true);
    expect(visibleCells(h)[1].junk).toBe(true);
  });

  it('mark-shown junk marks every visible (filtered) item', () => {
    const sels = h.container.queryAll((e: any) => e.tag === 'select');
    sels[0].value = 'material'; sels[0].fire('change');
    buttons(h, 'Mark shown junk')[0].click();
    expect(inv.junkItemIds()).toEqual(['mat_ore']);
  });

  it('sell junk: confirm credits exact scrap and removes the items', () => {
    inv.setJunk('mat_ore', true); // 5 x floor(4*0.3)=1 -> 5
    inv.setJunk('loot_surge_tonic', true); // 2 x floor(20*0.3)=6 -> 12
    inv.setJunk('quest_bloodied_token', true); // unsellable -> skipped
    (h.hud as any).refresh();
    buttons(h, 'Sell junk')[0].click();
    // confirm row appears with the exact total; click Confirm
    const confirmBtns = h.container.queryAll(
      (e: any) => e.tag === 'button' && e.textContent === 'Confirm',
    );
    expect(confirmBtns).toHaveLength(1);
    const label = h.container.queryAll((e: any) => e.tag === 'span' && /Sell 7 junk for 17 scrap/.test(e.textContent ?? ''));
    expect(label.length).toBe(1);
    confirmBtns[0].click();
    expect(h.added).toEqual([5, 12]); // wallet.add per entry, exact
    expect(inv.count('mat_ore')).toBe(0);
    expect(inv.count('loot_surge_tonic')).toBe(0);
    expect(inv.count('quest_bloodied_token')).toBe(1); // unsellable kept
    expect(inv.junkItemIds()).toEqual(['quest_bloodied_token']);
  });

  it('sell junk with nothing marked toasts and does nothing', () => {
    buttons(h, 'Sell junk')[0].click();
    expect(h.added).toEqual([]);
    expect(inv.count('mat_ore')).toBe(5);
  });

  it('destroy junk: confirm removes the items irreversibly', () => {
    inv.setJunk('mat_ore', true);
    inv.setJunk('craft_ember_blade', true);
    (h.hud as any).refresh();
    buttons(h, 'Destroy junk')[0].click();
    const label = h.container.queryAll((e: any) => e.tag === 'span' && /Destroy 6 junk/.test(e.textContent ?? ''));
    expect(label.length).toBe(1);
    h.container.queryAll((e: any) => e.tag === 'button' && e.textContent === 'Confirm')[0].click();
    expect(inv.count('mat_ore')).toBe(0);
    expect(inv.count('craft_ember_blade')).toBe(0);
    expect(inv.junkItemIds()).toEqual([]);
  });

  it('cancel leaves everything untouched', () => {
    inv.setJunk('mat_ore', true);
    (h.hud as any).refresh();
    buttons(h, 'Destroy junk')[0].click();
    h.container.queryAll((e: any) => e.tag === 'button' && e.textContent === 'Cancel')[0].click();
    expect(inv.count('mat_ore')).toBe(5);
    expect(inv.junkItemIds()).toEqual(['mat_ore']);
  });

  it('all toolbar controls meet the 28px touch-target floor', () => {
    // the scoped stylesheet is injected into document.head by the HUD
    // constructor; assert the min-height rules are present verbatim.
    const styleEl = h.doc.head.children.find((c: any) => c.tag === 'style');
    const text: string = styleEl.textContent ?? '';
    expect(text).toContain('.xinv .tools select { min-height:28px;');
    expect(text).toContain('.xinv .actions button, .xinv .confirm button { min-height:28px;');
  });

  it('equipped junk-marked items are never sold', () => {
    inv.setJunk('loot_ironfang_blade', true);
    expect(inv.equip('loot_ironfang_blade')).not.toBeNull();
    (h.hud as any).refresh();
    buttons(h, 'Sell junk')[0].click();
    // nothing sellable in the backpack -> no confirm row, no scrap
    expect(
      h.container.queryAll((e: any) => e.tag === 'button' && e.textContent === 'Confirm'),
    ).toHaveLength(0);
    expect(inv.getEquipped('weapon')).toBe('loot_ironfang_blade');
    expect(h.added).toEqual([]);
  });
});
