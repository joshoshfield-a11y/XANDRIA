/**
 * Wave 3B content-depth tests: enemy variant defs, difficulty scaling,
 * charger FSM, shield geometry, variant rolls, splitter minis, timed pickup
 * effects, boss-stage helpers. All deterministic (seeded Rng, fake enemies).
 */
import * as THREE from 'three';
import { describe, it, expect, vi } from 'vitest';
import {
  VARIANT_DEFS,
  ARENA_VARIANTS,
  ACTION_VARIANTS,
  scaleForStage,
  isFrontHit,
  shieldedDamage,
  pickVariant,
  planSpawns,
  isBossStageActive,
  createChargerMem,
  stepCharger,
  VariantDirector,
  type VariantEnemy,
  type EnemyVariant,
} from '../src/blueprints/enemies';
import { EffectState, EFFECT_DEFS, effectOf, spawnEffectPickup, applyPickupEffect } from '../src/blueprints/fx';
import { ENEMY_KINDS, type EnemySpec } from '../src/spec/schema';
import { Rng } from '../src/engine/core/Rng';
import type { Engine } from '../src/engine/Engine';
import type { Enemy, EnemyManager } from '../src/engine/game/EnemyAI';

const baseSpec = (kind: EnemySpec['kind'] = 'walker'): EnemySpec =>
  ({ kind, count: 4, health: 30, speed: 4, damage: 10, weapon: 'melee' }) as EnemySpec;

function mockEngine() {
  return {
    rng: new Rng(1234),
    hud: { showCard: vi.fn(), setBoss: vi.fn(), toast: vi.fn(), setHealth: vi.fn() },
    audio: { play: vi.fn() },
    scene: { add: vi.fn(), remove: vi.fn() },
    particles: { dust: vi.fn(), magic: vi.fn(), explosion: vi.fn() },
    frame: 0,
    mats: {},
    state: 'playing',
  };
}

function fakeEnemy(spec: EnemySpec = baseSpec()): any {
  const group = new THREE.Group();
  return {
    alive: true,
    spec,
    maxHealth: spec.health,
    health: spec.health,
    body: null,
    rig: { group, flash: vi.fn() },
    position: new THREE.Vector3(0, 0, 0),
    home: new THREE.Vector3(0, 0, 0),
    damage: vi.fn(),
  };
}

describe('VARIANT_DEFS', () => {
  it('covers every required variant with a valid base kind and distinct tint', () => {
    const required: EnemyVariant[] = ['charger', 'sniper', 'splitter', 'caster', 'shielded', 'skyray', 'spikeball'];
    for (const v of required) expect(VARIANT_DEFS[v]).toBeDefined();
    for (const v of required) {
      expect(ENEMY_KINDS).toContain(VARIANT_DEFS[v].base);
    }
    const tints = required.map((v) => VARIANT_DEFS[v].tint);
    expect(new Set(tints).size).toBe(tints.length); // distinct silhouettes
  });
  it('genre tables only reference real kinds and defined variants', () => {
    for (const table of [ARENA_VARIANTS, ACTION_VARIANTS]) {
      for (const [kind, vs] of Object.entries(table)) {
        expect(ENEMY_KINDS).toContain(kind);
        for (const v of vs!) expect(VARIANT_DEFS[v]).toBeDefined();
      }
    }
  });
});

describe('scaleForStage', () => {
  it('is identity at stage 0 and does not mutate the input', () => {
    const s = baseSpec();
    const out = scaleForStage(s, 0);
    expect(out.health).toBe(30);
    expect(out.speed).toBe(4);
    expect(out.count).toBe(4);
    expect(s.health).toBe(30);
  });
  it('compounds +15% HP and +8% speed per chapter', () => {
    const s1 = scaleForStage(baseSpec(), 1);
    expect(s1.health).toBe(Math.round(30 * 1.15)); // 35
    expect(s1.speed).toBeCloseTo(4 * 1.08, 10);
    const s2 = scaleForStage(baseSpec(), 2);
    expect(s2.health).toBe(Math.round(30 * 1.15 * 1.15)); // 40
    expect(s2.speed).toBeCloseTo(4 * 1.08 * 1.08, 10);
  });
});

