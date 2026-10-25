/**
 * Factions-reputation wave — unit tests.
 *
 * - Tier table boundaries + price factors (buy AND sell, every tier).
 * - Kind/vendor mappings (unknowns -> null, never invented).
 * - FactionStandings: kill / trade / quest-complete deltas, clamping,
 *   snapshot/restore round-trip + corrupt restores, storage adapter.
 * - QuestManager gating: gated quests start locked (even side quests),
 *   refreshStandingGates unlocks exactly when prerequisites + standing
 *   are met, accept() re-checks the gate, turnIn fires onQuestTurnedIn.
 * - ShopPanel: buy charges the standing-effective price (not the raw
 *   stock price) and fires onTrade; sell fires onTrade; at neutral the
 *   effective price is exactly the raw price (the vendor-economy
 *   contract is untouched).
 */
import { describe, it, expect } from 'vitest';
import {
  STANDING_TIERS,
  tierForStanding,
  clampStanding,
  standingBuyFactor,
  standingSellFactor,
  effectiveBuyPrice,
  effectiveSellPrice,
  FACTION_CATALOG,
  factionOfEnemyKind,
  factionOfVendor,
  FactionStandings,
  localStorageFactionsAdapter,
  KILL_STANDING_DELTA,
  BOSS_KILL_STANDING_DELTA,
  TRADE_BUY_STANDING_DELTA,
  TRADE_SELL_STANDING_DELTA,
} from '../src/engine/game/factions';
import { QuestManager, validateQuestDef, type QuestDef } from '../src/engine/game/quests';
import { Wallet } from '../src/engine/game/economy';
import { ShopPanel } from '../src/engine/ui/ShopPanel';

function makeEl(tag = 'div'): any {
  const el: any = {
    tag, children: [] as any[], style: {}, className: '', textContent: '', id: '',
    disabled: false,
    appendChild(c: any) { el.children.push(c); return c; },
    append(...cs: any[]) { for (const c of cs) el.children.push(c); },
    replaceChildren(...cs: any[]) { el.children = [...cs]; },
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    click() { el._handlers?.click?.({ stopPropagation() {} }); },
  };
  el.addEventListener = (_t: string, h: (...a: any[]) => void) => { (el._handlers ??= {})[_t] = h; };
  return el;
}

function fakeDoc(): any {
  return {
    createElement: (tag: string) => makeEl(tag),
    getElementById: () => makeEl('div'),
    addEventListener() {},
    removeEventListener() {},
  };
}

const questDef = (over: Partial<QuestDef>): QuestDef => ({
  id: 'q1',
  name: 'Test Quest',
  giver: 'any',
  brief: 'b',
  objectives: [{ id: 'o1', kind: 'talk', desc: 'Talk', target: 'any', count: 1 }],
  rewards: { xp: 0, items: [] },
  ...over,
});

function manager(defs: QuestDef[], opts: { standingOf?: (f: string) => number; onQuestTurnedIn?: (d: QuestDef) => void } = {}) {
  return new QuestManager({
    defs,
    inventory: () => null,
    defsTable: () => ({}),
    progression: null,
    toast: () => {},
    ...opts,
  });
}

describe('standing tiers', () => {
  it('has exactly the six hostile..exalted tiers in order', () => {
    expect(STANDING_TIERS.map((t) => t.id)).toEqual(
      ['hostile', 'unfriendly', 'neutral', 'friendly', 'honored', 'exalted'],
    );
  });
  it('maps boundary values to the right tier', () => {
    expect(tierForStanding(-1000).id).toBe('hostile');
    expect(tierForStanding(-301).id).toBe('hostile');
    expect(tierForStanding(-300).id).toBe('unfriendly');
    expect(tierForStanding(-51).id).toBe('unfriendly');
    expect(tierForStanding(-50).id).toBe('neutral');
    expect(tierForStanding(0).id).toBe('neutral');
    expect(tierForStanding(249).id).toBe('neutral');
    expect(tierForStanding(250).id).toBe('friendly');
    expect(tierForStanding(599).id).toBe('friendly');
    expect(tierForStanding(600).id).toBe('honored');
    expect(tierForStanding(899).id).toBe('honored');
    expect(tierForStanding(900).id).toBe('exalted');
    expect(tierForStanding(1000).id).toBe('exalted');
    expect(tierForStanding(NaN).id).toBe('neutral');
  });
  it('clamps standing into [-1000, 1000]', () => {
    expect(clampStanding(5000)).toBe(1000);
    expect(clampStanding(-5000)).toBe(-1000);
    expect(clampStanding(12.9)).toBe(12);
    expect(clampStanding(NaN)).toBe(0);
    expect(clampStanding('x' as unknown as number)).toBe(0);
  });
});

