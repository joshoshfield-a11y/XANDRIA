/**
 * Timed-quests wave: unit tests.
 * - TIMED_QUEST_SALT is distinct from every other wave's salt.
 * - TIMED_TEMPLATES is exactly the four brief variants (fetch / hunt /
 *   explore / craft), each on an existing objective kind, with a
 *   positive game-time limit and reward scale in the table.
 * - buildTimedOffers is a pure function of (spec, mapSeed, count):
 *   same inputs -> identical offer set (ids, objectives, rewards,
 *   timed limits/scales); timedOfferAt(k) replicates the batch's
 *   k-th offer, so board re-rolls are independently replicable.
 * - Reward scaling is exact: xp = round(baseXp * scale), item counts
 *   = max(1, round(count * scale)); the bonus-material line stays
 *   unscaled on its independent stream.
 * - QuestManager timer: the countdown advances ONLY through
 *   update(dt) (game-time, never wall-clock); non-positive / NaN dt
 *   never advances it; available and complete quests never tick;
 *   expiry flips the quest to 'failed' with no partial reward; the
 *   tracker shows the countdown line and refreshes only on
 *   whole-second ticks; reaccept() restarts the clock with progress
 *   reset and the retry can complete for the exact scaled reward.
 * - Portal snapshot/restore preserves elapsed exactly (corrupt
 *   values clamp); failed status restores as failed.
 * - TimedBoard: slots replicate the pure generator; abandon and
 *   turn-in re-roll deterministically; a failed slot stays for Try
 *   again (never orphaned by sync); no orphan defs.
 * - Manager timed-scoped methods: registerTimedDefs rejects
 *   non-timed / radiant / chained / gated / invalid defs;
 *   removeTimedDef and abandon keep story/side quests untouchable.
 */
import { describe, it, expect } from 'vitest';
import { defaultSpec, validateSpec, type GameSpec } from '../src/spec/schema';
import {
  QuestManager,
  validateQuestDef,
  formatTimedRemaining,
  QUEST_SALT,
  type QuestDef,
} from '../src/engine/game/quests';
import { SIDE_QUEST_SALT } from '../src/engine/game/sidequests';
import { RADIANT_SALT } from '../src/engine/game/radiantQuests';
import { QUEST_REWARD_BONUS_SALT, BONUS_MATERIALS } from '../src/engine/game/questRewards';
import { CRAFT_SALT, MAT_ORE, MAT_FIBER, MAT_SCRAP } from '../src/engine/game/crafting';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { STATION_SALT } from '../src/engine/game/stations';
import {
  TIMED_QUEST_SALT,
  TIMED_TEMPLATES,
  buildTimedOffers,
  timedOfferAt,
  resolveTimedCount,
  eligibleTimedTemplates,
  validateTimedDef,
  TimedBoard,
} from '../src/engine/game/timedQuests';

function specWith(seed: number, mut: (s: GameSpec) => void = () => {}): GameSpec {
  const spec = defaultSpec(seed) as GameSpec;
  mut(spec);
  return spec;
}

/** Portals-on spec: all four timed variants eligible (walker enemy + crafting on by default). */
function portalsSpec(seed: number): GameSpec {
  return specWith(seed, (s) => { s.world.portals = { enabled: true }; });
}

function makeManager(defs: QuestDef[], opts: Record<string, any> = {}) {
  const toasts: string[] = [];
  const inv = new Map<string, number>();
  const xpCalls: number[] = [];
  const renders: any[][] = [];
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
    tracker: { render: (qs: any[]) => { renders.push(qs); } } as any,
    toast: (m: string) => toasts.push(m),
    ...opts,
  });
  return { mgr, toasts, inv, xpCalls, renders };
}

/** Drive one objective to completion through the manager's own event methods. */
function driveToComplete(mgr: QuestManager, def: QuestDef): void {
  const o = def.objectives[0];
  if (o.kind === 'kill') for (let i = 0; i < o.count; i++) mgr.onKill(o.target);
  else if (o.kind === 'gather') mgr.onHarvest(o.target, o.count);
  else if (o.kind === 'craft') for (let i = 0; i < o.count; i++) mgr.onCraft(o.target);
  else throw new Error('test cannot drive kind ' + o.kind);
}

