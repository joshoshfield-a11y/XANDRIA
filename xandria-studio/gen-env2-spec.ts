/** Generate the deterministic env2 perf spec blob (seed 20261012, tp-action, hills, dusk).
 * Usage: tsx gen-env2-spec.ts <size> > /tmp/env2-spec-<size>.b64
 */
import { generateSpec } from './src/generator/generate';
import { normalizeSpec } from './src/spec/schema';

const size = Number(process.argv[2] ?? '2000');
const spec: any = generateSpec('a heroic knight adventure through ancient forest ruins at dusk', {
  seed: 20261012,
  genre: 'third-person-action',
  environment: 'forest',
});
spec.world.terrain.size = size;
spec.world.terrain.type = 'hills';
spec.world.portals = { enabled: false };
const norm = normalizeSpec(spec);
const json = JSON.stringify(norm);
const b64 = Buffer.from(json, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
console.log(`genre=${norm.meta.genre} env=${norm.theme.environment} tod=${norm.theme.timeOfDay} size=${norm.world.terrain.size} seed=${norm.meta.seed}`);
// write blob to stdout marker for capture
process.stdout.write('BLOB:' + b64 + '\n');
