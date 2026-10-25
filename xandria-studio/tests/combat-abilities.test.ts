/**
 * COMBAT-ABILITIES (upgrade loop): unit tests for the data-driven ability
 * system — defs table, cooldown/energy gating, dash-strike arc + mobility,
 * shockwave AoE + knockback, mend HoT, seeded damage variance, and the
 * remappable Input actions. No Engine needed: avatar/enemies/fx are fakes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  ABILITY_DEFS,
  ABILITY_IDS,
  abilityDefOf,
  AbilityManager,
  MAX_ENERGY,
  ENERGY_REGEN_PER_S,
  resolveAbilitiesEnabled,
} from '../src/engine/game/combatAbilities';
import { abilityTouchButtons, layoutForGenre } from '../src/engine/game/TouchControls';
import { Input } from '../src/engine/core/Input';

class FakeEnemy {
  alive = true;
  health: number;
  impulses: Array<{ x: number; y: number; z: number }> = [];
  damageTaken: number[] = [];
  body: { applyImpulse: (imp: { x: number; y: number; z: number }) => void };
  constructor(
    public position: THREE.Vector3,
    hp = 1000,
  ) {
    this.health = hp;
    this.body = {
      applyImpulse: (imp) => {
        this.impulses.push(imp);
      },
    };
  }
  damage(amount: number) {
    if (!this.alive) return;
    this.health -= amount;
    this.damageTaken.push(amount);
    if (this.health <= 0) this.alive = false;
  }
}

class FakeAvatar {
  health: number;
  vel = { x: 0, y: 0, z: 0 };
  ctrl: { body: { velocity: { set: (x: number, y: number, z: number) => void } }; position: THREE.Vector3 };
  constructor(
    public position: THREE.Vector3,
    public maxHealth = 100,
    hp = 100,
  ) {
    this.health = hp;
    this.ctrl = {
      body: {
        velocity: {
          set: (x: number, y: number, z: number) => {
            this.vel = { x, y, z };
          },
        },
      },
      position,
    };
  }
  heal(amount: number) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }
}

function makeManager(opts: {
  avatarPos?: THREE.Vector3;
  avatarHp?: number;
  enemies?: FakeEnemy[];
  seed?: number;
  enabled?: boolean;
  damageMult?: () => number;
} = {}) {
  const avatar = new FakeAvatar(opts.avatarPos ?? new THREE.Vector3(0, 0, 0), 100, opts.avatarHp ?? 100);
  const enemies = opts.enemies ?? [];
  const fx = { bursts: [] as Array<{ pos: THREE.Vector3; color: string }>, shakes: [] as number[], numbers: [] as string[] };
  const manager = new AbilityManager({
    avatar,
    enemies: { enemies },
    seed: opts.seed ?? 12345,
    enabled: opts.enabled,
    damageMult: opts.damageMult,
    fx: {
      burst: (pos, color) => {
        fx.bursts.push({ pos, color });
      },
      damageNumber: (_pos, text) => {
        fx.numbers.push(text);
      },
      shake: (amount) => {
        fx.shakes.push(amount);
      },
    },
  });
  return { manager, avatar, enemies, fx };
}

const FWD = new THREE.Vector3(0, 0, 1);

describe('ability defs', () => {
  it('ships exactly the three briefed abilities with the briefed costs/cooldowns', () => {
    expect(ABILITY_IDS).toEqual(['dash-strike', 'shockwave-slam', 'mend']);
    expect(abilityDefOf('dash-strike')?.cost).toBe(20);
    expect(abilityDefOf('dash-strike')?.cooldown).toBe(6);
    expect(abilityDefOf('shockwave-slam')?.cost).toBe(35);
    expect(abilityDefOf('shockwave-slam')?.cooldown).toBe(10);
    expect(abilityDefOf('mend')?.cost).toBe(25);
    expect(abilityDefOf('mend')?.cooldown).toBe(12);
    expect(new Set(ABILITY_DEFS.map((d) => d.id)).size).toBe(3);
  });

  it('resolveAbilitiesEnabled defaults on and honors the spec toggle', () => {
    expect(resolveAbilitiesEnabled({ custom: {} } as never)).toBe(true);
    expect(resolveAbilitiesEnabled({ custom: { abilities: { enabled: false } } } as never)).toBe(false);
    expect(resolveAbilitiesEnabled({ custom: { abilities: { enabled: true } } } as never)).toBe(true);
  });
});

describe('dash-strike', () => {
  it('hits frontal in-range enemies, spends energy, starts cooldown + dash velocity', () => {
    const front = new FakeEnemy(new THREE.Vector3(0, 0, 3));
    const behind = new FakeEnemy(new THREE.Vector3(0, 0, -3));
    const far = new FakeEnemy(new THREE.Vector3(0, 0, 8));
    const { manager, avatar, fx } = makeManager({ enemies: [front, behind, far] });
    const res = manager.cast('dash-strike', FWD);
    expect(res.ok).toBe(true);
    expect(res.targets).toBe(1);
    expect(front.damageTaken).toHaveLength(1);
    // 40 base * [0.9, 1.1] seeded variance
    expect(front.damageTaken[0]).toBeGreaterThanOrEqual(36);
    expect(front.damageTaken[0]).toBeLessThanOrEqual(44);
    expect(res.damageDealt).toBe(front.damageTaken[0]);
    expect(behind.damageTaken).toEqual([]);
    expect(far.damageTaken).toEqual([]);
    expect(manager.energy).toBe(MAX_ENERGY - 20);
    expect(manager.cooldownRemaining('dash-strike')).toBe(6);
    // dash: 7m / 0.25s = 28 m/s along +z
    expect(avatar.vel).toEqual({ x: 0, y: 0, z: 28 });
    expect(fx.bursts.length).toBeGreaterThan(0);
    // immediate re-cast fails closed on cooldown, no extra spend
    const again = manager.cast('dash-strike', FWD);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('cooldown');
    expect(manager.energy).toBe(MAX_ENERGY - 20);
  });

  it('cooldown ticks down and energy regens (clamped at max)', () => {
    const { manager } = makeManager({});
    manager.cast('dash-strike', FWD);
    manager.update(1);
    expect(manager.cooldownRemaining('dash-strike')).toBe(5);
    expect(manager.energy).toBe(80 + ENERGY_REGEN_PER_S * 1);
    manager.update(2);
    expect(manager.cooldownRemaining('dash-strike')).toBe(3);
    // 80 + 8*3 = 104, clamped at the 100 cap
    expect(manager.energy).toBe(100);
    manager.update(3);
    expect(manager.cooldownRemaining('dash-strike')).toBe(0);
    expect(manager.canCast('dash-strike')).toBe(true);
    manager.update(60);
    expect(manager.energy).toBe(MAX_ENERGY);
  });
});

describe('shockwave-slam', () => {
  it('hits everything in radius, knocks back away from the player, ignores the rest', () => {
    const near = new FakeEnemy(new THREE.Vector3(3, 0, 4)); // d=5
    const far = new FakeEnemy(new THREE.Vector3(0, 0, 9));
    const { manager } = makeManager({ enemies: [near, far] });
    const res = manager.cast('shockwave-slam', FWD);
    expect(res.ok).toBe(true);
    expect(res.targets).toBe(1);
    expect(near.damageTaken).toHaveLength(1);
    expect(near.damageTaken[0]).toBeGreaterThanOrEqual(27);
    expect(near.damageTaken[0]).toBeLessThanOrEqual(33);
    expect(far.damageTaken).toEqual([]);
    expect(near.impulses).toHaveLength(1);
    // push direction is (3,4)/5 * 14
    expect(near.impulses[0].x).toBeCloseTo(8.4, 5);
    expect(near.impulses[0].z).toBeCloseTo(11.2, 5);
    expect(manager.energy).toBe(MAX_ENERGY - 35);
  });
});

describe('mend', () => {
  it('heals 45 over 3s in ticks, clamped at max health', () => {
    const { manager, avatar } = makeManager({ avatarHp: 50 });
    const res = manager.cast('mend', FWD);
    expect(res.ok).toBe(true);
    expect(manager.energy).toBe(MAX_ENERGY - 25);
    manager.update(1);
    expect(avatar.health).toBe(65);
    manager.update(2);
    expect(avatar.health).toBe(95);
    expect(manager.hotHealed).toBe(45);
    // further ticks heal nothing
    manager.update(5);
    expect(avatar.health).toBe(95);
  });

  it('overheal is wasted, not banked', () => {
    const { manager, avatar } = makeManager({ avatarHp: 90 });
    manager.cast('mend', FWD);
    manager.update(3);
    expect(avatar.health).toBe(100);
    expect(manager.hotHealed).toBe(10);
  });
});

describe('gating + determinism', () => {
  it('fails closed on energy and when disabled, spending nothing', () => {
    const { manager } = makeManager({});
    manager.energy = 10;
    const res = manager.cast('mend', FWD);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('energy');
    expect(manager.energy).toBe(10);
    expect(manager.cooldownRemaining('mend')).toBe(0);
    const off = makeManager({ enabled: false }).manager;
    expect(off.cast('mend', FWD).reason).toBe('disabled');
    expect(off.cast('nope' as never).reason).toBe('unknown');
  });

  it('same seed + same cast sequence -> identical damage (seeded variance)', () => {
    const run = () => {
      const e = new FakeEnemy(new THREE.Vector3(0, 0, 2));
      const { manager } = makeManager({ enemies: [e], seed: 777 });
      const a = manager.cast('dash-strike', FWD);
      manager.update(6);
      const b = manager.cast('dash-strike', FWD);
      return [a.damageDealt, b.damageDealt];
    };
    expect(run()).toEqual(run());
  });

  it('damageMult scales damage (progression wiring)', () => {
    const e = new FakeEnemy(new THREE.Vector3(0, 0, 2));
    const { manager } = makeManager({ enemies: [e], damageMult: () => 2 });
    const res = manager.cast('dash-strike', FWD);
    expect(res.damageDealt).toBeGreaterThanOrEqual(72);
    expect(res.damageDealt).toBeLessThanOrEqual(88);
  });
});

describe('input + touch wiring', () => {
  beforeEach(() => {
    const noop = () => {};
    (globalThis as any).window = { addEventListener: noop, removeEventListener: noop, innerWidth: 800 };
    (globalThis as any).document = { addEventListener: noop, removeEventListener: noop };
  });

  function stubEl(): any {
    return {
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    };
  }

  it('defaults bind Z/C/V to ability1/2/3 and remapKey rebinds without touching the manager', () => {
    const input = new Input(stubEl());
    expect(input.actionsForCode('KeyZ')).toEqual(['ability1']);
    expect(input.actionsForCode('KeyC')).toEqual(['ability2']);
    expect(input.actionsForCode('KeyV')).toEqual(['ability3']);
    input.remapKey('KeyZ', ['ability2']);
    expect(input.actionsForCode('KeyZ')).toEqual(['ability2']);
    input.remapKey('KeyZ', null);
    expect(input.actionsForCode('KeyZ')).toEqual([]);
  });

  it('ability touch buttons are 56px and do not collide with the base clusters', () => {
    for (const genre of ['fps-arena', 'third-person-action', 'platformer', 'top-down-shooter', 'survivor']) {
      const layout = layoutForGenre(genre);
      const ab = layout.buttons.filter((b) => b.action.startsWith('ability'));
      expect(ab).toHaveLength(3);
      for (const b of ab) {
        expect(b.size).toBeGreaterThanOrEqual(28);
      }
      // pairwise: no two buttons overlap (rects in right/bottom space)
      const rects = layout.buttons.map((b) => ({
        left: 10000 - b.right - b.size,
        top: 10000 - b.bottom - b.size,
        right: 10000 - b.right,
        bottom: 10000 - b.bottom,
      }));
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const c = rects[j];
          const overlap = a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom;
          expect(overlap, `${genre}: button ${i} overlaps button ${j}`).toBe(false);
        }
      }
    }
    expect(abilityTouchButtons('top-down-shooter')[0].bottom).toBe(292);
    // MERGE (wave-4): deployables added a DEPLOY button at bottom 190 + size
    // 60 on third-person-action after this pin was written, so the ability
    // row moved to 268 (18px clearance); the no-overlap loop above still
    // guards the geometry.
    expect(abilityTouchButtons('third-person-action')[0].bottom).toBe(268);
  });

  it('non-combat genres get no ability buttons', () => {
    expect(layoutForGenre('racing').buttons.some((b) => b.action.startsWith('ability'))).toBe(false);
  });
});
