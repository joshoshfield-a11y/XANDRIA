import { describe, it, expect } from 'vitest';
import { generateSpec } from '../src/generator/generate';
import { validateSpec } from '../src/spec/schema';

const CASES: [string, string][] = [
  ['epic sword adventure through ancient ruins at dusk', 'third-person-action'],
  ['neon cyberpunk fps arena deathmatch', 'fps-arena'],
  ['racing through a volcanic canyon', 'racing'],
  ['dreamy platformer in the clouds', 'platformer'],
  ['top-down twin stick horde survival', 'top-down-shooter'],
  ['a quiet walk in the forest', 'third-person-action'],
  ['kart grand prix on tropical islands', 'racing'],
];

describe('generator', () => {
  it.each(CASES)('"%s" → %s (valid spec)', (intent, genre) => {
    const spec = generateSpec(intent);
    expect(spec.meta.genre).toBe(genre);
    const v = validateSpec(spec);
    expect(v.errors).toEqual([]);
  });

  it('is deterministic per intent', () => {
    const a = generateSpec('neon cyberpunk fps arena deathmatch');
    const b = generateSpec('neon cyberpunk fps arena deathmatch');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different intents → different seeds', () => {
    const a = generateSpec('forest adventure');
    const b = generateSpec('desert adventure');
    expect(a.meta.seed).not.toBe(b.meta.seed);
  });

  it('environment detection works', () => {
    expect(generateSpec('frozen arctic expedition').theme.environment).toBe('arctic');
    expect(generateSpec('cyberpunk neon city nights').theme.environment).toBe('neon-city');
    expect(generateSpec('volcanic lava fields').theme.environment).toBe('volcanic');
    expect(generateSpec('tropical island racing').theme.environment).toBe('islands');
  });

  it('racing specs always have vehicle + chase camera + laps', () => {
    const s = generateSpec('race me across the desert');
    expect(s.player.type).toBe('vehicle');
    expect(s.player.camera).toBe('chase');
    expect(s.objective.type).toBe('race');
    expect(s.objective.count).toBeGreaterThanOrEqual(3);
  });

  it('platformer grants doubleJump and side camera', () => {
    const s = generateSpec('a hard platformer over lava');
    expect(s.player.abilities).toContain('doubleJump');
    expect(s.player.camera).toBe('side');
  });

  it('genre override beats keywords', () => {
    const s = generateSpec('racing cars', { genre: 'platformer' });
    expect(s.meta.genre).toBe('platformer');
  });

  it('100 random intents all validate', () => {
    const words = ['dark', 'forest', 'racing', 'neon', 'zombie', 'platformer', 'boss', 'night', 'snow', 'city', 'quest', 'arena', 'lava', 'sky', 'ruins', 'mech', 'drone', 'sword', 'magic', 'storm'];
    let s = 12345;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 100; i++) {
      const intent = Array.from({ length: 3 + Math.floor(rnd() * 4) }, () => words[Math.floor(rnd() * words.length)]).join(' ');
      const v = validateSpec(generateSpec(intent));
      if (!v.ok) throw new Error(`intent "${intent}" failed: ${v.errors.join('; ')}`);
    }
  });
});
