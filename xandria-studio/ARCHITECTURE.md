# XANDRIA Studio — Architecture

XANDRIA Studio is the deterministic game-generation engine at the heart of this
repository. It turns a plain-language intent ("a spooky racing game in a frozen
wasteland") into a **validated, playable, exportable game** — with or without an
LLM in the loop.

The design rule that shapes everything below:

> **The LLM is optional seasoning. The engine is the guarantee.**
> Playability is enforced by schema validation + genre blueprints, never by
> hoping a model emits something coherent.

---

## 1. Pipeline overview

```
intent text ──► generator ──► GameSpec (validated) ──► blueprint ──► running game
                  │                                    │
                  └─ optional LLM flavor pass ─────────┘
                                                      │
                                               export ──┴──► single-file HTML
                                                      │
                                               electron ───► Windows / macOS / Linux app
```

1. **Generator** (`src/generator/`) maps keywords in the intent to genre,
   environment, mood and palette, scales difficulty, and produces a partial spec.
2. **Spec layer** (`src/spec/`) normalizes it over `defaultSpec(seed)` and runs
   `validateSpec`, which enforces *genre coherence* (racing ⇒ vehicle + chase
   camera, fps ⇒ first-person, platformer ⇒ side camera, top-down ⇒ top-down
   camera, …). An invalid spec can never reach a blueprint.
3. **Blueprints** (`src/blueprints/`) are five hand-tuned genre assemblies that
   wire the engine modules into a complete game loop: player, camera, enemies,
   pickups, objective, HUD, win/lose conditions.
4. **Engine** (`src/engine/`) is the genre-agnostic kernel: rendering, physics,
   audio, input, terrain, particles, characters, post-processing.
5. **Runtime** (`src/runtime/main.ts`) boots a spec in the browser; the same
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
│   │   │   ├── Sky.ts       gradient dome, sun/moon, stars, fog by time/weather
│   │   │   ├── PostFX.ts    bloom + retro shader (pixelate, quantize, vignette)
│   │   │   ├── Characters.ts procedural box-rig humanoids, drones, turrets, cars
│   │   │   └── Particles.ts pooled 4096-point particles + weather systems
│   │   ├── world/
│   │   │   ├── Terrain.ts   heightfield from spec.world.terrain, water plane
│   │   │   ├── Scatter.ts   instanced trees/rocks/crystals/ruins + colliders
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
│   │   │   ├── EnemyAI.ts         walker/brute/drone/flyer/turret + manager
│   │   │   ├── HUD.ts             DOM overlay: bars, objective, timer, screens
│   │   │   └── Objectives.ts      collect/eliminate/reach/survive/race/boss
│   │   └── Engine.ts        kernel: game states, fixed-step loop, substeps
│   ├── blueprints/
│   │   ├── common.ts        PlayerAvatar: health/lives/i-frames, weapons
│   │   ├── tpAction.ts      third-person action
│   │   ├── fpsArena.ts      FPS arena (pointer lock)
│   │   ├── racing.ts        laps, checkpoints, boost pads, rubber-band AI
│   │   ├── platformer.ts    side-view course, coin arcs, goal flag
│   │   ├── topdown.ts       twin-stick-ish top-down shooter
│   │   └── index.ts         BLUEPRINTS registry + GENRE_LABELS
│   ├── generator/
│   │   ├── generate.ts      deterministic intent→spec (keyword tables,
│   │   │                    13 environment palettes, difficulty scaling,
│   │   │                    seed = hash(intent))
│   │   └── llm.ts           optional OpenAI-compatible flavor enrichment
│   │                        (name/desc/palette/mood only — then re-validated)
│   ├── runtime/main.ts      boot: spec priority = window.__XANDRIA_SPEC__ →
│   │                        ?spec= (base64url) → ?intent= → demo
│   └── studio/studio.ts     Studio UI: prompt, presets, live preview iframe,
│                            Export (single-file HTML), Share link
├── scripts/export.ts        CLI: intent/spec → standalone HTML game file
├── electron/                main.cjs + preload.cjs (save-file IPC)
├── player.html              player entry (dark boot splash)
├── index.html               studio entry
└── tests/
    ├── *.test.ts            vitest: schema, generator, rng
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
| `pickups`  | health/ammo/score/boost with counts and values |
| `rules`    | timeLimit, friendlyFire, fallDamage, gravityScale |
| `audio`    | tempo, key, mood → generative soundtrack params |

`validateSpec` checks types, ranges, enum membership **and cross-field
coherence**. `normalizeSpec` deep-merges any partial over seeded defaults, so
generators only specify what they care about. `stableStringify` gives a
canonical serialization for share links, caching and tests.

Determinism: `seed` drives `Rng` everywhere (terrain, scatter, enemy placement,
name generation). Same spec ⇒ same game, every time.

## 4. Blueprint contract

A blueprint is:

```ts
interface Blueprint {
  genre: Genre;
  build(engine: Engine, spec: GameSpec): BlueprintInstance;
}
interface BlueprintInstance {
  onUpdate?(dt: number): void;   // per-fixed-step game logic
  dispose(): void;               // full teardown for restart/regeneration
}
```

Blueprints never touch the renderer directly — they compose engine modules.
This keeps genre code small (150–300 lines each) and forces reusable mechanics
down into the engine where all genres benefit.

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
screenshots for visual QA. A seventh test boots an exported standalone HTML
file with **network disabled** to prove offline playability.

## 6. Export & packaging

- **Standalone HTML**: `vite-plugin-singlefile` inlines everything (three.js,
  cannon-es, all assets — they're procedural, so there's nothing external)
  into one ~740 KB file (~200 KB gzip). The Studio injects
  `window.__XANDRIA_SPEC__` after `<head>` and hands you a file that runs from
  disk with no server, no network.
- **CLI**: `npm run export -- --intent "neon cyberpunk fps" -o game.html`.
- **Desktop app**: Electron loads the Studio; electron-builder produces
  Windows (NSIS installer + portable .exe), macOS (.dmg) and Linux (AppImage)
  artifacts via `.github/workflows/studio-ci.yml`.

## 7. Where the LLM fits (and doesn't)

`src/generator/llm.ts` accepts any OpenAI-compatible endpoint. It may only
suggest: display name, description, palette accents, mood, music tempo. Its
output passes through `normalizeSpec` + `validateSpec` like everything else —
if it hallucinates an invalid value, that field is dropped silently and the
deterministic value stands. Remove the LLM entirely and every feature of the
engine still works.

## 8. Performance notes

- InstancedMesh for all scatter/structures (a city is ~10 draw calls).
- Pooled particles and projectiles — zero allocation in the hot loop.
- One heightfield physics body + static boxes only; dynamic bodies ≤ ~40.
- Retro post shader doubles as a resolution scaler (`pixelRatio 0.66`),
  which is how "PS2-level" becomes a *style choice* instead of a compromise.