describe('standing price factors', () => {
  it('is exactly 1 at neutral for both buy and sell', () => {
    expect(standingBuyFactor(0)).toBe(1);
    expect(standingSellFactor(0)).toBe(1);
  });
  it('applies the tier table symmetrically (buy up, sell down at hostile)', () => {
    expect(standingBuyFactor(-1000)).toBe(1.25);
    expect(standingSellFactor(-1000)).toBe(0.75);
    expect(standingBuyFactor(-300)).toBe(1.1);
    expect(standingSellFactor(-300)).toBe(0.9);
    expect(standingBuyFactor(250)).toBe(0.9);
    expect(standingSellFactor(250)).toBe(1.1);
    expect(standingBuyFactor(600)).toBe(0.8);
    expect(standingSellFactor(600)).toBe(1.2);
    expect(standingBuyFactor(900)).toBe(0.7);
    expect(standingSellFactor(900)).toBe(1.3);
  });
  it('floors effective prices at 1', () => {
    expect(effectiveBuyPrice(1, -1000)).toBe(1);
    expect(effectiveSellPrice(1, -1000)).toBe(1);
    expect(effectiveBuyPrice(100, 250)).toBe(90);
    expect(effectiveSellPrice(100, 250)).toBe(110);
    expect(effectiveBuyPrice(100, 0)).toBe(100);
    expect(effectiveSellPrice(100, 0)).toBe(100);
  });
});

describe('faction mappings', () => {
  it('covers every catalog faction and every known kind/vendor', () => {
    expect(FACTION_CATALOG.map((f) => f.id)).toEqual(['ironfangs', 'ember_order', 'freeholds']);
    expect(factionOfEnemyKind('walker')).toBe('ironfangs');
    expect(factionOfEnemyKind('brute')).toBe('ironfangs');
    expect(factionOfEnemyKind('drone')).toBe('ember_order');
    expect(factionOfEnemyKind('turret')).toBe('ember_order');
    expect(factionOfEnemyKind('flyer')).toBe('freeholds');
    expect(factionOfEnemyKind('racer')).toBe('freeholds');
    expect(factionOfVendor('vendor_ironfangs')).toBe('ironfangs');
    expect(factionOfVendor('vendor_ember_vial')).toBe('ember_order');
    expect(factionOfVendor('vendor_scrap_plate')).toBe('freeholds');
  });
  it('returns null for unknowns instead of inventing a faction', () => {
    expect(factionOfEnemyKind('stalker')).toBeNull();
    expect(factionOfVendor('vendor_nope')).toBeNull();
  });
});

describe('FactionStandings', () => {
  it('starts at 0 for every faction', () => {
    const s = new FactionStandings();
    for (const f of FACTION_CATALOG) expect(s.standingOf(f.id)).toBe(0);
    expect(s.standingOf('nope')).toBe(0);
  });
  it('applies exact kill deltas (mob, boss, unknown kind ignored)', () => {
    const s = new FactionStandings();
    s.onKill('walker', false);
    expect(s.standingOf('ironfangs')).toBe(KILL_STANDING_DELTA);
    s.onKill('walker', true);
    expect(s.standingOf('ironfangs')).toBe(KILL_STANDING_DELTA + BOSS_KILL_STANDING_DELTA);
    s.onKill('stalker', false);
    expect(s.standingOf('ironfangs')).toBe(KILL_STANDING_DELTA + BOSS_KILL_STANDING_DELTA);
    expect(s.standingOf('ember_order')).toBe(0);
  });
  it('applies exact trade deltas per transaction', () => {
    const s = new FactionStandings();
    s.onTrade('vendor_ironfangs', 'buy');
    expect(s.standingOf('ironfangs')).toBe(TRADE_BUY_STANDING_DELTA);
    s.onTrade('vendor_ironfangs', 'sell');
    expect(s.standingOf('ironfangs')).toBe(TRADE_BUY_STANDING_DELTA + TRADE_SELL_STANDING_DELTA);
    s.onTrade('vendor_nope', 'buy');
    expect(s.standingOf('ironfangs')).toBe(TRADE_BUY_STANDING_DELTA + TRADE_SELL_STANDING_DELTA);
  });
  it('applies quest rewards: explicit def wins, otherwise +20 freeholds', () => {
    const s = new FactionStandings();
    s.onQuestComplete({ standingReward: { factionId: 'ember_order', amount: 40 } });
    expect(s.standingOf('ember_order')).toBe(40);
    expect(s.standingOf('freeholds')).toBe(0);
    s.onQuestComplete({});
    expect(s.standingOf('freeholds')).toBe(20);
    s.onQuestComplete({ standingReward: { factionId: 'nope', amount: 99 } });
    expect(s.standingOf('freeholds')).toBe(40);
  });
  it('clamps at both ends', () => {
    const s = new FactionStandings();
    for (let i = 0; i < 300; i++) s.adjust('ironfangs', 10);
    expect(s.standingOf('ironfangs')).toBe(1000);
    for (let i = 0; i < 300; i++) s.adjust('ironfangs', -10);
    expect(s.standingOf('ironfangs')).toBe(-1000);
    expect(s.adjust('nope', 50)).toBe(0);
  });
  it('round-trips snapshot/restore and sanitizes corrupt restores', () => {
    const s = new FactionStandings();
    s.adjust('ironfangs', -30);
    s.adjust('freeholds', 120);
    const snap = s.portalSnapshot();
    const t = new FactionStandings();
    t.restore(snap);
    expect(t.standingOf('ironfangs')).toBe(-30);
    expect(t.standingOf('freeholds')).toBe(120);
    t.restore({ version: 1, standings: { ironfangs: NaN as unknown as number, freeholds: 99999 } });
    expect(t.standingOf('ironfangs')).toBe(0);
    expect(t.standingOf('freeholds')).toBe(1000);
    t.restore(null);
    expect(t.standingOf('freeholds')).toBe(1000);
    t.restore({ version: 2 as unknown as 1, standings: {} });
    expect(t.standingOf('freeholds')).toBe(1000);
  });
  it('fires onChange on adjustment but not on a no-op', () => {
    const s = new FactionStandings();
    let n = 0;
    s.onChange = () => { n += 1; };
    s.adjust('ironfangs', 0);
    expect(n).toBe(0);
    s.adjust('ironfangs', 5);
    expect(n).toBe(1);
  });
  it('persists through the storage adapter', () => {
    const adapter = localStorageFactionsAdapter(12345);
    const s = new FactionStandings(adapter);
    s.adjust('ember_order', 75);
    s.save();
    const t = new FactionStandings(adapter);
    expect(t.standingOf('ember_order')).toBe(75);
  });
});

