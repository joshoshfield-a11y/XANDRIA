/**
 * Side-quests wave: unit tests.
 * - SIDE_QUEST_SALT distinctness (never collides with another wave's stream)
 * - buildSideQuestPool: determinism, 6-10 count, independence (no chaining,
 *   every def side:true), filters (crafting off, portals off, includeTalk
 *   false, no enemies), sideQuestCount override
 * - QuestManager: side quests available from construction (story line keeps
 *   its chain), autoAccept accepts everything, explore 'maps'/'biomes'
 *   tracking via getCurrentMap/worldSeed, portalSnapshot/portalRestore carry
 *   visited sets (no double-count after restore), corrupt visited input
 */
import { describe, it, expect } from 'vitest';
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import { SIDE_QUEST_SALT, buildSideQuestPool } from '../src/engine/game/sidequests';
import {
  QUEST_SALT,
  QuestManager,
  type QuestDef,
} from '../src/engine/game/quests';
import { NPC_SALT } from '../src/engine/game/Npc';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { CRAFT_SALT, MAT_ORE, MAT_FIBER, MAT_SCRAP } from '../src/engine/game/crafting';
import { STATION_SALT } from '../src/engine/game/stations';
import { GATHER_SALT } from '../src/engine/game/gathering';

function specWith(seed: number, mut: (s: GameSpec) => void = () => {}): GameSpec {
  const spec = defaultSpec(seed) as GameSpec;
  mut(spec);
  return spec;
}

function withPortals(spec: GameSpec): void {
  spec.world.portals = { ...(spec.world.portals as object | undefined), enabled: true } as GameSpec['world']['portals'];
}

function withTwoEnemies(spec: GameSpec): void {
  spec.enemies = [
    { kind: 'walker', count: 6, health: 30, speed: 4, damage: 10, weapon: 'melee' },
    { kind: 'brute', count: 2, health: 120, speed: 3, damage: 25, weapon: 'melee' },
  ];
}

function makeManager(defs: QuestDef[], opts: Record<string, any> = {}) {
  const toasts: string[] = [];
  const inv = new Map<string, number>();
  const mgr = new QuestManager({
    defs,
    inventory: () => ({
      add: (id: string, n = 1) => { inv.set(id, (inv.get(id) ?? 0) + n); return 0; },
    }),
    defsTable: () => ({ [MAT_ORE]: { id: MAT_ORE } as any, [MAT_FIBER]: { id: MAT_FIBER } as any, [MAT_SCRAP]: { id: MAT_SCRAP } as any }),
    progression: { addXp: (_n: number) => false, addXpEx: (_n: number) => ({ leveled: false, gain: null }) } as any,
    toast: (m: string) => toasts.push(m),
    ...opts,
  });
  return { mgr, toasts, inv };
}

describe('SIDE_QUEST_SALT', () => {
  it('is distinct from every other wave salt', () => {
    const salts = [QUEST_SALT, NPC_SALT, ENEMY_SALT, CRAFT_SALT, STATION_SALT, GATHER_SALT];
    for (const s of salts) expect(SIDE_QUEST_SALT).not.toBe(s);
    expect(new Set(salts).size).toBe(salts.length);
  });
});

