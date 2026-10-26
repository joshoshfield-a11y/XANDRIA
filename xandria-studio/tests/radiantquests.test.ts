/**
 * Radiant-quests wave: unit tests.
 * - RADIANT_SALT is distinct from every other wave's salt.
 * - Tier bands from player level (documented boundaries).
 * - buildRadiantOffers is a pure function of (player level, map seed,
 *   count): same inputs -> identical offer set; different level or
 *   seed -> different set; offers cover distinct kinds; every offer
 *   is a valid QuestDef, radiant-flagged, unchained, ungated, and uses
 *   only existing objective kinds.
 * - radiantOfferAt(index) replicates the board's sequence: offer k of
 *   the batch equals offerAt(k), so abandon/turn-in re-rolls are
 *   independently replicable.
 * - QuestManager radiant-scoped methods: register (radiant-only, dedupe,
 *   invalid skipped, never auto-accepted), abandon (active radiant
 *   only — story/side quests can never be abandoned), removeRadiantDef
 *   (available/turned-in only).
 * - RadiantBoard: 3 rotating slots; accept keeps the slot; abandon
 *   re-rolls the slot to radiantOfferAt(nextSeq); turn-in re-rolls via
 *   sync; syncTier re-rolls only available offers on a tier change and
 *   is a no-op otherwise; completion feeds the existing turn-in path
 *   (XP + items land exactly).
 * - Explore/escort completion through the manager's existing update()
 *   (portal transitions + map changes) — the e2e covers fetch/hunt/
 *   craft through the live page; explore detection is unit-proven here
 *   (same disclosure pattern as the curated-quest-rewards wave).
 */
import { describe, it, expect } from 'vitest';
import { defaultSpec, validateSpec, type GameSpec } from '../src/spec/schema';
import { QuestManager, validateQuestDef, QUEST_SALT, type QuestDef } from '../src/engine/game/quests';
import { SIDE_QUEST_SALT } from '../src/engine/game/sidequests';
import { QUEST_REWARD_BONUS_SALT } from '../src/engine/game/questRewards';
import { CRAFT_SALT, MAT_ORE, MAT_FIBER, MAT_SCRAP } from '../src/engine/game/crafting';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { STATION_SALT } from '../src/engine/game/stations';
import {
  RADIANT_SALT,
  RADIANT_TEMPLATES,
  buildRadiantOffers,
  radiantOfferAt,
  radiantTierForLevel,
  resolveRadiantCount,
  eligibleRadiantTemplates,
  validateRadiantDef,
  RadiantBoard,
} from '../src/engine/game/radiantQuests';

function specWith(seed: number, mut: (s: GameSpec) => void = () => {}): GameSpec {
  const spec = defaultSpec(seed) as GameSpec;
  mut(spec);
  return spec;
}

/** Portals-on spec: all five radiant kinds eligible (walker enemy + crafting on by default). */
function portalsSpec(seed: number): GameSpec {
  return specWith(seed, (s) => { s.world.portals = { enabled: true }; });
}

function makeManager(defs: QuestDef[], opts: Record<string, any> = {}) {
  const toasts: string[] = [];
  const inv = new Map<string, number>();
  const xpCalls: number[] = [];
  const mgr = new QuestManager({
    defs,
    inventory: () => ({
      add: (id: string, n = 1) => { inv.set(id, (inv.get(id) ?? 0) + n); return 0; },
    }),
    defsTable: () => ({
      [MAT_ORE]: { id: MAT_ORE } as any,
      [MAT_FIBER]: { id: MAT_FIBER } as any,
      [MAT_SCRAP]: { id: MAT_SCRAP } as any,
      mat_ember_shard: { id: 'mat_ember_shard' } as any,
      mat_beast_hide: { id: 'mat_beast_hide' } as any,
      mat_core_fragment: { id: 'mat_core_fragment' } as any,
      craft_field_kit: { id: 'craft_field_kit' } as any,
      craft_scrap_buckler: { id: 'craft_scrap_buckler' } as any,
      loot_surge_tonic: { id: 'loot_surge_tonic' } as any,
    }),
    progression: {
      addXp: (n: number) => { xpCalls.push(n); return false; },
      addXpEx: (n: number) => { xpCalls.push(n); return { leveled: false, gain: null }; },
    } as any,
    toast: (m: string) => toasts.push(m),
    ...opts,
  });
  return { mgr, toasts, inv, xpCalls };
}

