/**
 * Enemies wave, workstream C — instancing + flash + tuning.
 * - geometry sharing: same-set walkers share geometry objects; materials
 *   stay per-instance (flash safety on the direct-render path)
 * - registerEnemy buckets (geometry, role, shadow) well below mesh count
 *   for a mixed roster (walker/brute/drone/turret); turrets register too
 * - submit() matrices match the posed rig; tints match palette colors
 * - damage-flash: canonical shared materials are NEVER mutated; the hit
 *   pulse rides per-instance instanceColor and only the flashed enemy
 *   pulses; the direct-render path keeps its per-instance rig.flash()
 * - manager integration: spawnForMap/update/despawnAll drive the
 *   instancer; corpse sweep unregisters; portal round-trip re-registers
 *   cleanly with identical buckets
 * - resolveEnemyDensity: defaults, clamping, tier scaling
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
import { defaultSpec, type GameSpec, type EnemySpec } from '../src/spec/schema';
import { Enemy, EnemyManager } from '../src/engine/game/EnemyAI';
import { NpcInstancer } from '../src/engine/game/npcInstancing';
import { Npc } from '../src/engine/game/Npc';
import { resolveEnemyDensity } from '../src/engine/game/enemyTuning';
import { Rng } from '../src/engine/core/Rng';

/**
 * Enemies wave C: the blueprint drives the shared instancer frame, so
 * tests ticking a manager directly must open/close the frame themselves.
 */
function tickEnemies(m: EnemyManager, engine: Engine, dt = 0.016, t = 1.0): void {
  const inst = NpcInstancer.for(engine);
  inst.beginFrame(dt);
  m.update(dt, new THREE.Vector3(0, 0, 0), t);
  inst.endFrame();
}

/**
 * Tick both managers inside ONE shared frame (the real blueprint pattern).
 */
function tickBoth(foes: EnemyManager, npcs: { update(dt: number): void }, engine: Engine, dt = 0.016, t = 1.0): void {
  const inst = NpcInstancer.for(engine);
  inst.beginFrame(dt);
  foes.update(dt, new THREE.Vector3(0, 0, 0), t);
  npcs.update(dt);
  inst.endFrame();
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

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

const WALKER: EnemySpec = { kind: 'walker', count: 1, health: 30, speed: 4, damage: 10, weapon: 'melee' };
const BRUTE: EnemySpec = { kind: 'brute', count: 1, health: 120, speed: 2.5, damage: 25, weapon: 'melee' };
const DRONE: EnemySpec = { kind: 'drone', count: 1, health: 22, speed: 6, damage: 8, weapon: 'blaster' };
const TURRET: EnemySpec = { kind: 'turret', count: 1, health: 45, speed: 0, damage: 7, weapon: 'blaster' };

function makeEnemy(engine: Engine, spec: EnemySpec = WALKER, seed = 4242): Enemy {
  return new Enemy(engine, spec, new THREE.Vector3(0, 1, 0), null, {}, seed);
}

function meshesOf(e: Enemy): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  e.renderRoot!.traverse((o: any) => { if (o.isMesh) out.push(o); });
  return out;
}

function ownedMatsOf(e: Enemy): THREE.Material[] {
  const out: THREE.Material[] = [];
  for (const m of meshesOf(e)) {
    const list = Array.isArray(m.material) ? m.material : [m.material];
    for (const mm of list) if ((mm as THREE.Material).userData.owned) out.push(mm as THREE.Material);
  }
  return out;
}

function canonicalBuckets(engine: Engine): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  engine.scene.traverse((o: any) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && (im.material as any)?.userData?.npcInstancingCanonical) out.push(im);
  });
  return out;
}

function directMeshes(engine: Engine): number {
  let n = 0;
  engine.scene.traverse((o: any) => {
    if (o.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh && o.visible) n++;
  });
  return n;
}

function snapshotCanonical(engine: Engine): Map<string, string> {
  const out = new Map<string, string>();
  for (const im of canonicalBuckets(engine)) {
    const mat = im.material as THREE.MeshStandardMaterial;
    out.set(mat.uuid, `${mat.color.getHexString()}|${mat.emissive.getHexString()}|${mat.emissiveIntensity}|${mat.opacity}`);
  }
  return out;
}

