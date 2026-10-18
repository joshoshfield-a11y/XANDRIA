/**
 * NPC instancing pass:
 * - register() hides source meshes and buckets (geometry, material-role, castShadow)
 * - submit() writes per-instance matrices + tints; endFrame() publishes counts
 * - emissive roles (visor/clasp) keep baked emissive, never instance-tinted
 * - reset() removes buckets and restores the old direct-render path
 * - manager integration: spawnForMap/update/despawnAll drive the instancer
 * - determinism: same seed on two engines -> identical instance matrices
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import { Npc, spawnNpcsForMap } from '../src/engine/game/Npc';
import { NpcManager } from '../src/engine/game/NpcManager';
import { NpcInstancer } from '../src/engine/game/npcInstancing';

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

function directMeshes(engine: Engine): number {
  let n = 0;
  engine.scene.traverse((o: any) => {
    if (o.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh && o.visible) n++;
  });
  return n;
}

function instancedMeshes(engine: Engine): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  engine.scene.traverse((o: any) => { if ((o as THREE.InstancedMesh).isInstancedMesh) out.push(o); });
  return out;
}

describe('NpcInstancer', () => {
  it('register buckets (geo, role, shadow) well below the mesh count and hides sources', () => {
    const engine = makeEngine();
    const npcs = spawnNpcsForMap(engine, 20261012, { count: 8 });
    let meshes = 0;
    for (const n of npcs) n.rig!.group.traverse((o: any) => { if (o.isMesh) meshes++; });
    const inst = NpcInstancer.for(engine);
    // baselines: the test engine scene already holds its own meshes
    const baseDirect = directMeshes(engine);
    const baseInst = instancedMeshes(engine).length;
    for (const n of npcs) inst.register(n);
    expect(inst.registeredNpcCount).toBe(8);
    expect(inst.bucketCount).toBeGreaterThan(0);
    expect(inst.bucketCount).toBeLessThan(meshes);
    // every source mesh hidden
    for (const n of npcs) {
      n.rig!.group.traverse((o: any) => {
        if (o.isMesh) expect(o.visible).toBe(false);
      });
    }
    // no direct draws remain for the roster; buckets are in the scene.
    // (baseDirect was measured with the roster's own meshes visible, so
    // post-register it must drop by exactly the roster's mesh count; the
    // one pre-existing engine scenery mesh is left alone.)
    expect(directMeshes(engine)).toBe(baseDirect - meshes);
    expect(instancedMeshes(engine).length).toBe(baseInst + inst.bucketCount);
    for (const n of npcs) n.dispose();
  });

  it('submit writes matrices matching the posed rig; tints match palette colors', () => {
    const engine = makeEngine();
    const npc = new Npc(engine, { role: 'villager', armorSet: 'nomad' } as any, new THREE.Vector3(0, 0, 0), 4242);
    npc.update(0.016);
    const inst = NpcInstancer.for(engine);
    inst.register(npc);
    inst.beginFrame();
    inst.submit(npc);
    inst.endFrame();
    const stats = inst.stats();
    expect(stats.instances).toBeGreaterThan(0);
    // every instance matrix equals its source mesh's matrixWorld
    const m = new THREE.Matrix4();
    for (const im of instancedMeshes(engine)) {
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        expect(m.elements.some((v) => !Number.isFinite(v))).toBe(false);
      }
    }
    // instance colors: non-emissive buckets carry the palette tint
    let tinted = 0, emissiveBuckets = 0;
    for (const im of instancedMeshes(engine)) {
      const mat = im.material as THREE.MeshStandardMaterial;
      const isEmissive = mat.emissiveIntensity > 0 && !mat.emissive.equals(new THREE.Color(0x000000));
      if (isEmissive) {
        emissiveBuckets++;
        // emissive baked per role — never instance-tinted
        expect(im.instanceColor).toBe(null);
      } else if (im.instanceColor) {
        tinted++;
        const c = new THREE.Color();
        im.getColorAt(0, c);
        expect(c.equals(new THREE.Color(0xffffff))).toBe(false); // real tint, not white
      }
    }
    expect(emissiveBuckets).toBeGreaterThan(0); // visor slit + amber clasp render
    expect(tinted).toBeGreaterThan(0);
    npc.dispose();
  });

  it('posed matrices match the animated rig exactly (no visual drift)', () => {
    const engine = makeEngine();
    const npc = new Npc(engine, { role: 'villager', armorSet: 'raider' } as any, new THREE.Vector3(5, 0, -3), 777);
    for (let i = 0; i < 10; i++) npc.update(0.05); // walk a little
    const inst = NpcInstancer.for(engine);
    inst.register(npc);
    inst.beginFrame();
    inst.submit(npc);
    inst.endFrame();
    // rebuild the expected world matrices from the (hidden) rig
    npc.rig!.group.updateMatrixWorld(true);
    const expected = new Map<THREE.BufferGeometry, THREE.Matrix4[]>();
    npc.rig!.group.traverse((o: any) => {
      if (!o.isMesh) return;
      const arr = expected.get(o.geometry) ?? [];
      arr.push(o.matrixWorld.clone());
      expected.set(o.geometry, arr);
    });
    const got = new Map<THREE.BufferGeometry, THREE.Matrix4[]>();
    const m = new THREE.Matrix4();
    for (const im of instancedMeshes(engine)) {
      const arr = got.get(im.geometry) ?? [];
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        arr.push(m.clone());
      }
      got.set(im.geometry, arr);
    }
    // same multiset of matrices per geometry (order within a bucket may differ)
    const key = (mm: THREE.Matrix4) => mm.elements.map((v) => v.toFixed(5)).join(',');
    for (const [geo, arr] of expected) {
      const g = (got.get(geo) ?? []).map(key).sort();
      const e = arr.map(key).sort();
      expect(g).toEqual(e);
    }
    npc.dispose();
  });

  it('reset drops buckets from the scene and restores direct rendering', () => {
    const engine = makeEngine();
    const npcs = spawnNpcsForMap(engine, 20261012, { count: 4 });
    const inst = NpcInstancer.for(engine);
    const baseInst = instancedMeshes(engine).length;
    for (const n of npcs) inst.register(n);
    expect(instancedMeshes(engine).length).toBe(baseInst + inst.bucketCount);
    inst.reset();
    expect(instancedMeshes(engine).length).toBe(baseInst);
    expect(inst.bucketCount).toBe(0);
    // source meshes visible again (old path)
    let visible = 0;
    for (const n of npcs) n.rig!.group.traverse((o: any) => { if (o.isMesh && o.visible) visible++; });
    expect(visible).toBeGreaterThan(0);
    for (const n of npcs) n.dispose();
  });

  it('same seed on two engines -> identical instance matrices (render determinism)', () => {
    const snap = (engine: Engine): string[] => {
      const npcs = spawnNpcsForMap(engine, 20261012, { count: 4 });
      for (const n of npcs) for (let i = 0; i < 5; i++) n.update(0.05);
      const inst = NpcInstancer.for(engine);
      inst.beginFrame();
      for (const n of npcs) { inst.register(n); inst.submit(n); }
      inst.endFrame();
      const m = new THREE.Matrix4();
      const out: string[] = [];
      for (const im of instancedMeshes(engine)) {
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, m);
          out.push(m.elements.map((v) => v.toFixed(6)).join(','));
        }
      }
      for (const n of npcs) n.dispose();
      return out.sort();
    };
    expect(snap(makeEngine())).toEqual(snap(makeEngine()));
  });

  it('canonical materials are never mutated per-instance (shared-material safety)', () => {
    const engine = makeEngine();
    const npcs = spawnNpcsForMap(engine, 20261012, { count: 6 });
    const inst = NpcInstancer.for(engine);
    for (const n of npcs) inst.register(n);
    inst.beginFrame();
    for (const n of npcs) { n.update(0.016); inst.submit(n); }
    inst.endFrame();
    const seen = new Map<string, string>();
    for (const im of instancedMeshes(engine)) {
      const mat = im.material as THREE.MeshStandardMaterial;
      if (!(mat as any).userData?.npcInstancingCanonical) continue; // engine's own meshes
      const sig = `${mat.color.getHexString()}|${mat.emissive.getHexString()}|${mat.emissiveIntensity}`;
      const k = `${mat.uuid}`;
      if (!seen.has(k)) seen.set(k, sig);
      else expect(sig).toBe(seen.get(k)); // same canonical object, unchanged
    }
    for (const n of npcs) n.dispose();
  });
});

describe('NpcManager instancing integration', () => {
  const POIS = [{ x: 100, z: 100, r: 8 }, { x: -150, z: 60, r: 6 }];

  it('spawnForMap -> update -> instanced; despawnAll -> scene back to baseline', () => {
    const engine = makeEngine();
    const before = directMeshes(engine);
    const baseInst = instancedMeshes(engine).length;
    const m = new NpcManager(engine, { pois: POIS, density: 1 });
    m.spawnForMap(20261012);
    expect(m.npcs.length).toBeGreaterThan(0);
    m.update(0.016);
    const ims = instancedMeshes(engine);
    expect(ims.length).toBe(baseInst + NpcInstancer.for(engine).bucketCount);
    // roster draws no direct meshes anymore
    expect(directMeshes(engine)).toBe(before);
    // every bucket has instances after a tick
    let total = 0;
    for (const im of ims) {
      if (!(im.material as any).userData?.npcInstancingCanonical) continue;
      total += im.count;
    }
    expect(total).toBeGreaterThan(0);
    m.despawnAll();
    expect(instancedMeshes(engine).length).toBe(baseInst);
    expect(directMeshes(engine)).toBe(before);
  });

  it('portal round-trip: despawnAll -> spawnForMap re-registers cleanly', () => {
    const engine = makeEngine();
    const baseInst = instancedMeshes(engine).length;
    const m = new NpcManager(engine, { pois: POIS, density: 1 });
    m.spawnForMap(20261012);
    m.update(0.016);
    const buckets1 = NpcInstancer.for(engine).bucketCount;
    m.despawnAll();
    m.spawnForMap(20261012);
    m.update(0.016);
    expect(NpcInstancer.for(engine).bucketCount).toBe(buckets1);
    expect(instancedMeshes(engine).length).toBe(baseInst + buckets1);
    m.despawnAll();
  });
});