describe('RADIANT_SALT', () => {
  it('is distinct from every other wave salt', () => {
    const salts = [QUEST_SALT, SIDE_QUEST_SALT, QUEST_REWARD_BONUS_SALT, CRAFT_SALT, GATHER_SALT, STATION_SALT];
    expect(salts).not.toContain(RADIANT_SALT);
    expect(new Set(salts).size).toBe(salts.length);
  });
});

describe('radiantTierForLevel', () => {
  it('maps the documented bands', () => {
    expect(radiantTierForLevel(1)).toBe(1);
    expect(radiantTierForLevel(4)).toBe(1);
    expect(radiantTierForLevel(5)).toBe(2);
    expect(radiantTierForLevel(9)).toBe(2);
    expect(radiantTierForLevel(10)).toBe(3);
    expect(radiantTierForLevel(19)).toBe(3);
    expect(radiantTierForLevel(20)).toBe(4);
    expect(radiantTierForLevel(34)).toBe(4);
    expect(radiantTierForLevel(35)).toBe(5);
    expect(radiantTierForLevel(99)).toBe(5);
    expect(radiantTierForLevel(0)).toBe(1);
  });
});

describe('RADIANT_TEMPLATES', () => {
  it('is exactly the five brief kinds, each on an existing objective kind', () => {
    expect(RADIANT_TEMPLATES.map((t) => t.kind).sort()).toEqual(
      ['craft', 'escort', 'explore', 'fetch', 'hunt'].sort(),
    );
    expect(new Set(RADIANT_TEMPLATES.map((t) => t.slug)).size).toBe(5);
  });

  it('every template builds a valid, radiant, unchained, ungated def', () => {
    const spec = portalsSpec(20261012);
    for (const offer of buildRadiantOffers(spec, { playerLevel: 1, mapSeed: 20261012, count: 5 })) {
      expect(validateQuestDef(offer)).toEqual([]);
      expect(validateRadiantDef(offer)).toEqual([]);
      expect(offer.radiant).toBe(true);
      expect(offer.requiresQuests ?? []).toEqual([]);
      expect(offer.minStanding).toBeUndefined();
      expect(offer.objectives.length).toBeGreaterThanOrEqual(1);
      for (const o of offer.objectives) {
        expect(['kill', 'gather', 'craft', 'talk', 'explore']).toContain(o.kind);
      }
    }
  });
});