describe('enemy geometry sharing (geometries only, never materials)', () => {
  it('same-kind same-seed walkers share geometry objects', () => {
    const engine = makeEngine();
    const a = makeEnemy(engine, WALKER, 777);
    const b = makeEnemy(engine, WALKER, 777);
    const ga = new Set(meshesOf(a).map((m) => m.geometry));
    const gb = new Set(meshesOf(b).map((m) => m.geometry));
    // every geometry of b is the identical object as a's (content-hash dedup)
    for (const g of gb) expect(ga.has(g)).toBe(true);
    expect(ga.size).toBeGreaterThan(0);
    expect(ga.size).toBeLessThan(meshesOf(a).length); // symmetric parts dedup within one rig too
    a.dispose(); b.dispose();
  });

  it('materials stay per-instance: no owned material object is shared', () => {
    const engine = makeEngine();
    const a = makeEnemy(engine, WALKER, 777);
    const b = makeEnemy(engine, WALKER, 777);
    const ma = new Set(ownedMatsOf(a));
    for (const m of ownedMatsOf(b)) expect(ma.has(m)).toBe(false);
    expect(ma.size).toBeGreaterThan(0);
    a.dispose(); b.dispose();
  });

  it('geometry sharing is content-based across armor sets (dedup, not collapse)', () => {
    const engine = makeEngine();
    // find a seed that picks the marauder walker set (pauldron spikes r=0.075)
    const pick = (s: number) => new Rng((s ^ 0xe9b1) >>> 0).pick(['marauder', 'bloodreaver'] as const);
    let sA = 1; while (pick(sA) !== 'marauder') sA++;
    const a = makeEnemy(engine, WALKER, sA);
    const b = makeEnemy(engine, BRUTE, 4242); // brutehide: big pauldron spikes + back-spikes
    const cones = (e: Enemy) => meshesOf(e)
      .map((m) => m.geometry as THREE.ConeGeometry)
      .filter((g) => g.type === 'ConeGeometry');
    const byRadius = (e: Enemy, r: number) => cones(e)
      .filter((g) => Math.abs((g.parameters as any).radius - r) < 1e-9);
    // identical spike dims (pauldron spikes r=0.075 on both sets) SHARE —
    // content-hash dedup across sets is the instancing win, by design
    const pa = new Set(byRadius(a, 0.075));
    expect(pa.size).toBeGreaterThan(0);
    for (const g of byRadius(b, 0.075)) expect(pa.has(g)).toBe(true);
    // brutehide's back-spikes (r=0.095) are distinct geometry and must NOT
    // be collapsed into another set's cones — sharing is by content
    const spine = byRadius(b, 0.095);
    expect(spine.length).toBeGreaterThan(0);
    const allA = new Set(cones(a));
    for (const g of spine) expect(allA.has(g)).toBe(false);
    a.dispose(); b.dispose();
  });
});

