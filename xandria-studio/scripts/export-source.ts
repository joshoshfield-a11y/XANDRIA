/**
 * CLI: export a clean, readable, ready-to-hack TypeScript source project.
 *   npx tsx scripts/export-source.ts --out ./my-game --genre fps-arena --seed 123
 *   npx tsx scripts/export-source.ts --out ./my-game --intent "neon fps arena at night"
 *
 * Emits:
 *   my-game/
 *     package.json  (three, cannon-es, vite, typescript — pinned to the studio's versions)
 *     tsconfig.json, vite.config.ts, index.html
 *     README.md     — install / dev / build, project tour
 *     MODDING.md    — hook + registry reference for developers
 *     src/main.ts   — boots the game (readable, commented)
 *     src/game.ts   — THIS game's blueprint (readable, commented, not minified)
 *     src/spec.json — the generated GameSpec (edit me: the fastest way to reskin)
 *     src/engine/   — vendored engine source (copy of the studio tree)
 *     src/spec/     — vendored spec schema
 *     src/blueprints/ — shared blueprint helpers (common, campaign, enemies, fx, dressing)
 *
 * The exported game is a normal vite project:
 *   cd my-game && npm install && npm run dev
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSpec } from '../src/generator/generate';
import { normalizeSpec } from '../src/spec/schema';
import type { GameSpec, Genre } from '../src/spec/schema';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

const outDir = path.resolve(get('--out') ?? get('-o') ?? './xandria-game-src');
const genreArg = get('--genre');
const intentArg = get('--intent');
const seedArg = get('--seed');
const seed = seedArg !== null ? parseInt(seedArg, 10) : (Math.floor(Math.random() * 0xffffffff) >>> 0);

if (!genreArg && !intentArg) {
  console.error('Usage: export-source.ts --out ./my-game (--genre fps-arena [--seed 123] | --intent "...")');
  process.exit(1);
}

const GENRE_SOURCE: Record<string, { file: string; buildFn: string; label: string; intent: string }> = {
  'fps-arena': { file: 'fpsArena.ts', buildFn: 'buildFpsArena', label: 'FPS Arena', intent: 'fast arena shooter with waves of drones' },
  'third-person-action': { file: 'tpAction.ts', buildFn: 'buildThirdPersonAction', label: 'Third-Person Action', intent: 'heroic third-person melee adventure' },
  racing: { file: 'racing.ts', buildFn: 'buildRacing', label: 'Racing', intent: 'arcade rally race at sunset' },
  platformer: { file: 'platformer.ts', buildFn: 'buildPlatformer', label: 'Platformer', intent: 'jump-and-run platformer through floating ruins' },
  'top-down-shooter': { file: 'topdown.ts', buildFn: 'buildTopDown', label: 'Top-Down Shooter', intent: 'twin-stick top-down space shooter' },
};

// Pinned to the exact versions the studio builds against.
const PIN = { three: '0.182.0', 'cannon-es': '0.20.0', vite: '6.4.3', typescript: '5.9.3', '@types/three': '0.182.0', '@types/node': '20.19.43' };
const BLUEPRINT_SUPPORT = ['common.ts', 'campaign.ts', 'enemies.ts', 'fx.ts', 'dressing.ts'];

// ---- spec ---------------------------------------------------------------
let spec: GameSpec;
if (intentArg) {
  spec = generateSpec(intentArg);
} else {
  const g = GENRE_SOURCE[genreArg!];
  if (!g) { console.error(`Unknown genre "${genreArg}". Pick one of: ${Object.keys(GENRE_SOURCE).join(', ')}`); process.exit(1); }
  spec = generateSpec(g.intent);
  spec.meta.genre = genreArg as Genre;
}
spec.meta.seed = seed >>> 0;
spec = normalizeSpec(spec);
const gs = GENRE_SOURCE[spec.meta.genre];
if (!gs) { console.error(`Generator produced unsupported genre "${spec.meta.genre}"`); process.exit(1); }

const gameName = spec.meta.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'xandria-game';

// ---- helpers ------------------------------------------------------------
const write = (rel: string, content: string) => {
  const p = path.join(outDir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};
const copyTree = (from: string, to: string) => {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
};
const copyFile = (from: string, to: string) => {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
};

// ---- engine + spec (vendored) -------------------------------------------
console.log('Vendoring engine + spec…');
copyTree(path.join(root, 'src', 'engine'), path.join(outDir, 'src', 'engine'));
copyTree(path.join(root, 'src', 'spec'), path.join(outDir, 'src', 'spec'));
for (const f of BLUEPRINT_SUPPORT) {
  const src = path.join(root, 'src', 'blueprints', f);
  if (!existsSync(src)) { console.error(`missing blueprint support file: ${f}`); process.exit(1); }
  copyFile(src, path.join(outDir, 'src', 'blueprints', f));
}

// ---- this game's blueprint -> src/game.ts --------------------------------
let gameSrc = readFileSync(path.join(root, 'src', 'blueprints', gs.file), 'utf8');
// Re-root imports: src/blueprints/<genre>.ts -> src/game.ts
// Re-root imports: src/blueprints/<genre>.ts -> src/game.ts.
// Order matters: rewrite './x' first, THEN '../engine/x' (the first rewrite
// produces './engine/...' strings that the second pattern must not touch).
gameSrc = gameSrc
  .replace(/from '\.\//g, "from './blueprints/")
  .replace(/from '\.\.\/engine\//g, "from './engine/");
gameSrc =
  `/**\n * ${spec.meta.name} — game blueprint (${gs.label}).\n *\n * GENERATED by XANDRIA from intent/seed ${spec.meta.seed}, then exported as a\n * readable starting point. This is YOUR file now: tweak spawns, swap enemy\n * kinds, add chapters, or throw it away and write your own — main.ts just\n * needs a (engine, spec) => unknown build function.\n *\n * See MODDING.md for the hook/registry reference.\n */\n` + gameSrc;
write('src/game.ts', gameSrc);

// ---- spec.json (the fastest reskin lever) --------------------------------
write('src/spec.json', JSON.stringify(spec, null, 2) + '\n');

// ---- main.ts ---------------------------------------------------------------
write('src/main.ts', `/**
 * ${spec.meta.name} — entry point.
 *
 * The whole game is: Engine (runtime kernel) + GameSpec (data) + a blueprint
 * build function (this game's content, in ./game.ts).
 *
 * QUICK WINS:
 *  - Reskin without code: edit src/spec.json (names, colors, counts, chapters).
 *  - Change behavior: edit src/game.ts (spawns, waves, pickups, chapter flow).
 *  - React to game events: engine.hooks.tap('onKill', ...) — see MODDING.md.
 *  - Add your own enemy: engine.hooks.registerEnemyKind(...) — see MODDING.md.
 */