describe('TIMED_QUEST_SALT', () => {
  it('is distinct from every other wave salt', () => {
    const salts = [QUEST_SALT, SIDE_QUEST_SALT, RADIANT_SALT, QUEST_REWARD_BONUS_SALT, CRAFT_SALT, GATHER_SALT, STATION_SALT];
    expect(salts).not.toContain(TIMED_QUEST_SALT);
    expect(new Set(salts).size).toBe(salts.length);
  });
});

describe('TIMED_TEMPLATES', () => {
  it('is exactly the four brief variants across fetch/hunt/explore/craft', () => {
    expect(TIMED_TEMPLATES.map((t) => t.archetype).sort()).toEqual(['craft', 'explore', 'fetch', 'hunt']);
    expect(new Set(TIMED_TEMPLATES.map((t) => t.slug)).size).toBe(4);
    for (const t of TIMED_TEMPLATES) {
      expect(t.limitSeconds).toBeGreaterThan(0);
      expect(Number.isFinite(t.limitSeconds)).toBe(true);
      expect(t.rewardScale).toBeGreaterThan(0);
      expect(t.baseXp).toBeGreaterThan(0);
    }
  });

  it('every template builds a valid, timed, unchained, ungated def on an existing objective kind', () => {
    const spec = portalsSpec(20261012);
    for (const offer of buildTimedOffers(spec, { mapSeed: 20261012, count: 4 })) {
      expect(validateQuestDef(offer)).toEqual([]);
      expect(validateTimedDef(offer)).toEqual([]);
      expect(offer.timed).toBeDefined();
      expect(offer.radiant).toBeUndefined();
      expect(offer.requiresQuests ?? []).toEqual([]);
      expect(offer.minStanding).toBeUndefined();
      for (const o of offer.objectives) {
        expect(['kill', 'gather', 'craft', 'talk', 'explore']).toContain(o.kind);
      }
      const template = TIMED_TEMPLATES.find((t) => t.slug === offer.id.split('_').slice(3).join('_') || offer.id.endsWith(t.slug));
      expect(template).toBeDefined();
      expect(offer.timed!.limitSeconds).toBe(template!.limitSeconds);
      expect(offer.timed!.rewardScale).toBe(template!.rewardScale);
    }
  });

  it('reward scaling is exact: xp rounds, item counts round with a floor of 1, bonus line unscaled', () => {
    const spec = portalsSpec(20261012);
    const expectedItemCount: Record<string, number> = {
      timed_fetch: 4, // round(3 * 1.25)
      timed_hunt: 3, // round(2 * 1.5)
      timed_explore: 1, // round(1 * 1.25)
      timed_craft: 2, // round(1 * 1.5)
    };
    for (const offer of buildTimedOffers(spec, { mapSeed: 20261012, count: 4 })) {
      const slug = TIMED_TEMPLATES.find((t) => offer.id.endsWith(t.slug))!.slug;
      const template = TIMED_TEMPLATES.find((t) => t.slug === slug)!;
      expect(offer.rewards.xp).toBe(Math.round(template.baseXp * template.rewardScale));
      expect(offer.rewards.items[0].count).toBe(expectedItemCount[slug]);
      expect(offer.rewards.bonus).toHaveLength(1);
      expect(BONUS_MATERIALS).toContain(offer.rewards.bonus![0].id);
      expect(offer.rewards.bonus![0].count).toBeGreaterThanOrEqual(1);
      expect(offer.rewards.bonus![0].count).toBeLessThanOrEqual(2);
    }
  });
});