describe('enemy instancing (registerEnemy / submit / flash)', () => {
  const SPECS: EnemySpec[] = [
    { ...WALKER, count: 2 }, { ...BRUTE, count: 1 }, { ...DRONE, count: 1 }, { ...TURRET, count: 1 },
  ];
  const POIS = [{ x: 100, z: 100, r: 8 }];

  it('mixed roster buckets well below mesh count; turret registers; sources hidden', () => {
    const engine = makeEngine();
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: SPECS });
    m.spawnForMap(20261012);
    expect(m.enemies).toHaveLength(5);
    let meshes = 0;
    for (const e of m.enemies) meshes += meshesOf(e).length;
    const inst = NpcInstancer.for(engine);
    expect(inst.registeredNpcCount).toBe(5);
    expect(inst.bucketCount).toBeGreaterThan(0);
    expect(inst.bucketCount).toBeLessThan(meshes);
    // turret registered through its assembly group
    const turret = m.enemies.find((e) => e.spec.kind === 'turret')!;
    expect(inst.isRegistered(turret)).toBe(true);
    // every source mesh hidden
    for (const e of m.enemies) {
      for (const mesh of meshesOf(e)) expect(mesh.visible).toBe(false);
    }
    m.despawnAll();
  });

  it('enemy buckets reuse NPC canonical materials where roles match', () => {
    const engine = makeEngine();
    const npc = new Npc(engine, { role: 'villager', armorSet: 'nomad' } as any, new THREE.Vector3(0, 0, 0), 4242);
    const inst = NpcInstancer.for(engine);
    inst.register(npc);
    const npcMats = new Set(canonicalBuckets(engine).map((im) => im.material));
    const e = makeEnemy(engine, WALKER, 777);
    inst.registerEnemy(e);
    const shared = canonicalBuckets(engine).filter((im) => npcMats.has(im.material)).length;
    // B's role census: enemy non-emissive materials reuse NPC role combos
    expect(shared).toBeGreaterThan(0);
    npc.dispose(); e.dispose(); inst.reset();
  });

  it('submit matrices match the posed rig; instance tints carry palette colors', () => {
    const engine = makeEngine();
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: [{ ...WALKER, count: 1 }] });
    m.spawnForMap(20261012);
    const e = m.enemies[0];
    tickEnemies(m, engine, 0.016, 1.0);
    // rebuild expected matrices per geometry from the hidden rig.
    // NOTE: the instance buffer is float32 (setMatrixAt rounds), so compare
    // element-wise with |Δ|≤1e-4. Float32 quantization at these coordinates
    // is ≤ ~6e-6 (20x below the tolerance), while a genuinely stale matrix
    // (e.g. submit before the pose update) would differ by a whole frame of
    // motion (~6e-2, 600x above) — the assertion still catches real staleness.
    // String-rounding at toFixed(4/5) is NOT used: values sitting exactly on
    // a rounding boundary flip between float64 and float32 (observed).
    const closeEnough = (a: number[], b: number[]) =>
      a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-4);
    const multisetMatch = (exp: number[][], got: number[][]): boolean => {
      if (exp.length !== got.length) return false;
      const used = new Array(got.length).fill(false);
      outer: for (const e of exp) {
        for (let j = 0; j < got.length; j++) {
          if (!used[j] && closeEnough(e, got[j])) { used[j] = true; continue outer; }
        }
        return false;
      }
      return true;
    };
    const expected = new Map<THREE.BufferGeometry, number[][]>();
    e.renderRoot!.updateMatrixWorld(true);
    e.renderRoot!.traverse((o: any) => {
      if (!o.isMesh) return;
      const arr = expected.get(o.geometry) ?? [];
      arr.push(Array.from(o.matrixWorld.elements));
      expected.set(o.geometry, arr);
    });
    const got = new Map<THREE.BufferGeometry, number[][]>();
    const mm = new THREE.Matrix4();
    for (const im of canonicalBuckets(engine)) {
      const arr = got.get(im.geometry) ?? [];
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, mm);
        arr.push(Array.from(mm.elements));
      }
      got.set(im.geometry, arr);
    }
    for (const [geo, arr] of expected) {
      expect(multisetMatch(arr, got.get(geo) ?? [])).toBe(true);
    }
    // non-emissive buckets carry real (non-white) tints
    let tinted = 0;
    const c = new THREE.Color();
    for (const im of canonicalBuckets(engine)) {
      const mat = im.material as THREE.MeshStandardMaterial;
      const isEm = mat.emissiveIntensity > 0 && !mat.emissive.equals(new THREE.Color(0x000000));
      if (!isEm && im.instanceColor) {
        im.getColorAt(0, c);
        if (!c.equals(new THREE.Color(0xffffff))) tinted++;
      } else if (isEm) {
        expect(im.instanceColor).toBe(null); // emissive never tinted
      }
    }
    expect(tinted).toBeGreaterThan(0);
    m.despawnAll();
  });

  it('damage-flash never mutates canonical materials; only the flashed enemy pulses', () => {
    const engine = makeEngine();
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: [{ ...WALKER, count: 2 }] });
    m.spawnForMap(20261012);
    const [victim] = m.enemies;
    const inst = NpcInstancer.for(engine);
    tickEnemies(m, engine, 0.016, 1.0);
    const before = snapshotCanonical(engine);
    // instance colors before the hit
    const tintBefore = new Map<string, string>();
    const cc = new THREE.Color();
    for (const im of canonicalBuckets(engine)) {
      if (!im.instanceColor) continue;
      const arr: string[] = [];
      for (let i = 0; i < im.count; i++) { im.getColorAt(i, cc); arr.push(cc.getHexString()); }
      tintBefore.set(im.uuid, arr.join(','));
    }
    victim.damage(1, new THREE.Vector3(5, 0, 0));
    // let the 0.25s pulse decay into an "on" blink phase, then submit
    tickEnemies(m, engine, 0.016, 1.016);
    tickEnemies(m, engine, 0.016, 1.032);
    const after = snapshotCanonical(engine);
    expect(after).toEqual(before); // no canonical material mutated, ever
    // the victim's instances pulsed toward white-hot on at least one bucket;
    // the control's tints are untouched
    let pulsedBuckets = 0;
    for (const im of canonicalBuckets(engine)) {
      if (!im.instanceColor) continue;
      const arr: string[] = [];
      for (let i = 0; i < im.count; i++) { im.getColorAt(i, cc); arr.push(cc.getHexString()); }
      if (arr.join(',') !== tintBefore.get(im.uuid)) pulsedBuckets++;
    }
    expect(pulsedBuckets).toBeGreaterThan(0);
    // the pulse decays back to the exact original tints (no permanent
    // tint corruption on any instance)
    for (let i = 0; i < 25; i++) tickEnemies(m, engine, 0.016, 2 + i * 0.016);
    const restored = new Map<string, string>();
    for (const im of canonicalBuckets(engine)) {
      if (!im.instanceColor) continue;
      const arr: string[] = [];
      for (let i = 0; i < im.count; i++) { im.getColorAt(i, cc); arr.push(cc.getHexString()); }
      restored.set(im.uuid, arr.join(','));
    }
    expect(restored).toEqual(tintBefore);
    expect(snapshotCanonical(engine)).toEqual(before);
    m.despawnAll();
  });

  it('direct-render path: rig.flash() stays per-instance (no cross-flash)', () => {
    const engine = makeEngine();
    const a = makeEnemy(engine, WALKER, 777); // never registered — direct path
    const b = makeEnemy(engine, WALKER, 777);
    const emis = (e: Enemy) => ownedMatsOf(e).map(
      (m) => (m as THREE.MeshStandardMaterial).emissive.getHexString());
    const beforeB = emis(b);
    a.damage(1, new THREE.Vector3(5, 0, 0));
    // rig.flash() blinks at 20Hz for 0.25s: tick 1 (flashTime 0.234 →
    // floor(4.68)=4, even) is the "on" phase; tick 4 (0.186 → floor(3.72)=3,
    // odd) is "off". Assert on the right phase, not an arbitrary tick count.
    a.rig!.animate(1, 0, {});
    const onA = emis(a);
    expect(onA.some((h) => h === 'ff2222')).toBe(true); // the hit reads
    expect(emis(b)).toEqual(beforeB); // the other enemy is untouched
    for (let i = 0; i < 3; i++) a.rig!.animate(1 + i * 0.05, 0, {});
    expect(emis(a).some((h) => h === 'ff2222')).toBe(false); // blink cycles off, doesn't stick
    expect(emis(b)).toEqual(beforeB); // still untouched
    a.dispose(); b.dispose();
  });

  it('corpse sweep unregisters the enemy; buckets drop to the live set', () => {
    const engine = makeEngine();
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: [{ ...WALKER, count: 2 }] });
    m.spawnForMap(20261012);
    const inst = NpcInstancer.for(engine);
    tickEnemies(m, engine, 0.016, 1.0);
    const bucketsLive = inst.bucketCount;
    expect(bucketsLive).toBeGreaterThan(0);
    const dead = m.enemies[0];
    dead.damage(1000); // lethal — corpse tumble, then sweep
    expect(dead.alive).toBe(false);
    // run past the 1.5s corpse tumble (test engine: fixed 60Hz ticks)
    for (let i = 0; i < 120; i++) tickEnemies(m, engine, 1 / 60, 2 + i / 60);
    expect(m.enemies.includes(dead)).toBe(false);
    expect(inst.isRegistered(dead)).toBe(false);
    expect(inst.bucketCount).toBeLessThanOrEqual(bucketsLive);
    m.despawnAll();
    expect(inst.bucketCount).toBe(0);
  });

  it('reset restores direct rendering; re-register works (portal round-trip)', () => {
    const engine = makeEngine();
    const m = new EnemyManager(engine, null, {}, { pois: POIS, specs: SPECS });
    const baseDirect = directMeshes(engine);
    m.spawnForMap(20261012);
    tickEnemies(m, engine, 0.016, 1.0);
    const buckets1 = NpcInstancer.for(engine).bucketCount;
    expect(directMeshes(engine)).toBe(baseDirect); // roster draws nothing direct
    const sig = m.enemies.map((e) => e.spec.kind + e.home.x.toFixed(3)).join(';');
    m.despawnAll();
    expect(NpcInstancer.for(engine).bucketCount).toBe(0);
    expect(directMeshes(engine)).toBe(baseDirect);
    m.spawnForMap(20261012);
    tickEnemies(m, engine, 0.016, 1.0);
    expect(NpcInstancer.for(engine).bucketCount).toBe(buckets1);
    expect(m.enemies.map((e) => e.spec.kind + e.home.x.toFixed(3)).join(';')).toBe(sig);
    m.despawnAll();
  });
});