describe('shield geometry', () => {
  const origin = new THREE.Vector3(0, 0, 0);
  it('detects front-arc hits (model-forward is -Z at yaw 0)', () => {
    expect(isFrontHit(0, origin, new THREE.Vector3(0, 0, -5))).toBe(true); // dead ahead
    expect(isFrontHit(0, origin, new THREE.Vector3(0, 0, 5))).toBe(false); // behind
    expect(isFrontHit(0, origin, new THREE.Vector3(5, 0, 0))).toBe(false); // flank
    expect(isFrontHit(0, origin, new THREE.Vector3(0, 0, -0.001))).toBe(true); // contact
  });
  it('rotates with the facing yaw', () => {
    // yaw PI -> faces +Z
    expect(isFrontHit(Math.PI, origin, new THREE.Vector3(0, 0, 5))).toBe(true);
    expect(isFrontHit(Math.PI, origin, new THREE.Vector3(0, 0, -5))).toBe(false);
  });
  it('shieldedDamage reduces front hits to 30%, leaves the rest whole', () => {
    const e = fakeEnemy() as unknown as VariantEnemy;
    expect(shieldedDamage(e, 100, new THREE.Vector3(0, 0, -5))).toBeCloseTo(30, 10);
    expect(shieldedDamage(e, 100, new THREE.Vector3(0, 0, 5))).toBe(100);
    expect(shieldedDamage(e, 100, undefined)).toBe(100);
  });
});

describe('stepCharger FSM', () => {
  it('stalks until close and cooled down, then windup -> dash -> cool', () => {
    const rng = new Rng(7);
    const m = createChargerMem(rng);
    expect(m.mode).toBe('stalk');
    stepCharger(m, 30, 1); // far away: stays stalking
    expect(m.mode).toBe('stalk');
    stepCharger(m, 5, 10); // close + cooldown elapsed
    expect(m.mode).toBe('windup');
    stepCharger(m, 5, 0.3);
    expect(m.mode).toBe('windup');
    stepCharger(m, 5, 0.3); // 0.6 > 0.55 windup
    expect(m.mode).toBe('dash');
    expect(m.dir.lengthSq()).toBe(0); // dir locked by the director on entry
    stepCharger(m, 5, 0.7); // 0.7 > 0.65 dash
    expect(m.mode).toBe('cool');
    stepCharger(m, 5, 1);
    expect(m.mode).toBe('cool');
    stepCharger(m, 5, 2); // 3 > 2.6 cooldown
    expect(m.mode).toBe('stalk');
  });
});

describe('pickVariant / planSpawns', () => {
  it('is deterministic for a given seed', () => {
    const seq = (seed: number) => {
      const rng = new Rng(seed);
      return Array.from({ length: 12 }, () => pickVariant('walker', rng, 2, ARENA_VARIANTS));
    };
    expect(seq(99)).toEqual(seq(99));
  });
  it('never assigns variants to brutes, turrets or racers', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 40; i++) {
      expect(pickVariant('brute', rng, 3, ARENA_VARIANTS)).toBeNull();
      expect(pickVariant('turret', rng, 3, ARENA_VARIANTS)).toBeNull();
      expect(pickVariant('racer', rng, 3, ARENA_VARIANTS)).toBeNull();
    }
  });
  it('later stages roll more variants (statistical, seeded)', () => {
    const count = (stage: number) => {
      const rng = new Rng(11);
      let n = 0;
      for (let i = 0; i < 200; i++) if (pickVariant('walker', rng, stage, ARENA_VARIANTS)) n++;
      return n;
    };
    expect(count(3)).toBeGreaterThan(count(0));
  });
  it('planSpawns expands counts, scales by stage, keeps brutes plain', () => {
    const rng = new Rng(21);
    const specs: EnemySpec[] = [baseSpec('walker'), { ...baseSpec('brute'), count: 1, health: 300 }];
    const planned = planSpawns(specs, rng, 2, ARENA_VARIANTS);
    expect(planned.length).toBe(5); // 4 walkers + 1 brute
    for (const p of planned) expect(p.spec.count).toBe(1);
    const brutes = planned.filter((p) => p.spec.kind === 'brute');
    expect(brutes.length).toBe(1);
    expect(brutes[0].variant).toBeNull();
    expect(brutes[0].spec.health).toBe(Math.round(300 * 1.15 * 1.15));
    for (const p of planned.filter((p) => p.spec.kind === 'walker')) {
      expect(p.spec.health).toBe(Math.round(30 * 1.15 * 1.15));
    }
  });
});

