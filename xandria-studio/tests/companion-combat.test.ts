/**
 * UPGRADE LOOP (companion-combat-depth): enemies may target companions.
 * - weight table: player 100, companion 40, taunt +120 (=160 beats the
 *   player), guard +120 (=160, also draws aggro — otherwise guard
 *   would be unreachable: see companionCombat header); out-of-range = 0;
 *   both out = null
 * - guard reduction: exact halving (floored, min 1 on a nonzero hit)
 * - manager: stance set/persist/restore (old saves default to normal),
 *   takeEnemyHit full vs guard-halved, fall dismisses to the panel
 *   (never a player death), revive restores full HP without summoning
 * - manager update: taunt assigns companionTargetPos, normal with the
 *   player in range does not, dismiss clears targets, guard attacks
 *   nothing
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
import { CompanionsManager } from '../src/engine/game/companions';
import {
  COMPANION_TARGET_WEIGHTS,
  COMPANION_REVIVE_COST,
  GUARD_DAMAGE_FRACTION,
  enemyAggroRange,
  pickEnemyTarget,
  applyGuardReduction,
  isCompanionStance,
} from '../src/engine/game/companionCombat';

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
  spec: { kind: string };
  companionTargetPos: THREE.Vector3 | null;
  damaged: number[];
  damage(n: number, from?: THREE.Vector3): void;
}

function fakeEnemy(x: number, z: number, kind = 'walker', health = 100): FakeEnemy {
  const e: FakeEnemy = {
    alive: true,
    position: new THREE.Vector3(x, 0, z),
    health,
    maxHealth: 100,
    spec: { kind },
    companionTargetPos: null,
    damaged: [],
    damage(n: number) { this.damaged.push(n); this.health -= n; if (this.health <= 0) this.alive = false; },
  };
  return e;
}

function makeManager(engine: Engine, o: {
  player?: THREE.Vector3; enemies?: FakeEnemy[]; toasts?: string[]; saved?: any[]; initial?: any;
} = {}) {
  const player = o.player ?? new THREE.Vector3(0, 0, 0);
  const toasts = o.toasts ?? [];
  const saved = o.saved ?? [];
  const mgr = new CompanionsManager(engine, {
    getPlayerPos: () => player,
    getEnemies: () => (o.enemies ?? []) as any,
    healPlayer: () => {},
    toast: (m) => { toasts.push(m); },
    campfireLive: () => false,
    onChange: (s) => { saved.push(s); },
    initial: o.initial ?? null,
    mapSeed: 20261012,
  });
  return { mgr, player, toasts, saved };
}

describe('companion-combat weight table', () => {
  it('publishes the exact disclosed weights', () => {
    expect(COMPANION_TARGET_WEIGHTS.player).toBe(100);
    expect(COMPANION_TARGET_WEIGHTS.companionBase).toBe(40);
    expect(COMPANION_TARGET_WEIGHTS.tauntBonus).toBe(120);
    expect(COMPANION_TARGET_WEIGHTS.guardBonus).toBe(120);
    expect(COMPANION_TARGET_WEIGHTS.companionBase + COMPANION_TARGET_WEIGHTS.tauntBonus).toBe(160);
    expect(COMPANION_TARGET_WEIGHTS.companionBase + COMPANION_TARGET_WEIGHTS.guardBonus).toBe(160);
    expect(COMPANION_REVIVE_COST).toBe(25);
    expect(GUARD_DAMAGE_FRACTION).toBe(0.5);
  });

  it('taunt and guard beat the player in range; normal loses to the player', () => {
    expect(pickEnemyTarget({ playerDist: 5, companionDist: 5, stance: 'taunt', kind: 'walker' })).toBe('companion');
    expect(pickEnemyTarget({ playerDist: 5, companionDist: 5, stance: 'guard', kind: 'walker' })).toBe('companion');
    expect(pickEnemyTarget({ playerDist: 5, companionDist: 5, stance: 'normal', kind: 'walker' })).toBe('player');
  });

  it('out-of-range candidates weigh 0; companion wins when only it is in range', () => {
    expect(pickEnemyTarget({ playerDist: 40, companionDist: 5, stance: 'normal', kind: 'walker' })).toBe('companion');
    expect(pickEnemyTarget({ playerDist: 5, companionDist: 40, stance: 'taunt', kind: 'walker' })).toBe('player');
    expect(pickEnemyTarget({ playerDist: 40, companionDist: 40, stance: 'taunt', kind: 'walker' })).toBeNull();
    expect(pickEnemyTarget({ playerDist: 5, companionDist: null, stance: 'taunt', kind: 'walker' })).toBe('player');
  });

  it('aggro range mirrors Enemy.update: turret 42, others 30', () => {
    expect(enemyAggroRange('turret')).toBe(42);
    expect(enemyAggroRange('walker')).toBe(30);
    expect(enemyAggroRange('brute')).toBe(30);
    expect(enemyAggroRange('drone')).toBe(30);
    // A turret at 35m still sees both candidates; a walker does not.
    expect(pickEnemyTarget({ playerDist: 35, companionDist: 35, stance: 'normal', kind: 'turret' })).toBe('player');
    expect(pickEnemyTarget({ playerDist: 35, companionDist: 35, stance: 'normal', kind: 'walker' })).toBeNull();
  });
});

describe('guard reduction', () => {
  it('halves guard damage exactly; other stances take full damage', () => {
    expect(applyGuardReduction(10, 'guard')).toBe(5);
    expect(applyGuardReduction(11, 'guard')).toBe(5);
    expect(applyGuardReduction(1, 'guard')).toBe(1);
    expect(applyGuardReduction(0, 'guard')).toBe(0);
    expect(applyGuardReduction(10, 'normal')).toBe(10);
    expect(applyGuardReduction(10, 'taunt')).toBe(10);
  });

  it('validates stance values (old saves without one default to normal)', () => {
    expect(isCompanionStance('taunt')).toBe(true);
    expect(isCompanionStance('guard')).toBe(true);
    expect(isCompanionStance('normal')).toBe(true);
    expect(isCompanionStance('berserk')).toBe(false);
    expect(isCompanionStance(undefined)).toBe(false);
  });
});

describe('companion stances on the manager', () => {
  it('defaults to normal, sets taunt, persists it, restores it', () => {
    const engine = makeEngine();
    const { mgr, saved } = makeManager(engine);
    expect(mgr.activeStance).toBe('normal');
    mgr.summon('brawler');
    expect(mgr.setStance('taunt')).toBe(true);
    expect(mgr.activeStance).toBe('taunt');
    expect(saved[saved.length - 1].roster.find((s: any) => s.defId === 'brawler').stance).toBe('taunt');
    expect(mgr.setStance('berserk' as any)).toBe(false);
    expect(mgr.activeStance).toBe('taunt');
    const restored = makeManager(engine, { initial: mgr.serialize() }).mgr;
    restored.summon('brawler');
    expect(restored.activeStance).toBe('taunt');
  });

  it('old saves without a stance restore as normal', () => {
    const engine = makeEngine();
    const legacy = {
      activeId: 'brawler',
      roster: [
        { defId: 'brawler', name: 'Brak', hp: 120 },
        { defId: 'caster', name: 'Vex', hp: 70 },
        { defId: 'healer', name: 'Moth', hp: 80 },
      ],
    };
    const { mgr } = makeManager(engine, { initial: legacy });
    mgr.summon('brawler');
    expect(mgr.activeStance).toBe('normal');
  });
});

describe('companion fall + revive', () => {
  it('takeEnemyHit deals full damage in normal stance, halved in guard', () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);
    mgr.summon('brawler');
    expect(mgr.takeEnemyHit(10)).toBe(10);
    expect(mgr.activeState?.hp).toBe(110);
    mgr.setStance('guard');
    expect(mgr.takeEnemyHit(10)).toBe(5);
    expect(mgr.activeState?.hp).toBe(105);
  });

  it('a lethal hit falls the companion to the panel (never a player death) and revive restores it without summoning', () => {
    const engine = makeEngine();
    const { mgr, toasts } = makeManager(engine);
    mgr.summon('brawler');
    expect(mgr.takeEnemyHit(120)).toBe(120);
    expect(mgr.activeCompanionId).toBeNull();
    expect(mgr.live).toBeNull();
    expect(mgr.rosterView.find((s) => s.defId === 'brawler')?.hp).toBe(0);
    expect(toasts.join(' ')).toContain('falls');
    expect(toasts.join(' ')).toContain('25 scrap');
    expect(mgr.revive('brawler')).toBe(true);
    expect(mgr.rosterView.find((s) => s.defId === 'brawler')?.hp).toBe(120);
    expect(mgr.activeCompanionId).toBeNull(); // revive does NOT auto-summon
    expect(mgr.revive('brawler')).toBe(false); // already healthy
    expect(mgr.revive('nope')).toBe(false);
    mgr.summon('brawler');
    expect(mgr.live).not.toBeNull();
    expect(mgr.activeState?.hp).toBe(120);
  });

  it('takeEnemyHit with nothing summoned deals nothing', () => {
    const engine = makeEngine();
    const { mgr } = makeManager(engine);
    expect(mgr.takeEnemyHit(10)).toBe(0);
  });
});

describe('enemy target assignment in update()', () => {
  it('taunt and guard assign companionTargetPos; normal with the player in range does not', () => {
    const engine = makeEngine();
    const enemy = fakeEnemy(3, 0);
    const { mgr } = makeManager(engine, { enemies: [enemy] });
    mgr.summon('brawler');
    mgr.setStance('taunt');
    mgr.update(0.1);
    expect(enemy.companionTargetPos).not.toBeNull();
    mgr.setStance('guard');
    mgr.update(0.1);
    expect(enemy.companionTargetPos).not.toBeNull();
    mgr.setStance('normal');
    mgr.update(0.1);
    expect(enemy.companionTargetPos).toBeNull();
  });

  it('an enemy out of range of both candidates gets no target even in taunt', () => {
    // A live follower stays within ~14m of the player by design, so the
    // "player out of range, companion in range" split is covered at the
    // pure-function level; here the manager proves the both-out case.
    const engine = makeEngine();
    const enemy = fakeEnemy(40, 0);
    const { mgr } = makeManager(engine, { enemies: [enemy] });
    mgr.summon('brawler');
    mgr.setStance('taunt');
    mgr.update(0.1);
    expect(enemy.companionTargetPos).toBeNull();
  });

  it('dismiss clears companion targets; dead enemies never get one', () => {
    const engine = makeEngine();
    const enemy = fakeEnemy(3, 0);
    const dead = fakeEnemy(4, 0);
    dead.alive = false;
    const { mgr } = makeManager(engine, { enemies: [enemy, dead] });
    mgr.summon('brawler');
    mgr.setStance('taunt');
    mgr.update(0.1);
    expect(enemy.companionTargetPos).not.toBeNull();
    expect(dead.companionTargetPos).toBeNull();
    mgr.dismiss();
    expect(enemy.companionTargetPos).toBeNull();
  });

  it('guard stance attacks nothing even with an enemy in range', () => {
    const engine = makeEngine();
    const enemy = fakeEnemy(0, 0, 'walker', 100);
    const { mgr } = makeManager(engine, { enemies: [enemy] });
    mgr.summon('brawler');
    mgr.setStance('guard');
    // Put the enemy at the companion's feet so a normal stance would hit it.
    const cpos = mgr.live!.root.position.clone();
    enemy.position.set(cpos.x, 0, cpos.z);
    for (let i = 0; i < 5; i++) mgr.update(0.5);
    expect(enemy.damaged).toEqual([]);
  });
});
