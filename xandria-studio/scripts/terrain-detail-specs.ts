/**
 * Graphics wave 2, workstream A — deterministic scene blobs for the
 * terrain-detail before/after shots.
 *
 * Fixed seed, tp-action, mountains terrain (cliffs for strata, altitude for
 * caps, slopes for bands), forced water (shoreline wet band), dusk + day.
 * Four blobs: {dusk,day} x {high,standard} — the quality axis is the
 * desktop/S25 tier axis (feature-flagged detail layer, one code path).
 *
 * Run from xandria-studio/: npx tsx scripts/terrain-detail-specs.ts
 * Blobs land in $SPEC_OUT (default /tmp/terrain-detail-specs — override it:
 * /tmp is ephemeral on this box, so the e2e passes SPEC_DIR explicitly).
 * The blobs are shared by the before/after worktrees — the generator is
 * untouched by this workstream, so one set serves both.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateSpec } from '../src/generator/generate';

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const SEED = 20261014;
const SPEC_OUT = process.env.SPEC_OUT ?? '/tmp/terrain-detail-specs';
mkdirSync(SPEC_OUT, { recursive: true });

for (const tod of ['dusk', 'day'] as const) {
  for (const q of ['high', 'standard'] as const) {
    const spec = generateSpec('a heroic knight adventure through mountain ruins', {
      genre: 'third-person-action',
      seed: SEED,
    });
    spec.theme.timeOfDay = tod;
    spec.world.terrain.type = 'mountains';
    spec.world.terrain.size = 512; // chunked path (2x2), fast stream drain
    spec.world.terrain.water = true;
    spec.custom = { ...(spec.custom ?? {}), quality: q } as typeof spec.custom;
    const name = `${tod}-${q}`;
    writeFileSync(`${SPEC_OUT}/${name}.b64`, b64urlEncode(JSON.stringify(spec)) + '\n');
    console.log(
      `wrote ${SPEC_OUT}/${name}.b64 ` +
      `(genre=${spec.meta.genre} size=${spec.world.terrain.size} water=${spec.world.terrain.water} ` +
      `waterLevel=${spec.world.terrain.waterLevel})`,
    );
  }
}
