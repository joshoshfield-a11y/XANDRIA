/**
 * vendor-economy wave — currency wallet + NPC vendor shops.
 *
 * - VENDOR_SALT / CURRENCY_SALT are distinct from every other wave salt.
 * - The vendor catalog is valid: unique ids, sane multipliers, every
 *   stock-pool id exists in the merged item-def tables with a positive
 *   value (the items-expansion + crafting waves' fixed contracts).
 * - buildVendorStock is pure: same (def, spawnSeed, defs) -> identical
 *   stock; prices stay in the seeded jitter band around value*buyMult.
 * - resolveVendorDefs merges Studio overrides honestly (unknown ids
 *   dropped, empty pools fall back, catalog never mutated).
 * - Wallet: add/spend atomicity, portalSnapshot/restore round-trip,
 *   corrupt restores clamp to 0.
 * - rollCurrencyDrops: deterministic in the stream, bosses always pay
 *   60-140, brutes ("elites") pay more often than other kinds.
 * - Vendors ride the villager roster: appended specs keep the villager
 *   indices (and their seeded spawns) identical; vendor NPCs get the
 *   'Trade with' prompt, role 'merchant', and expose spawnSeed.
 * - ShopPanel (DOM): buy/sell tabs, seeded stock lists, buy is atomic
 *   (full backpack refunds), sell converts loot to scrap, all row
 *   buttons meet the 28px touch-target floor, Esc closes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '', width: 0, height: 0,
      id: '',
      disabled: false,
      appendChild(c: any) { el.children.push(c); return c; },
      append(...cs: any[]) { for (const c of cs) el.children.push(c); },
      replaceChildren(...cs: any[]) { el.children = [...cs]; },
      remove() {},
      setAttribute(k: string, v: string) { el[k] = v; },
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener(_t: string, h: (...a: any[]) => void) { (el._handlers ??= {})[_t] = h; },
      removeEventListener() {},
      querySelector() { return makeEl(); },
      querySelectorAll() { return []; },
      getContext: () => ({ createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
      click() { el._handlers?.click?.({ stopPropagation() {} }); },
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

import * as THREE from 'three';
import { Engine } from '../src/engine/Engine';
import { defaultSpec, type GameSpec, type ItemDef } from '../src/spec/schema';
import { Rng } from '../src/engine/core/Rng';
import { Inventory } from '../src/engine/game/items/Inventory';
import { Npc, spawnNpcsForMap, NPC_SALT } from '../src/engine/game/Npc';
import { NpcManager } from '../src/engine/game/NpcManager';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { CRAFT_SALT } from '../src/engine/game/crafting';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { STATION_SALT } from '../src/engine/game/stations';
import { MASTER_SALT } from '../src/engine/game/mastercraft';
import { LOOT_SALT, lootItemDefs } from '../src/engine/game/loot';
import { materialItemDefs, craftedItemDefs } from '../src/engine/game/crafting';
import {
  VENDOR_SALT,
  CURRENCY_SALT,
  CURRENCY_NAME,
  DEFAULT_BUY_MULT,
  DEFAULT_SELL_MULT,
  VENDOR_CATALOG,
  Wallet,
  resolveVendorDefs,
  buildVendorNpcSpecs,
  buildVendorStock,
  unitSellPrice,
  isSellable,
  hashStr32,
  buildCurrencyRng,
  rollCurrencyDrops,
} from '../src/engine/game/economy';
import { ShopPanel } from '../src/engine/ui/ShopPanel';

beforeEach(() => {
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head: makeEl('head'),
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
  };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

/** every item def the waves have registered (the stock-pool id universe) */
function allDefs(): Record<string, ItemDef> {
  return { ...materialItemDefs(), ...craftedItemDefs(), ...lootItemDefs() };
}

describe('salts', () => {
  it('VENDOR_SALT and CURRENCY_SALT are distinct from every other wave salt', () => {
    const salts = [
      ENEMY_SALT, NPC_SALT, CRAFT_SALT, STATION_SALT, GATHER_SALT,
      MASTER_SALT, LOOT_SALT, VENDOR_SALT, CURRENCY_SALT,
      0x901, // NpcManager POI_SALT
      0x90c, // gathering POI salt
      0x910d, // stations POI salt
    ];
    expect(new Set(salts).size).toBe(salts.length);
  });
});

