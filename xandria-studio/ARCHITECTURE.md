# XANDRIA Studio — Architecture

XANDRIA Studio is the deterministic game-generation engine at the heart of this
repository. It turns a plain-language intent ("a spooky racing game in a frozen
wasteland") into a **validated, playable, exportable game** — with or without an
LLM in the loop. Every game it generates is a **mini-campaign**: a multi-stage
quest chain with narrative framing, XP/levels/upgrades, and phased bosses —
not a single arcade loop.

The design rule that shapes everything below:

> **The LLM is optional seasoning. The engine is the guarantee.**
> Playability is enforced by schema validation + genre blueprints, never by
> hoping a model emits something coherent.

---

## 1. Pipeline overview

```
intent text ──► generator ──► GameSpec (validated) ──► campaign ──► blueprint ──► running game
                  │                                (quest stages,                    │
                  └─ optional LLM flavor pass ─────► narrative, XP)                   │
                                                                                     │
                                                              export ──┬──► single-file HTML
                                                                       │    (+ itch.io zip)
                                                                       │
                                                              electron ───► Windows / macOS / Linux app
```

1. **Generator** (`src/generator/`) maps keywords in the intent to genre,
   environment, mood and palette, scales difficulty, and produces a partial spec —
   including a **quest chain** (`objective.stages`: e.g. survive → eliminate →
   boss), deterministic **narrative** text (premise / win / lose), and a
   **progression** config (XP per kill/pickup).
2. **Spec layer** (`src/spec/`) normalizes it over `defaultSpec(seed)` and runs
   `validateSpec`, which enforces *genre coherence* (racing ⇒ vehicle + chase
   camera, fps ⇒ first-person, platformer ⇒ side camera, top-down ⇒ top-down
   camera, …) **and per-stage winnability** (each quest stage must be completable
   with the entities the spec spawns). An invalid spec can never reach a blueprint.
3. **Campaign systems** (`src/engine/game/`) turn the quest chain into a run:
   `Objectives` sequences stages with per-stage timers, `Progression` tracks
   XP/levels/upgrade choices, `HUD` renders intro/chapter/level-up/end cards,
   `EnemyAI` phase-shifts bosses at 66%/33% HP.
4. **Blueprints** (`src/blueprints/`) are five hand-tuned genre assemblies that
   wire the engine modules into a complete game loop: player, camera, enemies,
   pickups, objective, HUD, win/lose conditions. Shared campaign wiring lives in
   `src/blueprints/campaign.ts` (intro cards, chapter banners, level-up flow,
   boss banners, multiplier hooks).
5. **Engine** (`src/engine/`) is the genre-agnostic kernel: rendering, physics,
   audio, input, terrain, particles, characters, post-processing.
6. **Runtime** (`src/runtime/main.ts`) boots a spec in the browser; the same
   bundle powers the Studio preview iframe, exported standalone HTML files, and
   the Electron app.

## 2. Directory map

```
xandria-studio/
├── src/
│   ├── spec/            GameSpec contract — the single source of truth
│   │   ├── schema.ts      types, const unions, defaultSpec, normalizeSpec,
│   │   │                  validateSpec (hand-rolled, zero deps), stableStringify
│   │   └── index.ts       re-exports (@spec alias target)
│   ├── engine/
│   │   ├── core/
│   │   │   ├── Rng.ts       seeded mulberry32-style RNG + helpers
│   │   │   ├── Input.ts     keyboard/mouse/pointer-lock abstraction
│   │   │   ├── Audio.ts     WebAudio generative music + SFX synth
│   │   │   └── Physics.ts   cannon-es world, materials, raycast helpers
│   │   ├── gfx/
│   │   │   ├── Materials.ts palette-driven MeshStandardMaterial library
│   │   │   ├── Sky.ts       day/dusk: physical Preetham atmosphere; night: gradient
│   │   │   │                dome + stars; fog by time/weather
│   │   │   ├── Atmosphere.ts  OP-22 port: turbidity/Rayleigh/Mie from spec
│   │   │   ├── ModelForge.ts  deterministic parametric model synthesis — forged
│   │   │   │                body plans, headgear, armor, vehicle/drone variants
│   │   │   ├── PostFX.ts    bloom + retro shader (pixelate, quantize, vignette)
│   │   │   ├── Characters.ts forged rigs (humanoids, drones, turrets, cars) with
│   │   │   │                the shared CharacterRig animation contract
│   │   │   └── Particles.ts pooled 4096-point particles + weather systems
│   │   ├── world/
│   │   │   ├── Terrain.ts   heightfield from spec.world.terrain, water plane
│   │   │   ├── Scatter.ts   instanced rocks/crystals/ruins + colliders
│   │   │   ├── Vegetation.ts  OP-08 port: species flora (pine/oak/palm/cactus/
│   │   │   │                deadtree/mushroom/crystalflora), 3 LOD tiers
│   │   │   │                rebucketed by camera distance, GPU wind sway
│   │   │   └── Structures.ts city blocks, arena cover, platforms, race track
│   │   ├── game/
│   │   │   ├── Cameras.ts         third-person / first-person / top-down /
│   │   │   │                      side / chase rigs with ground clamping
│   │   │   ├── CharacterController.ts  capsule locomotion: coyote time,
│   │   │   │                      double-jump, dash, glide, sprint, melee swing
│   │   │   ├── VehicleController.ts    RaycastVehicle: RWD, drift handbrake,
│   │   │   │                      boost meter, flip auto-respawn
│   │   │   ├── Projectiles.ts     pooled tracers with raycast collision
│   │   │   ├── Pickups.ts         magnet-attracted collectibles
│   │   │   ├── EnemyAI.ts         walker/brute/drone/flyer/turret + manager;
│   │   │   │                      boss phase shifts at 66%/33% HP
│   │   │   ├── HUD.ts             DOM overlay: bars, objective, timer, screens;
│   │   │   │                      story cards (intro/chapter/level-up/end)
│   │   │   ├── Objectives.ts      stage sequencer: walks objective.stages in
│   │   │   │                      order (per-stage timers); legacy single
│   │   │   │                      objective behavior unchanged when absent
│   │   │   └── Progression.ts     XP/levels: xpForNext curve, 6-upgrade pool,
│   │   │                          3 choices per level-up, stacked multipliers
│   │   └── Engine.ts        kernel: game states, variable-dt loop (physics on fixed 1/60 substeps)
│   ├── blueprints/
│   │   ├── common.ts        PlayerAvatar: health/lives/i-frames, weapons
│   │   ├── campaign.ts      shared quest wiring: intro card, chapter banners,
│   │   │                    level-up modal flow, boss-phase banners, XP helpers
│   │   ├── tpAction.ts      third-person action
│   │   ├── fpsArena.ts      FPS arena (pointer lock)
│   │   ├── racing.ts        laps, checkpoints, boost pads, rubber-band AI
│   │   ├── platformer.ts    side-view course, coin arcs, goal flag
│   │   ├── topdown.ts       twin-stick-ish top-down shooter
│   │   └── index.ts         BLUEPRINTS registry + GENRE_LABELS
│   ├── generator/
│   │   ├── generate.ts      deterministic intent→spec (keyword tables,
│   │   │                    13 environment palettes, difficulty scaling,
│   │   │                    quest-stage chains, narrative text,
│   │   │                    seed = hash(intent))
│   │   └── llm.ts           optional OpenAI-compatible flavor enrichment
│   │                        (name/desc/palette/mood only — then re-validated)
│   ├── runtime/main.ts      boot: spec priority = window.__XANDRIA_SPEC__ →
│   │                        ?spec= (base64url) → ?intent= → demo
│   └── studio/studio.ts     Studio UI: prompt, presets, live preview iframe,
│                            Export (single-file HTML), Share link
├── scripts/
│   ├── export.ts        CLI: intent/spec → standalone HTML + itch.io zip
│   ├── zip.ts           dependency-free ZIP writer (node:zlib deflate)
│   └── cover.ts         generated 630×500 PNG cover (pure-TS encoder,
│                        embedded pixel font, styled from the spec palette)
├── electron/                main.cjs + preload.cjs (save-file IPC)
├── player.html              player entry (dark boot splash)
├── index.html               studio entry
└── tests/
    ├── *.test.ts            vitest: schema, generator, rng, quest stages,
    │                        campaign systems (130 tests)
    └── e2e/playability.spec.ts  Playwright: every genre boots, accepts input,
                                 runs ≥N simulated frames, zero console errors;
                                 exported HTML boots fully offline
```

## 3. The GameSpec contract

Everything a game needs is one JSON object:

| Section    | Contents |
|------------|----------|
| `meta`     | name, description, genre, difficulty, seed |
| `theme`    | environment, timeOfDay, weather, mood, 10-color palette |
| `world`    | size, terrain type/roughness, scatter density, boundary, structures |
| `player`   | type (humanoid/vehicle), camera, speed, jump, abilities, weapon, health, lives |
| `enemies`  | array of { kind, count, health, speed, damage, weapon? } |
| `objective`| type + target (collect N, eliminate N, reach goal, survive T, race laps, boss) |
| `objective.stages` | optional quest chain: ordered stages, each with own type/count/timeLimit/description |
| `narrative`| premise (intro card), winText, loseText — deterministic, from genre/mood/environment |
| `progression` | XP config: enabled, xpPerKill, xpPerPickup |
| `pickups`  | health/ammo/score/boost with counts and values |
| `rules`    | lives, difficulty |
| `audio`    | tempo, key, mood → generative soundtrack params |

`validateSpec` checks types, ranges, enum membership **and cross-field
coherence** — including **per-stage winnability**: every quest stage must be
completable with the entities the spec actually spawns (e.g. an eliminate-12
stage needs ≥12 killable enemies), with error paths like
`objective.stages[1].count`. `normalizeSpec` deep-merges any partial over seeded
defaults, so generators only specify what they care about. `stableStringify`
gives a canonical serialization for share links, caching and tests.

Determinism: `seed` drives `Rng` everywhere world geometry is generated
(terrain, scatter, enemy placement, name generation, ModelForge plans).
Same spec ⇒ same world, every time. Note: live gameplay runs on a
variable-dt loop, so long play sessions can diverge frame-to-frame;
determinism covers generation, not moment-to-moment replay.

## 4. Blueprint contract

A blueprint is a plain function registered in `src/blueprints/index.ts`:

```ts
type BlueprintFn = (engine: Engine, spec: GameSpec) => unknown;
```

It subscribes game logic to the engine via `engine.onUpdate(fn)` and composes
engine modules (enemies, projectiles, objectives, HUD). Blueprints never touch
the renderer directly — this keeps genre code small (120–160 lines each) and
forces reusable mechanics down into the engine where all genres benefit.

Note: there is currently no per-blueprint `dispose()` — restarting a game
reloads the page. Full teardown without reload is future work.

## 4b. Quest campaigns

The campaign layer is what makes each game more than an arcade loop. The
generator emits a quest chain (`objective.stages`) plus narrative and
progression config; the engine and blueprints execute it:

- **`Objectives` (stage sequencer)** — walks `stages` in order, each with its
  own progress counter and `timeLimit`. `onStageComplete(index, stage)` fires
  per stage (blueprints show a chapter banner); the final stage calls
  `engine.win()` with `{ kills, stagesCleared, level }`. When `stages` is
  absent the legacy single-objective behavior is byte-identical.
- **`Progression`** — XP/level system. `xpForNext(level) = round(100·level^1.5)`;
  `onKill()`/`onPickup()` add spec-configured XP and return true on level-up.
  Each level-up offers 3 distinct upgrades drawn (seeded) from a 6-pool:
  damage +25%, max HP +15% & heal, speed +12%, fire rate +20%, pickup
  magnet +50%, dash cooldown −25%. Multipliers stack multiplicatively and are
  exposed as `damageMult()` / `speedMult()` / `magnetMult()` / `dashCdMult()`
  for blueprints to apply. Clean no-op when `progression.enabled` is false.
- **`HUD` story cards** — `showCard(title, body)` for the intro premise and
  chapter banners (non-blocking, auto-dismiss); `showLevelUp(choices)` pauses
  the game until the player picks an upgrade; `showEnd(win, stats)` renders
  the narrative win/lose text with run stats (score, time, kills, level,
  chapters cleared).
- **Boss phases** (`EnemyAI`) — brute-kind enemies in boss stages get
  `isBoss`; at ≤66% and ≤33% HP they gain +25% speed / +30% aggression and
  fire `onPhase`, which blueprints turn into an enrage banner. Ordinary
  enemies are unaffected.
- **Blueprint wiring** (`src/blueprints/campaign.ts`) — shared helpers:
  `showIntroCard`, `makeCampaignObjectives` (chapter banners + HUD objective
  refresh + level provider for win stats), `makeLevelUpFlow` (queued modals),
  `grantKillXp` / `grantPickupXp`, `bossPhaseBanner`. Racing is special-cased:
  XP on laps/checkpoints, level-ups auto-apply speed (no modal — only speed
  is meaningful for a car).

Generator quest chains per genre (deterministic, from seed):
fps-arena eliminate→boss · third-person-action collect→eliminate→reach ·
platformer collect→reach · top-down-shooter survive→eliminate→boss ·
racing single race stage with narrative framing.

## 5. Test mode — how CI plays games

Real-time games can't be e2e-tested on a 3-FPS software rasterizer. So
`?test=1` activates:

- fixed `dt = 1/60`,
- **10 simulation substeps per rendered frame** (sim time decouples from GPU),
- muted audio, deterministic seed,
- `window.__XANDRIA__ = { engine, spec, blueprint, errors }` introspection,
- `__XANDRIA_ERRORS` capture of every console error / unhandled rejection.

Playwright then: boots each genre, injects movement input, asserts simulated
frames advance, asserts player state changed, asserts **zero** errors, and
screenshots for visual QA. A sixth test builds a real export (spec injected
into the single-file bundle, exactly like `scripts/export.ts`) and boots it
from `file://` in a fully offline browser context — proving the export needs
no network.

## 6. Export & packaging

- **Standalone HTML**: `vite-plugin-singlefile` inlines everything (three.js,
  cannon-es, all assets — they're procedural, so there's nothing external)
  into one ~840 KB file (~250 KB in the zip). The Studio injects
  `window.__XANDRIA_SPEC__` after `<head>` and hands you a file that runs from
  disk with no server, no network.
- **CLI**: `npm run export -- --intent "neon cyberpunk fps" -o game.html`.
  Every export also writes `game-itch.zip` (unless `--no-zip`), a distributable
  bundle containing:
  - `index.html` — the game (itch.io requires this name at the zip root),
  - `README.txt` — story, quest chapters, controls, credits,
  - `itch-upload-guide.txt` — upload checklist: HTML project kind, 1280×720
    viewport, cover art, pricing, troubleshooting,
  - `cover.png` — generated 630×500 cover thumbnail (pure-TS PNG encoder +
    embedded pixel font in `scripts/cover.ts`, styled from the game's own
    palette; deterministic per seed; zero external assets).
  The zip is built by a dependency-free writer (`scripts/zip.ts`, node:zlib
  only) and uploads directly as an itch.io HTML5 project.
- **Desktop app**: Electron loads the Studio; electron-builder produces
  Windows (NSIS installer + portable .exe), macOS (.dmg) and Linux (AppImage)
  artifacts via `.github/workflows/studio-ci.yml`.

## 7. Where the LLM fits (and doesn't)

`src/generator/llm.ts` accepts any OpenAI-compatible endpoint, in two modes:

- **flavor** — the LLM may only suggest display name, description, palette
  accents, mood, music tempo.
- **architect** — the LLM proposes a full partial spec: theme, world, enemies,
  weapons, and the freeform `custom` layer (biome tuning, forge hints, enemy /
  weapon mods, quality, asset packs). This is the "describe it → make it" path.

Either way, output is merged onto the deterministic base and passes through
`validateSpec` + `normalizeSpec` like everything else. Architect mode falls
back architect → flavor → deterministic on any failure. Remove the LLM
entirely and every feature of the engine still works.

## 7b. The custom layer (spec.custom)

`custom` is the freeform creativity layer of the GameSpec contract:

- `quality`: `retro` (pixelated PS2 look), `standard` (clean, no pixelation),
  `high` (no retro pass, full device pixel ratio).
- `biome`: terrain frequency/height multipliers, water level bias, and
  `floraMix` — arbitrary weighted mixes of all seven flora species, decoupled
  from the environment preset.
- `forge`: humanoid/vehicle design hints (head style, armor, bulk, height,
  spoiler) that override ModelForge's seeded rolls.
- `enemyMods`: size/speed/aggression multipliers and glow color for all enemies.
- `weaponMods`: projectile speed, fire rate, spread, pellet count, beam color.
- `assets`: opt-in **online** GLTF/GLB pack URLs, loaded by
  `src/engine/gfx/AssetBridge.ts` with hard timeouts and scattered as hero
  props. Additive only — any failure keeps the procedural world.

## 8. Performance notes

- InstancedMesh for all scatter/structures (a city is ~10 draw calls).
- Pooled particles and projectiles — zero allocation in the hot loop.
- One heightfield physics body + static boxes only; dynamic bodies ≤ ~40.
- Retro post shader doubles as a resolution scaler (`pixelRatio 0.66`),
  which is how "PS2-level" becomes a *style choice* instead of a compromise.
