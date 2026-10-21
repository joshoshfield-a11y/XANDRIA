/**
 * prompt-fidelity wave: the generate.ts refactor (consuming extractIntent)
 * must reproduce the pre-refactor outputs byte-for-byte.
 *
 * tests/fixtures/prompt-corpus-baseline.json was frozen from the pre-refactor
 * code via scripts/dump-prompt-corpus.ts. Any mismatch here is a behavior
 * regression — fix the refactor, never the fixture.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSpec, type GenerateOptions } from '../src/generator/generate';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/prompt-corpus-baseline.json'), 'utf8'),
) as { rows: { prompt: string; optsLabel: string; spec: string }[] };

const OPTS_BY_LABEL: Record<string, GenerateOptions> = {
  default: {},
  seed7: { seed: 7 },
  seed4242: { seed: 4242 },
  'genre-override': { genre: 'platformer', seed: 123 },
  'env-override': { environment: 'arctic', seed: 456 },
  'difficulty-hard': { difficulty: 'hard', seed: 789 },
};

describe('prompt corpus parity (pre/post intent refactor)', () => {
  it(`all ${BASELINE.rows.length} corpus rows reproduce byte-identically`, () => {
    const mismatches: string[] = [];
    for (const row of BASELINE.rows) {
      const got = JSON.stringify(generateSpec(row.prompt, OPTS_BY_LABEL[row.optsLabel]));
      if (got !== row.spec) mismatches.push(`${row.optsLabel} :: ${row.prompt.slice(0, 60)}`);
    }
    expect(mismatches).toEqual([]);
  });
});