describe('quest standing gates', () => {
  it('validates the new def fields', () => {
    expect(validateQuestDef(questDef({ minStanding: { factionId: '', min: 1 } })).length).toBeGreaterThan(0);
    expect(validateQuestDef(questDef({ minStanding: { factionId: 'freeholds', min: NaN } })).length).toBeGreaterThan(0);
    expect(validateQuestDef(questDef({ standingReward: { factionId: 'freeholds', amount: NaN } })).length).toBeGreaterThan(0);
    expect(validateQuestDef(questDef({ minStanding: { factionId: 'freeholds', min: 250 } }))).toEqual([]);
  });
  it('gated side quests start locked, ungated side quests start available', () => {
    const m = manager([
      questDef({ id: 'gated', side: true, minStanding: { factionId: 'freeholds', min: 250 } }),
      questDef({ id: 'open', side: true }),
    ]);
    expect(m.statusOf('gated')).toBe('locked');
    expect(m.statusOf('open')).toBe('available');
  });
  it('accept refuses a gated quest and re-locks it when standing drops', () => {
    let standing = 300;
    const m = manager(
      [questDef({ id: 'gated', side: true, minStanding: { factionId: 'freeholds', min: 250 } })],
      { standingOf: () => standing },
    );
    expect(m.statusOf('gated')).toBe('available');
    standing = 0;
    expect(m.accept('gated')).toBe(false);
    expect(m.statusOf('gated')).toBe('locked');
  });
  it('refreshStandingGates unlocks exactly when standing is met', () => {
    let standing = 0;
    const m = manager(
      [questDef({ id: 'gated', side: true, minStanding: { factionId: 'freeholds', min: 250 } })],
      { standingOf: () => standing },
    );
    expect(m.statusOf('gated')).toBe('locked');
    m.refreshStandingGates();
    expect(m.statusOf('gated')).toBe('locked');
    standing = 250;
    m.refreshStandingGates();
    expect(m.statusOf('gated')).toBe('available');
    expect(m.accept('gated')).toBe(true);
  });
  it('a gated chain quest stays locked after its prerequisite turns in until standing is met', () => {
    let standing = 0;
    const turnedIn: QuestDef[] = [];
    const m = manager(
      [
        questDef({ id: 'first' }),
        questDef({ id: 'second', requiresQuests: ['first'], minStanding: { factionId: 'freeholds', min: 100 } }),
      ],
      { standingOf: () => standing, onQuestTurnedIn: (d) => { turnedIn.push(d); } },
    );
    expect(m.accept('first')).toBe(true);
    // complete it by driving the talk objective to done via onTalk
    m.onTalk('any');
    expect(m.statusOf('first')).toBe('complete');
    expect(m.turnIn('first')).toBe(true);
    expect(turnedIn.map((d) => d.id)).toEqual(['first']);
    expect(m.statusOf('second')).toBe('locked');
    standing = 100;
    m.refreshStandingGates();
    expect(m.statusOf('second')).toBe('available');
  });
  it('the gate never blocks progress or turn-in of an accepted quest', () => {
    let standing = 300;
    const m = manager(
      [questDef({ id: 'gated', side: true, minStanding: { factionId: 'freeholds', min: 250 } })],
      { standingOf: () => standing },
    );
    expect(m.accept('gated')).toBe(true);
    standing = -1000; // standing collapses mid-quest: progress still counts
    m.onTalk('any');
    expect(m.statusOf('gated')).toBe('complete');
    expect(m.turnIn('gated')).toBe(true);
  });
});