describe('VariantDirector', () => {
  it('clones specs per enemy so stage scaling never mutates shared entries', () => {
    const eng = mockEngine();
    const shared = baseSpec();
    const manager = { enemies: [fakeEnemy(shared), fakeEnemy(shared)] } as unknown as EnemyManager;
    const d = new VariantDirector(eng as unknown as Engine, manager, null);
    d.register(manager.enemies[0] as Enemy, null);
    d.register(manager.enemies[1] as Enemy, null);
    d.applyStageScaling(1);
    expect((manager.enemies[0] as Enemy).spec.speed).toBeCloseTo(4 * 1.08, 10);
    expect(shared.speed).toBe(4); // shared entry untouched
    expect((manager.enemies[0] as Enemy).maxHealth).toBe(Math.round(30 * 1.15));
    d.applyStageScaling(1); // idempotent
    expect((manager.enemies[0] as Enemy).maxHealth).toBe(Math.round(30 * 1.15));
    d.applyStageScaling(2); // incremental
    expect((manager.enemies[0] as Enemy).maxHealth).toBe(Math.round(Math.round(30 * 1.15) * 1.15));
  });
  it('splitter death spawns exactly 2 minis (registered, non-splitting)', () => {
    const eng = mockEngine();
    const spawned: any[] = [];
    const manager = {
      enemies: [] as any[],
      spawnAll(specs: EnemySpec[], spawnFor: (kind: string, i: number, n: number) => THREE.Vector3) {
        for (const s of specs) {
          for (let i = 0; i < s.count; i++) {
            const e = fakeEnemy();
            e.spec = { ...s };
            e.maxHealth = e.health = s.health;
            e.position = spawnFor(s.kind, i, s.count).clone();
            (manager as any).enemies.push(e);
            spawned.push(e);
          }
        }
      },
    } as unknown as EnemyManager;
    const d = new VariantDirector(eng as unknown as Engine, manager, null);
    const splitter = fakeEnemy();
    splitter.maxHealth = splitter.health = 60;
    splitter.spec = { ...baseSpec(), health: 60 };
    (manager as any).enemies.push(splitter);
    d.register(splitter as unknown as Enemy, 'splitter');
    d.onEnemyDeath(splitter as unknown as Enemy);
    expect(spawned.length).toBe(2);
    for (const mini of spawned) {
      expect(mini.spec.kind).toBe('walker');
      expect(mini.health).toBe(Math.max(8, Math.round(60 * 0.3)));
      expect(d.getVariant(mini)).toBe('mini'); // minis never split again
    }
    // second death of a mini spawns nothing
    const before = spawned.length;
    d.onEnemyDeath(spawned[0]);
    expect(spawned.length).toBe(before);
  });
  it('notifyStage announces boss chapters once; updateBossBar tracks the toughest', () => {
    const eng = mockEngine();
    const boss = fakeEnemy();
    boss.maxHealth = boss.health = 500;
    const manager = { enemies: [boss, fakeEnemy()] } as unknown as EnemyManager;
    const d = new VariantDirector(eng as unknown as Engine, manager, null);
    d.notifyStage(2, true);
    d.notifyStage(2, true);
    expect(eng.hud.showCard).toHaveBeenCalledTimes(1);
    d.updateBossBar(true);
    expect(eng.hud.setBoss).toHaveBeenCalledWith('BOSS — WALKER', 1);
    d.updateBossBar(false);
    expect(eng.hud.setBoss).toHaveBeenLastCalledWith(null, 0);
  });
});

describe('isBossStageActive', () => {
  const spec: any = {
    objective: {
      type: 'eliminate', count: 0, timeLimit: 0, description: '',
      stages: [
        { type: 'eliminate', count: 5, timeLimit: 0, description: 'c1' },
        { type: 'boss', count: 1, timeLimit: 0, description: 'c2' },
      ],
    },
  };
  it('is true only on boss stages', () => {
    expect(isBossStageActive(spec, { currentStageIndex: 0 })).toBe(false);
    expect(isBossStageActive(spec, { currentStageIndex: 1 })).toBe(true);
  });
  it('is false for legacy single objectives', () => {
    expect(isBossStageActive({ objective: { type: 'boss' } } as any, { currentStageIndex: 0 })).toBe(false);
  });
});

