/**
 * Dynamic-events wave — unit tests (no engine required for the pure parts):
 * - EVENT_SALT distinctness vs every other system salt
 * - EVENT_DEFS table sanity (all 4 types, one def per type, valid triggers)
 * - planDynamicEvents determinism (same seed -> identical set), seed
 *   variance, spec overrides (enabled/counts/disabled), anchor ring bounds
 * - buildMerchantStock determinism + pricing math + pool filtering
 * - resolveEventCount clamping
 */
import { describe, it, expect } from 'vitest';
import {
  EVENT_DEFS,
  EVENT_SALT,
  EVENT_TYPE_IDS,
  eventDefById,
  planDynamicEvents,
  buildMerchantStock,
  resolveEventCount,
  resolveEventsEnabled,
  isEventTypeDisabled,
} from '../src/engine/game/dynamicEvents';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { NPC_SALT } from '../src/engine/game/Npc';
import { CRAFT_SALT } from '../src/engine/game/crafting';
import { STATION_SALT } from '../src/engine/game/stations';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { LOOT_SALT } from '../src/engine/game/loot';
import { BOSS_SALT } from '../src/engine/game/bosses';
import { defaultSpec, type GameSpec } from '../src/spec/schema';

function specWithEvents(events?: Record<string, unknown>): GameSpec {
  const s = defaultSpec();
  s.custom = { ...(s.custom ?? {}), events: events as never };
  return s;
}

const ANCHORS = [{ x: 0, z: 0, r: 0 }];

describe('EVENT_SALT', () => {
  it('is distinct from every other system salt', () => {
    const salts = [ENEMY_SALT, NPC_SALT, CRAFT_SALT, STATION_SALT, GATHER_SALT, LOOT_SALT, BOSS_SALT];
    for (const s of salts) expect(EVENT_SALT).not.toBe(s);
    expect(new Set([EVENT_SALT, ...salts]).size).toBe(salts.length + 1);
  });
});

describe('EVENT_DEFS', () => {
  it('covers all four event types exactly once', () => {
    expect(EVENT_DEFS.length).toBe(4);
    const types = EVENT_DEFS.map((d) => d.type).sort();
    expect(types).toEqual([...EVENT_TYPE_IDS].sort());
  });
  it('every def has a valid trigger, name, toasts, and beacon color', () => {
    for (const d of EVENT_DEFS) {
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.toastStart.length).toBeGreaterThan(0);
      expect(d.toastDone.length).toBeGreaterThan(0);
      expect(d.beaconColor).toMatch(/^#[0-9a-f]{6}$/);
      expect(['proximity', 'onSpawn', 'timed']).toContain(d.trigger.kind);
      expect(d.ringMin).toBeLessThan(d.ringMax);
      expect(d.defaultCount).toBeGreaterThanOrEqual(1);
    }
  });
  it('combat defs have sane combatant ranges; non-combat defs have none', () => {
    for (const d of EVENT_DEFS) {
      if (d.type === 'ambush' || d.type === 'patrol') {
        expect(d.combatants).not.toBeNull();
        expect(d.combatants!.countMin).toBeLessThanOrEqual(d.combatants!.countMax);
        expect(d.completionBonusRolls).toBeGreaterThan(0);
      } else {
        expect(d.combatants).toBeNull();
      }
    }
  });
  it('eventDefById resolves every def', () => {
    for (const d of EVENT_DEFS) expect(eventDefById(d.id)).toBe(d);
    expect(eventDefById('event_nope')).toBeNull();
  });
});

