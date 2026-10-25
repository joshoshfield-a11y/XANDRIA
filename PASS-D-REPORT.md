# Pass D — graphics continuation (branch `gfx-pass-d`, off main `41e25ba`)

Visuals-only continuation of the gfx-overhaul. Two items from the overhaul's
own deferred/carried list. Staged, not merged — merge stays on the user's word.

## D1 — the shared-texture repeat wart, fixed

The overhaul left one real wart: `MaterialLibrary.texture()` cached one texture
per kind+hex, and callers mutated `texture.repeat` on the shared instance, so
the last repeat written won for every material using that texture. Fixed on
both paths, with the shared texture never mutated again:

- **Baked path (`BakedTextures.ts`):** `loadCached` takes a `variant` cache key;
  new `bakedTextureInstance(id, repeat?)` / `bakedNormalTextureInstance(id,
  repeat?)` return the shared texture when repeat is 1/absent, else a fresh
  per-repeat load with repeat set. Deliberately NOT `Texture.clone()`: a clone
  taken before the async image load completes never receives the image and
  renders black.
- **Canvas path (`Materials.ts`):** new private `repeatInstance(key, base,
  repeat)` helper (a cached clone — safe for canvas textures because the
  image is synchronous). Applied at `texture()`'s return and its Sobel normal
  twin, `normalMap()`, `emissiveMap()` (both hit and fresh paths), and the
  `biomeGroundDef` baked branch (now via the instance helpers). One real bug
  caught by the new tests during this work: `texture()`'s early cache-hit
  return bypassed the repeat helper — fixed, so the hit path applies it too.
- Verified: every remaining `repeat.set` in src lives only inside the two
  helpers.

## D2 — structure/prop surfaces baked

Pass B listed PropSets/Structures/Landmarks textures, but the A+B+C pass only
baked grounds. Props/structures still ran canvas-painted. Now baked:

- One structures atlas (3x3, thick black separators, desaturated
  luminance-first swatches, same recipe as Pass A), sliced clean first try
  with `slice_structures.py` (band-edge logic from Pass A).
- Baked with `bake_surf.py` (256 albedo + 128 Sobel normal, same Sobel as
  Pass A): `surf-rock`, `surf-metal`, `surf-wood`, `surf-panel`,
  `surf-concrete` + normals = **106,642 B** in
  `xandria-studio/src/assets/baked/`. The other four atlas tiles (brick,
  sandstone, rusted metal, grid panel) stay masters for a later pass.
- `BakedTextures.ts`: 10 imports + 5 registry entries, all `mirror: true`
  (atlas tiles aren't seamlessly tileable; mirrored repeat hides seams,
  same as grounds).
- `Materials.ts`: exported `SURFACE_BAKED` maps only the kinds with real
  `standard()` callers (rock 21, metal 11, wood 10, panel 3, concrete 2 —
  verified by grep). `standard()` gained a baked branch: map/normalMap via
  the instance helpers, **`color: hex`** (canvas bakes hex into pixels; the
  baked tiles are luminance-first so tint rides on material color — grounds
  don't need this because terrain uses vertex colors), roughness/metalness/
  emissive unchanged, canvas fallback when the id is unknown.
- Riveted-panel note: the tile has a bright center highlight that repeats
  per tile (panels are usually repeat 1, so this is acceptable).

## Gates

- `tsc --noEmit`: clean.
- Full vitest: **144 files / 2183 tests pass** (main baseline 143 / 2174;
  Pass D adds `tests/gfx-pass-d.test.ts`, 9 tests). Two honest test updates
  along the way: the spike registry list pin gained the 5 surf ids, and the
  baked-spike repeat assertions moved to the new per-repeat-instance
  contract. One self-inflicted duplicate `itemWoodMap`/`itemEnergyMap`
  import in `BakedTextures.ts` was caught and fixed before the suite ran.
- Builds (worktree): player raw 2,418,599 B / gzip **1,110,241 B**
  (baseline 1,001.07 kB, +109.17 kB); studio gzip **902,562 B** (baseline
  793.18 kB, +109.38 kB). Matches the overhaul's measured rule (~100 kB
  WebP ~= ~100 kB gzip); the raw delta is larger because vite inlines the
  WebP as base64.
- Screenshots: surf demo (desktop + mobile, `__SURF_READY__` waited on, so
  the shots show loaded pixels, not placeholders) + in-game world walk
  (desktop + mobile) from the built player, same fixture spec as the
  overhaul screenshots. Page errors: none on any shot.
- Demo QC (by eye): all five tiles read on geometry — stone block courses,
  brushed metal, plank rows, riveted panel, poured concrete. The panel's
  center highlight shows on the top face; acceptable per the note above.

## Files

- Modified: `xandria-studio/src/engine/gfx/BakedTextures.ts`,
  `xandria-studio/src/engine/gfx/Materials.ts`,
  `xandria-studio/tests/gfx-baked-spike.test.ts`
- New: `xandria-studio/src/assets/baked/surf-*.webp` (10),
  `xandria-studio/tests/gfx-pass-d.test.ts`,
  `xandria-studio/surf-demo.html`, `xandria-studio/scripts/surf-demo.ts`
- Evidence only (worktree, not for commit — same shape as the overhaul):
  `atlas/`, `slice_structures.py`, `bake_surf.py`, `shots-pass-d/`

## Still open (not this pass)

- Direct-map skin mode (deferred at Pass 0), mirrored-repeat symmetry
  tradeoff on grounds, per-bundle texture tree-shaking, the four spare
  atlas tiles (brick, sandstone, rusted metal, grid panel).