describe('timed offer generation', () => {
  it('is a pure function of (spec, mapSeed, count)', () => {
    const spec = portalsSpec(777);
    const a = buildTimedOffers(spec, { mapSeed: 777, count: 3 });
    const b = buildTimedOffers(spec, { mapSeed: 777, count: 3 });
    expect(a).toEqual(b);
    const otherSeed = buildTimedOffers(spec, { mapSeed: 778, count: 3 });
    expect(otherSeed).not.toEqual(a);
  });

  it('first N offers cover distinct archetypes while N <= eligible variants', () => {
    const spec = portalsSpec(4242);
    const offers = buildTimedOffers(spec, { mapSeed: 4242, count: 4 });
    const slugs = offers.map((o) => TIMED_TEMPLATES.find((t) => o.id.endsWith(t.slug))!.slug);
    expect(new Set(slugs).size).toBe(4);
  });

  it('timedOfferAt(index) replicates the batch sequence exactly', () => {
    const spec = portalsSpec(99);
    const batch = buildTimedOffers(spec, { mapSeed: 99, count: 6 });
    for (let k = 0; k < 6; k++) {
      expect(timedOfferAt(spec, { mapSeed: 99, index: k })).toEqual(batch[k]);
    }
  });

  it('resolveTimedCount defaults to 3 and clamps authored values to 1..4', () => {
    expect(resolveTimedCount(portalsSpec(1))).toBe(3);
    expect(resolveTimedCount(specWith(1, (s) => { s.custom = { ...s.custom, quests: { timedCount: 4 } }; }))).toBe(4);
    expect(resolveTimedCount(specWith(1, (s) => { s.custom = { ...s.custom, quests: { timedCount: 99 } }; }))).toBe(4);
    expect(resolveTimedCount(specWith(1, (s) => { s.custom = { ...s.custom, quests: { timedCount: 0 } }; }))).toBe(1);
  });

  it('schema rejects timedCount outside 1..4', () => {
    const bad = specWith(1, (s) => { s.custom = { ...s.custom, quests: { timedCount: 5 } }; });
    expect(validateSpec(bad).ok).toBe(false);
    const good = specWith(1, (s) => { s.custom = { ...s.custom, quests: { timedCount: 2 } }; });
    expect(validateSpec(good).ok).toBe(true);
  });

  it('portals-off specs offer only fetch/hunt/craft (no explore variant)', () => {
    const spec = specWith(5);
    expect(eligibleTimedTemplates(spec).map((t) => t.slug)).not.toContain('timed_explore');
    expect(eligibleTimedTemplates(portalsSpec(5)).map((t) => t.slug)).toContain('timed_explore');
  });
});

describe('formatTimedRemaining', () => {
  it('formats M:SS, rounding up to the next whole second', () => {
    expect(formatTimedRemaining(0)).toBe('0:00');
    expect(formatTimedRemaining(59)).toBe('0:59');
    expect(formatTimedRemaining(60)).toBe('1:00');
    expect(formatTimedRemaining(125.2)).toBe('2:06');
    expect(formatTimedRemaining(239.5)).toBe('4:00');
    expect(formatTimedRemaining(-3)).toBe('0:00');
  });
});

