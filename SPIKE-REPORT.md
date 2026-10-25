# XANDRIA Graphics Overhaul — Pass 0 Spike Report

Branch: `gfx-overhaul` (worktree `~/workspace/xandria/wt-gfx-spike/`).
Status: **SPIKE ONLY — nothing merged to main.** Main is untouched at
`8d555e0`; the upgrade-loop cron stays paused.

## What was built

- `src/engine/gfx/BakedTextures.ts` — registry of baked assets (vite-inlined
  data URIs, so single-file bundles stay self-contained and offline).
  Albedo + Sobel normal twins, shared cached `THREE.Texture`s, unknown id → null.
- `src/engine/gfx/Skins.ts` — new texture form `{ baked: id }`, applied
  synchronously through the existing owned-material path (map + normalMap
  on the skin's `textureRoles`, default shirt+pants). Unknown id → palette
  stands, never throws. The shipped built-in skin roster is untouched —
  the spike skin is a literal `SkinDef` in the demo/test/spec, not a
  new built-in.
- `src/engine/gfx/Materials.ts` — `biomeGroundDef` gains an optional
  `baked` ground id (baked map + normal twin, ground-detail layer kept).
  Unknown id → canvas path. No shipped biome sets `baked`, so shipped
  content renders byte-identically to before.
- `src/spec/schema.ts` — `{ baked: string }` validated (non-empty);
  the item-texture validator is intentionally unchanged (spike scope:
  characters + ground only).
- `src/engine/world/Biomes.ts` — optional `baked` field on
  `BiomeGroundParams` (no shipped biome uses it).
- Baked assets (`src/assets/baked/`, WebP): `spike-shirt` (512px albedo
  42,660 B + 256px normal 18,738 B), `spike-ground` (512px albedo
  75,904 B + 256px normal 22,032 B). Full-res PNG masters are NOT in
  the repo (kept with the spike evidence in `your_files/gfx-spike-pass0/`).
- Demo (`spike-demo.html` + `scripts/spike-demo.ts`, branch-only):
  baked rig vs canvas-pattern rig on baked ground, desktop + mobile.
- Tests (`tests/gfx-baked-spike.test.ts`): 7/7 pass. tsc clean.
  Full suite was NOT re-run for the spike (only the spike, skins-beauty,
  and biomes files); the full 2160-test gate belongs to a Pass A merge.

## Evidence (in `spike/`)

- `demo-desktop.png` — baked rig (left) shows teal quilted padding
  detail on torso + arms; canvas-pattern rig (right) reads flat.
  Ground shows dark stone + teal moss, no hard seams at this scale.
  Zero page errors. **This is the decision screenshot.**
- `demo-mobile.png` — same scene, 390×844, after a portrait camera
  fix (first mobile framing cropped the pair; demo-only fix, not
  product code).
- `game.png` — the real built player with the spike skin applied via
  `spec.custom.characters.skins` + `player.skin`: boots clean, zero
  page errors, character visible center-frame. At gameplay camera
  distance the texture reads as tint + paneling, not fine detail —
  expected; the demo close-up is where detail is judged.
- `looksheet.png` — the art-direction reference set (character /
  terrain / rifle, dark teal + charcoal + amber). This is the style
  Pass A should hold.
- `tiled-ground.png` / `tiled-shirt.png` — 2×2 tiling QC. Ground:
  motifs repeat per tile (normal for tiled textures), no hard seam
  lines. Shirt: quilt grid tiles cleanly.

## Pass 0 decisions (the spike's actual job)

1. **Luminance-compatible textures: PROVEN.** The baked shirt texture
   is a near-white/gray quilt; multiplied by the teal palette it tints
   correctly and keeps its detail. Pass A should author character
   textures as luminance layers first. A direct-map skin mode is NOT
   needed for this look and is deferred — if a future pack wants true
   chromatic art (e.g. a rust-orange fabric that must stay orange
   under any palette), that mode gets its own proposal.
2. **Normal maps from albedo luminance work.** Sobel twins (wrap-around
   gradients, so they tile) add surface relief without new passes.
3. **Build budget: the plan's proposed budget DOES NOT HOLD at 512px.**
   Spike player build: **1,755.22 kB / gzip 611.93 kB** vs baseline
   **1,541.65 kB / gzip 449.56 kB** — delta +213.57 kB raw / +162.37 kB
   gzip, almost exactly the base64 expansion of the 159 KB WebP set
   (base64 of compressed data does not gzip back down). The plan's
   proposed player gzip ≤ 520 kB is breached by this spike alone.
   Recommendation for Pass A: standardize on **256px bakes**
   (estimated set ≈ 65–70 KB binary → ≈ 90 KB gzip delta, player
   ≈ 540 kB gzip) and revise the budget to **gzip ≤ 580 kB**, or keep
   512px and raise the budget to ≈ 650 kB. The user picks at the
   Pass A gate; the spike does not quietly move the budget.
4. **Perf: no new cost of consequence.** Same material/mesh counts —
   no new draw calls, no new passes. GPU texture memory for the spike
   set: 4 × 512² RGBA ≈ 4 MB (256px normals halve their share).
   S25 frame-time verification still belongs to Pass A/C on device.

## Known limits / honest notes

- Shared cached textures carry one repeat value: `biomeGroundDef`
  sets repeat on the shared baked texture, so two grounds with
  different repeats would fight. Pass A must clone-per-material (with
  GPU-upload cost noted) or bake repeat into UVs before any shipped
  biome uses `baked`. No shipped biome does today.
- The demo's first mobile framing was wrong (cropped pair); fixed in
  the demo only. Portrait camera framing for the real game is
  unchanged and out of scope.
- Ground fallback (unknown baked id → canvas) is unit-tested; the
  skin fallback is unit-tested; both are "never throws" by code path.
- Image generation is not perfectly seamless: the ground's motifs
  repeat visibly on close inspection. At ground repeat scale in the
  demo it reads as texture, not as a grid — acceptable for the spike,
  and Pass A QC should reject any atlas where repetition reads as a
  pattern at gameplay distance.
- Single-file note: baked assets inflate the HTML directly. Any
  future pack's size must be quoted as gzip delta, not binary size,
  because base64 + incompressible WebP is the real cost (this spike
  is the receipt).

## Next step

User decision: (a) approve the look + the revised budget direction,
then Pass A (character packs at 256px, roster promotion of the baked
path, full test + e2e + build gates); or (b) adjust the look first.