describe('resolveEnemyDensity', () => {
  const spec = (enemies?: any): GameSpec => {
    const s = defaultSpec(7) as GameSpec;
    if (enemies !== undefined) s.custom = { ...(s.custom ?? {}), enemies };
    return s;
  };
  it('defaults: 1 on desktop, 0.5 on s25', () => {
    expect(resolveEnemyDensity(spec(), 'desktop')).toBe(1);
    expect(resolveEnemyDensity(spec(), 's25')).toBe(0.5);
  });
  it('density scales both tiers', () => {
    expect(resolveEnemyDensity(spec({ density: 0.5 }), 'desktop')).toBe(0.5);
    expect(resolveEnemyDensity(spec({ density: 0.5 }), 's25')).toBe(0.25);
  });
  it('density 0 kills the roster', () => {
    expect(resolveEnemyDensity(spec({ density: 0 }), 'desktop')).toBe(0);
    expect(resolveEnemyDensity(spec({ density: 0 }), 's25')).toBe(0);
  });
  it('clamps out-of-range values', () => {
    expect(resolveEnemyDensity(spec({ density: 2 }), 'desktop')).toBe(1);
    expect(resolveEnemyDensity(spec({ density: -1 }), 'desktop')).toBe(0);
    // matches npcTuning.ts: lowTierScale clamps to [0,1], so 3 → 1 (not
    // "reset to default 0.5") — density 1 × 1 on s25
    expect(resolveEnemyDensity(spec({ lowTierScale: 3 }), 's25')).toBe(1);
  });
  it('lowTierScale only affects reduced tiers', () => {
    expect(resolveEnemyDensity(spec({ lowTierScale: 0.25 }), 'desktop')).toBe(1);
    expect(resolveEnemyDensity(spec({ lowTierScale: 0.25 }), 's25')).toBe(0.25);
  });
  it('spawnForMap applies the density multiplier per spec count', () => {
    const engine = makeEngine();
    const m = new EnemyManager(engine, null, {},
      { pois: [{ x: 0, z: 0, r: 0 }], specs: [{ ...WALKER, count: 4 }], density: 0.5 });
    m.spawnForMap(20261012);
    expect(m.enemies).toHaveLength(2);
    m.despawnAll();
  });
});

