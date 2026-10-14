/**
 * Generate the stage-1b workstream-C e2e spec blobs.
 * tests/e2e/maxsize-farfield.spec.ts reads /tmp/ff-specs/<name>.b64 so each
 * shot boots with a SINGLE goto. Run from xandria-studio/:
 *   npx tsx scripts/maxsize-farfield-specs.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateSpec } from '../src/generator/generate';

const SEED = 20261013;

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function specFor(name: string, intent: string, size: number, water: boolean) {
  const spec = generateSpec(intent, { seed: SEED });
  spec.world.terrain.size = size;
  spec.world.terrain.water = water;
  spec.world.terrain.waterLevel = -2;
  spec.custom = { ...(spec.custom ?? {}), quality: 'high' } as typeof spec.custom;
  writeFileSync(`/tmp/ff-specs/${name}.b64`, b64urlEncode(JSON.stringify(spec)) + '\n');
  console.log(`wrote /tmp/ff-specs/${name}.b64 (genre=${spec.meta.genre} terrain=${spec.world.terrain.type} size=${size} water=${water})`);
}

mkdirSync('/tmp/ff-specs', { recursive: true });
specFor('ff-2km-dusk-hills', 'a heroic knight adventure through vast hills with a lake at dusk', 2000, true);
specFor('ff-8km-dusk-hills', 'a heroic knight adventure through vast hills with a lake at dusk', 8000, true);
specFor('ff-8km-dusk-canyon', 'a heroic knight adventure through a vast canyon at dusk', 8000, false);
specFor('ff-8km-dusk-water', 'a heroic knight adventure across a vast ocean archipelago at dusk', 8000, true);
