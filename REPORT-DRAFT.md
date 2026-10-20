# Skills Wave — Final Report

**Branch:** `feature/upgrade-skills` (worktree `~/workspace/xandria/qa/upgrade-loop/wc-skills/`)
**Base:** main `dcccc91b` (auth+quota wave)
**Date:** 2026-10-19
**Status:** MERGE-READY (all gates green)

## What was built

### 1. Skill system (`src/engine/game/skills.ts`, new)

Data-driven skill definitions + per-skill XP/rank progression:

- **`SKILL_DEFS`** — 3 skills, all tuning in one table: `foraging`, `smithing`, `alchemy`.
  Each def: id, name, desc, `xpThresholds` (cumulative XP for ranks 1..3, e.g. foraging
  `[0, 60, 180]`), per-event XP (`xpPerHarvest: 8`, `xpPerCraft: 12`), per-rank effect
  magnitudes (`yieldBonus: [0,1,2]`, `craftTimeMult: [1, 0.9, 0.75]`), and one honest
  effect line per rank rendered verbatim by the UI.
- **`SkillSystem`** (blueprint-owned, like `Progression`): `rankOf`/`xpOf`,
  `addXp` (fires `onRankUp` once per rank gained, plays the `levelup` audio cue —
  same as Progression), `onHarvest()` (foraging XP), `onCraft(stationId)` (alchemy XP
  at the alchemy station, smithing XP everywhere else — `craftSkillForStation`),
  `harvestYieldBonus()` (flat deterministic +materials per harvest),
  `craftTimeMult(stationId)` (queue speed per station skill),
  `xpForNextRank`/`progressToNext` for the UI, `portalSnapshot`/`portalRestore`
  (PORTALS-D pattern, defensive clamps, unit-tested).
- **Determinism:** no RNG anywhere in the module. XP comes only from fixed-value
  gameplay events; ranks derive from the fixed threshold table. A unit test
  perturbs `Math.random` and asserts identical outcomes.
- **Resolvers** (enemyTuning/crafting pattern): `resolveSkillsEnabled(spec)`
  (default true), `resolveSkillsXpMultiplier(spec)` (default 1, sanitized 0..10).
- `SkillsLike` — the minimal `{ rankOf, skillName }` surface `checkCraft()` needs.

### 2. Skill-gated recipes (the crafting wave's `skillId` stub, now real)

- `CraftingRecipe` gains `minSkillRank?: number` (default 1); the `skillId` doc
  comment updated from STUB to the real contract.
- `checkCraft`/`craft` check order is now
  `crafting-disabled → recipe-not-found → unknown-output/unknown-ingredient →
  min-level → missing-skill → missing-station → missing-ingredients → no-room`.
  New `CraftFailureReason` `'missing-skill'` with honest detail, e.g.
  `"Requires Smithing rank 2 (you are rank 1)."`. Omitted `skills` = rank 0
  (fail closed); unknown skill ids are rank 0.
- Catalog gates: Iron Edge (anvil) smithing 2, Scrap Buckler (workbench) smithing 1,
  Ember Tonic (alchemy) smithing… alchemy 2, Spark Charge (forge) smithing 1,
  Grip Wrap (workbench) smithing 1, Alloy Greaves (forge) smithing 3
  ("master recipes" — the rank-3 effect text names it honestly).

### 3. Gameplay wiring (all four blueprints: tpAction, fpsArena, platformer, topdown)

- `const skills = new SkillSystem(engine, { onRankUp: toast })` next to `prog`;
  rank-ups toast `"Smithing rank 2!"`.
- Gathering opts: `yieldBonus: () => skills.harvestYieldBonus()`,
  `onHarvested: () => skills.onHarvest()` — every harvest grants foraging XP and
  the rank bonus lands in the inventory (deterministic flat bonus on top of the
  seeded base yield).
- Station session opts: `skills: () => skills` (gates), `craftTimeMult` (queue
  speed), `onCrafted: (recipe) => skills.onCraft(recipe.stationId)` (craft XP).
- `SkillsPanel` constructed when `resolveSkillsEnabled(spec)` (not built when
  disabled — no chip, no key handler).
