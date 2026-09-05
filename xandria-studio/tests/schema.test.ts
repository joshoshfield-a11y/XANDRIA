import { describe, it, expect } from 'vitest';
import { defaultSpec, validateSpec, normalizeSpec, stableStringify, GENRES } from '../src/spec/schema';

describe('GameSpec schema', () => {
  it('default spec validates', () => {
    const v = validateSpec(defaultSpec(42));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('rejects garbage', () => {
    expect(validateSpec(null).ok).toBe(false);
    expect(validateSpec({}).ok).toBe(false);
    expect(validateSpec('string').ok).toBe(false);
  });

  it('reports every structural error', () => {
    const bad: any = defaultSpec(1);
    bad.meta.seed = 'not-a-number';
    bad.theme.palette.primary = 'red';
    bad.world.gravity = 5;
    bad.player.speed = -3;
    bad.audio.tempo = 999;
    const v = validateSpec(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThanOrEqual(5);
  });

  it('enforces genre coherence', () => {
    const bad: any = defaultSpec(1);
    bad.meta.genre = 'racing';
    bad.player.type = 'humanoid';
    const v = validateSpec(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('racing requires'))).toBe(true);
  });

  it('normalizeSpec fills defaults from a partial', () => {
    const s = normalizeSpec({ meta: { name: 'X', seed: 7, genre: 'racing', version: 1 }, player: { type: 'vehicle' } });
    expect(s.meta.name).toBe('X');
    expect(s.theme.palette.primary).toMatch(/^#/);
    expect(s.player.type).toBe('vehicle');
  });

  it('stableStringify is deterministic regardless of key order', () => {
    const a = defaultSpec(5);
    // deep-reverse every object's key order
    const reverseKeys = (v: any): any =>
      Array.isArray(v) ? v.map(reverseKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])]))
          : v;
    const b = reverseKeys(JSON.parse(JSON.stringify(a)));
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('all genres produce valid defaults', () => {
    for (const g of GENRES) {
      const s: any = defaultSpec(9);
      s.meta.genre = g;
      if (g === 'racing') { s.player.type = 'vehicle'; s.player.camera = 'chase'; s.objective.type = 'race'; }
      if (g === 'fps-arena') s.player.camera = 'first-person';
      if (g === 'platformer') s.player.camera = 'side';
      if (g === 'top-down-shooter') s.player.camera = 'top-down';
      expect(validateSpec(s).ok).toBe(true);
    }
  });
});
