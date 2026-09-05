import { describe, it, expect } from 'vitest';
import { Rng, Noise2D, hashString } from '../src/engine/core/Rng';

describe('Rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('different seeds diverge', () => {
    const a = new Rng(1), b = new Rng(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('stays in [0,1) over 100k draws', () => {
    const r = new Rng(7);
    for (let i = 0; i < 100000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('fork produces independent streams', () => {
    const a = new Rng(9).fork(1);
    const b = new Rng(9).fork(2);
    expect([a.next(), a.next()]).not.toEqual([b.next(), b.next()]);
  });

  it('hashString is stable and sensitive', () => {
    expect(hashString('xandria')).toBe(hashString('xandria'));
    expect(hashString('xandria')).not.toBe(hashString('xandriB'));
  });
});

describe('Noise2D', () => {
  it('output is bounded', () => {
    const n = new Noise2D(3);
    for (let i = 0; i < 5000; i++) {
      const v = n.get(i * 0.13, i * 0.29);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.05);
    }
  });

  it('is deterministic per seed', () => {
    const a = new Noise2D(11), b = new Noise2D(11);
    expect(a.get(3.3, 4.4)).toBe(b.get(3.3, 4.4));
  });

  it('fbm is bounded and smooth', () => {
    const n = new Noise2D(5);
    let prev = n.fbm(0, 0);
    for (let i = 1; i < 500; i++) {
      const v = n.fbm(i * 0.01, 0);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.05);
      expect(Math.abs(v - prev)).toBeLessThan(0.2); // continuity
      prev = v;
    }
  });
});
