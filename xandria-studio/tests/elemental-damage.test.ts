/**
 * ELEMENTAL-DAMAGE-TYPES (upgrade loop): unit tests.
 * - Pure table checks: the damage-type table and the resistance table
 *   are well-formed, physical is 1.0 everywhere, multipliers are dyadic.
 * - Pure helpers: resistanceFor / applyElemental / resistanceLines /
 *   outgoingDamageType, including unknown-kind and boss-row defaults.
 * - Enchantment + ability type assignment: the def tables carry the
 *   briefed types; Inventory.outgoingDamageType resolves weapon-slot
 *   enchants only, and survives serialize/deserialize.
 * - Enemy.damage() integration (real Engine, direct Enemy): the
 *   elemental step applies before shield absorb and elite armor, the
 *   return value is the typed amount, dead enemies return 0, and the
 *   observe-only onElementalHit hook fires with the table multiplier.
 *   No status effect is applied by this phase (asserted: no slow/stun
 *   fields change — the hook payload carries the type only).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '', width: 0, height: 600,
      appendChild(c: any) { el.children.push(c); return c; }, append(...cs: any[]) { for (const c of cs) el.children.push(c); },
      remove() {}, setAttribute() {}, getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener() {}, removeEventListener() {}, querySelector() { return makeEl(); }, querySelectorAll() { return []; },
      getContext: () => ({ createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
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
import { defaultSpec, type GameSpec, type EnemySpec } from '../src/spec/schema';
import { Enemy } from '../src/engine/game/EnemyAI';
import {
  DAMAGE_TYPES,
  ELEMENTAL_TABLE,
  ENEMY_RESISTANCES,
  elementalDef,
  isDamageType,
  normalizeDamageType,
  resistanceFor,
  elementalMultiplierFor,
  applyElemental,
  displayedDamage,
  resistanceLines,
  outgoingDamageType,
  outgoingDamageTypeDetail,
  type DamageType,
} from '../src/engine/game/elemental';
import { ENCHANT_DEFS, enchantDef } from '../src/engine/game/enchantments';
import { ABILITY_DEFS, abilityDefOf } from '../src/engine/game/combatAbilities';
import { Inventory } from '../src/engine/game/items/Inventory';
import { lootItemDefs } from '../src/engine/game/loot';
import { craftedItemDefs } from '../src/engine/game/crafting';
import { setGearDefs } from '../src/engine/game/setBonuses';
import { enchantMaterialDefs } from '../src/engine/game/enchantments';

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

const DYADIC = new Set([0.5, 0.75, 1, 1.25, 1.5]);

describe('elemental table', () => {
  it('ships four types with labels, colors, and status hooks', () => {
    expect(DAMAGE_TYPES).toEqual(['physical', 'fire', 'frost', 'shock']);
    expect(elementalDef('fire')?.label).toBe('Fire');
    expect(elementalDef('frost')?.color).toBe('#7af7ff');
    expect(elementalDef('shock')?.statusHook).toBe('stun');
    expect(elementalDef('fire')?.statusHook).toBe('burn');
    expect(elementalDef('frost')?.statusHook).toBe('chill');
    expect(elementalDef('physical')?.statusHook).toBeNull();
    expect(elementalDef('nope')).toBeUndefined();
    for (const t of DAMAGE_TYPES) {
      expect(/^#[0-9a-f]{6}$/.test(ELEMENTAL_TABLE[t].color), t).toBe(true);
      expect(ELEMENTAL_TABLE[t].blurb.length, t).toBeGreaterThan(0);
    }
  });

  it('normalizes unknown values to physical', () => {
    expect(isDamageType('fire')).toBe(true);
    expect(isDamageType('acid')).toBe(false);
    expect(isDamageType(undefined)).toBe(false);
    expect(normalizeDamageType('shock')).toBe('shock');
    expect(normalizeDamageType('acid')).toBe('physical');
    expect(normalizeDamageType(undefined)).toBe('physical');
  });
});

describe('resistance table', () => {
  it('covers every kind with all four types; physical is 1.0 everywhere', () => {
    const kinds = ['walker', 'brute', 'drone', 'flyer', 'turret', 'boss'];
    expect(Object.keys(ENEMY_RESISTANCES).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      for (const t of DAMAGE_TYPES) {
        const m = ENEMY_RESISTANCES[kind][t];
        expect(typeof m === 'number' && Number.isFinite(m) && m > 0, `${kind}/${t}`).toBe(true);
        expect(DYADIC.has(m), `${kind}/${t} = ${m}`).toBe(true);
      }
      expect(ENEMY_RESISTANCES[kind].physical).toBe(1);
    }
  });

  it('each element has a 1.5 vulnerability and a <=0.75 resistance somewhere', () => {
    for (const t of ['fire', 'frost', 'shock'] as const) {
      const mults = Object.values(ENEMY_RESISTANCES).map((r) => r[t]);
      expect(mults).toContain(1.5);
      expect(Math.min(...mults)).toBeLessThanOrEqual(0.75);
    }
  });

  it('ships the briefed showcase values', () => {
    expect(resistanceFor('walker', 'frost')).toBe(1.5);
    expect(resistanceFor('brute', 'fire')).toBe(0.5);
    expect(resistanceFor('drone', 'shock')).toBe(1.5);
    expect(resistanceFor('flyer', 'fire')).toBe(1.5);
    expect(resistanceFor('turret', 'shock')).toBe(1.5);
    expect(resistanceFor('walker', 'fire')).toBe(0.75);
  });

  it('unknown kinds and types default to 1.0; bosses read the boss row', () => {
    expect(resistanceFor('stalker-custom', 'fire')).toBe(1);
    expect(resistanceFor('racer', 'shock')).toBe(1);
    expect(resistanceFor('walker', 'acid' as DamageType)).toBe(1);
    expect(elementalMultiplierFor('brute', 'fire')).toBe(0.5);
    expect(elementalMultiplierFor('brute', 'fire', true)).toBe(0.75);
    expect(elementalMultiplierFor('walker', 'frost', true)).toBe(1.25);
  });

  it('applyElemental rounds once and is identity for physical', () => {
    expect(applyElemental(100, 'walker', 'physical')).toBe(100);
    expect(applyElemental(100, 'walker', 'frost')).toBe(150);
    expect(applyElemental(100, 'brute', 'fire')).toBe(50);
    expect(applyElemental(41, 'flyer', 'fire')).toBe(62); // 61.5 rounds up
    expect(applyElemental(40, 'brute', 'frost')).toBe(50);
    expect(applyElemental(100, 'unknown-kind', 'fire')).toBe(100);
  });

  it('displayedDamage is the caller-side step; kind-less targets fall back', () => {
    // the number a caller shows for a frost hit on a walker, computed
    // from the crit-applied value before any caller-side wrapper
    expect(displayedDamage(82, 'walker', 'frost', 999)).toBe(123);
    expect(displayedDamage(41, 'brute', 'fire', 999)).toBe(21);
    expect(displayedDamage(50, 'walker', 'physical', 999)).toBe(50);
    // no kind (test fakes): the fallback — damage()'s return or the
    // raw amount — is used verbatim, never re-scaled
    expect(displayedDamage(50, undefined, 'frost', 75)).toBe(75);
    expect(displayedDamage(50, undefined, 'frost', 50)).toBe(50);
  });

  it('resistanceLines render the same table the damage path uses', () => {
    const lines = resistanceLines('drone');
    expect(lines.map((l) => l.type)).toEqual(DAMAGE_TYPES);
    expect(lines.find((l) => l.type === 'shock')).toEqual({
      type: 'shock',
      label: 'Shock',
      multiplier: 1.5,
      verdict: 'vulnerable',
      color: '#ffd23d',
      text: 'Shock ×1.5 — vulnerable',
    });
    expect(lines.find((l) => l.type === 'frost')?.verdict).toBe('resistant');
    expect(lines.find((l) => l.type === 'physical')?.verdict).toBe('normal');
    expect(resistanceLines('brute', true).find((l) => l.type === 'fire')?.multiplier).toBe(0.75);
  });
});

describe('type assignment: enchantments and abilities', () => {
  it('enchants carry the briefed damage types; defensive enchants carry none', () => {
    expect(enchantDef('ench_sharp')?.damageType).toBe('physical');
    expect(enchantDef('ench_deadly')?.damageType).toBe('shock');
    expect(enchantDef('ench_starlit')?.damageType).toBe('frost');
    expect(enchantDef('ench_warded')?.damageType).toBeUndefined();
    expect(enchantDef('ench_vital')?.damageType).toBeUndefined();
    expect(enchantDef('ench_sturdy')?.damageType).toBeUndefined();
    for (const e of ENCHANT_DEFS) {
      if (e.damageType) expect(isDamageType(e.damageType)).toBe(true);
    }
  });

  it('abilities carry the briefed damage types; mend carries none', () => {
    expect(ABILITY_DEFS).toHaveLength(3);
    expect(abilityDefOf('dash-strike')?.damageType).toBe('physical');
    expect(abilityDefOf('shockwave-slam')?.damageType).toBe('shock');
    expect(abilityDefOf('mend')?.damageType).toBeNull();
  });

  it('outgoingDamageType reads the weapon slot only', () => {
    const enchants = new Map<string, string>();
    expect(outgoingDamageType({}, enchants)).toBe('physical');
    expect(outgoingDamageType({ weapon: 'blade' }, enchants)).toBe('physical');
    enchants.set('blade', 'ench_starlit');
    expect(outgoingDamageType({ weapon: 'blade' }, enchants)).toBe('frost');
    expect(outgoingDamageTypeDetail({ weapon: 'blade' }, enchants)).toEqual({ type: 'frost', enchantId: 'ench_starlit' });
    // accessory enchant never sets the outgoing type
    expect(outgoingDamageType({ accessory: 'blade' }, enchants)).toBe('physical');
    // an enchant on a backpack item (not equipped) never counts
    expect(outgoingDamageType({ weapon: 'other' }, enchants)).toBe('physical');
    // unknown enchant id falls back to physical
    expect(outgoingDamageType({ weapon: 'blade' }, new Map([['blade', 'ench_nope']]))).toBe('physical');
  });
});

describe('Inventory outgoing type', () => {
  const allDefs = () => ({
    ...lootItemDefs(),
    ...craftedItemDefs(),
    ...setGearDefs(),
    ...enchantMaterialDefs(),
  });

  it('resolves from a real enchanted weapon and survives serialize/deserialize', () => {
    const inv = new Inventory(allDefs());
    inv.add('loot_ironfang_blade', 1);
    inv.add('mat_star_essence', 10);
    inv.add('mat_enchant_dust', 10);
    inv.equip('loot_ironfang_blade');
    expect(inv.outgoingDamageType()).toBe('physical');
    expect(inv.enchant('loot_ironfang_blade', 'ench_starlit')).toEqual({ ok: true });
    expect(inv.outgoingDamageType()).toBe('frost');
    expect(inv.outgoingDamageTypeDetail()).toEqual({ type: 'frost', enchantId: 'ench_starlit' });
    // remove -> refund -> back to physical
    inv.removeEnchant('loot_ironfang_blade');
    expect(inv.outgoingDamageType()).toBe('physical');
    // re-enchant, serialize round-trip keeps the type (ench state persists)
    inv.enchant('loot_ironfang_blade', 'ench_deadly');
    const restored = Inventory.deserialize(allDefs(), inv.serialize());
    restored.equip('loot_ironfang_blade');
    expect(restored.outgoingDamageType()).toBe('shock');
  });
});

describe('AbilityManager elemental wiring', () => {
  it('shockwave-slam deals shock through Enemy.damage semantics; lastCast reports post-elemental damage', async () => {
    const { AbilityManager } = await import('../src/engine/game/combatAbilities');
    class TableEnemy {
      alive = true;
      health = 1000;
      damageTaken: number[] = [];
      body = { applyImpulse: () => {} };
      constructor(public position: THREE.Vector3) {}
      damage(amount: number, _from?: THREE.Vector3, type?: DamageType): number {
        const dealt = applyElemental(amount, 'drone', type ?? 'physical');
        this.health -= dealt;
        this.damageTaken.push(dealt);
        return dealt;
      }
    }
    const enemy = new TableEnemy(new THREE.Vector3(3, 0, 0));
    const avatar: any = {
      health: 100,
      maxHealth: 100,
      heal: () => {},
      ctrl: { position: new THREE.Vector3(0, 0, 0), body: { velocity: { set: () => {} } } },
    };
    const numbers: string[] = [];
    const manager = new AbilityManager({
      avatar,
      enemies: { enemies: [enemy as any] },
      seed: 12345,
      fx: {
        burst: () => {},
        damageNumber: (_pos: THREE.Vector3, text: string) => { numbers.push(text); },
        shake: () => {},
      },
    });
    const res = manager.cast('shockwave-slam');
    expect(res.ok).toBe(true);
    expect(res.targets).toBe(1);
    expect(manager.lastCast?.damageType).toBe('shock');
    // post-elemental: the fake applied drone shock x1.5, so the cast
    // total equals the typed amount the enemy actually took, and the
    // floating number spawned from that same value.
    expect(res.damageDealt).toBe(enemy.damageTaken[0]);
    expect(res.damageDealt).toBeGreaterThan(0);
    expect(numbers).toEqual([String(enemy.damageTaken[0])]);
    const dash = new TableEnemy(new THREE.Vector3(3, 0, 0));
    const manager2 = new AbilityManager({
      avatar,
      enemies: { enemies: [dash as any] },
      seed: 12345,
      fx: { burst: () => {}, damageNumber: () => {}, shake: () => {} },
    });
    const res2 = manager2.cast('dash-strike', new THREE.Vector3(1, 0, 0));
    expect(manager2.lastCast?.damageType).toBe('physical');
    expect(res2.damageDealt).toBe(dash.damageTaken[0]);
  });
});

describe('Enemy.damage() elemental step', () => {
  function makeEnemy(kind: EnemySpec['kind'], health = 1000): { engine: Engine; enemy: Enemy } {
    const engine = makeEngine();
    const spec: EnemySpec = { kind, count: 1, health, speed: 4, damage: 10, weapon: 'melee' };
    const enemy = new Enemy(engine, spec, new THREE.Vector3(0, 2, 0), null, {}, 4242);
    return { engine, enemy };
  }

  it('physical is bit-identical; typed hits scale exactly and return the typed amount', () => {
    const { enemy } = makeEnemy('walker');
    expect(enemy.damage(100, new THREE.Vector3(0, 0, 0))).toBe(100);
    expect(enemy.health).toBe(900);
    const { enemy: frosted } = makeEnemy('walker');
    expect(frosted.damage(100, new THREE.Vector3(0, 0, 0), 'frost')).toBe(150);
    expect(frosted.health).toBe(850);
    const { enemy: fired } = makeEnemy('brute');
    expect(fired.damage(100, new THREE.Vector3(0, 0, 0), 'fire')).toBe(50);
    expect(fired.health).toBe(950);
    const { enemy: shocked } = makeEnemy('turret');
    expect(shocked.damage(80, new THREE.Vector3(0, 0, 0), 'shock')).toBe(120);
    expect(shocked.health).toBe(880);
  });

  it('bosses read the boss row, not their base-kind row', () => {
    const { enemy } = makeEnemy('brute');
    enemy.isBoss = true;
    expect(enemy.damage(100, new THREE.Vector3(0, 0, 0), 'fire')).toBe(75);
    expect(enemy.health).toBe(925);
  });

  it('elemental applies before shield absorb and elite armor', () => {
    const { enemy } = makeEnemy('walker');
    enemy.shield = 50;
    enemy.maxShield = 50;
    expect(enemy.damage(100, new THREE.Vector3(0, 0, 0), 'fire')).toBe(75);
    expect(enemy.shield).toBe(0);
    expect(enemy.health).toBe(975); // 75 typed - 50 shield = 25 through
    const { enemy: armored } = makeEnemy('walker');
    armored.damageTakenMult = 0.6;
    expect(armored.damage(100, new THREE.Vector3(0, 0, 0), 'frost')).toBe(150);
    expect(armored.health).toBe(910); // 150 * 0.6 = 90 through
  });

  it('dead enemies return 0 and emit nothing; the hook fires per hit with the table multiplier', () => {
    const { engine, enemy } = makeEnemy('walker', 100);
    const seen: Array<{ type: string; amount: number; multiplier: number }> = [];
    engine.hooks.tap('onElementalHit', ({ type, amount, multiplier }) => {
      seen.push({ type, amount, multiplier });
    });
    expect(enemy.damage(100, new THREE.Vector3(0, 0, 0), 'frost')).toBe(150);
    expect(enemy.alive).toBe(false);
    expect(enemy.damage(100, new THREE.Vector3(0, 0, 0), 'frost')).toBe(0);
    expect(seen).toEqual([{ type: 'frost', amount: 150, multiplier: 1.5 }]);
    // zero taps is a no-op: a fresh engine with no taps takes typed damage identically
    const { enemy: untapped } = makeEnemy('drone');
    expect(untapped.damage(100, new THREE.Vector3(0, 0, 0), 'shock')).toBe(150);
    expect(untapped.health).toBe(850);
  });

  it('untyped callers stay physical: default arg and unknown type both scale 1.0', () => {
    const { enemy } = makeEnemy('flyer');
    expect(enemy.damage(100, new THREE.Vector3(0, 0, 0))).toBe(100);
    expect(enemy.damage(100, new THREE.Vector3(0, 0, 0), 'acid' as DamageType)).toBe(100);
    expect(enemy.health).toBe(800);
  });
});