describe('enemy dispose lifecycle (shared geometries)', () => {
  it('dispose releases adopted geometries; a second enemy still renders', () => {
    const engine = makeEngine();
    const a = makeEnemy(engine, WALKER, 777);
    const b = makeEnemy(engine, WALKER, 777);
    const geoB = new Set(meshesOf(b).map((m) => m.geometry));
    a.dispose();
    // b's geometries survived a's dispose (ref-counted, not killed)
    for (const m of meshesOf(b)) expect(geoB.has(m.geometry)).toBe(true);
    b.dispose();
  });

  it('dispose is idempotent', () => {
    const engine = makeEngine();
    const a = makeEnemy(engine, WALKER, 777);
    a.dispose();
    expect(() => a.dispose()).not.toThrow();
  });
});

describe('shared instancer frame: npc + enemy managers on one engine', () => {
  it('both managers submit into the same frame; neither wipes the other', async () => {
    const { NpcManager } = await import('../src/engine/game/NpcManager');
    const engine = makeEngine();
    const npcs = new NpcManager(engine, { count: 2, pois: [{ x: 0, z: 0, r: 0 }] });
    const foes = new EnemyManager(engine, null, {}, { pois: [{ x: 50, z: 50, r: 0 }], specs: [{ ...WALKER, count: 2 }] });
    const inst = NpcInstancer.for(engine);
    npcs.spawnForMap(20261012);
    expect(inst.registeredNpcCount).toBe(2);
    // enemies spawn AFTER npcs: spawnForMap self-cleans via despawnAll,
    // which must NOT wipe the villagers' registrations (shared singleton).
    foes.spawnForMap(20261013);
    expect(inst.registeredNpcCount).toBe(4);
    // and the reverse order is safe too
    npcs.spawnForMap(20261012);
    expect(inst.registeredNpcCount).toBe(4);
    foes.spawnForMap(20261013);
    expect(inst.registeredNpcCount).toBe(4);
    // blueprint order in ONE shared frame: enemies submit, then NPCs
    tickBoth(foes, npcs, engine, 0.016, 1.0);
    const st = inst.stats();
    // every registered entity contributed instances this frame
    expect(st.instances).toBeGreaterThan(0);
    expect(inst.registeredNpcCount).toBe(4);
    // bucket counts published == instances submitted (nothing zeroed away)
    let published = 0;
    for (const im of canonicalBuckets(engine)) published += im.count;
    expect(published).toBe(st.instances);
    // a second frame works the same (frame flag closes on endFrame)
    tickBoth(foes, npcs, engine, 0.016, 1.016);
    const st2 = inst.stats();
    let published2 = 0;
    for (const im of canonicalBuckets(engine)) published2 += im.count;
    expect(published2).toBe(st2.instances);
    expect(st2.instances).toBe(st.instances);
    npcs.despawnAll();
    foes.despawnAll();
    expect(inst.bucketCount).toBe(0);
  });
});
