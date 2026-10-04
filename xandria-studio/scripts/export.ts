/**
 * CLI export: intent → standalone single-file playable HTML + itch.io-ready zip.
 *   npx tsx scripts/export.ts --intent "neon fps arena at night" --out my-game.html
 *   npx tsx scripts/export.ts --spec '{"meta":...}' --out game.html --no-zip
 * Builds the player bundle (vite) first if dist/player.html is missing.
 *
 * Always emits:
 *   <out>.html        standalone offline game
 *   <out>-itch.zip    distributable zip: index.html + README.txt +
 *                     itch-upload-guide.txt + cover.png (unless --no-zip)
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSpec } from '../src/generator/generate';
import { normalizeSpec, validateSpec } from '../src/spec/schema';
import type { GameSpec } from '../src/spec/schema';
import { ZipBuilder } from './zip';
import { generateCover } from './cover';

const GENRE_LABEL: Record<string, string> = {
  'fps-arena': 'FPS arena shooter',
  'third-person-action': 'third-person action',
  racing: 'racing',
  platformer: 'platformer',
  'top-down-shooter': 'top-down shooter',
};

// ESM-safe __dirname (package is "type": "module", so __dirname doesn't exist)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k: string) => args.includes(k);
const intent = get('--intent');
const specJson = get('--spec');
const out = get('--out') ?? get('-o') ?? 'xandria-game.html';
const wantZip = !has('--no-zip');

if (!intent && !specJson) {
  console.error('Usage: export.ts --intent "..." [--out game.html] [--no-zip] | --spec \'{...}\'');
  process.exit(1);
}

let spec: GameSpec;
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

if (wantZip) {
  const zipPath = out.replace(/\.html?$/i, '') + '-itch.zip';
  const zip = new ZipBuilder();
  zip.add('index.html', new TextEncoder().encode(html));
  zip.add('README.txt', new TextEncoder().encode(buildReadme(spec)));
  zip.add('itch-upload-guide.txt', new TextEncoder().encode(buildItchGuide(spec)));
  zip.add('cover.png', generateCover(spec));
  writeFileSync(zipPath, zip.build());
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`Itch.io bundle -> ${zipPath} (index.html + README.txt + itch-upload-guide.txt + cover.png; game ~${kb} KB)`);
}

// ---------------------------------------------------------------------------

function controlsFor(spec: GameSpec): string[] {
  const common = ['WASD / Arrow keys — move', 'Esc or P — pause'];
  switch (spec.meta.genre) {
    case 'fps-arena':
      return [
        'Click the game — capture the mouse',
        'Mouse — look · Left-click — shoot',
        'WASD — move · Space — jump · Shift — sprint',
        '1 / 2 — switch weapon · Right-click or Q — alt fire',
        'Esc or P — pause (releases the mouse)',
      ];
    case 'third-person-action':
      return [
        'WASD / Arrow keys — move',
        'Left-click — attack · Right-click or Q — alt attack',
        'Space — jump · Shift — dash · E — interact',
        'Esc or P — pause',
      ];
    case 'racing':
      return [
        'WASD / Arrow keys — steer and accelerate',
        'Space — boost · Ctrl or X — brake',
        'R — reset the car · Shift — drift',
        'Esc or P — pause',
      ];
    case 'platformer':
      return [
        'A/D or Arrow keys — move',
        'Space — jump (press again mid-air to double-jump)',
        'Shift — dash',
        'Esc or P — pause',
      ];
    case 'top-down-shooter':
      return [
        'WASD / Arrow keys — move',
        'Mouse — aim · Left-click — shoot',
        'Space — dash · Shift — sprint',
        'Esc or P — pause',
      ];
    default:
      return common;
  }
}

function chapterSummary(spec: GameSpec): string {
  const stages = spec.objective.stages;
  if (Array.isArray(stages) && stages.length > 1) {
    return stages.map((s) => `  ${s.description}`).join('\n');
  }
  return `  ${spec.objective.description}`;
}

function buildReadme(spec: GameSpec): string {
  const genre = GENRE_LABEL[spec.meta.genre] ?? spec.meta.genre;
  const premise = spec.narrative?.premise ?? spec.meta.description;
  return `${spec.meta.name.toUpperCase()}
${'='.repeat(Math.min(spec.meta.name.length, 60))}
A ${genre} game generated by XANDRIA Studio. Runs fully offline —
just open index.html in any modern browser.

STORY
${premise}

YOUR QUEST
${chapterSummary(spec)}

Earn XP from victories and pickups to level up; each level offers a
choice of upgrades (damage, health, speed, fire rate, and more).
Bosses grow more dangerous as their health drops — watch for the
warning when they enrage.

CONTROLS
${controlsFor(spec).map((c) => `  ${c}`).join('\n')}

CREDITS
  Generated with XANDRIA Studio (deterministic intent-to-game engine).
  Art, music, and levels are generated procedurally at build time —
  no external assets, no network needed.
`;
}

function buildItchGuide(spec: GameSpec): string {
  return `ITCH.IO UPLOAD GUIDE — ${spec.meta.name}
${'-'.repeat(50)}

1. On itch.io: Dashboard → New project → Kind of project: HTML.
   (Or: existing project → Edit → Upload files.)

2. Upload the whole .zip you got this file from. itch.io detects
   index.html inside the zip and ticks "This file will be played
   in the browser" automatically. Do NOT unzip it first.

3. Embed options (recommended):
     Viewport dimensions: 1280 x 720
     [x] Automatically start on page load
     [ ] Mobile friendly — leave OFF unless you tested touch;
         this game needs keyboard + mouse.

4. Cover art: upload cover.png (630x500, generated for this game)
   as the project's cover image.

5. Fill in: title, short description, genre (${GENRE_LABEL[spec.meta.genre] ?? spec.meta.genre}),
   tags (singleplayer, procedural, 3d, xandria).

6. Pricing: name your price or free. The game is one self-contained
   HTML file — no server, no DRM, no tracking.

TROUBLESHOOTING
  Black screen? Make sure the zip was uploaded whole and "played in
  the browser" is ticked. The game needs WebGL; very old browsers
  are not supported.
`;
}
