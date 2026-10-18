/**
 * NPCs wave (workstream C): deterministic e2e scene blob.
 * Seed 20261012, tp-action, forest/hills, dusk, 512m (chunked path — fast
 * stream drain under SwiftShader), portals disabled.
 *
 * Run from xandria-studio/: npx tsx scripts/npcs-specs.ts
 * Writes tests/e2e/fixtures/npcs.b64 (committed — the generator is seeded,
 * so the blob is deterministic).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateSpec } from '../src/generator/generate';
import { normalizeSpec } from '../src/spec/schema';

const OUT = process.env.SPEC_OUT ?? 'tests/e2e/fixtures';
mkdirSync(OUT, { recursive: true });

const spec: any = generateSpec('a heroic knight adventure through ancient forest ruins at dusk', {
  seed: 20261012,
  genre: 'third-person-action',
  environment: 'forest',
});
spec.world.terrain.size = 512;
spec.world.terrain.type = 'hills';
spec.world.portals = { enabled: false };
const norm = normalizeSpec(spec);
const b64 = Buffer.from(JSON.stringify(norm), 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
writeFileSync(`${OUT}/npcs.b64`, b64 + '\n');
console.log(
  `wrote ${OUT}/npcs.b64 ` +
  `(genre=${norm.meta.genre} env=${norm.theme.environment} tod=${norm.theme.timeOfDay} ` +
  `size=${norm.world.terrain.size} type=${norm.world.terrain.type} seed=${norm.meta.seed})`,
);
