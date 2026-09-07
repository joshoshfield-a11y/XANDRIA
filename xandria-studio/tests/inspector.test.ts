import { describe, it, expect } from 'vitest';
import { applyPatch, readFields, findPath, describeSpec } from '../src/studio/inspector/specInspector';

// Structural fixture: deliberately NOT the real GameSpec type, to prove the
// inspector is schema-agnostic. Any spec shape containing these leaves works.
const fixture = () => ({
  meta: { seed: 42, title: 'Hollow Expanse' },
  world: { timeOfDay: 0.5, fogDensity: 0.2 },
  enemies: { enemyCount: 8 },
  rules: { difficulty: 'normal' },
  theme: { palette: { primary: '#aabbcc', accent: '#112233' } },
});

describe('specInspector', () => {
  it('reads declared fields from a nested spec', () => {
    const fields = readFields(fixture());
    const keys = fields.map((f) => f.def.key).sort();
    expect(keys).toEqual(['accent', 'difficulty', 'enemyCount', 'fogDensity', 'primary', 'seed', 'timeOfDay']);
  });

  it('findPath locates deep leaves', () => {
    expect(findPath(fixture(), 'seed')).toEqual(['meta', 'seed']);
    expect(findPath(fixture(), 'nonexistent')).toBeNull();
  });

  it('applies a patch without mutating the input', () => {
    const spec = fixture();
    const { spec: next, changed } = applyPatch(spec, { enemyCount: 12, timeOfDay: 0.9 });
    expect(changed.sort()).toEqual(['enemies.enemyCount', 'world.timeOfDay']);
    expect((next as any).enemies.enemyCount).toBe(12);
    expect(spec.enemies.enemyCount).toBe(8); // input untouched
  });

  it('clamps out-of-range numbers', () => {
    const { spec: next } = applyPatch(fixture(), { enemyCount: 9999, timeOfDay: -5 });
    expect((next as any).enemies.enemyCount).toBe(40);
    expect((next as any).world.timeOfDay).toBe(0);
  });

  it('rejects locked keys (seed lock) and unknown keys', () => {
    const { spec: next, rejected } = applyPatch(fixture(), { seed: 7, banana: 1 }, ['seed']);
    expect(rejected.sort()).toEqual(['banana', 'seed']);
    expect((next as any).meta.seed).toBe(42);
  });

  it('rejects invalid colors and non-option selects', () => {
    const { rejected } = applyPatch(fixture(), { primary: 'red', difficulty: 'nightmare' });
    expect(rejected.sort()).toEqual(['difficulty', 'primary']);
  });

  it('ignores fields absent from the spec instead of inventing them', () => {
    const { spec: next, changed } = applyPatch({ meta: { seed: 1 } }, { enemyCount: 5 });
    expect(changed).toEqual([]);
    expect(next).toEqual({ meta: { seed: 1 } });
  });

  it('describeSpec summarizes what is editable', () => {
    expect(describeSpec(fixture())).toContain('Seed: 42');
    expect(describeSpec({})).toBe('No editable fields found in spec');
  });
});