describe('QuestManager timed countdown', () => {
  it('advances only through update(dt): available and complete quests never tick, bad dt never advances', () => {
    const spec = portalsSpec(20261012);
    const offers = buildTimedOffers(spec, { mapSeed: 20261012, count: 4 });
    const { mgr } = makeManager([]);
    mgr.registerTimedDefs(offers);
    const def = offers[0];
    // Available: a huge dt does nothing.
    mgr.update(9999);
    expect(mgr.statusOf(def.id)).toBe('available');
    expect(mgr.timeRemaining(def.id)).toBe(def.timed!.limitSeconds);
    // Bad dt never advances an active quest.
    expect(mgr.accept(def.id)).toBe(true);
    mgr.update(0);
    mgr.update(-10);
    mgr.update(Number.NaN);
    expect(mgr.elapsedOf(def.id)).toBe(0);
    expect(mgr.timeRemaining(def.id)).toBe(def.timed!.limitSeconds);
    // Real game-time accrues exactly.
    mgr.update(30);
    expect(mgr.elapsedOf(def.id)).toBe(30);
    expect(mgr.timeRemaining(def.id)).toBe(def.timed!.limitSeconds - 30);
    // Complete quests stop ticking.
    driveToComplete(mgr, def);
    expect(mgr.statusOf(def.id)).toBe('complete');
    const remainingAtComplete = mgr.timeRemaining(def.id);
    mgr.update(9999);
    expect(mgr.statusOf(def.id)).toBe('complete');
    expect(mgr.timeRemaining(def.id)).toBe(remainingAtComplete);
  });

  it('expiry fails cleanly: no partial reward, tracker drops the quest, giver retry surface appears', () => {
    const spec = portalsSpec(20261012);
    const offers = buildTimedOffers(spec, { mapSeed: 20261012, count: 4 });
    const { mgr, toasts, inv, xpCalls, renders } = makeManager([]);
    mgr.registerTimedDefs(offers);
    const def = offers.find((o) => o.objectives[0].kind !== 'explore')!;
    expect(mgr.accept(def.id)).toBe(true);
    // Partial progress first: expiry must not pay for it.
    const o = def.objectives[0];
    if (o.kind === 'kill') mgr.onKill(o.target);
    else if (o.kind === 'gather') mgr.onHarvest(o.target, 1);
    else if (o.kind === 'craft') mgr.onCraft(o.target);
    mgr.update(def.timed!.limitSeconds + 1);
    expect(mgr.statusOf(def.id)).toBe('failed');
    expect(mgr.timeRemaining(def.id)).toBe(0);
    expect(toasts.some((t) => t.includes('Quest failed') && t.includes(def.name))).toBe(true);
    expect(inv.size).toBe(0);
    expect(xpCalls).toEqual([]);
    // The tracker no longer lists the failed quest.
    const last = renders[renders.length - 1] as any[];
    expect(last.some((q: any) => q.name === def.name)).toBe(false);
    // The giver retry surface lists it.
    expect(mgr.actionsForNpc('villager').failed.map((d) => d.id)).toContain(def.id);
    // Further game-time never revives or re-fails it.
    mgr.update(500);
    expect(mgr.statusOf(def.id)).toBe('failed');
    expect(mgr.actionsForNpc('villager').failed).toHaveLength(1);
  });

  it('tracker shows the countdown line and refreshes only on whole-second ticks', () => {
    const spec = portalsSpec(20261012);
    const offers = buildTimedOffers(spec, { mapSeed: 20261012, count: 4 });
    const { mgr, renders } = makeManager([]);
    mgr.registerTimedDefs(offers);
    const def = offers[0];
    expect(mgr.accept(def.id)).toBe(true);
    const baseRenders = renders.length;
    mgr.update(0.5); // first tick records the whole-second value
    expect(renders.length).toBe(baseRenders + 1);
    mgr.update(0.4); // same whole second: no DOM refresh
    expect(renders.length).toBe(baseRenders + 1);
    mgr.update(1.0); // whole second rolls over: one refresh
    expect(renders.length).toBe(baseRenders + 2);
    const snap = renders[renders.length - 1] as any[];
    const entry = snap.find((q: any) => q.name === def.name);
    expect(entry).toBeDefined();
    expect(entry.lines.some((l: string) => /⏱ \d+:\d+ left/.test(l))).toBe(true);
  });

  it('reaccept() restarts the clock with progress reset, and the retry can complete for the exact scaled reward', () => {
    const spec = portalsSpec(20261012);
    const offers = buildTimedOffers(spec, { mapSeed: 20261012, count: 4 });
    const { mgr, inv, xpCalls } = makeManager([]);
    mgr.registerTimedDefs(offers);
    const def = offers.find((o) => o.objectives[0].kind !== 'explore')!;
    expect(mgr.accept(def.id)).toBe(true);
    // Earn partial progress, then fail.
    const o = def.objectives[0];
    if (o.kind === 'kill') mgr.onKill(o.target);
    else if (o.kind === 'gather') mgr.onHarvest(o.target, 1);
    else if (o.kind === 'craft') mgr.onCraft(o.target);
    mgr.update(def.timed!.limitSeconds);
    expect(mgr.statusOf(def.id)).toBe('failed');
    // Re-accept is the only way back; accept() alone refuses a failed quest.
    expect(mgr.accept(def.id)).toBe(false);
    expect(mgr.reaccept(def.id)).toBe(true);
    expect(mgr.statusOf(def.id)).toBe('active');
    expect(mgr.elapsedOf(def.id)).toBe(0);
    expect(mgr.progressOf(def.id)).toEqual([0]);
    expect(mgr.timeRemaining(def.id)).toBe(def.timed!.limitSeconds);
    // Retry completes in time and grants exactly the scaled reward.
    driveToComplete(mgr, def);
    expect(mgr.statusOf(def.id)).toBe('complete');
    expect(mgr.turnIn(def.id)).toBe(true);
    expect(xpCalls).toEqual([def.rewards.xp]);
    const expected = new Map<string, number>();
    for (const r of [...def.rewards.items, ...(def.rewards.bonus ?? [])]) {
      expected.set(r.id, (expected.get(r.id) ?? 0) + r.count);
    }
    for (const [id, count] of expected) expect(inv.get(id)).toBe(count);
    // reaccept() refuses everything that is not a failed timed quest.
    expect(mgr.reaccept(def.id)).toBe(false);
    expect(mgr.reaccept('nope')).toBe(false);
  });

  it('portal snapshot/restore preserves elapsed exactly and clamps corrupt values', () => {
    const spec = portalsSpec(20261012);
    const offers = buildTimedOffers(spec, { mapSeed: 20261012, count: 4 });
    const { mgr } = makeManager([]);
    mgr.registerTimedDefs(offers);
    const def = offers[0];
    mgr.accept(def.id);
    mgr.update(90);
    const snap = mgr.portalSnapshot();
    expect(snap.states[def.id].elapsed).toBe(90);
    const second = makeManager([]);
    second.mgr.registerTimedDefs(offers);
    second.mgr.portalRestore(snap);
    expect(second.mgr.statusOf(def.id)).toBe('active');
    expect(second.mgr.elapsedOf(def.id)).toBe(90);
    expect(second.mgr.timeRemaining(def.id)).toBe(def.timed!.limitSeconds - 90);
    // Corrupt elapsed clamps to the limit; corrupt status clamps to locked; failed restores as failed.
    const corrupt = JSON.parse(JSON.stringify(snap)) as any;
    corrupt.states[def.id].elapsed = 99999;
    corrupt.states[def.id].status = 'bogus';
    const third = makeManager([]);
    third.mgr.registerTimedDefs(offers);
    third.mgr.portalRestore(corrupt);
    expect(third.mgr.statusOf(def.id)).toBe('locked');
    expect(third.mgr.elapsedOf(def.id)).toBe(def.timed!.limitSeconds);
    mgr.update(def.timed!.limitSeconds); // fail the first manager's quest
    const failedSnap = mgr.portalSnapshot();
    const fourth = makeManager([]);
    fourth.mgr.registerTimedDefs(offers);
    fourth.mgr.portalRestore(failedSnap);
    expect(fourth.mgr.statusOf(def.id)).toBe('failed');
  });

  it('validateQuestDef rejects bad timed fields', () => {
    const base: QuestDef = {
      id: 'q1', name: 'Q', giver: 'villager', brief: 'b',
      objectives: [{ id: 'o', kind: 'kill', desc: 'd', target: 'walker', count: 1 }],
      rewards: { xp: 10, items: [] },
    };
    expect(validateQuestDef({ ...base, timed: { limitSeconds: 0, rewardScale: 1 } })).not.toEqual([]);
    expect(validateQuestDef({ ...base, timed: { limitSeconds: 60, rewardScale: -1 } })).not.toEqual([]);
    expect(validateQuestDef({ ...base, timed: { limitSeconds: 60, rewardScale: 1 } })).toEqual([]);
  });
});