describe('planDynamicEvents', () => {
  it('is deterministic: same (mapSeed, spec) -> identical event set', () => {
    const spec = specWithEvents();
    const a = planDynamicEvents(20261012, spec, ANCHORS);
    const b = planDynamicEvents(20261012, spec, ANCHORS);
    expect(a).toEqual(b);
    expect(a.length).toBe(4); // one instance of each def by default
  });
  it('varies with the seed', () => {
    const spec = specWithEvents();
    const a = planDynamicEvents(1, spec, ANCHORS);
    const b = planDynamicEvents(2, spec, ANCHORS);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
  it('rings positions inside each def ring bounds', () => {
    const spec = specWithEvents();
    const planned = planDynamicEvents(777, spec, ANCHORS);
    for (const p of planned) {
      const def = eventDefById(p.defId)!;
      const d = Math.hypot(p.x, p.z);
      expect(d).toBeGreaterThanOrEqual(def.ringMin);
      expect(d).toBeLessThanOrEqual(def.ringMax);
    }
  });
  it('honors enabled=false (no events)', () => {
    const spec = specWithEvents({ enabled: false });
    expect(planDynamicEvents(1, spec, ANCHORS)).toEqual([]);
    expect(resolveEventsEnabled(spec)).toBe(false);
  });
  it('honors per-type counts and disabled flags', () => {
    const spec = specWithEvents({ counts: { event_cache: 3, event_ambush: 0 }, disabled: { event_patrol: true } });
    const planned = planDynamicEvents(1, spec, ANCHORS);
    expect(planned.filter((p) => p.defId === 'event_cache').length).toBe(3);
    expect(planned.filter((p) => p.defId === 'event_ambush').length).toBe(0);
    expect(planned.filter((p) => p.defId === 'event_patrol').length).toBe(0);
    expect(isEventTypeDisabled(spec, 'event_patrol')).toBe(true);
  });
  it('per-instance seeds are distinct (decorrelated draws)', () => {
    const spec = specWithEvents({ counts: { event_cache: 4 } });
    const seeds = planDynamicEvents(5, spec, ANCHORS)
      .filter((p) => p.defId === 'event_cache')
      .map((p) => p.seed);
    expect(new Set(seeds).size).toBe(4);
  });
});

describe('resolveEventCount', () => {
  it('defaults to the def default, clamps 0..4', () => {
    const def = eventDefById('event_cache')!;
    expect(resolveEventCount(specWithEvents(), def)).toBe(def.defaultCount);
    expect(resolveEventCount(specWithEvents({ counts: { event_cache: 99 } }), def)).toBe(4);
    expect(resolveEventCount(specWithEvents({ counts: { event_cache: -2 } }), def)).toBe(0);
  });
});

describe('buildMerchantStock', () => {
  const defs: Record<string, { value: number }> = {
    mat_beast_hide: { value: 4 },
    mat_ember_shard: { value: 8 },
    loot_ironfang_blade: { value: 40 },
    junk_no_value: { value: 0 },
  } as never;
  const def = eventDefById('event_merchant')!;

  it('is deterministic per (def, seed, defs)', () => {
    const a = buildMerchantStock(def, 4242, defs as never);
    const b = buildMerchantStock(def, 4242, defs as never);
    expect(a).toEqual(b);
    expect(buildMerchantStock(def, 4243, defs as never)).not.toEqual(a);
  });
  it('filters ids with no finite positive value and caps at maxStock', () => {
    const stock = buildMerchantStock(def, 4242, defs as never);
    expect(stock.length).toBeGreaterThan(0);
    expect(stock.length).toBeLessThanOrEqual(def.merchant!.maxStock);
    expect(stock.every((l) => l.itemId !== 'junk_no_value')).toBe(true);
    for (const line of stock) {
      const value = (defs[line.itemId] as { value: number }).value;
      expect(line.cost).toBe(Math.max(1, Math.ceil(value * def.merchant!.buyMult)));
      expect(line.yieldPer).toBe(Math.max(1, Math.floor(value * def.merchant!.sellMult)));
      expect(line.count).toBeGreaterThanOrEqual(1);
    }
  });
  it('returns [] for a non-merchant def or an empty pool', () => {
    expect(buildMerchantStock(eventDefById('event_cache')!, 1, defs as never)).toEqual([]);
    expect(buildMerchantStock(def, 1, {})).toEqual([]);
  });
});
