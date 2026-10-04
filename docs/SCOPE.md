# XANDRIA Studio — Product Scope (v1.3.0)

Date: 2026-10-04. Supersedes `docs/V1-LOCK.md` (2026-09-06, one-genre lock).

## What ships

- **Five playable genres** in the Studio UI: third-person action, FPS arena,
  racing, platformer, top-down shooter. All five boot, play, and have
  winnable/losable objectives.
- **Quest campaigns**: every generated game is a mini-campaign — a multi-stage
  quest chain (chapters) with a narrative premise card, chapter banners, XP +
  levels + upgrade choices, and phased bosses (enrage at 66%/33% HP). Victory
  and defeat screens show narrative text and run stats.
- **Deterministic generator**: intent → validated `GameSpec` → genre
  blueprint. Same spec ⇒ same world, every time (seeded `Rng`; gameplay runs
  variable-dt, so replays are not frame-identical).
- **Spec inspector**: `<xandria-spec-inspector>` panel in the Studio; edits
  apply to the preview via `specInspector` patch logic.
- **Export**: single-file offline HTML (three.js/cannon-es inlined) via the
  Studio button or `npm run export -- --intent "..." --out game.html`.
  Every CLI export also produces a `game-itch.zip` (index.html + README.txt +
  itch.io upload guide + generated 630×500 cover art) ready to upload as an
  itch.io HTML5 project. Exports belong to the user (`docs/EXPORT-LICENSE.md`).
- **Desktop**: Electron wrapper + electron-builder installers (win/mac/linux)
  via CI on tagged releases.
- **LLM (optional)**: flavor/architect modes over any OpenAI-compatible
  endpoint; validation-gated; engine works fully without it.
- **Legacy bridge**: the frozen 72-operator vocabulary
  (`src/generator/operators.ts`) recognizes lattice-era `OP-N`/name intents.

## Quality bar

- `tsc --noEmit` clean, `vitest` green (130 tests), Playwright boots all five
  genres with zero console errors.
- Every generated spec must validate AND be winnable — per quest stage
  (stage counts ≤ available enemies/pickups; genre/objective coherence).
- The 20-seed stranger set (`src/generator/seedSet.ts`) must generate,
  validate, and pass winnability checks.

## Explicitly out of scope

Multiplayer, branching dialogue/quest graphs, persistent cross-run
progression, Steam/console signing, accounts, cloud sync, billing, hosted-LLM
requirement, per-blueprint `dispose()` without page reload (restart = reload
for now), bit-identical gameplay replays.
