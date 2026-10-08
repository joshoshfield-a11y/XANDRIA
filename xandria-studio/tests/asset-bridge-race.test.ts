/**
 * R2-N3 regression tests: the AssetBridge restart/dispose race.
 *
 * Repro (from BUGS-2026-10-07): restart mid-.glb-pack-fetch → run 1's late
 * load() injects duplicate props into run 2 (roots: 8 instead of 4). The same
 * mechanism repopulates roots after Engine.dispose(). The fix is a generation
 * token: load() captures ++generation at entry and bails after the await when
 * the generation moved on; dispose() increments it first.
 *
 * GLTFLoader is mocked with controllable deferred fetches; the model graph is
 * a real THREE.Group so clone/traverse/Box3 run for real.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// Controllable in-flight fetches: url -> resolver.
const { pendingFetches } = vi.hoisted(() => {
  const pendingFetches = new Map<string, (gltf: any) => void>();
  return { pendingFetches };
});

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    loadAsync(url: string) {
      return new Promise((resolve) => { pendingFetches.set(url, resolve as any); });
    }
  },
}));

import * as THREE from 'three';
import { AssetBridge } from '../src/engine/gfx/AssetBridge';
import type { GameSpec } from '@spec';

afterEach(() => { pendingFetches.clear(); });

const PACK_URL = 'https://example.com/pack.glb';
// terrain.size = 200 -> instances per pack = min(24, max(3, round(200/100*2))) = 4
const PER_PACK = 4;

function makeSpec(): GameSpec {
  return {
    meta: { seed: 1234 },
    world: { terrain: { size: 200 } },
    custom: { assets: { enabled: true, packs: { hero: PACK_URL } } },
  } as unknown as GameSpec;
}

function makeBridge() {
  const scene = new THREE.Scene();
  const bridge = new AssetBridge(makeSpec(), scene, undefined);
  const gltfFor = (url: string) => {
    const resolve = pendingFetches.get(url);
    expect(resolve, `expected an in-flight fetch for ${url}`).toBeDefined();
    resolve!({ scene: new THREE.Group() });
  };
  return { bridge, scene, gltfFor };
}

const rootsOf = (bridge: AssetBridge) => (bridge as unknown as { roots: THREE.Group[] }).roots;

describe('R2-N3 asset-bridge generation race', () => {
  it('a load() whose fetch resolves after dispose() never touches scene/roots', async () => {
    const { bridge, scene, gltfFor } = makeBridge();
    const p = bridge.load();          // run 1's fetch hangs
    bridge.dispose();                 // Engine.dispose() / restart teardown mid-fetch
    gltfFor(PACK_URL);                // run 1's fetch finally resolves
    const result = await p;
    expect(result.loaded).toEqual([]);   // stale load claims nothing
    expect(rootsOf(bridge).length).toBe(0);
    expect(scene.children.length).toBe(0);
  });

  it('restart sequence: stale run-1 load bails, run-2 load places exactly one pack', async () => {
    const { bridge, scene, gltfFor } = makeBridge();
    const p1 = bridge.load();         // run 1's fetch hangs
    bridge.dispose();                 // blueprint teardown at the start of run 2 (M7)
    gltfFor(PACK_URL);                // run 1's fetch completes late -> must be dropped
    await p1;
    const p2 = bridge.load();         // run 2's load (resetRun re-triggers it)
    gltfFor(PACK_URL);
    const result = await p2;
    expect(result.loaded).toEqual(['hero']);
    expect(rootsOf(bridge).length).toBe(PER_PACK);   // not 2*PER_PACK
    expect(scene.children.length).toBe(PER_PACK);
  });

  it('the normal path is unaffected: load places one pack and reports it', async () => {
    const { bridge, scene, gltfFor } = makeBridge();
    const p = bridge.load();
    gltfFor(PACK_URL);
    const result = await p;
    expect(result.loaded).toEqual(['hero']);
    expect(result.failed).toEqual([]);
    expect(rootsOf(bridge).length).toBe(PER_PACK);
    expect(scene.children.length).toBe(PER_PACK);
    bridge.dispose();
    expect(rootsOf(bridge).length).toBe(0);
    expect(scene.children.length).toBe(0);
  });

  it('a timed-out pack still falls back safely (no scene mutation, no roots)', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, scene } = makeBridge();
      const p = bridge.load();        // fetch never resolves
      await vi.advanceTimersByTimeAsync(16000); // past the 15s withTimeout
      const result = await p;
      expect(result.loaded).toEqual([]);
      expect(result.failed).toEqual(['hero']);
      expect(rootsOf(bridge).length).toBe(0);
      expect(scene.children.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
