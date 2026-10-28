/**
 * Quest-waypoints: unit tests for the pure objective -> position resolver.
 * No engine, no DOM, no RNG — the resolver is a pure function of
 * (manager state, world view), so every case is asserted exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveQuestWaypoint,
  trackedObjective,
  type QuestManagerLike,
  type WaypointWorld,
} from '../src/engine/game/questWaypoints';
import type { QuestDef, QuestStatus } from '../src/engine/game/quests';

function def(id: string, objectives: QuestDef['objectives'], extra: Partial<QuestDef> = {}): QuestDef {
  return {
    id,
    name: `Quest ${id}`,
    giver: 'villager',
    brief: 'brief',
    objectives,
    rewards: { xp: 10, items: [] },
    ...extra,
  };
}

function fakeManager(defs: QuestDef[], states: Record<string, { status: QuestStatus; progress: number[] }>): QuestManagerLike {
  return {
    defs,
    statusOf: (id) => states[id]?.status ?? 'unknown',
    progressOf: (id) => [...(states[id]?.progress ?? [])],
  };
}

function world(over: Partial<WaypointWorld> = {}): WaypointWorld {
  return {
    playerPos: { x: 0, y: 0, z: 0 },
    enemies: [],
    npcs: [],
    nodes: [],
    stations: [],
    portalExits: [],
    recipeStation: () => undefined,
    ...over,
  };
}

const TALK = def('q1', [{ id: 'o1', kind: 'talk', desc: 'talk', target: 'villager', count: 2 }]);
const KILL = def('q2', [{ id: 'o1', kind: 'kill', desc: 'kill', target: 'walker', count: 3 }]);

describe('trackedObjective', () => {
  it('picks the first active quest in roster order', () => {
    const m = fakeManager([TALK, KILL], {
      q1: { status: 'available', progress: [0] },
      q2: { status: 'active', progress: [0] },
    });
    expect(trackedObjective(m)?.def.id).toBe('q2');
  });

  it('returns null when nothing is active', () => {
    const m = fakeManager([TALK], { q1: { status: 'available', progress: [0] } });
    expect(trackedObjective(m)).toBeNull();
  });

  it('returns null when the active quest is complete (waypoint clears)', () => {
    const m = fakeManager([TALK], { q1: { status: 'complete', progress: [2] } });
    expect(trackedObjective(m)).toBeNull();
    expect(resolveQuestWaypoint(m, world())).toBeNull();
  });

  it('advances to the first incomplete objective', () => {
    const multi = def('qm', [
      { id: 'o1', kind: 'kill', desc: 'kill', target: 'walker', count: 1 },
      { id: 'o2', kind: 'talk', desc: 'talk', target: 'villager', count: 1 },
    ]);
    const m = fakeManager([multi], { qm: { status: 'active', progress: [1, 0] } });
    expect(trackedObjective(m)?.objective.id).toBe('o2');
  });

  it('returns null when the active quest is fully progressed but still active', () => {
    const m = fakeManager([TALK], { q1: { status: 'active', progress: [2] } });
    expect(trackedObjective(m)).toBeNull();
  });
});

describe('resolveQuestWaypoint', () => {
  it('kill: nearest alive enemy of the target kind, exact position', () => {
    const m = fakeManager([KILL], { q2: { status: 'active', progress: [0] } });
    const w = resolveQuestWaypoint(m, world({
      enemies: [
        { kind: 'walker', alive: true, position: { x: 30, y: 1, z: 0 } },
        { kind: 'walker', alive: true, position: { x: 10, y: 2, z: 0 } },
        { kind: 'brute', alive: true, position: { x: 1, y: 0, z: 0 } },
      ],
    }));
    expect(w?.position).toEqual({ x: 10, y: 2, z: 0 });
    expect(w?.questId).toBe('q2');
  });

  it('kill: dead enemies and wrong kinds are skipped; none -> null', () => {
    const m = fakeManager([KILL], { q2: { status: 'active', progress: [0] } });
    expect(resolveQuestWaypoint(m, world({
      enemies: [
        { kind: 'walker', alive: false, position: { x: 1, y: 0, z: 0 } },
        { kind: 'brute', alive: true, position: { x: 2, y: 0, z: 0 } },
      ],
    }))).toBeNull();
  });

  it('gather: nearest live node of the target material; depleted skipped', () => {
    const gather = def('qg', [{ id: 'o1', kind: 'gather', desc: 'g', target: 'mat_ore', count: 2 }]);
    const m = fakeManager([gather], { qg: { status: 'active', progress: [0] } });
    const w = resolveQuestWaypoint(m, world({
      nodes: [
        { materialId: 'mat_ore', depleted: true, position: { x: 1, y: 0, z: 0 } },
        { materialId: 'mat_fiber', depleted: false, position: { x: 2, y: 0, z: 0 } },
        { materialId: 'mat_ore', depleted: false, position: { x: 8, y: 3, z: 4 } },
      ],
    }));
    expect(w?.position).toEqual({ x: 8, y: 3, z: 4 });
  });

  it("gather 'any': nearest node of any material", () => {
    const gather = def('qg', [{ id: 'o1', kind: 'gather', desc: 'g', target: 'any', count: 1 }]);
    const m = fakeManager([gather], { qg: { status: 'active', progress: [0] } });
    const w = resolveQuestWaypoint(m, world({
      nodes: [
        { materialId: 'mat_scrap', depleted: false, position: { x: 5, y: 0, z: 0 } },
        { materialId: 'mat_ore', depleted: false, position: { x: 9, y: 0, z: 0 } },
      ],
    }));
    expect(w?.position.x).toBe(5);
  });

  it('craft: prefers the station the recipe requires', () => {
    const craft = def('qc', [{ id: 'o1', kind: 'craft', desc: 'c', target: 'recipe_x', count: 1 }]);
    const m = fakeManager([craft], { qc: { status: 'active', progress: [0] } });
    const w = resolveQuestWaypoint(m, world({
      stations: [
        { stationId: 'station_workbench', position: { x: 1, y: 0, z: 0 } },
        { stationId: 'station_forge', position: { x: 20, y: 0, z: 0 } },
      ],
      recipeStation: (id) => (id === 'recipe_x' ? 'station_forge' : undefined),
    }));
    expect(w?.position.x).toBe(20);
  });

  it('craft: station-free recipe -> nearest station; no stations -> null', () => {
    const craft = def('qc', [{ id: 'o1', kind: 'craft', desc: 'c', target: 'recipe_x', count: 1 }]);
    const m = fakeManager([craft], { qc: { status: 'active', progress: [0] } });
    expect(resolveQuestWaypoint(m, world({
      stations: [{ stationId: 'station_anvil', position: { x: 3, y: 0, z: 0 } }],
    }))?.position.x).toBe(3);
    expect(resolveQuestWaypoint(m, world())).toBeNull();
  });

  it('talk: nearest live NPC of the target role; any role when target is any', () => {
    const m = fakeManager([TALK], { q1: { status: 'active', progress: [0] } });
    const w = resolveQuestWaypoint(m, world({
      npcs: [
        { role: 'merchant', alive: true, position: { x: 1, y: 0, z: 0 } },
        { role: 'villager', alive: true, position: { x: 7, y: 0, z: 0 } },
        { role: 'villager', alive: false, position: { x: 2, y: 0, z: 0 } },
      ],
    }));
    expect(w?.position.x).toBe(7);
  });

  it('explore: nearest portal exit', () => {
    const explore = def('qe', [{ id: 'o1', kind: 'explore', desc: 'e', target: 'portals', count: 1 }]);
    const m = fakeManager([explore], { qe: { status: 'active', progress: [0] } });
    const w = resolveQuestWaypoint(m, world({
      playerPos: { x: 90, y: 0, z: 0 },
      portalExits: [
        { x: 0, y: 0, z: -256 },
        { x: 256, y: 0, z: 0 },
        { x: 0, y: 0, z: 256 },
      ],
    }));
    expect(w?.position).toEqual({ x: 256, y: 0, z: 0 });
  });

  it('explore with portals disabled (no exits) -> null, honestly', () => {
    const explore = def('qe', [{ id: 'o1', kind: 'explore', desc: 'e', target: 'portals', count: 1 }]);
    const m = fakeManager([explore], { qe: { status: 'active', progress: [0] } });
    expect(resolveQuestWaypoint(m, world())).toBeNull();
  });

  it('ties break by roster order (deterministic)', () => {
    const m = fakeManager([KILL], { q2: { status: 'active', progress: [0] } });
    const w = resolveQuestWaypoint(m, world({
      enemies: [
        { kind: 'walker', alive: true, position: { x: 10, y: 1, z: 0 } },
        { kind: 'walker', alive: true, position: { x: -10, y: 2, z: 0 } },
      ],
    }));
    expect(w?.position).toEqual({ x: 10, y: 1, z: 0 });
  });

  it('is pure: same inputs -> identical output, no hidden state', () => {
    const m = fakeManager([KILL], { q2: { status: 'active', progress: [0] } });
    const w = world({ enemies: [{ kind: 'walker', alive: true, position: { x: 4, y: 0, z: 0 } }] });
    expect(resolveQuestWaypoint(m, w)).toEqual(resolveQuestWaypoint(m, w));
  });

  it('re-resolves after a portal trip: same quest, new roster -> new position', () => {
    const m = fakeManager([KILL], { q2: { status: 'active', progress: [0] } });
    const before = resolveQuestWaypoint(m, world({
      enemies: [{ kind: 'walker', alive: true, position: { x: 4, y: 0, z: 0 } }],
    }));
    const after = resolveQuestWaypoint(m, world({
      enemies: [{ kind: 'walker', alive: true, position: { x: 40, y: 0, z: 40 } }],
    }));
    expect(before?.position).toEqual({ x: 4, y: 0, z: 0 });
    expect(after?.position).toEqual({ x: 40, y: 0, z: 40 });
    expect(after?.questId).toBe(before?.questId);
  });
});