- Portal seam: `PortalParts.skills?` + `PlayerStateSnapshot.skills` (optional,
  backward-compatible — old snapshots without the field restore fine). The live
  objects persist across transitions today (no blueprint teardown), same as
  Progression; the seam is ready for a future rebuild path.

### 4. Skills UI (`src/engine/ui/SkillsPanel.ts`, new)

- Centered responsive modal (`min(440px, 94vw)`, fits 360×780), CraftingPanel
  visual language (amber accents, same header/footer pattern).
- Per-skill card: name, `RANK n/3`, XP progress bar (`"60 / 180 XP to rank 3"`,
  `"MAX RANK"` at cap), desc, per-rank effect lines (current rank highlighted),
  and the skill's **gated recipes** with honest `LOCKED — Iron Edge → Iron Edge
  (requires rank 2)` / `UNLOCKED` states from the live ranks.
- Open/close: `K` key (capture phase; never while another modal owns input or
  the user is typing), Esc closes, plus a floating **SKILLS chip** (top-right,
  native button) as the touch/mouse entry point — chip hides while open.
- `doc` injectable for unit tests; `refresh()` for post-XP re-render; `dispose()`
  removes listeners + nodes (idempotent).

### 5. Studio controls (`src/studio/editor/editorPanel.ts`)

SKILLS section after CRAFTING: `SKILLS — ENABLED` checkbox →
`custom.skills.enabled`; `SKILL XP MULTIPLIER` slider (0–4, step 0.25) →
`custom.skills.xpMultiplier`. Mirrors the enemyTuning/crafting pattern.

### 6. Test seams (`src/runtime/main.ts`)

`skillsTest`: `SkillSystem`, `SKILL_DEFS`, `SKILL_IDS`, `SkillsPanel`,
resolvers, `liveSkills()`, `livePanel()`.

## Gate evidence

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` | ✅ CLEAN |
| Full `npx vitest run` | ✅ **106 files, 1426 tests, all passing** (1366 baseline + 60 new: 32 skills + 10 skills-panel + 18 net new/updated crafting incl. 3 onCrafted regression tests) |
| `npm run build:player` | ✅ CLEAN (dist/player.html 1,252.90 kB, gzip 364.20 kB) |
| e2e `skills.spec.ts` | ✅ ~3 min, zero console/page errors, desktop + 360×780 |

### e2e legs (all green, zero errors)

- **Panel:** `K` opens the real panel — Foraging/Smithing/Alchemy cards, `RANK 1/3`,
  XP labels; screenshot verified visually; Esc closes. SKILLS chip opens (touch
  path); the panel × button closes.
- **Harvest XP:** 2 real `[E]` harvests → foraging XP 16 (2 × 8), materials land.
- **Gates:** smithing ranked to 2 via the real `SkillSystem`; panel shows
  `UNLOCKED — Spark Charge/Grip Wrap`, `LOCKED — Iron Edge/Alloy Greaves`
  (asserted against the actual seeded pool, not a fixed list).
- **Craft XP:** workbench `[E]` → first craftable recipe's CRAFT → queue completes
  → smithing XP 80 → 92 (real `onCrafted` path; this leg caught the missing
  `onCrafted` invocation bug).
- **Perf:** `renderer.info.render.calls` median-of-5, panel closed vs open —
  199 vs 199, Δ = 0 (DOM-only UI adds zero WebGL draws).
- **Mobile 360×780:** panel bounding box fits (left ≥ 0, right ≤ 360, bottom ≤ 780),
  chip toggles, cards render, screenshot.

### Perf table (INSTANCING.md method — measured, not modeled)

Seed 20261012 tp-action scene, NPCs/enemies despawned, gathering + stations live:

| Tier | Panel closed (draws) | Panel open (draws) | Δ |
|------|---------------------|--------------------|---|
| desktop | 199 | 199 | **0** |

The skills wave adds no meshes, no materials, no instancer buckets — the panel
is pure DOM. SkillSystem per-frame cost is zero (event-driven: harvest/craft
callbacks only). Draw-call delta measured at **0**.

## Bugs found and fixed (by my own tests)