describe('vendor catalog', () => {
  it('has 3 vendors with unique ids, sane multipliers, non-empty pools', () => {
    expect(VENDOR_CATALOG.length).toBe(3);
    const ids = VENDOR_CATALOG.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of VENDOR_CATALOG) {
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.keeper.length).toBeGreaterThan(0);
      expect(v.buyMult).toBeGreaterThan(1);
      expect(v.sellMult).toBeGreaterThan(0);
      expect(v.sellMult).toBeLessThan(v.buyMult);
      expect(v.maxStock).toBeGreaterThan(0);
      expect(v.stockPool.length).toBeGreaterThan(0);
    }
  });

  it('every stock-pool id exists in the merged def tables with a positive value', () => {
    const defs = allDefs();
    for (const v of VENDOR_CATALOG) {
      for (const id of v.stockPool) {
        const def = defs[id];
        expect(def, `${v.id} stock pool id ${id}`).toBeDefined();
        expect(Number.isFinite(def.value) && (def.value as number) > 0).toBe(true);
      }
    }
  });

  it('default multipliers match the documented constants', () => {
    for (const v of VENDOR_CATALOG) {
      expect(v.buyMult).toBe(DEFAULT_BUY_MULT);
      expect(v.sellMult).toBe(DEFAULT_SELL_MULT);
    }
  });
});

describe('resolveVendorDefs', () => {
  it('returns a deep copy of the catalog when the spec has no overrides', () => {
    const spec = defaultSpec(1) as GameSpec;
    const defs = resolveVendorDefs(spec);
    expect(defs.map((d) => d.id)).toEqual(VENDOR_CATALOG.map((d) => d.id));
    defs[0].name = 'MUTATED';
    defs[0].stockPool.push('x');
    expect(VENDOR_CATALOG[0].name).not.toBe('MUTATED');
    expect(VENDOR_CATALOG[0].stockPool).not.toContain('x');
  });

  it('merges per-field overrides, drops unknown ids, honors disabledVendors', () => {
    const spec = defaultSpec(1) as GameSpec;
    spec.custom = {
      ...(spec.custom ?? {}),
      vendors: {
        defs: {
          vendor_ironfangs: { name: 'New Edge', buyMult: 2 },
          vendor_nope: { name: 'Ghost' },
        },
        disabledVendors: ['vendor_scrap_plate'],
      },
    };
    const defs = resolveVendorDefs(spec);
    expect(defs.map((d) => d.id).sort()).toEqual(['vendor_ember_vial', 'vendor_ironfangs']);
    const iron = defs.find((d) => d.id === 'vendor_ironfangs')!;
    expect(iron.name).toBe('New Edge');
    expect(iron.buyMult).toBe(2);
    expect(iron.sellMult).toBe(DEFAULT_SELL_MULT); // untouched fields keep catalog values
    expect(iron.stockPool).toEqual(VENDOR_CATALOG[0].stockPool);
  });

  it('an empty override stock pool falls back to the catalog pool', () => {
    const spec = defaultSpec(1) as GameSpec;
    spec.custom = { ...(spec.custom ?? {}), vendors: { defs: { vendor_ironfangs: { stockPool: [] } } } };
    const defs = resolveVendorDefs(spec);
    expect(defs.find((d) => d.id === 'vendor_ironfangs')!.stockPool).toEqual(VENDOR_CATALOG[0].stockPool);
  });
});

