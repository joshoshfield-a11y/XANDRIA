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

import { generateSpec } from './generate';
import { validateSpec } from '@spec';

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

/**
 * Representative intents covering every objective type and genre the
 * winnability rules care about. Each seed is exercised through all of them
 * via the deterministic seed-override path.
 */
const STRANGER_INTENTS = [
  'neon cyberpunk fps arena',       // eliminate, fps-arena
  'brutal fps deathmatch',          // eliminate, hard difficulty
  'collect treasure coins',         // collect
  'survive the endless horde',      // survive
  'kart grand prix',                // race
  'boss battle colossus',           // boss
  'dreamy platformer in the clouds', // platformer / reach
] as const;

/**
 * Real stranger test: for every frozen seed, generate a spec per
 * representative intent through the deterministic compiler (seed override),
 * validate it — validation now includes the winnability invariants — and
 * also run the provided engine harness. Returns a per-seed pass/fail report;
 * a seed fails if ANY intent is unwinnable/invalid or the harness reports
 * failure. Never throws: harness/spec errors become failing notes.
 */
export async function runStrangerTest(run: SeedRunner): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  for (const seed of STRANGER_TEST_SEEDS) {
    const notes: string[] = [];
    // spec-level: deterministic generation + validation (incl. winnability)
    for (const intent of STRANGER_INTENTS) {
      try {
        const spec = generateSpec(intent, { seed });
        const v = validateSpec(spec);
        if (!v.ok) notes.push(`intent "${intent}" invalid: ${v.errors.join('; ')}`);
      } catch (e) {
        notes.push(`intent "${intent}" threw: ${(e as Error).message}`);
      }
    }
    // engine-level: the harness contract (Playwright capture in CI)
    try {
      const r = await run(seed);
      if (!r.ok) notes.push(`harness: ${r.notes ?? 'runner reported failure'}`);
    } catch (e) {
      notes.push(`harness threw: ${(e as Error).message}`);
    }
    results.push({ seed, ok: notes.length === 0, notes: notes.length ? notes.join(' | ') : undefined });
  }
  return results;
}