describe('QuestManager timed-scoped registration', () => {
  it('registerTimedDefs accepts only valid timed defs, dedupes, never throws', () => {
    const spec = portalsSpec(20261012);
    const offers = buildTimedOffers(spec, { mapSeed: 20261012, count: 4 });
    const { mgr } = makeManager([]);
    const plain: QuestDef = {
      id: 'plain', name: 'Plain', giver: 'villager', brief: 'b',
      objectives: [{ id: 'o', kind: 'kill', desc: 'd', target: 'walker', count: 1 }],
      rewards: { xp: 1, items: [] },
    };
    const radiantLike: QuestDef = { ...offers[0], id: 'rad1', radiant: true };
    const chained: QuestDef = { ...offers[0], id: 'chain1', requiresQuests: ['x'] };
    const gated: QuestDef = { ...offers[0], id: 'gate1', minStanding: { factionId: 'f', min: 5 } };
    const invalid: QuestDef = { ...offers[0], id: 'bad1', timed: { limitSeconds: 0, rewardScale: 1 } };
    mgr.registerTimedDefs([plain, radiantLike, chained, gated, invalid, ...offers, ...offers]);
    expect(mgr.defs.map((d) => d.id).sort()).toEqual(offers.map((d) => d.id).sort());
    expect(mgr.defs.every((d) => mgr.statusOf(d.id) === 'available')).toBe(true);
  });

  it('removeTimedDef and abandon keep story/side quests untouchable', () => {
    const spec = portalsSpec(20261012);
    const offers = buildTimedOffers(spec, { mapSeed: 20261012, count: 4 });
    const plain: QuestDef = {
      id: 'plain', name: 'Plain', giver: 'villager', brief: 'b',
      objectives: [{ id: 'o', kind: 'kill', desc: 'd', target: 'walker', count: 1 }],
      rewards: { xp: 1, items: [] },
    };
    const { mgr } = makeManager([plain]);
    mgr.registerTimedDefs(offers);
    const timed = offers[0];
    expect(mgr.removeTimedDef('plain')).toBe(false);
    expect(mgr.removeTimedDef(timed.id)).toBe(true);
    expect(mgr.statusOf(timed.id)).toBe('unknown');
    mgr.registerTimedDefs([timed]);
    expect(mgr.accept(timed.id)).toBe(true);
    expect(mgr.removeTimedDef(timed.id)).toBe(false); // active: must abandon first
    expect(mgr.abandon(timed.id)).toBe(true);
    expect(mgr.statusOf(timed.id)).toBe('unknown');
    // A story quest can never be abandoned, even when active.
    expect(mgr.accept('plain')).toBe(true);
    expect(mgr.abandon('plain')).toBe(false);
    expect(mgr.statusOf('plain')).toBe('active');
    expect(mgr.removeTimedDef('plain')).toBe(false);
  });
});

