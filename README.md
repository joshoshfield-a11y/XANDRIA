# XANDRIA

**Type a sentence. Get a playable game. Keep it as an app.**

XANDRIA is a deterministic game-generation engine. You describe a game —
*"a spooky racing game in a frozen wasteland"*, *"neon cyberpunk arena shooter"* —
and it produces a validated, winnable, losable game with procedural 3D graphics,
generative music, and a complete game loop. Export it as a single HTML file that
runs offline, or install the Studio as a desktop app.

No model roulette: an LLM can add flavor, but playability is guaranteed by
schema validation and hand-tuned genre blueprints.

## What it generates

Five genre blueprints, all playable out of the box — and every game is a
**mini-campaign**, not an arcade loop:

| Genre | Camera | Mechanics |
|---|---|---|
| Third-person action | orbit | melee combos, dashes, enemy waves, boss objectives |
| FPS arena | first-person (pointer lock) | blaster/rifle/shotgun, drones, turrets, pickups |
| Racing | chase | laps, checkpoints, boost pads, drift, rubber-band AI racers |
| Platformer | side view | double-jump, glide, coin arcs, moving hazards, goal flag |
| Top-down shooter | top-down | twin-stick combat, cover, elimination/survival objectives |

Each generated game runs a multi-stage quest chain (chapters): a narrative
premise card opens the run, chapter banners mark each new objective stage,
and a win/lose story card closes it. Kills and pickups earn XP; every level
offers a choice of upgrades (damage, health, speed, fire rate, magnet,
dash cooldown). Bosses fight in phases — they speed up and hit harder at
66% and 33% health, with an on-screen warning when they enrage.

Worlds are themed across 13 environments (desert, tundra, neon city, volcanic,
dreamscape, …) with day/night, weather, and seeded terrain — every game is
reproducible from its spec.

## Quick start

```bash
cd xandria-studio
npm install

# Open the Studio (prompt → preview → export)
npm run dev

# Or generate a game straight from the CLI
npm run export -- --intent "a hard platformer in a crystal dreamscape" -o my-game.html
```

Open `my-game.html` in any browser — it works from disk, fully offline.
`npm run export` also drops a `my-game-itch.zip` next to it: the game as
`index.html` plus a README, an itch.io upload guide, and a generated cover
thumbnail — ready to upload as an HTML5 project on itch.io.

## Desktop app (Windows / macOS / Linux)

```bash
cd xandria-studio
npm install
npm run dist        # electron-builder → installers in release/
```

- **Windows**: NSIS installer + portable `.exe`
- **macOS**: `.dmg`
- **Linux**: AppImage

Tagged releases on GitHub build all three automatically
(see `.github/workflows/studio-ci.yml`).

## How it works

```
intent ──► deterministic generator ──► GameSpec (validated) ──► quest campaign ──► genre blueprint ──► game
```

- **GameSpec** (`src/spec/schema.ts`) is the contract: theme, world, player,
  enemies, objective, rules, audio — plus `narrative` (premise / win / lose
  text) and `progression` (XP rates). `validateSpec` enforces genre coherence
  and per-stage winnability, so a broken game is *unrepresentable*.
- **Quest campaigns** turn one objective into a chapter chain: the generator
  emits `objective.stages` (e.g. survive → eliminate → boss), the engine's
  `Objectives` sequencer walks them with per-stage timers, `Progression`
  tracks XP/levels/upgrades, `HUD` shows intro/chapter/level-up/end cards,
  and bosses phase-shift at 66%/33% health.
- **Blueprints** (`src/blueprints/`) assemble the engine (three.js rendering,
  cannon-es physics, WebAudio synth) into complete game loops.
- The **LLM adapter** (`src/generator/llm.ts`) is optional and constrained to
  flavor: names, descriptions, palette accents. Its output is re-validated;
  anything invalid is silently discarded.

Full details: **[xandria-studio/ARCHITECTURE.md](xandria-studio/ARCHITECTURE.md)**.
How this engine realizes the legacy 72/216-operator lattice:
**[xandria-studio/docs/OPERATOR-MAP.md](xandria-studio/docs/OPERATOR-MAP.md)**.

## Testing

```bash
cd xandria-studio
npm test            # vitest: schema, generator, campaign systems, RNG (130 tests)
npm run test:e2e    # Playwright: every genre boots, plays, zero errors
```

The e2e suite literally plays the games (fixed timestep + simulation substeps)
and fails on any console error.

## Repository layout

```
xandria-studio/     The engine, Studio app, CLI, tests — all active development
legacy/             Everything that came before: the v7.0-prime React/Three/Gemini
                    demo, the XANDRIAv3.0 72-operator lattice, OPERATORS.md and
                    the original docs, preserved untouched for reference
```

The legacy operator lattice lives on as XANDRIA Studio's design vocabulary —
see the operator mapping above.

## License

XANDRIA is licensed under the **XANDRIA Commercial License v1.0**.

- **Personal / non-commercial use**: Free with attribution. See [`LICENSE`](LICENSE) for full terms.
- **Commercial use**: Requires a paid license. Contact [joshoshfield-a11y](https://github.com/joshoshfield-a11y) for licensing inquiries.

By using this software, you acknowledge that you have read, understood, and agree to be bound by the terms of the `LICENSE` file.
