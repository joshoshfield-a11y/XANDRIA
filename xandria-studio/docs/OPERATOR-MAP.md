# Operator Lattice → Engine Mapping

The legacy XANDRIA v3.0 design described games as compositions over a symbolic
**operator lattice**: a 72-operator core (`OPERATORS_72`) expanded to a 216-entry
catalog (`OPERATORS.md`). That system was expressive but had no executable
semantics — operators were tokens a model rearranged, and nothing guaranteed the
result was a playable game.

XANDRIA Studio keeps the lattice as a **vocabulary** and gives every operator a
deterministic implementation. This document is the rosetta stone: each legacy
operator family, and the module that now executes it.

## How to read this table

- **Operators** counts entries from the legacy 216-operator catalog per family.
- **Core 72** marks families present in the original 72-operator lattice.
- **Studio implementation** is the file(s) that realize the family today.

| # | Legacy family | Operators | Core 72 | Studio implementation |
|---|---------------|-----------|---------|------------------------|
| 1 | GENESIS — world seeding & creation | 12 | ✓ | `src/generator/generate.ts`, `src/engine/core/Rng.ts` |
| 2 | TERRA — terrain shaping | 10 | ✓ | `src/engine/world/Terrain.ts` |
| 3 | CAELUM — sky, time of day, weather | 9 | ✓ | `src/engine/gfx/Sky.ts` + `Atmosphere.ts` (physical Preetham sky), `Particles.ts` (weather) |
| 4 | MATERIA — palettes & materials | 8 | ✓ | `src/engine/gfx/Materials.ts`, `spec.theme.palette` |
| 5 | STRUCTURA — buildings, arenas, tracks | 11 | ✓ | `src/engine/world/Structures.ts` |
| 6 | FLORA — scatter & props | 7 | ✓ | `src/engine/world/Vegetation.ts` (species/LOD/wind flora), `Scatter.ts` |
| 7 | CORPUS — character bodies | 9 | ✓ | `src/engine/gfx/ModelForge.ts` + `Characters.ts` (seeded forged rigs) |
| 8 | MOTUS — locomotion & movement | 12 | ✓ | `src/engine/game/CharacterController.ts` |
| 9 | VEHICULUM — vehicles & driving | 8 | ✓ | `src/engine/game/VehicleController.ts` |
| 10 | VISUS — cameras & framing | 8 | ✓ | `src/engine/game/Cameras.ts` |
| 11 | HOSTIS — enemies & AI behaviors | 12 | ✓ | `src/engine/game/EnemyAI.ts` |
| 12 | ARMA — weapons & projectiles | 10 | ✓ | `src/blueprints/common.ts`, `src/engine/game/Projectiles.ts` |
| 13 | PRAEMIUM — pickups & rewards | 7 | ✓ | `src/engine/game/Pickups.ts` |
| 14 | SCOPUS — objectives & win/lose | 11 | ✓ | `src/engine/game/Objectives.ts` |
| 15 | NEXUS — physics & collision | 9 | ✓ | `src/engine/core/Physics.ts` |
| 16 | IACTUS — forces, impulses, knockback | 6 | ✓ | `Physics.ts`, `VehicleController.ts` |
| 17 | LUX — lighting & post-processing | 8 | ✓ | `src/engine/gfx/PostFX.ts`, `Sky.ts`, `Engine.ts` |
| 18 | PARTICULA — VFX & particles | 8 | ✓ | `src/engine/gfx/Particles.ts` |
| 19 | SONUS — music & sound | 9 | ✓ | `src/engine/core/Audio.ts` |
| 20 | SENSUS — input & controls | 7 | ✓ | `src/engine/core/Input.ts` |
| 21 | IUDICIUM — rules, difficulty, timers | 8 | ✓ | `spec.rules`, `Objectives.ts`, `generator/generate.ts` |
| 22 | ORDO — game states & flow | 7 | ✓ | `src/engine/Engine.ts` (loading/ready/playing/paused/won/lost) |
| 23 | FACIES — HUD & UI | 8 | ✓ | `src/engine/game/HUD.ts` |
| 24 | FABULA — naming & flavor text | 6 | ✓ | `src/generator/generate.ts` (+ optional `llm.ts`) |
| 25 | MACHINA — generation orchestration | 10 | ✓ | `src/generator/`, `src/runtime/main.ts`, `scripts/export.ts` |
| 26 | VINCULUM — contracts & validation | 7 | ✓ | `src/spec/schema.ts` (validateSpec / normalizeSpec) |
| 27 | ITERUM — determinism & replay | 5 | ✓ | `Rng.ts`, `stableStringify`, Engine test-mode substeps |
| 28 | EXIRE — export & packaging | 6 | ✓ | `scripts/export.ts`, `electron/`, vite single-file build |
| | **Total** | **216** | | |

## The semantic shift

| Legacy lattice (v3.0) | XANDRIA Studio |
|---|---|
| Operators are prompt tokens | Operators are typed spec fields + engine modules |
| Composition by LLM attention | Composition by blueprint code |
| Validation: none (hope) | Validation: `validateSpec`, 100% of generated specs |
| Output: a demo scene | Output: a playable, winnable/losable, exportable game |
| Determinism: none | Determinism: seeded end-to-end, bit-identical replays |

Any prompt written in the old operator vocabulary still works: the generator's
keyword tables recognize the operator names themselves, so lattice-era intents
degrade gracefully into modern specs.