describe('buildVendorStock', () => {
  it('is pure: same (def, spawnSeed, defs) -> identical stock', () => {
    const defs = allDefs();
    const def = VENDOR_CATALOG[0];
    const a = buildVendorStock(def, 123456789, defs);
    const b = buildVendorStock(def, 123456789, defs);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThanOrEqual(def.maxStock);
  });

  it('differs across spawn seeds and vendors (per-vendor sub-salt)', () => {
    const defs = allDefs();
    const a = buildVendorStock(VENDOR_CATALOG[0], 111, defs);
    const b = buildVendorStock(VENDOR_CATALOG[0], 222, defs);
    const c = buildVendorStock(VENDOR_CATALOG[1], 111, defs);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('prices sit in the seeded jitter band around value*buyMult, stock counts sane', () => {
    const defs = allDefs();
    const def = VENDOR_CATALOG[2];
    for (const seed of [1, 42, 777, 20261012]) {
      for (const line of buildVendorStock(def, seed, defs)) {
        const value = defs[line.itemId].value as number;
        const lo = Math.round(value * def.buyMult * 0.9);
        const hi = Math.round(value * def.buyMult * 1.1) + 1;
        expect(line.price).toBeGreaterThanOrEqual(Math.max(1, lo - 1));
        expect(line.price).toBeLessThanOrEqual(Math.max(1, hi));
        expect(line.stock).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('skips stock ids missing from the defs instead of fabricating them', () => {
    const defs = allDefs();
    const def = { ...VENDOR_CATALOG[0], stockPool: ['nope_missing', 'loot_ironfang_blade'] };
    const stock = buildVendorStock(def, 5, defs);
    expect(stock.every((l) => l.itemId !== 'nope_missing')).toBe(true);
    expect(stock.length).toBeGreaterThan(0);
  });
});

describe('pricing helpers', () => {
  it('unitSellPrice floors value*sellMult at min 1', () => {
    const defs = allDefs();
    expect(unitSellPrice(defs['loot_ironfang_blade'], 0.3)).toBe(Math.max(1, Math.floor(120 * 0.3)));
    expect(unitSellPrice(defs['mat_beast_hide'], 0.3)).toBe(Math.max(1, Math.floor(4 * 0.3)));
  });

  it('isSellable is true only for positive-value defs', () => {
    const defs = allDefs();
    expect(isSellable(defs['loot_ironfang_blade'])).toBe(true);
    expect(isSellable(undefined)).toBe(false);
    expect(isSellable({ ...defs['loot_ironfang_blade'], value: 0 })).toBe(false);
  });

  it('hashStr32 is deterministic and decorrelates vendor ids', () => {
    expect(hashStr32('vendor_ironfangs')).toBe(hashStr32('vendor_ironfangs'));
    expect(hashStr32('vendor_ironfangs')).not.toBe(hashStr32('vendor_scrap_plate'));
  });
});

describe('Wallet', () => {
  it('add/spend arithmetic, spend is atomic on insufficient funds', () => {
    const w = new Wallet();
    expect(w.balance).toBe(0);
    expect(w.spend(10)).toBe(false);
    expect(w.balance).toBe(0); // nothing changed
    w.add(50);
    expect(w.balance).toBe(50);
    expect(w.spend(60)).toBe(false);
    expect(w.balance).toBe(50);
    expect(w.spend(20)).toBe(true);
    expect(w.balance).toBe(30);
    w.add(-5);
    expect(w.balance).toBe(30);
  });

  it('fires onChange after every mutation and never throws through it', () => {
    const w = new Wallet();
    let n = 0;
    w.onChange = () => { n++; throw new Error('boom'); };
    w.add(10);
    w.spend(5);
    expect(n).toBe(2);
    expect(w.balance).toBe(5);
  });

  it('portalSnapshot/restore round-trips; corrupt restores clamp to 0', () => {
    const w = new Wallet();
    w.add(123);
    const snap = w.portalSnapshot();
    const w2 = new Wallet();
    w2.portalRestore(snap);
    expect(w2.balance).toBe(123);
    w2.portalRestore({ balance: NaN });
    expect(w2.balance).toBe(0);
    w2.portalRestore({ balance: -40 });
    expect(w2.balance).toBe(0);
    w2.portalRestore(null);
    expect(w2.balance).toBe(0);
  });
});

describe('currency drops', () => {
  it('buildCurrencyRng is deterministic per mapSeed', () => {
    const a = buildCurrencyRng(20261012, LOOT_SALT);
    const b = buildCurrencyRng(20261012, LOOT_SALT);
    expect(a.int(0, 1000)).toBe(b.int(0, 1000));
  });

  it('rollCurrencyDrops is stream-deterministic and range-bounded', () => {
    const seq = (seed: number) => {
      const rng = buildCurrencyRng(seed, LOOT_SALT);
      return ['walker', 'brute', 'drone', 'flyer', 'turret', 'walker'].map((k, i) =>
        rollCurrencyDrops(rng, k, i === 5));
    };
    expect(seq(42)).toEqual(seq(42));
    const drops = seq(7);
    expect(drops[5]).toBeGreaterThanOrEqual(60); // boss (last) always pays
    expect(drops[5]).toBeLessThanOrEqual(140);
    for (const d of drops) expect(d).toBeGreaterThanOrEqual(0);
  });

  it('brutes pay more often than walkers over a fixed script (seeded)', () => {
    const sumFor = (kind: string) => {
      const rng = buildCurrencyRng(99, LOOT_SALT);
      let s = 0;
      for (let i = 0; i < 200; i++) s += rollCurrencyDrops(rng, kind, false);
      return s;
    };
    expect(sumFor('brute')).toBeGreaterThan(sumFor('walker'));
  });
});

describe('vendor roster (separate salted NpcManager)', () => {
  const POI = [{ x: 100, z: 100, r: 8 }];

  function vendorManager() {
    const engine = makeEngine();
    const m = new NpcManager(engine, {
      id: 'vendors',
      salt: VENDOR_SALT,
      specs: buildVendorNpcSpecs(VENDOR_CATALOG),
      count: VENDOR_CATALOG.length,
      pois: POI,
    });
    m.spawnForMap(20261012);
    return m;
  }

  it('buildVendorNpcSpecs produces merchant specs with vendor ids', () => {
    const specs = buildVendorNpcSpecs(VENDOR_CATALOG);
    expect(specs.length).toBe(3);
    for (const s of specs) {
      expect(s.role).toBe('merchant');
      expect(typeof s.vendorId).toBe('string');
      expect(s.count).toBe(1);
    }
    expect(specs[0].name).toBe('Kess');
  });

  it('vendor NPCs get the Trade prompt, role merchant, and expose spawnSeed', () => {
    const m = vendorManager();
    expect(m.id).toBe('vendors');
    expect(m.npcs.length).toBe(3);
    for (const v of m.npcs) {
      expect(v.vendorId).toBeDefined();
      expect(v.role).toBe('merchant');
      expect(v.interactable.prompt).toMatch(/^Trade with /);
      expect(Number.isInteger(v.spawnSeed)).toBe(true);
    }
    m.despawnAll();
    expect(m.npcs.length).toBe(0);
  });

  it('the salted roster is deterministic across managers', () => {
    const a = vendorManager();
    const b = vendorManager();
    const sig = (n: Npc) => [n.name, n.home.x.toFixed(4), n.home.z.toFixed(4), n.spawnSeed].join('|');
    expect(a.npcs.map(sig)).toEqual(b.npcs.map(sig));
  });

  it('the salted roster is distinct from the unsalted villager roster on the same map', () => {
    const vendors = vendorManager();
    const engine = makeEngine();
    const plain = new NpcManager(engine, {
      specs: [{ role: 'villager', count: 3 }],
      count: 3,
      pois: POI,
    });
    plain.spawnForMap(20261012);
    const vPos = new Set(vendors.npcs.map((n) => `${n.home.x.toFixed(4)}|${n.home.z.toFixed(4)}`));
    const pPos = new Set(plain.npcs.map((n) => `${n.home.x.toFixed(4)}|${n.home.z.toFixed(4)}`));
    const overlap = [...vPos].filter((p) => pPos.has(p));
    expect(overlap.length).toBe(0);
    // identity streams decorrelated too
    const vSeeds = new Set(vendors.npcs.map((n) => n.spawnSeed));
    for (const n of plain.npcs) expect(vSeeds.has(n.spawnSeed)).toBe(false);
  });

  it('the unsalted villager stream is byte-identical to the historical behavior', () => {
    // historical: stream Rng(mapSeed ^ NPC_SALT), per-NPC seed
    // (mapSeed ^ imul(i+1, 0x9e3779b9)). With no pois both the manager
    // and the direct call fall back to the origin cluster, so the
    // rosters must match one-to-one.
    const engine = makeEngine();
    const m = new NpcManager(engine, {
      specs: [{ role: 'villager', count: 2 }],
      count: 2,
    });
    m.spawnForMap(20261012);
    const direct = spawnNpcsForMap(engine, 20261012, {
      count: 2,
      specs: [{ role: 'villager', count: 2 }],
    });
    const sig = (n: Npc) => [n.name, n.home.x.toFixed(4), n.home.z.toFixed(4), n.spawnSeed].join('|');
    expect(m.npcs.map(sig)).toEqual(direct.map(sig));
    for (const n of m.npcs) expect(n.vendorId).toBeUndefined();
  });
});

describe('ShopPanel', () => {
  function panelHarness() {
    const container = makeEl('div');
    const doc: any = (globalThis as any).document;
    const defs = allDefs();
    const inv = new Inventory(defs);
    const wallet = new Wallet();
    const vendorDefs = resolveVendorDefs(defaultSpec(1) as GameSpec);
    const panel = new ShopPanel({
      container,
      doc,
      inventory: () => inv,
      wallet: () => wallet,
      defs: () => defs,
      vendorDefs: () => vendorDefs,
      toast: () => {},
    });
    return { panel, inv, wallet, defs, vendorDefs, container };
  }

  const vendorArg = { vendorId: 'vendor_ironfangs', spawnSeed: 987654321, keeperName: 'Kess' };

  it('opens with the shop name, balance, tabs, and seeded stock rows', () => {
    const { panel } = panelHarness();
    expect(panel.openForVendor(vendorArg)).toBe(true);
    expect(panel.isOpen).toBe(true);
    expect(panel.vendorId).toBe('vendor_ironfangs');
    // buy rows: one BUY button per stock line
    const buyButtons = (panel as any).listEl.children.filter(
      (r: any) => r.children.some((c: any) => c.textContent === 'BUY'));
    expect(buyButtons.length).toBeGreaterThan(0);
    // every row button meets the 28px touch floor
    for (const row of (panel as any).listEl.children) {
      for (const c of row.children) {
        if (c.tag === 'button') expect(c.style.cssText).toContain('min-height:28px');
      }
    }
    panel.dispose();
  });

  it('buy is atomic: wallet -> inventory -> stock, full backpack refunds', () => {
    const { panel, inv, wallet, defs } = panelHarness();
    wallet.add(100000);
    panel.openForVendor(vendorArg);
    const line = panel.stockFor('vendor_ironfangs', 987654321)[0];
    const before = wallet.balance;
    panel.buy(line);
    expect(wallet.balance).toBe(before - line.price);
    expect(inv.count(line.itemId)).toBe(1);
    expect(line.stock).toBeGreaterThanOrEqual(0);
    // fill the backpack completely, then buy -> refund, no stock change
    const filler = 'mat_beast_hide';
    while (inv.add(filler, 999) === 0) { /* fill */ }
    const line2 = panel.stockFor('vendor_ironfangs', 987654321).find((l) => l.stock > 0)!;
    const stockBefore = line2.stock;
    const balBefore = wallet.balance;
    panel.buy(line2);
    expect(wallet.balance).toBe(balBefore); // refunded
    expect(line2.stock).toBe(stockBefore); // untouched
    panel.dispose();
  });

  it('buy fails honestly when the wallet is short', () => {
    const { panel, inv, wallet } = panelHarness();
    panel.openForVendor(vendorArg);
    const line = panel.stockFor('vendor_ironfangs', 987654321)[0];
    expect(line.price).toBeGreaterThan(0);
    panel.buy(line);
    expect(wallet.balance).toBe(0);
    expect(inv.count(line.itemId)).toBe(0);
    expect(line.stock).toBeGreaterThan(0);
    panel.dispose();
  });

  it('sell converts a backpack item to scrap at the vendor sell price', () => {
    const { panel, inv, wallet, defs, vendorDefs } = panelHarness();
    inv.add('loot_ironfang_blade', 2);
    panel.openForVendor(vendorArg);
    // switch to the SELL tab via the real tab button
    (panel as any).tabSell.click();
    const sellRows = (panel as any).listEl.children.length;
    expect(sellRows).toBeGreaterThan(0);
    const unit = unitSellPrice(defs['loot_ironfang_blade'], vendorDefs[0].sellMult);
    panel.sell('loot_ironfang_blade', unit);
    expect(inv.count('loot_ironfang_blade')).toBe(1);
    expect(wallet.balance).toBe(unit);
    panel.dispose();
  });

  it('stock is identical for the same (vendor, spawnSeed) across panel instances', () => {
    const { vendorDefs, defs } = panelHarness();
    const { panel: p2 } = panelHarness();
    const a = JSON.stringify(p2.stockFor('vendor_ember_vial', 555));
    const b = JSON.stringify(buildVendorStock(vendorDefs[2], 555, defs));
    expect(a).toBe(b);
    p2.dispose();
  });

  it('Escape closes the panel (capture-phase key handler)', () => {
    const { panel } = panelHarness();
    panel.openForVendor(vendorArg);
    expect(panel.isOpen).toBe(true);
    const doc: any = (globalThis as any).document;
    (panel as any).onKey({ key: 'Escape', stopPropagation() {} });
    expect(panel.isOpen).toBe(false);
    panel.dispose();
  });

  it(`currency unit is "${CURRENCY_NAME}" in the balance header`, () => {
    const { panel, wallet } = panelHarness();
    wallet.add(77);
    panel.openForVendor(vendorArg);
    expect((panel as any).balanceEl.textContent).toContain(CURRENCY_NAME);
    expect((panel as any).balanceEl.textContent).toContain('77');
    panel.dispose();
  });
});
