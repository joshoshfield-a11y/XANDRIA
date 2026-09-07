# XANDRIA Studio — v1 Product Lock

Date: 2026-09-06
Status: BINDING for v1. Anything not listed here is out of scope until the acceptance criteria pass.

## Genre Freeze

v1 ships exactly one genre in the studio UI: **third-person action** (`blueprints/tpAction.ts`).

Rationale:
- tpAction is the only blueprint where the procedural character pipeline (ModelForge → Characters, weapon mounts, limb rigs) is visible on screen. That is the engine's most distinctive asset; first-person hides it.
- The camera system already supports a follow/orbit rig (`CameraKind`), so the hard part of third-person is not net-new work.
- Full RPG systems (inventory, dialogue trees, quest state) are explicitly deferred. RPG-lite (XP, damage numbers, one upgrade track) may enter only after the acceptance criteria below pass.
- FPS arena, platformer, racing, and topdown remain in the codebase but are hidden from the v1 UI.

## v1 Product Definition

A stranger must be able to:
1. Type a one-sentence prompt.
2. Play a ~3-minute third-person game that does not look like debug geometry.
3. Change seed, difficulty, enemy count, palette, and time-of-day from an inspector panel without regenerating the whole world.
4. Export a single-file HTML build they legally own.
5. See five public example exports before ever installing anything.

## Acceptance Criteria (all must pass)

- [ ] Default asset/SFX pack loads; procedural primitive fallback is a debug flag, not the demo.
- [ ] Spec inspector edits apply live to the iframe preview (see `src/studio/inspector/specInspector.ts`).
- [ ] 20 fixed seeds produce games a first-time player can tell apart within 3 minutes.
- [ ] Exported HTML includes pause, settings, and a win condition that is not only timer/death.
- [ ] License states in one paragraph: exports belong to the user; engine remains the author's.
- [ ] Five exports published (itch.io or GitHub Release) with an unedited capture.

## Explicitly Out Of Scope For v1

Multiplayer, campaigns, dialogue/quest graphs, Steam/console signing, accounts, cloud sync, billing, hosted-LLM requirement, additional genres, Electron as the primary path (Electron is Save-As only; web player is primary).

## Change Control

Changes to this file require a log entry in the perplexity-knowledge-base repo under `logs/` referencing the commit SHA.