import { Engine } from './engine/Engine';
import { ${gs.buildFn} } from './game';
import specJson from './spec.json';
import type { GameSpec } from '@spec';

const spec = specJson as GameSpec;

function boot() {
  document.title = \`\${spec.meta.name} — XANDRIA\`;
  const container = document.getElementById('app')!;
  const engine = new Engine(container, spec);

  // Build this game's world. Swap ${gs.buildFn} for your own
  // (engine: Engine, spec: GameSpec) => unknown function to total-convert.
  const blueprint = ${gs.buildFn}(engine, spec);

  // Example mod hook (uncomment to try):
  // engine.hooks.tap('onKill', ({ enemy }) => console.log('down:', enemy.spec.kind));

  // Expose for debugging / automation.
  (window as any).__GAME__ = { engine, spec, blueprint };
  document.body.dataset.genre = spec.meta.genre;

  engine.hud.toast(spec.meta.name.toUpperCase(), 3);
  engine.particles.setWeather(spec.theme.weather, spec.meta.seed);
  engine.onUpdatePersistent(() => engine.particles.updateWeather(engine.camera.position, 1 / 60));
  // Enables the in-game RESTART button (rebuilds from the same spec+seed).
  engine.setRunBuilder((e) => ${gs.buildFn}(e, spec));
  engine.start();
}

boot();
`);

// ---- project files ---------------------------------------------------------
write('package.json', JSON.stringify({
  name: gameName,
  version: '1.0.0',
  private: true,
  type: 'module',
  description: `${spec.meta.name} — a XANDRIA-generated ${gs.label} game.`,
  scripts: { dev: 'vite', build: 'tsc --noEmit && vite build', preview: 'vite preview' },
  dependencies: { 'cannon-es': PIN['cannon-es'], three: PIN.three },
  devDependencies: {
    '@types/node': PIN['@types/node'], '@types/three': PIN['@types/three'],
    typescript: PIN.typescript, vite: PIN.vite,
  },
}, null, 2) + '\n');

write('tsconfig.json', JSON.stringify({
  compilerOptions: {
    target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    module: 'ESNext', moduleResolution: 'bundler', strict: true,
    noUnusedLocals: false, noUnusedParameters: false, noImplicitAny: true,
    skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true,
    isolatedModules: true, useDefineForClassFields: true, noEmit: true,
    baseUrl: '.', paths: { '@spec': ['src/spec/index.ts'], '@spec/*': ['src/spec/*'] },
    types: ['vite/client', 'node'],
  },
  include: ['src', 'vite.config.ts'],
}, null, 2) + '\n');

write('vite.config.ts', `import { defineConfig } from 'vite';
import path from 'node:path';

// '@spec' alias mirrors the studio layout so vendored sources compile unchanged.
export default defineConfig({
  resolve: { alias: { '@spec': path.resolve(__dirname, 'src/spec/index.ts') } },
});
`);

write('index.html', `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>${spec.meta.name}</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #06080e; }
      #app { position: fixed; inset: 0; }
      canvas { display: block; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`);

