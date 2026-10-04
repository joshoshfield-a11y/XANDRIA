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

describe('winnability', () => {
  it('eliminate count must not exceed spawned enemies', () => {
    const bad: any = defaultSpec(1); // eliminate 6 of 6 walkers
    bad.objective.count = 7;
    const v = validateSpec(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('exceeds total spawned enemies'))).toBe(true);
    expect(validateSpec(defaultSpec(1)).ok).toBe(true); // 6 of 6 is fine
  });

  it('collect count must not exceed pickups.coins', () => {
    const bad: any = defaultSpec(1);
    bad.objective = { type: 'collect', count: 99, timeLimit: 0, description: 'x' };
    bad.pickups.coins = 12;
    const v = validateSpec(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('exceeds pickups.coins'))).toBe(true);
    const good: any = defaultSpec(1);
    good.objective = { type: 'collect', count: 12, timeLimit: 0, description: 'x' };
    expect(validateSpec(good).ok).toBe(true);
  });

  it('race requires at least 1 lap', () => {
    const bad: any = defaultSpec(1);
    bad.meta.genre = 'racing';
    bad.player.type = 'vehicle';
    bad.player.camera = 'chase';
    bad.objective = { type: 'race', count: 0, timeLimit: 0, description: 'x' };
    const v = validateSpec(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('at least 1 lap'))).toBe(true);
    const good: any = defaultSpec(1);
    good.meta.genre = 'racing';
    good.player.type = 'vehicle';
    good.player.camera = 'chase';
    good.objective = { type: 'race', count: 3, timeLimit: 0, description: 'x' };
    expect(validateSpec(good).ok).toBe(true);
  });

  it('platformer requires player.jump > 0', () => {
    const bad: any = defaultSpec(1);
    bad.meta.genre = 'platformer';
    bad.player.camera = 'side';
    bad.player.jump = 0;
    const v = validateSpec(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('platformer requires player.jump'))).toBe(true);
    const good: any = defaultSpec(1);
    good.meta.genre = 'platformer';
    good.player.camera = 'side';
    expect(validateSpec(good).ok).toBe(true); // default jump 9
  });

  it('survive requires timeLimit > 0', () => {
    const bad: any = defaultSpec(1);
    bad.objective = { type: 'survive', count: 0, timeLimit: 0, description: 'x' };
    const v = validateSpec(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('survive requires timeLimit'))).toBe(true);
    const good: any = defaultSpec(1);
    good.objective = { type: 'survive', count: 0, timeLimit: 120, description: 'x' };
    expect(validateSpec(good).ok).toBe(true);
  });

  it('boss objective requires a brute-class enemy', () => {
    const bad: any = defaultSpec(1); // only walkers
    bad.objective = { type: 'boss', count: 6, timeLimit: 0, description: 'x' };
    const v = validateSpec(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('brute-class enemy'))).toBe(true);
    const good: any = defaultSpec(1);
    good.enemies = [{ kind: 'brute', count: 1, health: 300, speed: 3, damage: 20, weapon: 'melee' }];
    good.objective = { type: 'boss', count: 1, timeLimit: 0, description: 'x' };
    expect(validateSpec(good).ok).toBe(true);
  });
});

describe('validation warnings', () => {
  it('unknown top-level and custom keys become warnings, not errors', () => {
    const s: any = defaultSpec(1);
    s.bogusKey = 123;
    s.custom = { bogusSection: true, quality: 'retro' };
    const v = validateSpec(s);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toContain('unknown top-level key "bogusKey" ignored');
    expect(v.warnings).toContain('unknown custom key "bogusSection" ignored');
  });

  it('clean specs produce no warnings', () => {
    expect(validateSpec(defaultSpec(1)).warnings).toEqual([]);
  });
});

describe('normalizeSpec', () => {
  it('never aliases caller arrays or nested objects', () => {
    const partial: any = {
      meta: { seed: 3 },
      enemies: [{ kind: 'drone', count: 3, health: 20, speed: 5, damage: 5, weapon: 'blaster' }],
      objective: { type: 'eliminate', count: 3, timeLimit: 0, description: 'x' },
      custom: { quality: 'retro' },
    };
    const s = normalizeSpec(partial);
    expect(s.enemies).not.toBe(partial.enemies);
    expect(s.enemies[0]).not.toBe(partial.enemies[0]);
    expect(s.custom).not.toBe(partial.custom);
    // mutating the caller's input after the fact must not leak into the spec
    partial.enemies[0].count = 99;
    partial.custom.quality = 'high';
    expect(s.enemies[0].count).toBe(3);
    expect(s.custom!.quality).toBe('retro');
  });
});
