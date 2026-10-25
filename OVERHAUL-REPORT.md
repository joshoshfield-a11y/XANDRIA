# XANDRIA Graphics Overhaul — Pass A+B+C Report (2026-10-25)

Branch: `gfx-overhaul` in worktree `~/workspace/xandria/wt-gfx-spike`.
Main and origin/main untouched at `8d555e0`. **Merge stays gated on the user's word.**

## What shipped in this pass

Pass A (characters), Pass B (world), Pass C (items/readability/perf) were
done as one wiring pass because they share the same registry and the same
remap sweep. The user authorized the full overhaul on 2026-10-25 06:00 PDT
("do that with the rest of the body parts and items and terrain etc etc").

### Atlases (image generation, 4 calls — the per-message max)

`atlas/` (worktree, evidence only, not committed): 4 plates, each 1600×1600
WebP, 3×3 grid with thick black separators:

- `atlas-fabrics`: quilt, carbon, ribbed / leather, circuit, camo / canvas, scale, chainmail
- `atlas-terrain`: mossy, cracked, litter / snow, basalt, wetsand / caverock, deck, grass
- `atlas-items`: brushed, rust, wood / wrap, ceramic, hazard / energy, crystal, bone
- `atlas-body`: skin, denim, cargo / mesh, plate, fur / runes, circuit, rope

`slice_atlas.py` cuts tiles on separator-band EDGES (not band centers —
the first cut left ~15 px of black border on every tile, which rendered as
a black grid on the ground; see "QC findings"). 35/36 tiles usable; the
body plate-armor tile is a centered breastplate photo, not tileable, and
was not shipped. Unused tiles stay as masters.

### Design rule (unified, proven in Pass 0)

All baked textures are **luminance-first**: terrain vertex colors are
saturated biome colors, so a chromatic ground map would double-tint.
Palette / vertex tint does the coloring; the baked map supplies detail.
Same rule as the proven Pass 0 shirt.

### Baked set (18 registry ids, `src/assets/baked/` = 545,768 B)

New in this pass (16): `fabric-carbon`, `fabric-camo`, `pants-denim`,
`skin-matte`, `accent-runes`, `accent-hazard`, grounds at 256 albedo + 128
Sobel normal (`ground-grass`, `ground-cracked`, `ground-litter`,
`ground-snow`, `ground-basalt`, `ground-wetsand`, `ground-caverock`),
items at 128 (`item-brushed`, `item-wood`, `item-energy`).
Plus the Pass 0 spike set (2 albedo + 2 normal). Registry total: 18 ids.

### Code wiring (all on `gfx-overhaul`, tsc clean)

- `BakedTextures.ts`: 16 new registry entries; `mirror` flag for ground
  textures (MirroredRepeatWrapping — atlas tiles are not seamlessly
  tileable, mirrored repeat hides the seam); `loadCached` now
  try/catches `loader.load` and falls back to a bare `THREE.Texture`,
  so the never-throws contract holds in DOM-less runtimes too.
- `spec/schema.ts`: `SkinDef.textures` per-role `{ baked }` + validator;
  `ItemSkinDef.texture` gains `{ baked }`, `ItemSkinDef.textures` added,
  item validator extended.
- `gfx/Skins.ts`: per-role texture loop in `applySkin`; all 16 built-in
  skins remapped from canvas patterns to baked (default/crimson/
  royalguard/solarpaladin/emerald-guardian → spike-shirt; stealth/gold/
  neonstreet/abyssal/cyberronin/nomad/void-scout → fabric-carbon;
  rustscrap/desertnomad/desert-raider → fabric-camo; spectral →
  accent-runes). Every built-in also gets `skin: skin-matte` +
  `pants: pants-denim`; rustscrap additionally `accent: accent-hazard`.
- `gfx/ItemSkins.ts`: baked branch + per-role textures loop; iron/steel/
  gold/frost/shadow/storm → item-brushed; ember → accent-hazard;
  verdant → fabric-camo; storm additionally `glow: item-energy`.
- `world/Biomes.ts`: all 7 biome grounds get `baked` (plains→grass,
  desert-canyon→cracked, forest→litter, snow→snow, volcanic→basalt,
  coastline→wetsand, caves→caverock). `kind`/`base`/`alt` unchanged —
  canvas fallback + tint logic preserved.