describe('buildRadiantOffers determinism', () => {
  it('same (level, mapSeed, count) -> identical offer set', () => {
    const a = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 3, mapSeed: 777, count: 3 });
    const b = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 3, mapSeed: 777, count: 3 });
    expect(a).toEqual(b);
  });

  it('different mapSeed -> different set; different level -> different counts/rewards', () => {
    const base = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, count: 3 });
    const otherSeed = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 1, mapSeed: 778, count: 3 });
    expect(otherSeed).not.toEqual(base);
    const highLevel = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 40, mapSeed: 777, count: 3 });
    // Same template order (same stream), but tier-scaled counts/XP differ.
    expect(highLevel.map((d) => d.name)).toEqual(base.map((d) => d.name));
    expect(highLevel.some((d, i) => d.rewards.xp !== base[i].rewards.xp)).toBe(true);
  });

  it('offers cover distinct kinds and cap at the eligible-kind count', () => {
    const offers = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, count: 3 });
    expect(offers).toHaveLength(3);
    const kinds = offers.map((d) => d.objectives[0].kind);
    expect(new Set(kinds).size).toBe(3);
    // Past the eligible-kind count the sequence cycles the shuffled
    // order (the board is endless) — the first 5 stay distinct.
    const all = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, count: 9 });
    expect(all).toHaveLength(9);
    // Distinctness is by template slug: explore + escort share the
    // 'explore' objective kind by design (both ride the same hook).
    const slugOf = (id: string): string => id.replace(/^quest_radiant_\d+_/, '');
    expect(new Set(all.slice(0, 5).map((d) => slugOf(d.id))).size).toBe(5);
    expect(slugOf(all[5].id)).toBe(slugOf(all[0].id));
  });

  it('portals-off specs exclude explore + escort (fetch/hunt/craft only)', () => {
    const offers = buildRadiantOffers(specWith(20261012), { playerLevel: 1, mapSeed: 777, count: 3 });
    expect(offers.map((d) => d.objectives[0].kind).sort()).toEqual(['craft', 'gather', 'kill'].sort());
    expect(eligibleRadiantTemplates(specWith(20261012)).map((t) => t.kind).sort())
      .toEqual(['craft', 'fetch', 'hunt'].sort());
  });

  it('radiantOfferAt(k) equals batch offer k, for every k', () => {
    const spec = portalsSpec(20261012);
    const batch = buildRadiantOffers(spec, { playerLevel: 7, mapSeed: 4242, count: 5 });
    for (let k = 0; k < batch.length; k++) {
      expect(radiantOfferAt(spec, { playerLevel: 7, mapSeed: 4242, index: k })).toEqual(batch[k]);
    }
  });

  it('rewards scale with tier and reuse the existing bonus line', () => {
    const spec = portalsSpec(20261012);
    const low = buildRadiantOffers(spec, { playerLevel: 1, mapSeed: 777, count: 5 });
    const high = buildRadiantOffers(spec, { playerLevel: 40, mapSeed: 777, count: 5 });
    for (let i = 0; i < low.length; i++) {
      expect(high[i].rewards.xp).toBeGreaterThan(low[i].rewards.xp);
      // Bonus line: one material from the curated bonus pool, count 1..2.
      expect(low[i].rewards.bonus).toHaveLength(1);
      expect([MAT_ORE, MAT_FIBER, MAT_SCRAP]).toContain(low[i].rewards.bonus![0].id);
      expect(low[i].rewards.bonus![0].count).toBeGreaterThanOrEqual(1);
      expect(low[i].rewards.bonus![0].count).toBeLessThanOrEqual(2);
    }
  });
});

describe('resolveRadiantCount', () => {
  it('defaults to 3 and honors the authored 1..5 range', () => {
    expect(resolveRadiantCount(portalsSpec(1))).toBe(3);
    expect(resolveRadiantCount(specWith(1, (s) => { s.custom = { ...(s.custom ?? {}), quests: { radiantCount: 5 } }; }))).toBe(5);
    expect(resolveRadiantCount(specWith(1, (s) => { s.custom = { ...(s.custom ?? {}), quests: { radiantCount: 99 } }; }))).toBe(5);
  });

  it('validateSpec rejects malformed radiantCount', () => {
    const bad = specWith(1, (s) => { s.custom = { ...(s.custom ?? {}), quests: { radiantCount: 0 } }; });
    expect(validateSpec(bad).errors.some((e) => e.includes('radiantCount'))).toBe(true);
    const good = specWith(1, (s) => { s.custom = { ...(s.custom ?? {}), quests: { radiantCount: 2 } }; });
    expect(validateSpec(good).errors.filter((e) => e.includes('radiantCount'))).toEqual([]);
  });
});