write('README.md', `# ${spec.meta.name}

A **${gs.label}** game generated by [XANDRIA](https://github.com/joshoshfield-a11y/XANDRIA) (seed \`${spec.meta.seed}\`), exported as a clean TypeScript source project. This is a real, hackable game — not a bundle.

## Run it

\`\`\`bash
npm install
npm run dev      # play at http://localhost:5173
npm run build    # typecheck + production build into dist/
\`\`\`

## Project tour

| Path | What it is |
|---|---|
| \`src/main.ts\` | Boots the game: Engine + spec + blueprint. Start reading here. |
| \`src/game.ts\` | **This game's content** — spawns, waves, chapters, pickups. Your main file. |
| \`src/spec.json\` | The generated GameSpec. Reskin without touching code. |
| \`src/engine/\` | The runtime kernel (renderer, physics, HUD, audio, AI…). Vendored; treat as a library. |
| \`src/spec/\` | The GameSpec schema + validator. |
| \`src/blueprints/\` | Shared content helpers (campaign flow, enemy variants, effects, dressing). |

## Make it yours

1. **Reskin** — edit \`src/spec.json\`: names, palette, enemy counts, chapter list.
2. **Rebalance** — edit \`src/game.ts\`: spawn tables, wave sizes, pickup drops.
3. **Extend** — \`engine.hooks.tap(...)\` / \`registerEnemyKind\` / \`registerUpgrade\` — see **MODDING.md**.
4. **Total convert** — write your own \`(engine, spec) => unknown\` build function and call it from \`src/main.ts\` instead of \`${gs.buildFn}\`.

## Ship it

\`npm run build\` → upload \`dist/\` to itch.io as an HTML5 project (viewport 1280×720).
`);

write('MODDING.md', `# Modding ${spec.meta.name}

Two layers, both additive — nothing here changes default behavior unless you opt in.

## 1. Hooks — react to game events

\`\`\`ts
// in src/main.ts, after creating the engine:
engine.hooks.tap('onKill', ({ enemy }) => {
  console.log('destroyed:', enemy.spec.kind);
});
engine.hooks.tap('onLevelUp', ({ level }) => console.log('level', level));
\`\`\`

| Hook | Payload | Fires when |
|---|---|---|
| \`onKill\` | \`{ enemy }\` | any enemy dies |
| \`onPickup\` | \`{ pickup }\` | player collects a pickup |
| \`onStageComplete\` | \`{ index, stage }\` | a quest chapter completes |
| \`onPhase\` | \`{ enemy, phase }\` | boss crosses 66% / 33% HP |
| \`onLevelUp\` | \`{ level, progression }\` | player gains a level |
| \`onWin\` / \`onLose\` | \`{ stats }\` / \`{ reason, stats }\` | run ends |
| \`onTick\` | \`{ dt, t }\` | every frame while playing |

\`tap()\` returns an untap function. All payloads are typed — see \`src/engine/game/Modding.ts\`.

## 2. Registries — add content

**Custom enemy kind** (body/rig built from a base kind, re-tinted, with your own per-tick logic):

\`\`\`ts
engine.hooks.registerEnemyKind('stalker', {
  base: 'walker',                       // walker | brute | drone | flyer | turret
  name: 'Stalker',
  tint: { shirt: '#0a3', pants: '#021', accent: '#0fc' },
  scale: 1.2,
  update: (enemy, { dt, t, playerPos }) => {
    // runs after the base walker AI each tick — use engine.rng, not Math.random
  },
});
// then spawn it: { kind: 'stalker' as EnemyKind, count: 3, health: 60, ... }
\`\`\`

**Custom upgrade** (joins the level-up choice pool automatically):

\`\`\`ts
engine.hooks.registerUpgrade({
  id: 'vampire',
  name: 'Vampire Rounds',
  desc: 'Heal 5 HP on every kill',
  apply: (prog, avatar) => {
    engine.hooks.tap('onKill', () => avatar.heal(5));
  },
});
\`\`\`

## 3. New genre blueprint

A blueprint is just \`(engine: Engine, spec: GameSpec) => unknown\`. Copy \`src/game.ts\`,
rename the build function, wire it in \`src/main.ts\`. The engine hands you: \`engine.scene\`,
\`engine.physics\`, \`engine.hud\`, \`engine.audio\`, \`engine.juice\`, \`engine.rng\` (seeded —
use it for anything gameplay-affecting), plus the content systems in \`src/engine/game/\`
(\`EnemyManager\`, \`Projectiles\`, \`Pickups\`, \`Objectives\`, \`Progression\`).

Full class reference: the studio repo's \`docs/API.md\`.
`);

console.log(`Exported source project -> ${outDir}`);
console.log(`  game: "${spec.meta.name}" (${spec.meta.genre}, seed ${spec.meta.seed})`);
console.log(`  next: cd ${path.relative(process.cwd(), outDir)} && npm install && npm run dev`);