- `gfx/VoxelArmor.ts`: `makeMat` gains optional `bakedId`; shell + trim
  at both build sites pass `'item-brushed'`; dark/glow stay untextured.
- Scripting bug fixed during the remap: an entry-slice regex requiring a
  trailing newline silently failed for skins whose texture/palette line
  was the entry's last line (9 skins). Final audit verified all 16 carry
  baked main + per-role textures.

## Verification

- Full suite: **143 files / 2174 tests, all pass** (wave-4 baseline was
  142 / 2160; +1 file, +14 tests = the Pass A tests). tsc clean.
- Touched files re-run first: 90/90 (gfx-baked-spike, skins-beauty,
  biomes, items-schema, builders, character-custom).
- Demo (desktop + mobile, zero page errors): 4 rigs — Default (quilt),
  Stealth (carbon), Desert Nomad (camo), Spectral (runes) — over baked
  grass, denim pants, matte skin. Screenshots in `spike/`.
- In-game player screenshot (built player, fixture spec untouched):
  `spike/game-passa.png` — see below.

## QC findings (honest)

1. **Atlas separator bleed (found by eye, fixed):** band-center slicing
   left black borders on every tile → black grid on the ground at
   repeat 4. Fixed by slicing on band edges + 2 px inset, then
   re-baking everything. A second failure mode hid it: the slicer's
   `segments()` counted 4 runs and fell back to thirds; fixed with an
   assert (exactly 3 spans). Verified by pixel sampling: tile edges
   now carry grass/quilt colors, not black.
2. **Mirrored repeat is a tradeoff:** ground tiles mirror at boundaries,
   which hides seams but makes the grass pattern visibly symmetric on
   close inspection. Acceptable for ground; character UVs keep plain
   repeat (single wrap, seam hides at the back).
3. **Dark palettes crush texture:** Stealth's near-black palette makes
   the carbon weave nearly invisible; it reads via its emissive cyan
   straps instead. That's palette physics, not a texture failure — the
   same carbon reads clearly on lighter skins.
4. **Known wart carried over from Pass 0:** `biomeGroundDef` sets repeat
   on the shared cached baked texture. Pass A demo used one repeat;
   shipped biomes use one repeat per biome material, so no product
   impact yet — but a future pass must clone-per-material or bake
   repeat into UVs before two repeats of one ground id coexist.

## Bundle cost (disclosed, not hidden)

Measured from the `gfx-overhaul` branch build, same vite singlefile
pipeline as wave-4:

| Bundle | Baseline (wave-4) | Pass 0 spike | Pass A (this pass) |
|---|---|---|---|
| Player raw / gzip | 1,541.65 / 449.56 kB | 1,755.22 / 611.93 kB | 2,274.94 / **1,001.07 kB** |
| Studio raw / gzip | 865.39 / 241.83 kB | — | 1,597.99 / **793.18 kB** |

Delta vs baseline: **+551.51 kB gzip (player), +551.35 kB (studio)**.
Rule of thumb measured twice now: every 100 kB of baked WebP costs
~100 kB gzip, because WebP is already entropy-coded and base64 adds
33% that gzip cannot recover. The full-overhaul look costs ~550 kB
gzip on both bundles. Both bundles carry all 18 textures (the registry
imports everything); per-bundle tree-shaking is a future optimization,
not done here.

## What is NOT in this pass

- No balance, mechanic, or behavior changes (visuals only).
- No runtime generation — everything baked and checked in.
- No Meshy/Tripo/cloud models (local-only art rule held).
- No auto-rigging, no skeletal rigs (procedural rig unchanged).
- No merge to main (gated on the user's word). No push.
- `atlas/` masters, `slice_atlas.py`, `bake_tiles.py`,
  `bake_normals128.py`, `spike-masters/`, demo/shot scripts stay
  untracked evidence in the worktree, not committed.

## In-game screenshot

Built player (preview server, fixture spec untouched, zero page errors):
the Forgotten Valley forest floor renders the baked litter texture under
the forest biome tint, and the player wears the remapped baked quilt
skin. The character is small in this third-person frame, so the demo
close-ups above are the detail proof; the game shot proves the wiring
survives a real boot and a real scene, not just the demo rig.
