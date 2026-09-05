import { describe, it, expect } from 'vitest';
import { generateSpec } from '../src/generator/generate';
import { validateSpec, normalizeSpec, type GameSpec } from '../src/spec/schema';
import { forgeHumanoidPlan, forgeVehiclePlan } from '../src/engine/gfx/ModelForge';
import { speciesFromMix } from '../src/engine/world/Vegetation';

function withCustom(custom: unknown): GameSpec {
  const spec = JSON.parse(JSON.stringify(generateSpec('test game in the forest'))) as GameSpec;
  (spec as unknown as Record<string, unknown>).custom = custom;
  return spec;
}

describe('custom spec layer', () => {
  it('accepts a full valid custom block', () => {
    const spec = withCustom({
      quality: 'high',
      biome: { terrainFrequency: 1.5, heightScale: 2, waterBias: 3, floraMix: { pine: 5, mushroom: 2 } },
      forge: { headStyle: 'horned', armor: 'plate', bulk: 1.4, height: 1.1, vehicleSpoiler: 'wing' },
      enemyMods: { size: 2, speed: 1.5, aggression: 2, glow: '#ff00ff' },
      weaponMods: { projectileSpeed: 80, rateOfFire: 4, spread: 0.2, pellets: 8, beamColor: '#00ff88' },
      assets: { enabled: true, packs: { trees: 'https://example.com/trees.glb' } },
    });
    const v = validateSpec(spec);
    expect(v.ok, v.ok ? '' : v.errors.join('\n')).toBe(true);
  });

  it('rejects bad quality mode', () => {
    expect(validateSpec(withCustom({ quality: 'ultra' })).ok).toBe(false);
  });

  it('rejects out-of-range biome values', () => {
    expect(validateSpec(withCustom({ biome: { terrainFrequency: 99 } })).ok).toBe(false);
    expect(validateSpec(withCustom({ biome: { heightScale: -1 } })).ok).toBe(false);
    expect(validateSpec(withCustom({ biome: { waterBias: 50 } })).ok).toBe(false);
  });

  it('rejects unknown flora species and bad weights', () => {
    expect(validateSpec(withCustom({ biome: { floraMix: { oakley: 3 } } })).ok).toBe(false);
    expect(validateSpec(withCustom({ biome: { floraMix: { pine: 99 } } })).ok).toBe(false);
  });

  it('rejects bad forge/enemy/weapon values', () => {
    expect(validateSpec(withCustom({ forge: { headStyle: 'mohawk-x' } })).ok).toBe(false);
    expect(validateSpec(withCustom({ enemyMods: { glow: 'red' } })).ok).toBe(false);
    expect(validateSpec(withCustom({ weaponMods: { pellets: 99 } })).ok).toBe(false);
  });

  it('rejects non-https asset pack URLs and non-glb files', () => {
    expect(validateSpec(withCustom({ assets: { enabled: true, packs: { a: 'http://evil.com/x.glb' } } })).ok).toBe(false);
    expect(validateSpec(withCustom({ assets: { enabled: true, packs: { a: 'https://ok.com/x.txt' } } })).ok).toBe(false);
    expect(validateSpec(withCustom({ assets: { enabled: true, packs: { a: 'https://ok.com/x.glb' } } })).ok).toBe(true);
  });

  it('survives normalizeSpec round-trip', () => {
    const spec = normalizeSpec(withCustom({ quality: 'standard', forge: { bulk: 1.2 } }));
    expect(spec.custom?.quality).toBe('standard');
    expect(spec.custom?.forge?.bulk).toBe(1.2);
    expect(validateSpec(spec).ok).toBe(true);
  });
});

describe('forge hints', () => {
  it('humanoid hints override rolled values', () => {
    const p = forgeHumanoidPlan(1234, {}, { headStyle: 'horned', armor: 'plate', bulk: 1.5, height: 1.1 });
    expect(p.headStyle).toBe('horned');
    expect(p.armor).toBe('plate');
    expect(p.bulk).toBe(1.5);
    expect(p.height).toBe(1.1);
  });

  it('vehicle spoiler hint overrides', () => {
    expect(forgeVehiclePlan(77, { vehicleSpoiler: 'ducktail' }).spoiler).toBe('ducktail');
  });

  it('hints do not break determinism', () => {
    const h = { headStyle: 'hood' as const };
    expect(forgeHumanoidPlan(5, {}, h)).toEqual(forgeHumanoidPlan(5, {}, h));
  });
});

describe('floraMix', () => {
  it('expands weights into a species list', () => {
    expect(speciesFromMix({ pine: 2, oak: 1 })).toEqual(['pine', 'pine', 'oak']);
  });
  it('ignores zero/negative weights', () => {
    expect(speciesFromMix({ pine: 0, oak: -2 })).toEqual([]);
  });
});