describe('QuestManager radiant-scoped methods', () => {
  const story: QuestDef = {
    id: 'story1', name: 'Story', giver: 'villager', brief: 'b',
    objectives: [{ id: 'o', kind: 'kill', desc: 'Kill 1', target: 'walker', count: 1 }],
    rewards: { xp: 10, items: [] },
  };

  it('registerRadiantDefs: radiant only, deduped, invalid skipped, never auto-accepted', () => {
    const h = makeManager([story], { autoAccept: true });
    // autoAccept took the story quest at construction; radiant defs must NOT auto-accept.
    expect(h.mgr.statusOf('story1')).toBe('active');
    const offers = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, count: 3 });
    h.mgr.registerRadiantDefs(offers);
    for (const o of offers) expect(h.mgr.statusOf(o.id)).toBe('available');
    h.mgr.registerRadiantDefs(offers); // dedupe: no crash, no change
    for (const o of offers) expect(h.mgr.statusOf(o.id)).toBe('available');
    // Non-radiant defs are refused.
    h.mgr.registerRadiantDefs([{ ...offers[0], id: 'impostor', radiant: false }]);
    expect(h.mgr.statusOf('impostor')).toBe('unknown');
    // Chained radiant defs are refused.
    h.mgr.registerRadiantDefs([{ ...offers[0], id: 'chained', requiresQuests: ['story1'] }]);
    expect(h.mgr.statusOf('chained')).toBe('unknown');
    // Story quest still active and untouched.
    expect(h.mgr.statusOf('story1')).toBe('active');
  });

  it('abandon: active radiant only — story/side quests can never be abandoned', () => {
    const h = makeManager([story]);
    const offers = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, count: 3 });
    h.mgr.registerRadiantDefs(offers);
    expect(h.mgr.abandon(offers[0].id)).toBe(false); // available, not active
    expect(h.mgr.abandon('story1')).toBe(false); // non-radiant, and available anyway
    h.mgr.accept('story1');
    expect(h.mgr.abandon('story1')).toBe(false); // active but NOT radiant: refused
    expect(h.mgr.statusOf('story1')).toBe('active');
    h.mgr.accept(offers[0].id);
    expect(h.mgr.abandon(offers[0].id)).toBe(true);
    expect(h.mgr.statusOf(offers[0].id)).toBe('unknown');
    expect(h.mgr.abandon(offers[0].id)).toBe(false); // already gone
  });

  it('removeRadiantDef: available/turned-in only, never active/complete or non-radiant', () => {
    const h = makeManager([story]);
    const offers = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, count: 3 });
    h.mgr.registerRadiantDefs(offers);
    expect(h.mgr.removeRadiantDef('story1')).toBe(false);
    h.mgr.accept(offers[0].id);
    expect(h.mgr.removeRadiantDef(offers[0].id)).toBe(false); // active: must abandon instead
    expect(h.mgr.removeRadiantDef(offers[1].id)).toBe(true); // available: removable
    expect(h.mgr.statusOf(offers[1].id)).toBe('unknown');
  });

  it('radiant turn-in grants XP + items + bonus exactly, via the existing path', () => {
    const h = makeManager([]);
    const offers = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, count: 5 });
    const target = offers.find((o) => o.objectives[0].kind === 'gather')!;
    h.mgr.registerRadiantDefs([target]);
    h.mgr.accept(target.id);
    const obj = target.objectives[0];
    h.mgr.onHarvest(obj.target, obj.count);
    expect(h.mgr.statusOf(target.id)).toBe('complete');
    const before = new Map(h.inv);
    const xpBefore = h.xpCalls.length;
    expect(h.mgr.turnIn(target.id)).toBe(true);
    expect(h.mgr.statusOf(target.id)).toBe('turned-in');
    expect(h.xpCalls.slice(xpBefore)).toEqual([target.rewards.xp]);
    for (const item of [...target.rewards.items, ...(target.rewards.bonus ?? [])]) {
      expect((h.inv.get(item.id) ?? 0) - (before.get(item.id) ?? 0)).toBe(item.count);
    }
  });

  it('explore + escort objectives complete through the existing update() (portals + maps)', () => {
    let transitions = 0;
    let coord: { mx: number; my: number } | null = { mx: 0, my: 0 };
    const h = makeManager([], {
      getTransitions: () => transitions,
      getCurrentMap: () => coord,
      worldSeed: 99,
    });
    const offers = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, count: 5 });
    const explore = offers.find((o) => o.objectives[0].target === 'portals')!;
    const escort = offers.find((o) => o.objectives[0].target === 'maps')!;
    h.mgr.registerRadiantDefs([explore, escort]);
    h.mgr.update(0.016); // prime: home map seeds BEFORE accept, as in the live game
    h.mgr.accept(explore.id);
    h.mgr.accept(escort.id);
    h.mgr.update(0.016); // no portal yet: nothing advances
    expect(h.mgr.statusOf(explore.id)).toBe('active');
    expect(h.mgr.statusOf(escort.id)).toBe('active');
    transitions = 1;
    coord = { mx: 1, my: 0 };
    h.mgr.update(0.016);
    expect(h.mgr.statusOf(explore.id)).toBe('complete');
    expect(h.mgr.statusOf(escort.id)).toBe('complete');
  });
});

