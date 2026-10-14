# XANDRIA Open World — Maximum World Size: the measured ceiling

Workstream E owns this file. Rule enforced throughout: **no cap without a
measurement behind it.** Every section carries a MEASURED value and a verdict
on whether it limits the cap.

Deterministic scene for all E measurements: seed 20261012, third-person-action,
hills, dusk ("Forgotten Valley"), `?test=1`. Render numbers are headless
SwiftShader on a 2-vCPU sandbox — LABELED as such; absolute frame ms is
meaningless there (only relative deltas count). Real-GPU numbers need a device
(Galaxy S25 target); the 150-draw-call budget is assessed against SwiftShader
counts, the honest apples-to-apples the harness supports.

Worker inputs: A (workers-max/A.md) · B (workers-max/B.md) · C (workers-max/C.md) ·
D (workers-max/D.md). E measured on A's branch (`feature/openworld-maxsize-A`
@ `5a841db`) for the 8000m numbers — the branch that actually raises the cap —
and on stage-1 (`18e8fe0`) for the 2000m baseline.

## The ceiling

**Supported max world size: 8000 m.**

**Limiting factor: none of the hard candidates.** Every wall the brief named was
measured and either fixed (jitter, cold build) or proven non-binding (physics,
far-field, memory, draw calls — see below). The cap stands at the 8000m A
raised it to; E's measurements do not demand lowering it. The binding **soft**
constraint — the number to watch before any future raise — is draw calls vs
the 150 S25 budget (§4).

## 1. float32 jitter vs distance — NOT LIMITING (measured, B)

B's verdict (workers-max/B.md, `feature/openworld-maxsize-B` @ `05adc61`):
after the chunk-local vertex rebase fix, terrain static projection error is
**0.003 px flat from 250 m to 64 km** camera distance (max over on-screen
vertices, 1080p, fov 66; harness simulates the three.js r182 vertex pipeline
against a float64 reference). Pre-fix the 1 px wall sat at ~75 km. Residual:
instanced scatter/grass/vegetation props keep world-baked float32 instance
translations — 0.61 px worst case at 64 km close-range, ~10x beyond any
plausible cap. **Precision does not limit the world-size cap.**
(Caveat from B, for the record: depth-buffer precision from the scaled
near/far planes — ~8 cm depth slop at 1 km on an 8 km world — can z-fight the
water plane against terrain. That's z-fighting, not jitter; C owns the
far-field look.)

## 2. Cold-build time vs size — NOT LIMITING (measured, A)

A's verdict (workers-max/A.md, `5a841db`): spawn-area-first lazy terrain —
the constructor sync-builds only the 16 spawn chunks; everything else builds
on demand from the pure height function through the existing per-frame budget.
Measured headless (`scripts/bench-coldbuild.ts`, this sandbox):

| size | old ctor (everything upfront) | new ctor (16 spawn chunks) | drain to steady state |
|------|-------------------------------|---------------------------|----------------------|
| 2000m | 1371 ms | 1207 ms | 1627 ms / 24 updates |
| 4000m | 4761 ms | 987 ms | 3550 ms / 62 updates |
| 8000m | **15124 ms** | **746 ms** | 2731 ms / 62 updates |

Time-to-interactive is now the ctor row: **size-independent, ~0.7–1.2 s**.
E's in-browser corroboration (dev server + SwiftShader, time to `playing`):
15.0 s @ 2000m → 18.2 s @ 8000m desktop (module compile dominates; the delta
is the streaming drain, not the build). **Cold build does not limit the cap.**

E's independent Node probe (terrain build only, stage-1 code — for the
record): 3.4 s @ 2km / 5.1 s @ 4km / 22.8 s @ 8km, heap Δ 17/55/106 MB.
Superlinear past 4km on the old path — the path A replaced.

## 3. Chunk / physics-body counts — NOT LIMITING (measured, D)

D's verdict (workers-max/D.md, `feature/openworld-maxsize-D` @ `ab11b28`,
zero engine changes): physics + streaming hold at **4 km and 8 km**. 2-minute
traverse at racing top speed (70 m/s): queue depth max 0, focus chunk resident
100% of 7200 frames, 34 seam crossings, no falls, no pops, no tunneling.
Resident chunk bodies **24–39 regardless of world size** (bounded by chunkSize
+ stream radii, not total size); SAPBroadphase delta for ~31 extra static
bodies: **+0.006–0.015 ms/step median** — two orders below contact-solver
cost. 4 km = 256 chunks / res 1601; 8 km = 1024 chunks / res 3201.
**Chunk and body counts do not limit the cap at any size this wave considers.**

## 4. Draw calls at max size — MEASURED (E; 150 S25 budget)

Deterministic scene, SwiftShader, `engine.perf.snapshot()`:

| stop | 2000m desktop | 2000m mobile | 8000m desktop | 8000m mobile |
|------|--------------|-------------|--------------|-------------|
| spawn | 247 | 188 | 208 → **230 steady** | 155 |
| traverse | 130–247 | 119–159 | 126–218 | 89–161 |

(8000m "steady": after ~8 min of stream drain at spawn — 230 draw calls,
164 geometries, 2.16M tris, 110 chunk meshes built, queue 26 still draining;
0 console/page errors. Geometries 142–192 desktop / 93–145 mobile.)

