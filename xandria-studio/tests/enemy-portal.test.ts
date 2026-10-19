/**
 * Enemies workstream A: EnemyManager as a MapLocalEntitySystem.
 * - spawnForMap(mapSeed) deterministic from mapSeed alone (two engines, same seed)
 * - portal round-trip regenerates the identical roster
 * - despawnAll leaves zero payloads (physics bodies + scene meshes back to
 *   baseline, idempotent), INCLUDING mid-tumble corpses
 * - enemy <-> NPC collision occurs (both mask directions, live contact);
 *   NPCs still never collide with projectiles
 * - spawnAll backward compat (blueprint chapter/variant paths untouched)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '', width: 0, height: 0,
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
import { defaultSpec, type GameSpec, type EnemySpec, type NpcSpec } from '../src/spec/schema';
import { GROUP } from '../src/engine/core/Physics';
import { EnemyManager, ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { Npc } from '../src/engine/game/Npc';

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

const POIS = [
  { x: 100, z: 100, r: 8 },
  { x: -150, z: 60, r: 6 },
  { x: 40, z: -200, r: 10 },
];

const SPECS: EnemySpec[] = [
  { kind: 'walker', count: 2, health: 30, speed: 3, damage: 10, weapon: 'melee' },
  { kind: 'drone', count: 1, health: 20, speed: 5, damage: 8, weapon: 'blaster' },
  { kind: 'turret', count: 1, health: 50, speed: 0, damage: 12, weapon: 'blaster' },
];

function rosterSig(m: EnemyManager) {
  return m.enemies.map((e) => [
    e.spec.kind,
    e.home.x.toFixed(4), e.home.y.toFixed(4), e.home.z.toFixed(4),
  ].join('|'));
}

function countMeshes(engine: Engine): number {
  let n = 0;
  engine.scene.traverse((o: any) => { if (o.isMesh) n++; });
  return n;
}

describe('EnemyManager determinism (salted Rng, never engine.rng)', () => {
  it('same mapSeed on two engines -> identical roster (kinds + positions)', () => {
    const e1 = makeEngine(), e2 = makeEngine();
    const m1 = new EnemyManager(e1, null, {}, { pois: POIS, specs: SPECS });
    const m2 = new EnemyManager(e2, null, {}, { pois: POIS, specs: SPECS });
    m1.spawnForMap(20261012);
    m2.spawnForMap(20261012);
    expect(m1.enemies.length).toBe(4);
    expect(m1.enemies.length).toBe(m2.enemies.length);
    expect(rosterSig(m1)).toEqual(rosterSig(m2));
    m1.despawnAll(); m2.despawnAll();
    e1.dispose(); e2.dispose();
  });

  it('different mapSeed -> different roster', () => {
    const engine = makeEngine();
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: SPECS });
    m.spawnForMap(111);
    const a = rosterSig(m);
    m.spawnForMap(222);
    const b = rosterSig(m);
    expect(a).not.toEqual(b);
    m.despawnAll();
    engine.dispose();
  });

  it('portal round-trip regenerates identically: spawn(s) -> despawn -> spawn(s)', () => {
    const engine = makeEngine();
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: SPECS });
    m.spawnForMap(777001);
    const first = rosterSig(m);
    m.despawnAll();
    expect(m.enemies.length).toBe(0);
    m.spawnForMap(777001);
    expect(rosterSig(m)).toEqual(first);
    m.despawnAll();
    engine.dispose();
  });

  it('ENEMY_SALT is distinct from NPC_SALT (streams never collide)', async () => {
    const { NPC_SALT } = await import('../src/engine/game/Npc');
    expect(ENEMY_SALT).not.toBe(NPC_SALT);
    expect(ENEMY_SALT).toBe(0x454e454d);
  });
});

describe('EnemyManager lifecycle (zero-leak, idempotent)', () => {
  it('despawnAll returns physics bodies + scene meshes to baseline; idempotent', () => {
    const engine = makeEngine();
    const bodiesBefore = engine.physics.world.bodies.length;
    const meshesBefore = countMeshes(engine);
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: SPECS });
    m.spawnForMap(424242);
    expect(m.enemies.length).toBe(4);
    // every enemy owns exactly one physics body
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore + m.enemies.length);
    expect(countMeshes(engine)).toBeGreaterThan(meshesBefore);
    const groups = m.enemies.map((e) => e.rig?.group ?? e.turret!.group);
    for (const g of groups) expect(engine.scene.children).toContain(g);
    m.despawnAll();
    expect(m.enemies.length).toBe(0);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    expect(countMeshes(engine)).toBe(meshesBefore);
    for (const g of groups) expect(engine.scene.children).not.toContain(g);
    // second call is a no-op, never an error
    expect(() => m.despawnAll()).not.toThrow();
    expect(m.enemies.length).toBe(0);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    expect(countMeshes(engine)).toBe(meshesBefore);
    engine.dispose();
  });

  it('despawnAll cleans up mid-tumble corpses (body already gone, rig still in scene)', () => {
    const engine = makeEngine();
    const bodiesBefore = engine.physics.world.bodies.length;
    const m = new EnemyManager(engine, null, {});
    m.spawnAll(
      [{ kind: 'walker', count: 1, health: 30, speed: 3, damage: 10, weapon: 'melee' }],
      () => new THREE.Vector3(0, 0, 0),
    );
    const e = m.enemies[0];
    const rigGroup = e.rig!.group;
    // kill via the real death path: ragdoll-lite corpse — sim body removed,
    // rig kept animating its tumble for ~1.5s, roster entry retained
    (e as any).die();
    expect(e.alive).toBe(false);
    expect(e.body).toBeNull();
    expect(e.corpseDone).toBe(false);
    expect(m.enemies.length).toBe(1); // update() would sweep it later; portals can't wait
    expect(engine.scene.children).toContain(rigGroup);
    m.despawnAll();
    expect(m.enemies.length).toBe(0);
    expect(engine.scene.children).not.toContain(rigGroup);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    expect(() => m.despawnAll()).not.toThrow(); // still idempotent after corpses
    engine.dispose();
  });

  it('spawnForMap is self-cleaning: re-spawn never double-counts bodies', () => {
    const engine = makeEngine();
    const bodiesBefore = engine.physics.world.bodies.length;
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: SPECS });
    m.spawnForMap(1);
    m.spawnForMap(2);
    m.spawnForMap(3);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore + m.enemies.length);
    m.despawnAll();
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    engine.dispose();
  });

  it('spawnAll (blueprint path) still works and keeps chapter/variant-compatible roster', () => {
    const engine = makeEngine();
    const m = new EnemyManager(engine, null, {});
    m.spawnAll(SPECS, () => new THREE.Vector3(1, 1, 1));
    expect(m.enemies.length).toBe(4);
    expect(m.enemies.map((e) => e.spec.kind)).toEqual(['walker', 'walker', 'drone', 'turret']);
    // the returned Enemy is the same object the manager holds (variant registration path)
    const e = m.spawnOne(SPECS[0], new THREE.Vector3(2, 1, 2), 1234);
    expect(m.enemies).toContain(e);
    m.despawnAll();
    expect(m.enemies.length).toBe(0);
    engine.dispose();
  });
});

describe('enemy <-> NPC collision, NPC <-> projectile exclusion', () => {
  it('enemy bodies and NPC bodies collide (both mask directions; live contact)', () => {
    const engine = makeEngine();
    const mgr = new EnemyManager(engine, null, {});
    mgr.spawnAll(
      [{ kind: 'walker', count: 1, health: 30, speed: 3, damage: 10, weapon: 'melee' }],
      () => new THREE.Vector3(0, 0, 0),
    );
    const enemy = mgr.enemies[0];
    const npc = new Npc(engine, { role: 'villager' } as NpcSpec, new THREE.Vector3(0.5, 0, 0), 4242);
    // cannon-es requires BOTH directions: enemy.group in npc.mask AND npc.group in enemy.mask
    expect(enemy.body!.collisionFilterGroup).toBe(GROUP.ENEMY);
    expect(enemy.body!.collisionFilterMask & GROUP.NPC).not.toBe(0);
    expect(npc.body!.collisionFilterGroup).toBe(GROUP.NPC);
    expect(npc.body!.collisionFilterMask & GROUP.ENEMY).not.toBe(0);
    // live contact: bodies start overlapped (0.5m < r_enemy + r_npc)
    let contact = false;
    for (let i = 0; i < 30; i++) {
      engine.physics.step(1 / 60);
      if (engine.physics.world.contacts.length > 0) { contact = true; break; }
    }
    expect(contact).toBe(true);
    npc.dispose();
    mgr.despawnAll();
    engine.dispose();
  });

  it('NPCs still never collide with projectiles (mask has no PROJECTILE bit)', () => {
    const engine = makeEngine();
    const npc = new Npc(engine, { role: 'villager' } as NpcSpec, new THREE.Vector3(0, 0, 0), 99);
    expect(npc.body!.collisionFilterGroup).toBe(GROUP.NPC);
    expect(npc.body!.collisionFilterMask & GROUP.PROJECTILE).toBe(0);
    // belt-and-braces: neither projectile mask covers the NPC group, so even
    // a mask bug on the projectile side could not create the collision
    const friendlyProjMask = GROUP.WORLD | GROUP.ENEMY;
    const hostileProjMask = GROUP.WORLD | GROUP.PLAYER;
    expect(friendlyProjMask & GROUP.NPC).toBe(0);
    expect(hostileProjMask & GROUP.NPC).toBe(0);
    npc.dispose();
    engine.dispose();
  });
});

describe('portal registry integration', () => {
  it('drives through engine.portalEntities like PortalTransition does', () => {
    const engine = makeEngine();
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: SPECS });
    engine.portalEntities.register(m);
    expect(engine.portalEntities.ids()).toContain('enemies');
    const bodiesBefore = engine.physics.world.bodies.length;
    engine.portalEntities.spawnForMap(60606);
    expect(m.enemies.length).toBe(4);
    const first = rosterSig(m);
    engine.portalEntities.despawnAll();
    expect(m.enemies.length).toBe(0);
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    engine.portalEntities.spawnForMap(60606);
    expect(rosterSig(m)).toEqual(first); // revisit regenerates identically
    engine.portalEntities.despawnAll();
    // re-registration (blueprint rebuild) replaces the stale entry, never duplicates
    engine.portalEntities.register(m);
    expect(engine.portalEntities.ids().filter((id) => id === 'enemies').length).toBe(1);
    engine.dispose();
  });
});
