/**
 * UPGRADE LOOP (companion-system): data-driven companion followers.
 * - defs table: 3 companions, distinct roles, sane tuning
 * - seeded rolls: damage/heal/follow-offset deterministic + in range
 * - target pick: nearest wins, wounded bonus flips a close call, dead/out-of-range skipped
 * - manager: summon/select/rename/dismiss, follow movement, attack via
 *   the existing damage path (exact seeded damage, kill counted),
 *   healer aura ticks exact, campfire gate honest, portal respawn from
 *   roster, serialize/restore round trip (unknown defs dropped, hp clamped)
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
      replaceChildren(...cs: any[]) { el.children = cs; },
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
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import {
  COMPANION_SALT,
  COMPANION_DEFS,
  CompanionsManager,
  companionDefOf,
  rollCompanionDamage,
  rollCompanionHeal,
  rollFollowOffset,
  pickCompanionTarget,
} from '../src/engine/game/companions';

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
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

interface FakeEnemy {
  alive: boolean;
  position: THREE.Vector3;
  health: number;
  maxHealth: number;
  damaged: number[];
  damage(n: number, from?: THREE.Vector3): void;
}

function fakeEnemy(x: number, z: number, health = 100): FakeEnemy {
  const e: FakeEnemy = {
    alive: true,
    position: new THREE.Vector3(x, 0, z),
    health,
    maxHealth: 100,
    damaged: [],
    damage(n: number) { this.damaged.push(n); this.health -= n; if (this.health <= 0) this.alive = false; },
  };
  return e;
}

function makeManager(engine: Engine, o: {
  player?: THREE.Vector3; enemies?: FakeEnemy[]; healed?: number[];
  toasts?: string[]; campfire?: boolean; saved?: any[]; initial?: any;
} = {}) {
  const player = o.player ?? new THREE.Vector3(0, 0, 0);
  const healed = o.healed ?? [];
  const toasts = o.toasts ?? [];
  const saved = o.saved ?? [];
  const mgr = new CompanionsManager(engine, {
    getPlayerPos: () => player,
    getEnemies: () => (o.enemies ?? []) as any,
    healPlayer: (n) => { healed.push(n); },
    toast: (m) => { toasts.push(m); },
    campfireLive: () => o.campfire ?? false,
    onChange: (s) => { saved.push(s); },
    initial: o.initial ?? null,
    mapSeed: 20261012,
  });
  return { mgr, player, healed, toasts, saved };
}

describe('companion defs', () => {
  it('seeds exactly three companions with distinct roles', () => {
    expect(COMPANION_DEFS.map((d) => d.id)).toEqual(['brawler', 'caster', 'healer']);
    expect(COMPANION_DEFS.map((d) => d.role)).toEqual(['melee', 'ranged', 'aura']);
    expect(companionDefOf('brawler')?.name).toBe('Brak');
    expect(companionDefOf('caster')?.name).toBe('Vex');
    expect(companionDefOf('healer')?.name).toBe('Moth');
    expect(companionDefOf('nope')).toBeUndefined();
  });

  it('tuning is sane: attackers deal damage, healer heals, nobody does both', () => {
    for (const d of COMPANION_DEFS) {
      if (d.role === 'aura') { expect(d.damage).toBe(0); expect(d.heal).toBeGreaterThan(0); }
      else { expect(d.damage).toBeGreaterThan(0); expect(d.heal).toBe(0); }
      expect(d.maxHp).toBeGreaterThan(0);
      expect(d.followDist).toBeGreaterThan(0);
    }
  });
});

describe('seeded rolls', () => {
  it('damage roll is deterministic and in [base, base+variance]', () => {
    const def = companionDefOf('brawler')!;
    const a = rollCompanionDamage(def, 20261012, 0);
    expect(rollCompanionDamage(def, 20261012, 0)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(def.damage);
    expect(a).toBeLessThanOrEqual(def.damage + def.damageVariance);
    // rolls vary across the index stream (not every index need differ)
    const stream = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => rollCompanionDamage(def, 20261012, i));
    expect(new Set(stream).size).toBeGreaterThan(1);
    expect(COMPANION_SALT).toBe(0xc0ff1e);
  });

  it('heal roll is deterministic and in [base, base+variance]', () => {
    const def = companionDefOf('healer')!;
    const a = rollCompanionHeal(def, 20261012, 0);
    expect(rollCompanionHeal(def, 20261012, 0)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(def.heal);
    expect(a).toBeLessThanOrEqual(def.heal + def.healVariance);
  });

  it('follow offset is deterministic and near the def angle/dist', () => {
    const def = companionDefOf('caster')!;
    const a = rollFollowOffset(def, 20261012);
    expect(rollFollowOffset(def, 20261012)).toEqual(a);
    expect(Math.abs(a.angle - def.followAngle)).toBeLessThanOrEqual(0.35 + 1e-9);
    expect(Math.abs(a.dist - def.followDist)).toBeLessThanOrEqual(0.4 + 1e-9);
  });
});

describe('target pick (additive wounded weight)', () => {
  const origin = new THREE.Vector3(0, 0, 0);
  it('nearest alive enemy in range wins', () => {
    const near = { position: new THREE.Vector3(2, 0, 0), alive: true, health: 100, maxHealth: 100 };
    const far = { position: new THREE.Vector3(5, 0, 0), alive: true, health: 100, maxHealth: 100 };
    expect(pickCompanionTarget([far, near], origin, 10)).toBe(near);
  });

  it('wounded bonus flips a close call (within the 2.5m bonus)', () => {
    const healthy = { position: new THREE.Vector3(4, 0, 0), alive: true, health: 100, maxHealth: 100 };
    const wounded = { position: new THREE.Vector3(5, 0, 0), alive: true, health: 10, maxHealth: 100 };
    // wounded score: 5 - 0.9*2.5 = 2.75 < healthy 4
    expect(pickCompanionTarget([healthy, wounded], origin, 10)).toBe(wounded);
  });

  it('dead and out-of-range candidates are skipped', () => {
    const dead = { position: new THREE.Vector3(1, 0, 0), alive: false, health: 0, maxHealth: 100 };
    const far = { position: new THREE.Vector3(50, 0, 0), alive: true, health: 100, maxHealth: 100 };
    expect(pickCompanionTarget([dead, far], origin, 10)).toBeNull();
  });
});

describe('manager lifecycle', () => {
  it('summon spawns a live follower; follow closes distance to the player', () => {
    const engine = makeEngine();
    const { mgr, player } = makeManager(engine);
    expect(mgr.summon('brawler')).toBe(true);
    expect(mgr.activeCompanionId).toBe('brawler');
    expect(mgr.live).not.toBeNull();
    // Walk case: move the player 10m — the companion walks 7.5m toward
    // its new follow point (teleport only kicks in beyond 14m).
    player.set(10, 0, 0);
    const target = new THREE.Vector3(
      player.x + Math.cos(mgr.live!.follow.angle) * mgr.live!.follow.dist,
      0,
      player.z + Math.sin(mgr.live!.follow.angle) * mgr.live!.follow.dist,
    );
    const before = mgr.live!.root.position.distanceTo(target);
    mgr.update(1.0);
    const after = mgr.live!.root.position.distanceTo(target);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(before - 7.5, 5);
    // Settle: after a long update the companion sits exactly at its
    // follow offset from the player.
    mgr.update(5.0);
    const settled = mgr.live!.root.position.distanceTo(player);
    expect(settled).toBeCloseTo(mgr.live!.follow.dist, 5);
    // Teleport case: a 30m jump puts the companion straight at the offset.
    player.set(40, 0, 40);
    mgr.update(0.016);
    expect(mgr.live!.root.position.distanceTo(player)).toBeCloseTo(mgr.live!.follow.dist, 5);
  });

  it('brawler attack deals the exact seeded damage through the damage path', () => {
    const engine = makeEngine();
    const enemy = fakeEnemy(1, 0);
    const { mgr } = makeManager(engine, { enemies: [enemy] });
    mgr.summon('brawler');
    // Pin the enemy at the companion's feet (inside melee range).
    enemy.position.copy(mgr.live!.root.position);
    const seed = mgr.live!.seed;
    mgr.update(1.0); // attackCd starts 0 -> fires immediately
    const def = companionDefOf('brawler')!;
    expect(enemy.damaged).toEqual([rollCompanionDamage(def, seed, 0)]);
    expect(mgr.totalDamage).toBe(rollCompanionDamage(def, seed, 0));
  });

  it('a companion kill is counted (the onDeath path fires off the same damage call in-game)', () => {
    const engine = makeEngine();
    const enemy = fakeEnemy(1, 0, 5); // less than any brawler roll
    const { mgr } = makeManager(engine, { enemies: [enemy] });
    mgr.summon('brawler');
    enemy.position.copy(mgr.live!.root.position);
    mgr.update(1.0);
    expect(enemy.alive).toBe(false);
    expect(mgr.kills).toBe(1);
  });

  it('healer aura ticks the player with the exact seeded heal', () => {
    const engine = makeEngine();
    const healed: number[] = [];
    const { mgr } = makeManager(engine, { healed });
    mgr.summon('healer');
    mgr.update(1.0);
    const def = companionDefOf('healer')!;
    expect(healed).toEqual([rollCompanionHeal(def, mgr.live!.seed, 0)]);
    expect(mgr.totalHealed).toBe(healed[0]);
  });

  it('rename + dismiss persist; roster entry survives dismissal', () => {
    const engine = makeEngine();
    const { mgr, saved } = makeManager(engine);
    mgr.summon('caster');
    expect(mgr.rename('caster', '  Sparky  ')).toBe(true);
    expect(mgr.rosterView.find((s) => s.defId === 'caster')?.name).toBe('Sparky');
    expect(mgr.rename('caster', '   ')).toBe(false);
    expect(mgr.dismiss()).toBe(true);
    expect(mgr.activeCompanionId).toBeNull();
    expect(mgr.live).toBeNull();
    expect(mgr.rosterView.find((s) => s.defId === 'caster')?.name).toBe('Sparky');
    expect(saved[saved.length - 1]).toEqual({
      activeId: null,
      roster: expect.arrayContaining([expect.objectContaining({ defId: 'caster', name: 'Sparky' })]),
    });
  });

  it('portal lifecycle: despawnAll keeps the roster; spawnForMap respawns it', () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);
    mgr.summon('brawler');
    mgr.rename('brawler', 'Tank');
    mgr.despawnAll();
    expect(mgr.live).toBeNull();
    expect(mgr.activeCompanionId).toBe('brawler');
    mgr.spawnForMap(777);
    expect(mgr.live).not.toBeNull();
    expect(mgr.activeState?.name).toBe('Tank');
    expect(mgr.activeState?.hp).toBe(companionDefOf('brawler')!.maxHp);
    mgr.despawnAll();
    expect(mgr.despawnAll()).toBeUndefined(); // idempotent
  });

  it('dismissed companions spawn nothing on arrival', () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);
    mgr.summon('brawler');
    mgr.dismiss();
    mgr.spawnForMap(777);
    expect(mgr.live).toBeNull();
  });

  it('heal-at-campfire refuses without a campfire and fully heals with one', () => {
    const engine = makeEngine();
    const { mgr, toasts } = makeManager(engine, { campfire: false });
    mgr.summon('brawler');
    mgr.damageActive(50);
    expect(mgr.healAtCampfire()).toBe(0);
    expect(toasts[toasts.length - 1]).toMatch(/No campfire/);
    // flip the gate on and retry
    const engine2 = makeEngine();
    const { mgr: mgr2 } = makeManager(engine2, { campfire: true });
    mgr2.summon('brawler');
    mgr2.damageActive(50);
    const def = companionDefOf('brawler')!;
    expect(mgr2.healAtCampfire()).toBe(50);
    expect(mgr2.activeState?.hp).toBe(def.maxHp);
  });

  it('downed companions stop acting until healed', () => {
    const engine = makeEngine();
    const enemy = fakeEnemy(1, 0);
    const { mgr } = makeManager(engine, { enemies: [enemy] });
    mgr.summon('brawler');
    enemy.position.copy(mgr.live!.root.position);
    mgr.damageActive(9999);
    expect(mgr.activeState?.hp).toBe(0);
    mgr.update(1.0);
    expect(enemy.damaged).toEqual([]);
    mgr.healActive(10);
    mgr.update(1.0);
    expect(enemy.damaged.length).toBe(1);
  });

  it('serialize/restore round trip; unknown defs dropped, hp clamped', () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);
    mgr.summon('healer');
    mgr.rename('healer', 'Glow');
    const save = mgr.serialize();
    const { mgr: mgr2 } = makeManager(makeEngine(), {
      initial: {
        activeId: save.activeId,
        roster: [...save.roster, { defId: 'ghost', name: 'Ghost', hp: 999 } as any,
          { defId: 'brawler', name: 'Big', hp: 9999 }],
      },
    });
    expect(mgr2.activeCompanionId).toBe('healer');
    expect(mgr2.rosterView.find((s) => s.defId === 'healer')?.name).toBe('Glow');
    expect(mgr2.rosterView.find((s) => s.defId === 'ghost')).toBeUndefined();
    expect(mgr2.rosterView.find((s) => s.defId === 'brawler')?.hp)
      .toBe(companionDefOf('brawler')!.maxHp);
    expect(mgr2.rosterView).toHaveLength(3);
  });

  it('summon of an unknown id refuses honestly', () => {
    const engine = makeEngine();
    const { mgr, toasts } = makeManager(engine);
    expect(mgr.summon('ghost')).toBe(false);
    expect(mgr.activeCompanionId).toBeNull();
    expect(toasts[toasts.length - 1]).toMatch(/Unknown companion/);
  });
});