describe('EffectState', () => {
  it('applies multipliers while active and expires cleanly', () => {
    const fx = new EffectState();
    expect(fx.scoreMult()).toBe(1);
    fx.timers.set('mult', EFFECT_DEFS.mult.duration);
    fx.timers.set('rapid', EFFECT_DEFS.rapid.duration);
    fx.timers.set('magnet', EFFECT_DEFS.magnet.duration);
    expect(fx.scoreMult()).toBe(2);
    expect(fx.magnetMult()).toBeCloseTo(1.8, 10);
    expect(fx.boostMult()).toBe(2);
    fx.tick(1000); // everything expires
    expect(fx.scoreMult()).toBe(1);
    expect(fx.magnetMult()).toBe(1);
    expect(fx.boostMult()).toBe(1);
    expect(fx.timers.size).toBe(0);
  });
  it('ticks down partially', () => {
    const fx = new EffectState();
    fx.timers.set('mult', 20);
    fx.tick(7, undefined);
    expect(fx.remaining('mult')).toBeCloseTo(13, 10);
    expect(fx.isActive('mult')).toBe(true);
  });
  it('removes only the rapid bonus on expiry — a concurrent firerate upgrade survives (M8)', () => {
    const fx = new EffectState();
    const spec: any = { custom: { weaponMods: { rateOfFire: 1 } } };
    // rapid collected: ×2 folded into weaponMods.rateOfFire
    fx.timers.set('rapid', 5);
    fx.rapidApplied = true;
    spec.custom.weaponMods.rateOfFire = 2;
    // firerate level-up taken while rapid is active
    spec.custom.weaponMods.rateOfFire *= 1.2; // 2.4
    fx.tick(6, spec);
    // expiry divides the rapid bonus back out; the upgrade is retained
    expect(spec.custom.weaponMods.rateOfFire).toBeCloseTo(1.2, 10);
    expect(fx.rapidApplied).toBe(false);
  });
  it('re-collecting rapid mid-rapid refreshes the timer without re-stacking the multiplier', () => {
    const fx = new EffectState();
    const spec: any = { custom: {} };
    const engine: any = { audio: { play() {} }, hud: { toast() {} } };
    applyPickupEffect(engine, fx, {} as any, spec, 'rapid');
    expect(spec.custom.weaponMods.rateOfFire).toBe(2);
    applyPickupEffect(engine, fx, {} as any, spec, 'rapid'); // still active
    expect(spec.custom.weaponMods.rateOfFire).toBe(2); // not ×4
    fx.tick(EFFECT_DEFS.rapid.duration + 1, spec);
    expect(spec.custom.weaponMods.rateOfFire).toBe(1);
  });
  it('drains the shield pool on shield expiry', () => {
    const fx = new EffectState();
    fx.timers.set('shield', 3);
    fx.shieldPool = 40;
    fx.tick(5);
    expect(fx.shieldPool).toBe(0);
  });
});

describe('EFFECT_DEFS', () => {
  it('defines four timed effects with positive durations', () => {
    for (const k of ['shield', 'rapid', 'mult', 'magnet'] as const) {
      expect(EFFECT_DEFS[k].duration).toBeGreaterThan(0);
      expect(EFFECT_DEFS[k].name.length).toBeGreaterThan(0);
    }
  });
});

describe('spawnEffectPickup', () => {
  it('tags the pickup and swaps in a distinct mesh', () => {
    const eng = mockEngine();
    const added: any[] = [];
    const removed: any[] = [];
    (eng.scene.add as any) = (o: any) => { added.push(o); };
    (eng.scene.remove as any) = (o: any) => { removed.push(o); };
    (eng.mats as any) = {
      glow: (hex: string) => new THREE.MeshBasicMaterial({ color: hex }),
      flat: (hex: string) => new THREE.MeshBasicMaterial({ color: hex }),
    };
    const pickups = {
      list: [] as any[],
      spawn(kind: string, pos: THREE.Vector3) {
        const mesh = new THREE.Group();
        mesh.position.copy(pos);
        (this as any).list.push({ kind, mesh, pos: pos.clone(), taken: false, baseY: pos.y, phase: 0 });
      },
    } as any;
    const before = new THREE.Vector3(1, 2, 3);
    spawnEffectPickup(pickups, eng as unknown as Engine, 'shield', before);
    const p = pickups.list[0];
    expect(effectOf(p)).toBe('shield');
    expect(p.mesh.position.equals(before)).toBe(true);
    expect(removed.length).toBe(1); // generic star removed
    expect(added.length).toBe(1); // distinct mesh added
    expect(added[0]).not.toBe(removed[0]);
  });
});
