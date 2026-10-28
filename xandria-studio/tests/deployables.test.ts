/**
 * UPGRADE LOOP (deployables): deployable field items — campfire, spike
 * trap, lure totem.
 * - data-driven defs table (all tuning in one place)
 * - recipes: tier-1 materials, hand-crafted, always in the seeded pool
 * - item defs validate; outputs resolve in craftedItemDefs
 * - seeded tick magnitudes: deterministic, exact, in [base, base+variance]
 * - manager: deploy consumes inventory, seeded placement, cooldown, cap,
 *   expiry/retire, heal + damage ticks exact, lure assign/clear,
 *   despawnAll idempotent, spawnForMap clears (no regeneration)
 * - Enemy.lureTarget hook: null default; lured enemies chase the totem
 *   and never damage the player with melee
 * - touch layout: third-person-action has a DEPLOY button on the deploy action
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
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import { Inventory } from '../src/engine/game/items/Inventory';
import { buildRecipePool, craftedItemDefs, ensureCraftingItemDefs } from '../src/engine/game/crafting';
import { Enemy } from '../src/engine/game/EnemyAI';
import { layoutForGenre } from '../src/engine/game/TouchControls';
import type { EnemyKind } from '../src/spec/schema';
import {
  DEPLOY_SALT,
  DEPLOYABLE_DEFS,
  DEPLOY_CATALOG_RECIPES,
  DeployablesManager,
  deployableDefOf,
  deployableItemDefs,
  rollDeployTickMagnitude,
} from '../src/engine/game/deployables';
import { STATUS_TRAP_SALT, StatusTracker } from '../src/engine/game/statusEffects';
import { Rng } from '../src/engine/core/Rng';

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

function makeInventoryWith(ids: string[]): Inventory {
  const defs: Record<string, any> = {};
  for (const id of ids) defs[id] = { name: id, type: 'consumable' };
  return new Inventory(defs);
}

interface FakeEnemy {
  alive: boolean;
  position: THREE.Vector3;
  lureTarget: THREE.Vector3 | null;
  damaged: Array<{ n: number; from: THREE.Vector3 | undefined }>;
  damage(n: number, from?: THREE.Vector3): void;
}

function fakeEnemy(x: number, z: number): FakeEnemy {
  return {
    alive: true,
    position: new THREE.Vector3(x, 0, z),
    lureTarget: null,
    damaged: [],
    damage(n: number, from?: THREE.Vector3) { this.damaged.push({ n, from: from?.clone() }); },
  };
}

interface MgrOpts {
  player?: THREE.Vector3;
  enemies?: FakeEnemy[];
  healed?: number[];
  toasts?: string[];
  inventory?: Inventory | null;
  enabled?: boolean;
  mapSeed?: number;
  cleansed?: number[];
}

function makeManager(engine: Engine, o: MgrOpts = {}) {
  const player = o.player ?? new THREE.Vector3(0, 0, 0);
  const healed = o.healed ?? [];
  const toasts = o.toasts ?? [];
  const cleansed = o.cleansed ?? [];
  const mgr = new DeployablesManager(engine, {
    getPlayerPos: () => player,
    getEnemies: () => (o.enemies ?? []) as any,
    healPlayer: (n) => { healed.push(n); },
    toast: (m) => { toasts.push(m); },
    inventory: () => o.inventory ?? null,
    enabled: o.enabled,
    mapSeed: o.mapSeed ?? 4242,
    // STATUS-EFFECTS: the campfire-aura cleanse hook.
    clearPlayerStatuses: () => { cleansed.push(1); },
  });
  return { mgr, player, healed, toasts, cleansed };
}

// ---------------------------------------------------------------- defs table

describe('deployable defs table', () => {
  it('seeds exactly the three kinds with all tuning in one table', () => {
    expect(DEPLOYABLE_DEFS.map((d) => d.id).sort()).toEqual(['campfire', 'lure_totem', 'spike_trap']);
    for (const d of DEPLOYABLE_DEFS) {
      expect(d.itemId, `${d.id} itemId`).toMatch(/^deploy_/);
      expect(d.radius, `${d.id} radius`).toBeGreaterThan(0);
      expect(d.duration, `${d.id} duration`).toBeGreaterThan(0);
      expect(d.cooldown, `${d.id} cooldown`).toBeGreaterThan(0);
      expect(d.maxActive, `${d.id} maxActive`).toBeGreaterThan(0);
      expect(d.name.length, `${d.id} name`).toBeGreaterThan(0);
      expect(d.desc.length, `${d.id} desc`).toBeGreaterThan(0);
    }
    expect(deployableDefOf('campfire')?.effectKind).toBe('heal');
    expect(deployableDefOf('spike_trap')?.effectKind).toBe('damage');
    expect(deployableDefOf('lure_totem')?.effectKind).toBe('lure');
    expect(deployableDefOf('lure_totem')?.tickInterval).toBe(0);
    expect(deployableDefOf('campfire')?.tickInterval).toBeGreaterThan(0);
    expect(deployableDefOf('nope')).toBeUndefined();
  });

  it('item defs exist for every def itemId and are consumable kits', () => {
    const defs = deployableItemDefs();
    for (const d of DEPLOYABLE_DEFS) {
      const item = defs[d.itemId];
      expect(item, d.itemId).toBeTruthy();
      expect(item.type).toBe('consumable');
      expect(item.stack).toBeGreaterThanOrEqual(1);
    }
  });

  it('craftedItemDefs resolves every deployable output id', () => {
    const defs = craftedItemDefs();
    for (const d of DEPLOYABLE_DEFS) {
      expect(defs[d.itemId], d.itemId).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------- recipes

describe('deployable recipes', () => {
  it('three recipes, tier-1 materials, hand-crafted, always in pool', () => {
    expect(DEPLOY_CATALOG_RECIPES).toHaveLength(3);
    const tier1 = new Set(['mat_ore', 'mat_fiber', 'mat_scrap']);
    const itemIds = new Set(Object.keys(deployableItemDefs()));
    for (const r of DEPLOY_CATALOG_RECIPES) {
      expect(r.alwaysInPool).toBe(true);
      expect(r.stationId, `${r.id} station`).toBeUndefined();
      expect(r.minLevel, `${r.id} level gate`).toBeUndefined();
      expect(r.skillId, `${r.id} skill gate`).toBeUndefined();
      expect(itemIds.has(r.output.itemId), `${r.id} output`).toBe(true);
      for (const ing of r.ingredients) {
        expect(tier1.has(ing.itemId), `${r.id} ingredient ${ing.itemId}`).toBe(true);
        expect(ing.count).toBeGreaterThan(0);
      }
    }
  });

  it('buildRecipePool always includes the deployable recipes (any pool size)', () => {
    const ids = DEPLOY_CATALOG_RECIPES.map((r) => r.id);
    for (const poolSize of [1, 4, 8]) {
      const spec = defaultSpec(20261012) as GameSpec;
      spec.custom = { ...(spec.custom ?? {}), crafting: { recipes: { poolSize } } };
      const pool = buildRecipePool(spec);
      for (const id of ids) {
        expect(pool.some((r) => r.id === id), `poolSize ${poolSize} has ${id}`).toBe(true);
      }
    }
  });

  it('deployable recipes survive ensureCraftingItemDefs (no-overwrite)', () => {
    const spec = defaultSpec(7) as GameSpec;
    ensureCraftingItemDefs(spec);
    const defs = spec.custom?.items?.defs ?? {};
    for (const d of DEPLOYABLE_DEFS) {
      expect(defs[d.itemId], d.itemId).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------- seeded ticks

describe('rollDeployTickMagnitude', () => {
  it('deterministic, in [base, base+variance]', () => {
    const def = deployableDefOf('spike_trap')!;
    for (let i = 0; i < 30; i++) {
      const a = rollDeployTickMagnitude(def, 999, i);
      const b = rollDeployTickMagnitude(def, 999, i);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(def.tickMagnitude);
      expect(a).toBeLessThanOrEqual(def.tickMagnitude + def.tickVariance);
    }
    // the sequence is not constant (variance actually rolls)
    const seq = Array.from({ length: 12 }, (_, i) => rollDeployTickMagnitude(def, 999, i));
    expect(new Set(seq).size).toBeGreaterThan(1);
    // different seeds differ (not asserted to differ — just deterministic per seed)
    expect(rollDeployTickMagnitude(def, 1000, 3)).toBe(rollDeployTickMagnitude(def, 1000, 3));
  });
});

// ---------------------------------------------------------------- manager

describe('DeployablesManager', () => {
  it('refuses honestly with no stock', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_campfire']);
    const { mgr, toasts } = makeManager(engine, { inventory: inv });
    const r = mgr.tryDeploy();
    expect(r.ok).toBe(false);
    expect(r.kind).toBeNull();
    expect(mgr.deployables).toHaveLength(0);
    expect(toasts.join(' ')).toMatch(/craft/i);
  });

  it('deploys round-robin, consumes inventory, places near the player', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_campfire', 'deploy_spike_trap', 'deploy_lure_totem']);
    inv.add('deploy_campfire', 1);
    inv.add('deploy_spike_trap', 1);
    inv.add('deploy_lure_totem', 1);
    const { mgr, player } = makeManager(engine, { inventory: inv });
    const kinds: Array<string | null> = [];
    for (let i = 0; i < 3; i++) kinds.push(mgr.tryDeploy().kind);
    expect(kinds).toEqual(['campfire', 'spike_trap', 'lure_totem']);
    expect(inv.count('deploy_campfire')).toBe(0);
    expect(mgr.deployables).toHaveLength(3);
    for (const d of mgr.deployables) {
      const dist = d.root.position.distanceTo(player);
      expect(dist).toBeGreaterThanOrEqual(2.2 - 1e-6);
      expect(dist).toBeLessThanOrEqual(3.6 + 1e-6);
    }
  });

  it('placement is deterministic for the same deploy sequence', () => {
    const mk = () => {
      const engine = makeEngine();
      const inv = makeInventoryWith(['deploy_campfire']);
      inv.add('deploy_campfire', 2);
      const { mgr } = makeManager(engine, { inventory: inv, mapSeed: 777 });
      mgr.tryDeploy();
      (engine as any).time += 30; // past the campfire cooldown
      mgr.tryDeploy();
      return mgr.deployables.map((d) => d.root.position.toArray());
    };
    expect(mk()).toEqual(mk());
  });

  it('cooldown blocks immediate redeploy of the same kind', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_campfire']);
    inv.add('deploy_campfire', 3);
    const { mgr, toasts } = makeManager(engine, { inventory: inv });
    expect(mgr.tryDeploy().ok).toBe(true);
    const r2 = mgr.tryDeploy();
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/recharging/);
    expect(toasts.join(' ')).toMatch(/recharging/);
    expect(mgr.deployables).toHaveLength(1);
    expect(inv.count('deploy_campfire')).toBe(2); // failed deploy consumes nothing
  });

  it('live cap blocks over-deploying one kind', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_campfire']);
    inv.add('deploy_campfire', 5);
    const { mgr } = makeManager(engine, { inventory: inv });
    const def = deployableDefOf('campfire')!;
    for (let i = 0; i < def.maxActive; i++) {
      expect(mgr.tryDeploy().ok).toBe(true);
      (engine as any).time += def.cooldown + 1;
    }
    const r = mgr.tryDeploy();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cap/);
  });

  it('expiry retires and removes the deployable (shrink, no pop)', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_campfire']);
    inv.add('deploy_campfire', 1);
    const { mgr } = makeManager(engine, { inventory: inv });
    mgr.tryDeploy();
    const d = mgr.deployables[0];
    const fullScale = d.root.scale.x;
    (engine as any).time += deployableDefOf('campfire')!.duration + 0.01;
    mgr.update(0.016);
    expect(d.retiring).toBe(true);
    expect(d.root.scale.x).toBeLessThan(fullScale);
    expect(mgr.deployables).toHaveLength(1); // still collapsing
    (engine as any).time += 1;
    mgr.update(0.6);
    expect(mgr.deployables).toHaveLength(0);
  });

  it('campfire heal ticks are exact and seeded', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_campfire']);
    inv.add('deploy_campfire', 1);
    const healed: number[] = [];
    const { mgr } = makeManager(engine, { inventory: inv, healed });
    mgr.tryDeploy();
    const d = mgr.deployables[0];
    const def = d.def;
    // 3 ticks at 1s intervals (engine starts at time 0)
    for (let i = 1; i <= 3; i++) {
      (engine as any).time = i * def.tickInterval + 0.01;
      mgr.update(0.016);
    }
    const expected = [0, 1, 2].map((ti) => rollDeployTickMagnitude(def, d.seed, ti));
    expect(healed).toEqual(expected);
    expect(d.totalApplied).toBe(expected.reduce((a, b) => a + b, 0));
    expect(d.tickIndex).toBe(3);
  });

  it('spike trap damage ticks are exact and seeded, only in radius', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_spike_trap']);
    inv.add('deploy_spike_trap', 1);
    const near = fakeEnemy(50, 50);
    const far = fakeEnemy(60, 60);
    const { mgr } = makeManager(engine, { inventory: inv, enemies: [near, far] });
    mgr.tryDeploy();
    const d = mgr.deployables[0];
    const def = d.def;
    // park the near enemy inside the trap radius, far one stays out
    near.position.copy(d.root.position);
    for (let i = 1; i <= 4; i++) {
      (engine as any).time = i * def.tickInterval + 0.01;
      mgr.update(0.016);
    }
    const expected = [0, 1, 2, 3].map((ti) => rollDeployTickMagnitude(def, d.seed, ti));
    expect(near.damaged.map((h) => h.n)).toEqual(expected);
    expect(far.damaged).toEqual([]);
    expect(d.totalApplied).toBe(expected.reduce((a, b) => a + b, 0));
  });

  it('lure totem assigns and clears lureTarget', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_lure_totem']);
    inv.add('deploy_lure_totem', 1);
    const e = fakeEnemy(30, 30);
    const { mgr } = makeManager(engine, { inventory: inv, enemies: [e] });
    mgr.tryDeploy();
    const totem = mgr.deployables[0];
    // enemy within totem radius (14m) but far from the player at origin
    e.position.copy(totem.root.position).add(new THREE.Vector3(5, 0, 0));
    mgr.update(0.016);
    expect(e.lureTarget).not.toBeNull();
    expect(e.lureTarget!.distanceTo(totem.root.position)).toBeLessThan(1e-6);
    // expiry clears the target
    (engine as any).time += deployableDefOf('lure_totem')!.duration + 2;
    mgr.update(0.016);
    mgr.update(0.6);
    expect(mgr.deployables).toHaveLength(0);
    expect(e.lureTarget).toBeNull();
  });

  it('despawnAll is idempotent and clears lure targets', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_campfire', 'deploy_lure_totem']);
    inv.add('deploy_campfire', 1);
    inv.add('deploy_lure_totem', 1);
    const e = fakeEnemy(1, 0);
    const { mgr } = makeManager(engine, { inventory: inv, enemies: [e] });
    mgr.tryDeploy();
    (engine as any).time += 40;
    mgr.tryDeploy();
    expect(mgr.deployables).toHaveLength(2);
    mgr.update(0.016);
    mgr.despawnAll();
    mgr.despawnAll();
    expect(mgr.deployables).toHaveLength(0);
    expect(e.lureTarget).toBeNull();
  });

  it('spawnForMap clears live deployables and resets the placement stream', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_campfire']);
    inv.add('deploy_campfire', 2);
    const { mgr } = makeManager(engine, { inventory: inv, mapSeed: 111 });
    mgr.tryDeploy();
    expect(mgr.deployables).toHaveLength(1);
    mgr.spawnForMap(222);
    expect(mgr.deployables).toHaveLength(0);
    // arrival does NOT regenerate deployables (player-placed, documented)
    expect(mgr.deployables).toHaveLength(0);
  });

  it('disabled manager refuses honestly', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_campfire']);
    inv.add('deploy_campfire', 1);
    const { mgr } = makeManager(engine, { inventory: inv, enabled: false });
    const r = mgr.tryDeploy();
    expect(r.ok).toBe(false);
    expect(inv.count('deploy_campfire')).toBe(1);
  });

  it('uses seeded streams only (no engine.rng / Math.random / Date.now)', () => {
    const src = (DeployablesManager as any).toString() + (rollDeployTickMagnitude as any).toString();
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/engine\.rng/);
  });
});

// ---------------------------------------------------------------- Enemy lure hook

describe('Enemy.lureTarget (additive hook)', () => {
  const enemySpec = (kind: EnemyKind) => ({
    kind, count: 1, health: 100, speed: 2, damage: 10, weapon: 'melee' as const,
  });

  it('defaults to null (pre-deployables behavior untouched)', () => {
    const engine = makeEngine();
    const e = new Enemy(engine, enemySpec('walker'), new THREE.Vector3(0, 2, 0), null, {}, 4242);
    try {
      expect(e.lureTarget).toBeNull();
    } finally {
      e.dispose();
    }
  });

  it('lured enemy chases the totem while the player is far away', () => {
    const engine = makeEngine();
    const onPlayerHit = vi.fn();
    const e = new Enemy(engine, enemySpec('walker'), new THREE.Vector3(0, 2, 0), null, { onPlayerHit }, 4243);
    try {
      const farPlayer = new THREE.Vector3(100, 0, 100);
      e.update(0.016, farPlayer, 0);
      expect(e.hostile).toBe(false); // idle without a lure
      e.lureTarget = new THREE.Vector3(5, 0, 0);
      e.update(0.016, farPlayer, 0.016);
      expect(e.hostile).toBe(true); // chasing the totem
      expect(onPlayerHit).not.toHaveBeenCalled();
    } finally {
      e.dispose();
    }
  });

  it('melee against the lure never damages the player', () => {
    const engine = makeEngine();
    const onPlayerHit = vi.fn();
    const e = new Enemy(engine, enemySpec('walker'), new THREE.Vector3(0, 2, 0), null, { onPlayerHit }, 4244);
    try {
      const farPlayer = new THREE.Vector3(100, 0, 100);
      // the totem sits on top of the enemy: 3D dist 0 < attackR (2.2)
      e.lureTarget = e.position.clone();
      e.update(0.016, farPlayer, 0);
      e.update(0.016, farPlayer, 0.016);
      expect(onPlayerHit).not.toHaveBeenCalled();
    } finally {
      e.dispose();
    }
    // control: same geometry without the lure hits the player (fresh
    // enemy so the lured swing's attack cooldown can't mask the hit)
    const engine2 = makeEngine();
    const e2 = new Enemy(engine2, enemySpec('walker'), new THREE.Vector3(0, 2, 0), null, { onPlayerHit }, 4245);
    try {
      onPlayerHit.mockClear();
      e2.update(0.016, e2.position.clone(), 0);
      expect(onPlayerHit).toHaveBeenCalledTimes(1);
    } finally {
      e2.dispose();
    }
  });
});

// ---------------------------------------------------------------- touch seam

describe('deploy action seams', () => {
  it('third-person-action touch layout has a DEPLOY button on the deploy action', () => {
    const l = layoutForGenre('third-person-action');
    const b = l.buttons.find((x) => x.action === 'deploy');
    expect(b).toBeTruthy();
    expect(b!.label).toBe('DEPLOY');
  });
});

describe('STATUS-EFFECTS: deployable status hooks', () => {
  it('campfire heal ticks invoke the cleanse hook once per tick, in radius only', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_campfire']);
    inv.add('deploy_campfire', 1);
    const cleansed: number[] = [];
    const { mgr, player } = makeManager(engine, { inventory: inv, cleansed });
    mgr.tryDeploy();
    const d = mgr.deployables[0];
    const def = d.def;
    // 2 ticks with the player in radius (player at origin, fire ~3m away,
    // radius 6): one cleanse call per heal tick.
    for (let i = 1; i <= 2; i++) {
      (engine as any).time = i * def.tickInterval + 0.01;
      mgr.update(0.016);
    }
    expect(cleansed).toHaveLength(2);
    // Move the player out of the aura (the getter closes over this same
    // Vector3): the next heal tick is out of range, so no new cleanse.
    player.set(500, 0, 500);
    (engine as any).time = 3 * def.tickInterval + 0.01;
    mgr.update(0.016);
    expect(cleansed).toHaveLength(2);
  });

  it('spike trap damage rolls poison on the dedicated seeded stream', () => {
    const engine = makeEngine();
    const inv = makeInventoryWith(['deploy_spike_trap']);
    inv.add('deploy_spike_trap', 1);
    const tracker = new StatusTracker();
    const enemy = {
      ...fakeEnemy(0, 0),
      applyStatus(id: string, opts: { roll: number; now: number }) {
        return tracker.apply(id, opts.now, { roll: opts.roll });
      },
    };
    const { mgr } = makeManager(engine, { inventory: inv, enemies: [enemy as any] });
    mgr.tryDeploy();
    const d = mgr.deployables[0];
    // Stand the enemy on the trap.
    enemy.position.copy(d.root.position);
    const def = d.def;
    (engine as any).time = def.tickInterval + 0.01;
    mgr.update(0.016);
    expect(enemy.damaged).toHaveLength(1);
    // The trap roller is seeded (mapSeed ^ STATUS_TRAP_SALT); draw 1
    // decides poison. Replicate with the game's Rng.
    const draw = new Rng((4242 ^ STATUS_TRAP_SALT) >>> 0).next();
    expect(tracker.activeIds()).toEqual(draw < 0.3 ? ['poison'] : []);
  });
});