describe('buildSideQuestPool', () => {
  it('is deterministic: same spec -> identical pool', () => {
    const a = buildSideQuestPool(specWith(20261012));
    const b = buildSideQuestPool(specWith(20261012));
    expect(a).toEqual(b);
  });

  it('varies with the seed', () => {
    const a = JSON.stringify(buildSideQuestPool(specWith(1)));
    const b = JSON.stringify(buildSideQuestPool(specWith(2)));
    expect(a).not.toBe(b);
  });

  it('holds 6-10 independent quests, all side:true, no chaining', () => {
    for (const seed of [20261012, 7, 99, 123456]) {
      const pool = buildSideQuestPool(specWith(seed, withPortals));
      expect(pool.length).toBeGreaterThanOrEqual(6);
      expect(pool.length).toBeLessThanOrEqual(10);
      const ids = pool.map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const d of ids) expect(d).toMatch(/^quest_side_\d+_[a-z_]+$/);
      for (const d of pool) {
        expect(d.side).toBe(true);
        expect(d.requiresQuests ?? []).toEqual([]);
        expect(d.objectives.length).toBeGreaterThanOrEqual(1);
        for (const o of d.objectives) {
          expect(['kill', 'gather', 'craft', 'talk', 'explore']).toContain(o.kind);
          expect(o.count).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('covers fetch, hunt, craft and explore archetypes when everything is on', () => {
    const kinds = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 20261012]) {
      for (const d of buildSideQuestPool(specWith(seed, (s) => { withPortals(s); withTwoEnemies(s); }))) {
        for (const o of d.objectives) kinds.add(o.kind);
      }
    }
    for (const k of ['gather', 'kill', 'craft', 'explore', 'talk']) {
      expect(kinds, `archetype ${k} appears across seeds`).toContain(k);
    }
  });

  it('filters when features are off', () => {
    const noCraft = buildSideQuestPool(specWith(20261012, (s) => { s.custom = { ...s.custom, crafting: { enabled: false } }; }));
    expect(noCraft.some((d) => d.objectives.some((o) => o.kind === 'gather' || o.kind === 'craft'))).toBe(false);
    const noPortals = buildSideQuestPool(specWith(20261012));
    expect(noPortals.some((d) => d.objectives.some((o) => o.kind === 'explore' && (o.target === 'maps' || o.target === 'biomes')))).toBe(false);
    const portals = buildSideQuestPool(specWith(20261012, withPortals));
    expect(portals.some((d) => d.objectives.some((o) => o.kind === 'explore'))).toBe(true);
    const noTalk = buildSideQuestPool(specWith(20261012), { includeTalk: false });
    expect(noTalk.some((d) => d.objectives.some((o) => o.kind === 'talk'))).toBe(false);
    const noEnemies = buildSideQuestPool(specWith(20261012, (s) => { s.enemies = []; }));
    expect(noEnemies.some((d) => d.objectives.some((o) => o.kind === 'kill'))).toBe(false);
  });

  it('honors the sideQuestCount Studio override', () => {
    const pool = buildSideQuestPool(specWith(20261012, (s) => {
      s.custom = { ...s.custom, quests: { sideQuestCount: 3 } };
    }));
    expect(pool.length).toBe(3);
    const capped = buildSideQuestPool(specWith(20261012, (s) => {
      s.custom = { ...s.custom, quests: { sideQuestCount: 99 } };
    }));
    expect(capped.length).toBeLessThanOrEqual(12);
  });
});

describe('QuestManager with side quests', () => {
  it('marks side quests available from construction; story quest[0] available, rest locked', () => {
    const story: QuestDef = {
      id: 'quest_story_1_first_blood', name: 'First Blood', giver: 'villager',
      brief: 'b', objectives: [{ id: 'o', kind: 'kill', desc: 'd', target: 'walker', count: 2 }],
      rewards: { xp: 10, items: [] },
    };
    const story2: QuestDef = {
      ...story, id: 'quest_story_2_big_game', name: 'Big Game', requiresQuests: [story.id],
    };
    const side: QuestDef = {
      id: 'quest_side_1_spare_parts', name: 'Spare Parts', giver: 'villager', side: true,
      brief: 'b', objectives: [{ id: 'o', kind: 'gather', desc: 'd', target: MAT_SCRAP, count: 2 }],
      rewards: { xp: 5, items: [] },
    };
    const { mgr } = makeManager([story, story2, side]);
    expect(mgr.statusOf(story.id)).toBe('available');
    expect(mgr.statusOf(story2.id)).toBe('locked');
    expect(mgr.statusOf(side.id)).toBe('available');
    // side quest: accept -> progress -> complete -> turn in
    expect(mgr.accept(side.id)).toBe(true);
    mgr.onHarvest(MAT_SCRAP, 2);
    expect(mgr.statusOf(side.id)).toBe('complete');
    expect(mgr.turnIn(side.id)).toBe(true);
    expect(mgr.statusOf(side.id)).toBe('turned-in');
    // story line untouched by the side quest
    expect(mgr.statusOf(story.id)).toBe('available');
    expect(mgr.statusOf(story2.id)).toBe('locked');
  });

  it('autoAccept accepts side quests at construction too', () => {
    const side: QuestDef = {
      id: 'quest_side_1_spare_parts', name: 'Spare Parts', giver: 'villager', side: true,
      brief: 'b', objectives: [{ id: 'o', kind: 'gather', desc: 'd', target: MAT_SCRAP, count: 1 }],
      rewards: { xp: 5, items: [] },
    };
    const { mgr } = makeManager([side], { autoAccept: true });
    expect(mgr.statusOf(side.id)).toBe('active');
    mgr.onHarvest(MAT_SCRAP, 1);
    expect(mgr.statusOf(side.id)).toBe('turned-in'); // auto-turn-in on completion
  });

  it('explore maps/biomes: distinct maps and biomes count once each', () => {
    const maps: QuestDef = {
      id: 'quest_side_8_waystations', name: 'Waystations', giver: 'villager', side: true,
      brief: 'b', objectives: [{ id: 'o', kind: 'explore', desc: 'd', target: 'maps', count: 3 }],
      rewards: { xp: 5, items: [] },
    };
    const biomes: QuestDef = {
      id: 'quest_side_9_biome_survey', name: 'Biome Survey', giver: 'villager', side: true,
      brief: 'b', objectives: [{ id: 'o', kind: 'explore', desc: 'd', target: 'biomes', count: 2 }],
      rewards: { xp: 5, items: [] },
    };
    let coord = { mx: 0, my: 0 };
    const { mgr } = makeManager([maps, biomes], {
      getCurrentMap: () => coord,
      worldSeed: 20261012,
      autoAccept: true,
    });
    mgr.update(0); // home map seeds: 1 map, 1 biome
    expect(mgr.progressOf(maps.id)).toEqual([1]);
    expect(mgr.progressOf(biomes.id)).toEqual([1]);
    mgr.update(0); // same map: no change
    expect(mgr.progressOf(maps.id)).toEqual([1]);
    coord = { mx: 1, my: 0 }; // portal arrival on a new map
    mgr.update(0);
    expect(mgr.progressOf(maps.id)).toEqual([2]);
    // biome count advances only when the derived biome is actually new
    const after = mgr.progressOf(biomes.id)[0];
    expect(after).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThanOrEqual(2);
  });

  it('portalSnapshot/portalRestore carry visited sets; re-visits do not double-count', () => {
    const maps: QuestDef = {
      id: 'quest_side_8_waystations', name: 'Waystations', giver: 'villager', side: true,
      brief: 'b', objectives: [{ id: 'o', kind: 'explore', desc: 'd', target: 'maps', count: 3 }],
      rewards: { xp: 5, items: [] },
    };
    let coord = { mx: 0, my: 0 };
    const mk = () => makeManager([maps], {
      getCurrentMap: () => coord, worldSeed: 20261012, autoAccept: true,
    });
    const a = mk();
    a.mgr.update(0);
    coord = { mx: 2, my: 3 };
    a.mgr.update(0);
    expect(a.mgr.progressOf(maps.id)).toEqual([2]);
    const snap = a.mgr.portalSnapshot();
    expect(snap.visited?.maps).toContain('0,0');
    expect(snap.visited?.maps).toContain('2,3');
    // restore into a fresh manager (rebuild scenario)
    const b = mk();
    b.mgr.portalRestore(snap);
    expect(b.mgr.progressOf(maps.id)).toEqual([2]);
    b.mgr.update(0); // same coord as the snapshot: no recount
    expect(b.mgr.progressOf(maps.id)).toEqual([2]);
    coord = { mx: 4, my: 4 };
    b.mgr.update(0);
    expect(b.mgr.progressOf(maps.id)).toEqual([3]);
    expect(b.mgr.statusOf(maps.id)).toBe('turned-in'); // autoAccept turn-in
  });

  it('portalRestore tolerates corrupt visited input', () => {
    const maps: QuestDef = {
      id: 'quest_side_8_waystations', name: 'Waystations', giver: 'villager', side: true,
      brief: 'b', objectives: [{ id: 'o', kind: 'explore', desc: 'd', target: 'maps', count: 3 }],
      rewards: { xp: 5, items: [] },
    };
    const { mgr } = makeManager([maps], { autoAccept: true });
    const snap: any = { version: 1, states: {}, visited: { maps: [42, null], biomes: 'nope' } };
    expect(() => mgr.portalRestore(snap)).not.toThrow();
    expect(mgr.portalSnapshot().visited).toEqual({ maps: [], biomes: [] });
  });
});
