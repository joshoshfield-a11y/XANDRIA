/**
 * Asset registry tests: override application, unknown-id warnings, list(),
 * determinism, legacy-shape tolerance, invalid-value handling.
 * Pure THREE objects — no renderer needed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { AssetRegistry, ASSET_IDS } from '../src/engine/game/Assets';
import type { GameSpec } from '../src/spec/schema';

function specWithAssets(assets: unknown): GameSpec {
  return { custom: { assets } } as unknown as GameSpec;
}

function stdMat(hex: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8 });
}

function box(mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
}

const REQUIRED_IDS = [
  'player.body',
  'enemy.walker', 'enemy.drone', 'enemy.brute',
  'enemy.charger', 'enemy.sniper', 'enemy.splitter', 'enemy.caster',
  'enemy.shielded', 'enemy.skyray', 'enemy.spikeball', 'enemy.mini',
  'pickup.coin', 'pickup.health', 'pickup.shield', 'pickup.rapid',
  'pickup.score', 'pickup.magnet',
  'world.sky', 'world.ground', 'world.fog',
  'boss.body',
];

describe('ASSET_IDS catalog', () => {
  it('contains every required asset id', () => {
    for (const id of REQUIRED_IDS) expect(ASSET_IDS).toContain(id);
  });
  it('has no duplicates', () => {
    expect(new Set(ASSET_IDS).size).toBe(ASSET_IDS.length);
  });
});

describe('AssetRegistry.applyOverrides', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('applies color/emissive/scale/visible to registered materials', () => {
    const reg = new AssetRegistry();
    const mat = stdMat('#112233');
    reg.register('pickup.coin', { kind: 'pickup', materials: [mat] });
    reg.applyOverrides(specWithAssets({
      'pickup.coin': { color: '#ff0000', emissive: '#00ff00', emissiveIntensity: 3 },
    }));
    expect('#' + mat.color.getHexString()).toBe('#ff0000');
    expect('#' + (mat.emissive as THREE.Color).getHexString()).toBe('#00ff00');
    expect(mat.emissiveIntensity).toBe(3);
  });

  it('swaps shared materials on roots instead of mutating them (no cross-talk)', () => {
    const reg = new AssetRegistry();
    const shared = stdMat('#445566');
    const mesh = box(shared);
    const other = box(shared); // another asset using the same shared material
    reg.register('pickup.coin', { kind: 'pickup', roots: [mesh] });
    reg.applyOverrides(specWithAssets({ 'pickup.coin': { color: '#abcdef' } }));
    // registered mesh got a per-entry clone carrying the override…
    expect(mesh.material).not.toBe(shared);
    expect('#' + ((mesh.material as THREE.MeshStandardMaterial).color.getHexString())).toBe('#abcdef');
    // …while the shared original (and its other user) is untouched
    expect('#' + shared.color.getHexString()).toBe('#445566');
    expect(other.material).toBe(shared);
  });

  it('applies scale multiplicatively on the base scale and stays idempotent', () => {
    const reg = new AssetRegistry();
    const mesh = box(stdMat('#ffffff'));
    mesh.scale.setScalar(2); // non-unit base scale
    reg.register('world.gate', { kind: 'world', roots: [mesh] });
    const spec = specWithAssets({ 'world.gate': { scale: 3 } });
    reg.applyOverrides(spec);
    expect(mesh.scale.x).toBeCloseTo(6);
    reg.applyOverrides(spec); // second apply must not compound
    expect(mesh.scale.x).toBeCloseTo(6);
  });

  it('applies visible:false to roots', () => {
    const reg = new AssetRegistry();
    const mesh = box(stdMat('#ffffff'));
    reg.register('world.arena', { kind: 'world', roots: [mesh] });
    reg.applyOverrides(specWithAssets({ 'world.arena': { visible: false } }));
    expect(mesh.visible).toBe(false);
  });

  it('applies color to scene fog', () => {
    const reg = new AssetRegistry();
    const fog = new THREE.Fog('#111111');
    reg.register('world.fog', { kind: 'world', fog });
    reg.applyOverrides(specWithAssets({ 'world.fog': { color: '#334455' } }));
    expect('#' + fog.color.getHexString()).toBe('#334455');
  });

  it('warns on unknown asset ids and does not crash', () => {
    const reg = new AssetRegistry();
    expect(() =>
      reg.applyOverrides(specWithAssets({ 'enemey.walker': { color: '#ff0000' } })),
    ).not.toThrow();
    expect(reg.getWarnings().some((w) => w.includes('unknown asset id'))).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('silently skips known ids that are not registered in this game', () => {
    const reg = new AssetRegistry();
    expect(() =>
      reg.applyOverrides(specWithAssets({ 'enemy.walker': { color: '#ff0000' } })),
    ).not.toThrow();
    expect(reg.getWarnings()).toEqual([]);
  });

  it('warns and skips invalid values without applying them', () => {
    const reg = new AssetRegistry();
    const mat = stdMat('#112233');
    const mesh = box(stdMat('#ffffff'));
    reg.register('pickup.coin', { kind: 'pickup', materials: [mat], roots: [mesh] });
    reg.applyOverrides(specWithAssets({
      'pickup.coin': { color: 'red', emissive: '#gggggg', emissiveIntensity: NaN, scale: 'big', visible: 1 },
    }));
    expect('#' + mat.color.getHexString()).toBe('#112233'); // unchanged
    expect(mesh.scale.x).toBe(1);
    expect(mesh.visible).toBe(true);
    expect(reg.getWarnings().length).toBeGreaterThanOrEqual(4);
  });

  it('clamps out-of-range scale with a warning', () => {
    const reg = new AssetRegistry();
    const mesh = box(stdMat('#ffffff'));
    reg.register('boss.body', { kind: 'boss', roots: [mesh] });
    reg.applyOverrides(specWithAssets({ 'boss.body': { scale: 100 } }));
    expect(mesh.scale.x).toBeCloseTo(10);
    expect(reg.getWarnings().some((w) => w.includes('clamped'))).toBe(true);
  });

  it('ignores the legacy AssetPacks shape silently', () => {
    const reg = new AssetRegistry();
    expect(() =>
      reg.applyOverrides(specWithAssets({ enabled: true, packs: { hero: 'https://x.test/a.glb' } })),
    ).not.toThrow();
    expect(reg.getWarnings()).toEqual([]);
  });

  it('is a no-op when custom.assets is absent', () => {
    const reg = new AssetRegistry();
    const mat = stdMat('#112233');
    reg.register('pickup.coin', { kind: 'pickup', materials: [mat] });
    reg.applyOverrides({} as GameSpec);
    reg.applyOverrides({ custom: {} } as unknown as GameSpec);
    expect('#' + mat.color.getHexString()).toBe('#112233');
    expect(reg.getWarnings()).toEqual([]);
  });

  it('is deterministic: same spec → same colors, regardless of key order', () => {
    const build = () => {
      const r = new AssetRegistry();
      r.register('pickup.coin', { kind: 'pickup', materials: [stdMat('#111111')] });
      r.register('enemy.walker', { kind: 'enemy', materials: [stdMat('#222222')] });
      return r;
    };
    const a = build();
    const b = build();
    a.applyOverrides(specWithAssets({
      'pickup.coin': { color: '#aabbcc' },
      'enemy.walker': { color: '#ddeeff', emissive: '#112233', emissiveIntensity: 2 },
    }));
    b.applyOverrides(specWithAssets({
      'enemy.walker': { color: '#ddeeff', emissive: '#112233', emissiveIntensity: 2 },
      'pickup.coin': { color: '#aabbcc' },
    }));
    const colors = (r: AssetRegistry) => r.list().map((e) => e.currentColor);
    expect(colors(a)).toEqual(colors(b));
    expect(colors(a)).toContain('#aabbcc');
  });
});

describe('AssetRegistry.list', () => {
  it('returns id/kind/currentColor for every registered asset, sorted', () => {
    const reg = new AssetRegistry();
    reg.register('world.sky', { kind: 'world', roots: [box(stdMat('#0a1428'))] });
    reg.register('player.body', { kind: 'player', materials: [stdMat('#cc3333')] });
    const list = reg.list();
    expect(list.map((e) => e.id)).toEqual(['player.body', 'world.sky']);
    expect(list[0]).toEqual({ id: 'player.body', kind: 'player', currentColor: '#cc3333' });
    expect(list[1].currentColor).toBe('#0a1428');
  });

  it('reflects overridden colors', () => {
    const reg = new AssetRegistry();
    const mat = stdMat('#111111');
    reg.register('pickup.coin', { kind: 'pickup', materials: [mat] });
    reg.applyOverrides(specWithAssets({ 'pickup.coin': { color: '#bada55' } }));
    expect(reg.list()[0].currentColor).toBe('#bada55');
  });

  it('returns null currentColor for fog-only entries', () => {
    const reg = new AssetRegistry();
    reg.register('world.fog', { kind: 'world', fog: new THREE.Fog('#000000') });
    expect(reg.list()[0].currentColor).toBeNull();
  });
});
