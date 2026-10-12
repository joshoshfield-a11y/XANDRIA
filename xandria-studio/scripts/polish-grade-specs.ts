/**
 * Regenerate the polish-grade e2e spec blobs.
 *
 * tests/e2e/polish-grade.spec.ts reads /tmp/grade-specs/<genre>.b64 so each
 * genre boots with a SINGLE goto. The original script was never committed;
 * this is the replacement. Run from xandria-studio/:
 *   npx tsx scripts/polish-grade-specs.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateSpec } from '../src/generator/generate';
import type { Genre } from '../src/spec/schema';

const GENRES: { name: string; genre: Genre; intent: string }[] = [
  { name: 'tp-action', genre: 'third-person-action', intent: 'a heroic knight adventure through ancient forest ruins at dusk' },
  { name: 'fps-arena', genre: 'fps-arena', intent: 'fps arena shooter in a neon foundry at dusk' },
  { name: 'racing', genre: 'racing', intent: 'desert canyon rally race at dusk' },
  { name: 'platformer', genre: 'platformer', intent: 'forest temple platformer at dusk' },
  { name: 'topdown', genre: 'top-down-shooter', intent: 'top-down twin stick shooter in a neon city at dusk' },
];

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

mkdirSync('/tmp/grade-specs', { recursive: true });
for (const g of GENRES) {
  const spec = generateSpec(g.intent, { genre: g.genre, seed: 7 });
  spec.custom = { ...(spec.custom ?? {}), quality: 'high' } as typeof spec.custom;
  writeFileSync(`/tmp/grade-specs/${g.name}.b64`, b64urlEncode(JSON.stringify(spec)) + '\n');
  console.log(`wrote /tmp/grade-specs/${g.name}.b64 (genre=${spec.meta.genre})`);
}