**Honest vs the 150 budget: over at every size ≥ 2000m**, worst at spawn
viewpoints (looking across the world, most chunks in frustum). But the key
finding: **draw calls are size-independent** — 230 @ 8km vs 247 @ 2km. The
stream radii (mesh 1500/2000m) bound the resident set, so growing the world
does not grow the draw calls. Lowering the cap would not fix the budget
(2000m is already over); raising it further would not worsen it, until a
radius change does. **Draw calls do not set the cap — but they are the binding
soft constraint**: the number to watch, and the reason the next raise needs a
draw-call diet first. No adaptive quality per the brief — the number is what
it is. Frame ms under SwiftShader (800–5900 ms) is software-renderer bound;
real frame cost needs the S25.

Far-field draw-call cost (C, constant at every size): 1 shell + 1 water +
1 sky dome + 1 clouds = **4**. B's vertex rebase: +0 draw calls.

## 5. Fog / sky / water at multi-km — NOT LIMITING (measured, C)

C's verdict (workers-max/C.md, `feature/openworld-maxsize-C` @ `c9b91ff`):
far-shell resolution tiers (64/96/128 segs — still **1 draw call**), type-aware
shell bias (measured interpolation error, canyon-corrected), water radial edge
fade (rim dissolves into the horizon; byte-identical water ≤2000m), fog
validated scale-invariant (FogExp2 transmittance at the far plane in
[0.29, 0.39] for 2km→8km), sky domes verified by design (camera-following,
radius 1000 — encloses the view at any world size), dusk grading no regression.
Horizon reads intentional at 8km (before/after shots in workers-max/).

One E observation, flagged not adjudicated: under SwiftShader at 8000m the sky
shows pale diagonal banding streaks (see workers-max/e-perf-evidence/
steady-8km-steady.png, top of frame; also present in traverse shots, absent at
2000m). C's 8km shots report no banding beyond the 2km baseline — this may be
a SwiftShader-only artifact of the 10100m far plane, or the depth-slop
z-fighting B flagged. Needs a real-GPU check; not a cap-setter on current
evidence.

## 6. Memory at max size — NOT LIMITING (measured, E)

JS heap (`performance.memory.usedJSHeapSize`, headless — note: bucketed
without `--enable-precise-memory-info`, treat as ±10 MB) on the deterministic
scene: **179.3 MB desktop / 189.8 MB mobile @ 8000m, flat across all traverse
stops** (streaming reuses pools; no growth with distance traveled). For
comparison: 289.9 / 307.1 MB @ 2000m on stage-1 code — A's lazy terrain
*removed* the full-world float64 grid (78 MB @ 8km on the old path), so the
bigger world uses less heap. Scatter worst-case pool allocation 34.3 MB
(stage-1 C — size-independent by construction).

Caveat (A's, adopted): built chunk geometry is cached forever — a player who
fully traverses an 8km world accumulates up to 1024 chunks × ~10k verts
(~300 MB worst case). No LRU/disposal policy in this wave (backlogged).
**Memory does not limit the 8000m cap**; it becomes a review item past it.

## Determinism at the new sizes (E)

FNV-1a digest gate extended to the ceiling
(`xandria-studio/tests/chunked-determinism-maxsize.test.ts`): the cap is
**probed from validateSpec at runtime** — no hardcoded number, tracks whatever
A ships. At the probed cap: (a) chunked == legacy exact digest on a 256×256
world-spanning grid (pure `terrainHeightAt` vs the verbatim legacy loop,
2 seeds × 2 terrain types); (b) same seed → same world across two independent
generateSpec+Terrain builds (heightAt-grid digest + chunk-mesh position digest
bit-identical; version-agnostic across stage-1 and A's lazy Terrain);
(c) non-vacuity (distinct seeds digest distinctly). **3/3 green at the probed
8000m cap on A's branch** (and at 2000m on stage-1 code).

## Gates at max size (E)

- `npx tsc --noEmit`: clean (E branch; A/B/C/D report clean on theirs)
- Full vitest: 79 files / 1018 tests green (78/1015 stage-1 baseline + 3 new
  maxsize determinism tests; full-suite re-run at merge is the coordinator's gate)
- Playwright e2e (desktop + 360×780 mobile, zero console errors): main suite
  re-running at write time; the deterministic-scene harness recorded
  **0 console/page errors at 2000m and 8000m, both viewports**
  (1 SwiftShader screenshot timeout at 2000m — harness artifact, not a game
  error). Beta bots: tp-action playthrough fails on the known pre-existing
  softlock (bot stalls, 0.70m moved — matches the stage-1 report; E's branch
  touches no engine/bot code), fps-arena passes.

## What would move the cap

- **Up**: a draw-call diet (the 150 budget is the binding constraint) + an
  LRU/disposal policy for traversed chunk geometry + a real-GPU pass on the
  sky/depth behavior at 8km. Precision, cold build, physics, and far-field all
  have headroom past 8km (B verified to 64 km).
- **Down**: nothing measured demands it. If a real device shows the 230-draw
  worst case unplayable on the S25, the cap — or the radii — revisits.