describe('ShopPanel standing pricing', () => {
  const defs: Record<string, any> = {
    loot_ironfang_blade: { id: 'loot_ironfang_blade', name: 'Ironfang Blade', value: 100, rarity: 'common' },
  };
  const vendorDefs: any[] = [{
    id: 'vendor_ironfangs', name: "Ironfang's Edge", keeper: 'Kess', tagline: 't',
    stockPool: ['loot_ironfang_blade'], buyMult: 1.5, sellMult: 0.3, maxStock: 4,
  }];

  function panel(standing: number, trades: Array<{ vendorId: string; kind: 'buy' | 'sell' }>) {
    const doc = fakeDoc();
    const container = makeEl('div');
    const wallet = new Wallet(100000);
    const backpack = new Map<string, number>();
    const inv: any = {
      add: (id: string, n: number) => { backpack.set(id, (backpack.get(id) ?? 0) + n); return 0; },
      remove: (id: string, n: number) => {
        const cur = backpack.get(id) ?? 0;
        if (cur < n) return 0;
        backpack.set(id, cur - n);
        return 1;
      },
      count: (id: string) => backpack.get(id) ?? 0,
      getBackpack: () => [...backpack.entries()].map(([itemId]) => ({ itemId })),
      onChange: null,
    };
    const p = new ShopPanel({
      container, doc,
      inventory: () => inv,
      wallet: () => wallet,
      defs: () => defs,
      vendorDefs: () => vendorDefs,
      toast: () => {},
      standingOf: () => standing,
      onTrade: (vendorId, kind) => { trades.push({ vendorId, kind }); },
    });
    return { p, wallet, inv, backpack };
  }

  it('at neutral, buy charges exactly the raw stock price and fires onTrade', () => {
    const trades: Array<{ vendorId: string; kind: 'buy' | 'sell' }> = [];
    const { p, wallet, backpack } = panel(0, trades);
    p.openForVendor({ vendorId: 'vendor_ironfangs', spawnSeed: 7, keeperName: 'Kess' });
    const stock = p.stockFor('vendor_ironfangs', 7);
    expect(stock.length).toBe(1);
    const before = wallet.balance;
    p.buy(stock[0]);
    expect(before - wallet.balance).toBe(stock[0].price);
    expect(backpack.get('loot_ironfang_blade')).toBe(1);
    expect(trades).toEqual([{ vendorId: 'vendor_ironfangs', kind: 'buy' }]);
    p.hide();
  });

  it('at friendly, buy charges exactly round(raw * 0.9)', () => {
    const trades: Array<{ vendorId: string; kind: 'buy' | 'sell' }> = [];
    const { p, wallet } = panel(300, trades);
    p.openForVendor({ vendorId: 'vendor_ironfangs', spawnSeed: 7, keeperName: 'Kess' });
    const stock = p.stockFor('vendor_ironfangs', 7);
    const before = wallet.balance;
    p.buy(stock[0]);
    expect(before - wallet.balance).toBe(Math.round(stock[0].price * 0.9));
    p.hide();
  });

  it('at hostile, buy charges exactly round(raw * 1.25) and sell fires onTrade', () => {
    const trades: Array<{ vendorId: string; kind: 'buy' | 'sell' }> = [];
    const { p, wallet, backpack } = panel(-1000, trades);
    p.openForVendor({ vendorId: 'vendor_ironfangs', spawnSeed: 7, keeperName: 'Kess' });
    const stock = p.stockFor('vendor_ironfangs', 7);
    const before = wallet.balance;
    p.buy(stock[0]);
    expect(before - wallet.balance).toBe(Math.round(stock[0].price * 1.25));
    // sell leg: the rendered sell price is floor(value*sellMult*0.75);
    // sell() itself transacts whatever price it is given (the render
    // path passes the effective price), and fires onTrade.
    backpack.set('loot_ironfang_blade', 2);
    const unit = Math.floor(100 * 0.3 * 0.75);
    p.sell('loot_ironfang_blade', unit);
    expect(wallet.balance - before + Math.round(stock[0].price * 1.25)).toBe(unit);
    expect(trades).toEqual([
      { vendorId: 'vendor_ironfangs', kind: 'buy' },
      { vendorId: 'vendor_ironfangs', kind: 'sell' },
    ]);
    p.hide();
  });
});
