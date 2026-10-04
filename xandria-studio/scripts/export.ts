/**
 * CLI export: intent → standalone single-file playable HTML.
 *   npx tsx scripts/export.ts --intent "neon fps arena at night" --out my-game.html
 *   npx tsx scripts/export.ts --spec '{"meta":...}' --out game.html
 * Builds the player bundle (vite) first if dist/player.html is missing.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSpec } from '../src/generator/generate';
import { normalizeSpec, validateSpec } from '../src/spec/schema';

// ESM-safe __dirname (package is "type": "module", so __dirname doesn't exist)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const intent = get('--intent');
const specJson = get('--spec');
const out = get('--out') ?? get('-o') ?? 'xandria-game.html';

if (!intent && !specJson) {
  console.error('Usage: export.ts --intent "..." [--out game.html] | --spec \'{...}\'');
  process.exit(1);
}

let spec;
if (specJson) {
  const raw = JSON.parse(specJson);
  const v = validateSpec(raw);
  spec = v.ok ? raw : normalizeSpec(raw);
} else {
  spec = generateSpec(intent!);
}

const playerPath = path.join(root, 'dist', 'player.html');
if (!existsSync(playerPath)) {
  console.log('Building player bundle…');
  execSync('npx vite build --mode player', { cwd: root, stdio: 'inherit' });
}
let html = readFileSync(playerPath, 'utf8');
// Escape </script inside the spec JSON so it can't break out of the injection block
const specJsonSafe = JSON.stringify(spec).replace(/<\/script/gi, '<\\/script');
html = html.replace('<head>', `<head><script>window.__XANDRIA_SPEC__=${specJsonSafe};</script>`);
writeFileSync(out, html);
console.log(`Exported "${spec.meta.name}" (${spec.meta.genre}) -> ${out} (${(html.length / 1024 / 1024).toFixed(2)} MB, fully offline)`);