describe('RadiantBoard', () => {
  function makeBoard(level = 1, mapSeed = 777) {
    const h = makeManager([]);
    let lv = level;
    const board = new RadiantBoard({
      manager: h.mgr,
      spec: portalsSpec(20261012),
      getPlayerLevel: () => lv,
      getMapSeed: () => mapSeed,
    });
    return { ...h, board, setLevel: (n: number) => { lv = n; } };
  }

  it('starts with 3 available slots matching the pure offer set', () => {
    const { board } = makeBoard();
    const slots = board.getSlots();
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => s.status === 'available')).toBe(true);
    const pure = buildRadiantOffers(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, count: 3 });
    expect(slots.map((s) => s.def)).toEqual(pure);
  });

  it('accept keeps the slot; abandon re-rolls it to radiantOfferAt(nextSeq)', () => {
    const { board, mgr } = makeBoard();
    const first = board.getSlots()[0].def;
    expect(board.accept(0)).toBe(true);
    expect(board.getSlots()[0].status).toBe('active');
    const nextIdx = board.nextSequenceIndex;
    expect(board.abandon(0)).toBe(true);
    expect(mgr.statusOf(first.id)).toBe('unknown');
    const replacement = board.getSlots()[0].def;
    expect(replacement).toEqual(
      radiantOfferAt(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, index: nextIdx }),
    );
    expect(mgr.statusOf(replacement.id)).toBe('available');
  });

  it('abandon consumes exactly one sequence index and orphans no def (2026-10-25 sync re-entrancy bug)', () => {
    // Reproduce the live blueprint wiring: the manager's
    // onQuestsChanged thunk calls board.sync(), so manager.abandon
    // re-enters sync() mid-abandon. Without the guard the slot was
    // replaced twice (sync's offer, then abandon's own offer) and the
    // first replacement orphaned in the manager.
    let board: RadiantBoard | null = null;
    const h = makeManager([], { onQuestsChanged: () => board?.sync() });
    board = new RadiantBoard({
      manager: h.mgr, spec: portalsSpec(20261012),
      getPlayerLevel: () => 1, getMapSeed: () => 777,
    });
    board.accept(0);
    const before = board.nextSequenceIndex;
    expect(board.abandon(0)).toBe(true);
    expect(board.nextSequenceIndex).toBe(before + 1);
    const slotIds = new Set(board.getSlots().map((s) => s.def.id));
    const radiantInMgr = h.mgr.defs.filter((d) => d.radiant).map((d) => d.id);
    expect(radiantInMgr.sort()).toEqual([...slotIds].sort());
    // The replacement is exactly the next sequence offer (replicable).
    expect(board.getSlots()[0].def).toEqual(
      radiantOfferAt(portalsSpec(20261012), { playerLevel: 1, mapSeed: 777, index: before }),
    );
  });

  it('abandon refuses non-active slots and leaves the board unchanged', () => {
    const { board } = makeBoard();
    const before = board.getSlots().map((s) => s.def.id);
    expect(board.abandon(0)).toBe(false); // available, not active
    expect(board.getSlots().map((s) => s.def.id)).toEqual(before);
  });

  it('turn-in re-rolls the slot; story quests on the same manager are untouched', () => {
    const story: QuestDef = {
      id: 'story1', name: 'Story', giver: 'villager', brief: 'b',
      objectives: [{ id: 'o', kind: 'kill', desc: 'Kill 1', target: 'walker', count: 1 }],
      rewards: { xp: 10, items: [] },
    };
    const h = makeManager([story]);
    let lv = 1;
    const board = new RadiantBoard({
      manager: h.mgr, spec: portalsSpec(20261012),
      getPlayerLevel: () => lv, getMapSeed: () => 777,
    });
    const slots = board.getSlots();
    const gather = slots.findIndex((s) => ['kill', 'gather', 'craft'].includes(s.def.objectives[0].kind));
    expect(gather).toBeGreaterThanOrEqual(0);
    const def = slots[gather].def;
    const obj = def.objectives[0];
    board.accept(gather);
    if (obj.kind === 'kill') for (let i = 0; i < obj.count; i++) h.mgr.onKill(obj.target);
    if (obj.kind === 'gather') h.mgr.onHarvest(obj.target, obj.count);
    if (obj.kind === 'craft') for (let i = 0; i < obj.count; i++) h.mgr.onCraft(obj.target);
    expect(board.getSlots()[gather].status).toBe('complete');
    expect(board.turnIn(gather)).toBe(true);
    expect(h.mgr.statusOf(def.id)).toBe('unknown'); // turned-in slot re-rolled away
    expect(board.getSlots()[gather].status).toBe('available');
    expect(h.mgr.statusOf('story1')).toBe('available'); // untouched
  });

  it('syncTier re-rolls only available offers on a tier change, and is a no-op otherwise', () => {
    const { board, setLevel } = makeBoard(1, 777);
    const before = board.getSlots().map((s) => s.def.id);
    board.syncTier();
    expect(board.getSlots().map((s) => s.def.id)).toEqual(before); // no tier change
    board.accept(0); // slot 0 active: must survive the tier move
    const activeId = board.getSlots()[0].def.id;
    setLevel(10); // tier 1 -> 3
    board.syncTier();
    const after = board.getSlots();
    expect(after[0].def.id).toBe(activeId);
    expect(after[0].status).toBe('active');
    expect(after.slice(1).map((s) => s.def.id)).not.toEqual(before.slice(1));
    expect(after.slice(1).every((s) => s.status === 'available')).toBe(true);
  });

  it('sync replaces slots turned in via another path (e.g. villager dialogue)', () => {
    const { board, mgr } = makeBoard();
    // Pick a directly completable slot (kill/gather/craft), not explore.
    const slots = board.getSlots();
    const idx = slots.findIndex((s) => ['kill', 'gather', 'craft'].includes(s.def.objectives[0].kind));
    expect(idx).toBeGreaterThanOrEqual(0);
    const def = slots[idx].def;
    const obj = def.objectives[0];
    board.accept(idx);
    if (obj.kind === 'kill') for (let i = 0; i < obj.count; i++) mgr.onKill(obj.target);
    if (obj.kind === 'gather') mgr.onHarvest(obj.target, obj.count);
    if (obj.kind === 'craft') for (let i = 0; i < obj.count; i++) mgr.onCraft(obj.target);
    expect(mgr.statusOf(def.id)).toBe('complete');
    mgr.turnIn(def.id); // as the villager dialogue would
    board.sync();
    expect(mgr.statusOf(def.id)).toBe('unknown');
    expect(board.getSlots()[idx].status).toBe('available');
  });
});
