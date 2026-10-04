import { describe, it, expect } from 'vitest';
import { STRANGER_TEST_SEEDS, runStrangerTest, type SeedResult } from '../src/generator/seedSet';

describe('stranger test seeds', () => {
  it('seed list is frozen at 20 entries', () => {
    expect(STRANGER_TEST_SEEDS).toHaveLength(20);
    expect(new Set(STRANGER_TEST_SEEDS).size).toBe(20);
  });

  it('all seeds pass spec-level winnability with a passing harness stub', async () => {
    const stub = async (seed: number): Promise<SeedResult> => ({ seed, ok: true });
    const results = await runStrangerTest(stub);
    expect(results).toHaveLength(STRANGER_TEST_SEEDS.length);
    for (const r of results) {
      expect(r.seed).toBeDefined();
      expect(typeof r.ok).toBe('boolean');
    }
    const failed = results.filter((r) => !r.ok);
    expect(failed.map((r) => `${r.seed}: ${r.notes}`)).toEqual([]);
  }, 60000);

  it('reports harness failures per seed without aborting the run', async () => {
    const bad = STRANGER_TEST_SEEDS[0];
    const stub = async (seed: number): Promise<SeedResult> =>
      seed === bad ? { seed, ok: false, notes: 'engine never reached playing' } : { seed, ok: true };
    const results = await runStrangerTest(stub);
    const hit = results.find((r) => r.seed === bad)!;
    expect(hit.ok).toBe(false);
    expect(hit.notes).toContain('engine never reached playing');
    expect(results.filter((r) => r.seed !== bad && !r.ok)).toEqual([]);
  }, 60000);

  it('survives a throwing harness and still reports every seed', async () => {
    const stub = async (seed: number): Promise<SeedResult> => {
      if (seed === STRANGER_TEST_SEEDS[1]) throw new Error('playwright crashed');
      return { seed, ok: true };
    };
    const results = await runStrangerTest(stub);
    expect(results).toHaveLength(STRANGER_TEST_SEEDS.length);
    const hit = results.find((r) => r.seed === STRANGER_TEST_SEEDS[1])!;
    expect(hit.ok).toBe(false);
    expect(hit.notes).toContain('playwright crashed');
  }, 60000);
});
