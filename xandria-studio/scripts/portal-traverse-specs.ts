/**
 * Generate the portals workstream-B e2e spec blob.
 * tests/e2e/portal-traverse.spec.ts reads /tmp/portal-specs/portal-8km.b64
 * (fallback: the committed copy next to this script's output dir) so each
 * leg boots with a SINGLE goto. Run from xandria-studio/:
 *   npx tsx scripts/portal-traverse-specs.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateSpec } from '../src/generator/generate';

const SEED = 20261014;

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const spec = generateSpec('a heroic knight adventure through vast hills at dusk', {
  seed: SEED,
  genre: 'third-person-action',
});
spec.world.terrain.size = 8000;
spec.world.terrain.water = false;
spec.world.boundary = 'walls';
// Canonical portal flag (workstream C schema): world.portals.enabled.
// The generator already emits this for open-world games; set explicitly so
// the blob never depends on generator defaults.
spec.world.portals = { enabled: true };
// The traversal bot is made invincible at runtime (test-only); enemies stay
// so the objective validation (eliminate N of M spawned) keeps passing.

mkdirSync('/tmp/portal-specs', { recursive: true });
writeFileSync('/tmp/portal-specs/portal-8km.b64', b64urlEncode(JSON.stringify(spec)) + '\n');
console.log(`wrote /tmp/portal-specs/portal-8km.b64 (genre=${spec.meta.genre} size=${spec.world.terrain.size} seed=${spec.meta.seed})`);