1. **REAL BUG — `completeCraft` never called `onCrafted`:** I added the
   `onCrafted` option to `CraftingPanelOpts`, wired it through
   `CraftingInteractionSession` and all four blueprints — but never invoked it
   on queue completion. Craft XP was silently dropped: the queue completed, the
   item was granted, but no skill XP fired. The e2e caught it (queue row
   vanished, XP stayed 80). Fixed with a one-line call after a successful
   `craft()`, plus 3 new unit tests (`onCrafted` fires on success, does NOT
   fire on stale-queue failure, `craftTimeMult` scales queue duration).
2. **e2e chip-toggle leg clicked a hidden chip** (my test bug): the SKILLS chip
   hides while the panel is open, so the second chip click waited forever and
   burned the 15-min test timeout. Fixed the leg: touch close path is the panel's
   native × button; chip re-opens after close.
3. **Playwright actionability flakes under SwiftShader** (harness, not product):
   the × button and the SKILLS chip are provably visible/enabled/stable (28×28
   box, pointer-events auto, `elementFromPoint` hits them, identical box across
   rAF), but plain `.click()` actionability checks hung twice. Used
   `click({ force: true })` with comments documenting the evidence — the force
   clicks still dispatch the real handlers through the input pipeline.
4. **Old crafting tests hit the new gate first**: 3 crafting.test.ts + 3
   crafting-panel.test.ts tests now reached `missing-skill` before the gate
   they meant to test. Updated honestly: max-rank skill stubs where the test's
   intent is a later gate (same convention as the crafting wave's npcs.spec.ts
   update); the `missing-skill` gate itself is covered in skills.test.ts.

## Files changed (committed on `feature/upgrade-skills`, not merged, not pushed)

**New:**
- `src/engine/game/skills.ts` — SkillDef table, SkillSystem, resolvers, SkillsLike
- `src/engine/ui/SkillsPanel.ts` — skills UI panel + SKILLS chip
- `tests/skills.test.ts` — 32 unit tests
- `tests/skills-panel.test.ts` — 10 unit tests
- `tests/e2e/skills.spec.ts` — full e2e

**Modified:**
- `src/engine/game/crafting.ts` — `minSkillRank`, `missing-skill` gate + check
  order, catalog skill gates (6 recipes)
- `src/engine/game/gathering.ts` — `yieldBonus` + `onHarvested` opts, bonus in
  `harvestById`
- `src/engine/game/stations.ts` — `skills`/`craftTimeMult`/`onCrafted` session
  opts, pass-through to panel
- `src/engine/ui/CraftingPanel.ts` — skills-aware checkCraft/craft opts,
  craft-time multiplier on enqueue, `onCrafted` on completion
- `src/blueprints/{tpAction,fpsArena,platformer,topdown}.ts` — SkillSystem,
  gathering/station/panel wiring, `skills`/`skillsPanel` in returns
- `src/spec/schema.ts` — `CustomSpec.skills` + `SkillsTuningCustom`
- `src/studio/editor/editorPanel.ts` — SKILLS section (toggle + XP multiplier)
- `src/runtime/main.ts` — `skillsTest` seam
- `src/engine/world/PortalState.ts` + `PortalManager.ts` — optional skills
  snapshot slice
- `tests/crafting.test.ts`, `tests/crafting-panel.test.ts` — skill-stub updates
  for the new check order (documented above)

## Caveats & honest disclosures

1. **No preview servers left running.** (vite preview was Playwright-managed.)
2. **Rank-3 content is thin:** only Alloy Greaves is rank-3-gated; alchemy has no
   rank-3 gate yet (rank 3 = 25% faster brewing). Future content waves can add
   master recipes; the gate machinery is in place.
3. **Skill XP events are harvest/craft only.** Kills grant Progression XP, not
   skill XP — a future wave can add combat-skill events without reshaping.
4. **Depleted-node design inherited:** harvest XP fires per harvest; nodes
   respawn on portal return (crafting wave's documented design).
5. **The e2e `force:true` × click** (bug 2 above) — harness-only workaround,
   evidence documented in the spec.

## Merge-readiness verdict

✅ **MERGE-READY.** All gates green. Four real issues found and fixed by my own
tests (one genuine product bug — `onCrafted` never invoked, caught by the e2e
and now covered by 3 unit tests; one test bug; one harness flake with
documented evidence; six honest old-test updates for the new check order).
Perf delta measured at zero. No NPC/enemy behavior contracts changed; their
suites are green. Main untouched; nothing pushed.
