/**
 * Generate the water-shore e2e spec blobs (workstream D, graphics wave 2).
 *
 * tests/e2e/water-shore.spec.ts reads /tmp/water-specs/<weather>.b64 so each
 * weather boots with a SINGLE goto. Top-down genre: legacy 220m world, no
 * portals, fast boot; 'flat' terrain with waterLevel=0 puts the waterline
 * through natural terrain (spawn flattening ends ~32m out, the in-page scan
 * finds a real shoreline beyond it).
 *
 * Run from xandria-studio/: npx tsx scripts/water-shore-specs.ts
 * (tsx via npx; falls back to the repo's vite-node if tsx is absent)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateSpec } from '../src/generator/generate';

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

mkdirSync('/tmp/water-specs', { recursive: true });
for (const weather of ['clear', 'rain'] as const) {
  // platformer + forest: 'hills' terrain (y in [-6.9, 12.7]) with waterLevel 0
  // → real lakes with depth up to ~7m, so the 1–9m shallow→deep grade reads
  // alongside the foam band. 260m legacy world, no portals, fast boot.
  // Spawn (flattened to 0) sits at the waterline — fine for screenshots;
  // the camera is pinned in-page.
  const spec = generateSpec('platformer adventure across a misty lake district at dusk', {
    seed: 4242, genre: 'platformer', environment: 'forest',
  });
  spec.world.terrain.water = true;
  spec.world.terrain.waterLevel = 0;
  spec.theme.weather = weather;
  spec.theme.timeOfDay = 'dusk';
  writeFileSync(`/tmp/water-specs/${weather}.b64`, b64urlEncode(JSON.stringify(spec)) + '\n');
  console.log(`wrote /tmp/water-specs/${weather}.b64 (genre=${spec.meta.genre}, weather=${spec.theme.weather})`);
}