describe('TimedBoard', () => {
  function boardHarness(seed = 20261012, count = 3) {
    const spec = portalsSpec(seed);
    const { mgr, toasts, inv, xpCalls } = makeManager([]);
    const changed: number[] = [];
    const board = new TimedBoard({
      manager: mgr,
      spec,
      getMapSeed: () => seed,
      onChanged: () => changed.push(1),
    });
    return { spec, mgr, toasts, inv, xpCalls, changed, board };
  }

  it('slots replicate the pure generator exactly', () => {
    const { spec, board } = boardHarness();
    const slots = board.getSlots();
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.def)).toEqual(buildTimedOffers(spec, { mapSeed: 20261012, count: 3 }));
    expect(slots.every((s) => s.status === 'available')).toBe(true);
    expect(slots.every((s) => s.remainingSeconds === s.def.timed!.limitSeconds)).toBe(true);
  });

  it('abandon re-rolls deterministically and orphans no defs', () => {
    const { spec, mgr, board } = boardHarness();
    const nextIdx = board.nextSequenceIndex;
    const abandonedId = board.getSlots()[0].def.id;
    expect(board.accept(0)).toBe(true);
    expect(board.abandon(0)).toBe(true);
    expect(mgr.statusOf(abandonedId)).toBe('unknown');
    const after = board.getSlots();
    expect(after[0].def).toEqual(timedOfferAt(spec, { mapSeed: 20261012, index: nextIdx }));
    expect(after[0].status).toBe('available');
    const slotIds = new Set(after.map((s) => s.def.id));
    const timedIds = mgr.defs.filter((d) => d.timed !== undefined).map((d) => d.id);
    expect(timedIds.sort()).toEqual([...slotIds].sort());
  });

  it('turn-in re-rolls via sync and grants the exact scaled reward', () => {
    const { spec, mgr, board, inv, xpCalls } = boardHarness();
    const slots = board.getSlots();
    const idx = slots.findIndex((s) => s.def.objectives[0].kind !== 'explore');
    const def = slots[idx].def;
    expect(board.accept(idx)).toBe(true);
    driveToComplete(mgr, def);
    expect(board.turnIn(idx)).toBe(true);
    expect(xpCalls).toEqual([def.rewards.xp]);
    const expected = new Map<string, number>();
    for (const r of [...def.rewards.items, ...(def.rewards.bonus ?? [])]) {
      expected.set(r.id, (expected.get(r.id) ?? 0) + r.count);
    }
    for (const [id, count] of expected) expect(inv.get(id)).toBe(count);
    // The turned-in slot re-rolled; the old def is gone from the manager.
    expect(mgr.statusOf(def.id)).toBe('unknown');
    expect(board.getSlots()[idx].status).toBe('available');
    expect(board.getSlots()[idx].def.id).not.toBe(def.id);
  });

  it('a failed slot stays for Try again: sync never orphans it, reaccept restarts the same def', () => {
    const { mgr, board } = boardHarness();
    const def = board.getSlots()[0].def;
    expect(board.accept(0)).toBe(true);
    mgr.update(def.timed!.limitSeconds + 5);
    expect(mgr.statusOf(def.id)).toBe('failed');
    board.sync();
    // Still the same slot, still failed — sync must not re-roll it away.
    expect(board.getSlots()[0].def.id).toBe(def.id);
    expect(board.getSlots()[0].status).toBe('failed');
    expect(board.getSlots()[0].remainingSeconds).toBe(0);
    // Try again restarts the SAME def with a full clock and zero progress.
    expect(board.reaccept(0)).toBe(true);
    expect(board.getSlots()[0].def.id).toBe(def.id);
    expect(mgr.statusOf(def.id)).toBe('active');
    expect(mgr.elapsedOf(def.id)).toBe(0);
    expect(mgr.timeRemaining(def.id)).toBe(def.timed!.limitSeconds);
    expect(board.reaccept(0)).toBe(false); // active now, not failed
  });

  it('sync replaces slots turned in via the manager directly (dialogue path)', () => {
    const { mgr, board } = boardHarness();
    const def = board.getSlots()[1].def;
    expect(mgr.accept(def.id)).toBe(true);
    driveToComplete(mgr, def);
    expect(mgr.turnIn(def.id)).toBe(true);
    expect(mgr.statusOf(def.id)).toBe('turned-in');
    board.sync();
    expect(board.getSlots()[1].status).toBe('available');
    expect(board.getSlots()[1].def.id).not.toBe(def.id);
    expect(mgr.statusOf(def.id)).toBe('unknown');
  });

  it('validateTimedDef rejects radiant, chained, and gated defs', () => {
    const spec = portalsSpec(1);
    const offer = buildTimedOffers(spec, { mapSeed: 1, count: 1 })[0];
    expect(validateTimedDef(offer)).toEqual([]);
    expect(validateTimedDef({ ...offer, radiant: true })).not.toEqual([]);
    expect(validateTimedDef({ ...offer, requiresQuests: ['x'] })).not.toEqual([]);
    expect(validateTimedDef({ ...offer, minStanding: { factionId: 'f', min: 1 } })).not.toEqual([]);
    expect(validateTimedDef({ ...offer, timed: undefined })).not.toEqual([]);
  });
});
