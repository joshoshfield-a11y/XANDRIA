/**
 * Fixed seed set for the v1 "stranger test" acceptance criterion.
 *
 * These 20 seeds are the public quality bar: a first-time player must be able
 * to tell any two of the resulting games apart within 3 minutes. They are
 * fixed (not random) so the test is reproducible across builds, and so a
 * regression in generator variety is caught by diffing captures.
 *
 * Selection method: mulberry32(0x5EED) stream, first 20 values in
 * [10000, 99999], deduped. Chosen once, frozen forever — do NOT re-pick to
 * make a failing build pass. If a seed produces a broken game, fix the
 * generator, not the seed list.
 */

export const STRANGER_TEST_SEEDS: readonly number[] = [
  53042, 87136, 24478, 69812, 31297,
  92654, 15873, 47208, 68541, 20963,
  84719, 39285, 56147, 73892, 19456,
  41278, 95304, 26741, 58967, 70413,
] as const;

export interface SeedResult {
  seed: number;
  ok: boolean;
  notes?: string;
}

/**
 * Placeholder runner contract. The real harness loads player.html headless
 * (Playwright) once per seed, waits for engine state 'playing', captures a
 * screenshot, and records it next to the seed. A seed `ok` requires: engine
 * reached 'playing', no console errors, and a non-blank frame.
 *
 * Implemented as a contract first so CI wiring does not change this file.
 */
export type SeedRunner = (seed: number) => Promise<SeedResult>;

export async function runStrangerTest(run: SeedRunner): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  for (const seed of STRANGER_TEST_SEEDS) {
    results.push(await run(seed));
  }
  return results;
}
