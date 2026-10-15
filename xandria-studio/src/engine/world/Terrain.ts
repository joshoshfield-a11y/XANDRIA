/** Heightfield terrain: vertex-colored, textured, with matching cannon Heightfield and boundary walls. */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { GameSpec } from '@spec';
import { Noise2D } from '../core/Rng';
import { MaterialLibrary, shade } from '../gfx/Materials';
import { gradeAtmosphere } from '../gfx/GenreGrade';
import { resolveBiomeDef, biomeTint } from './Biomes';
// Portals wave, workstream A: transparent energy-field boundary on
// portal-enabled maps (replaces the wall/cliff boundary bodies+meshes).
import { portalsEnabled, buildEnergyField, updateEnergyField, disposeEnergyField } from '../gfx/EnergyField';
import { GROUP, type Physics } from '../core/Physics';
// Stage-1 workstream B: chunked physics + streaming (chunked mesh generation
// is workstream A's; both share the chunkLayout grid convention).
import { chunkCellRange, chunkKey, worldToChunk, type ChunkGrid } from './chunkLayout';
import { ChunkStream } from './ChunkStream';

/**
 * Stage-1 B: mesh streaming radii (meters). Chunk meshes page out only far
 * beyond the camera far plane (~1400m), so the horizon never shows holes;
 * hysteresis band prevents thrash. Worker D's far-field work (impostor
 * ring / scaled far plane) owns tuning these further — if the camera far
 * plane ever grows past MESH_STREAM_LOAD_RADIUS, raise these with it.
 */
export const MESH_STREAM_LOAD_RADIUS = 1500;
export const MESH_STREAM_UNLOAD_RADIUS = 2000;

// ---------------------------------------------------------------------------
// Open-world stage 1 (worker A): chunked terrain mesh generation.
//
// The terrain height is a PURE function of world (x, z). Chunks sample it at
// world-space coordinates on one shared vertex grid, so adjacent chunks own
// bit-identical edge vertices — no cracks, no T-junctions, no stitching code.
// Small worlds (<= TERRAIN_CHUNK_TARGET) are a single chunk built on the
// legacy grid, so they come out identical to before.
// ---------------------------------------------------------------------------

/** Target chunk edge length in meters; the world tiles into ceil(size/256) chunks per side. */
export const TERRAIN_CHUNK_TARGET = 256;
/** Vertex-grid cell in meters for multi-chunk worlds (~the legacy 220m cell, so 1000m+ worlds keep detail). */
export const TERRAIN_CHUNK_CELL = 2.5;

/** Everything the pure height function closes over (was: the constructor's locals). */
export interface TerrainHeightParams {
  seed: number;
  size: number;
  type: string;
  maxHeight: number;
  roughness: number;
  freq: number;
  hscale: number;
  flatCenters: Array<{ x: number; y: number; z: number }>;
  flatRadius: number;
  boundary: string;
}

// Noise2D instances are immutable after construction (the perm table is fixed
// by the seed; get()/fbm() mutate nothing), so one cached instance per seed
// is exactly equivalent to constructing per call — and keeps heightAt() cheap
// enough to call per frame.
const heightNoiseCache = new Map<number, Noise2D>();
function heightNoise(seed: number): Noise2D {
  let n = heightNoiseCache.get(seed);
  if (!n) {
    n = new Noise2D(seed);
    heightNoiseCache.set(seed, n);
  }
  return n;
}

/**
 * Pure terrain height at world (x, z) — the legacy in-constructor height loop
 * extracted verbatim (same noise calls in the same order, same math), so it
 * reproduces the old heights BIT-IDENTICALLY for the same inputs. Do not
 * "improve" the noise: determinism (same seed -> same world, chunked or not)
 * depends on it.
 */
export function terrainHeightAt(p: TerrainHeightParams, x: number, z: number): number {
  const noise = heightNoise(p.seed);
  let y = 0;
  const nx = x / p.size, nz = z / p.size;
  const base = noise.fbm(nx * 3 * p.freq + 10, nz * 3 * p.freq + 10, 5, 2, 0.5);
  switch (p.type) {
    case 'flat': y = base * 0.6; break;
    case 'hills': y = (base + 0.3) * p.maxHeight * (0.4 + p.roughness * 0.6); break;
    case 'mountains': y = Math.pow(Math.abs(base) + 0.15, 1.6) * p.maxHeight * 1.4 * (0.5 + p.roughness); break;
    case 'canyon': { const r = Math.abs(noise.get(nx * 2 * p.freq, nz * 2 * p.freq + 5)); y = (r < 0.18 ? -0.6 : 0.8 + base * 0.5) * p.maxHeight; break; }
    case 'islands': { const d = Math.hypot(nx, nz) * 2; y = (base + 0.35 - d * d * 0.9) * p.maxHeight; break; }
    case 'platforms': y = Math.round((base + 1) * 3) * (p.maxHeight / 6); break;
  }
  y *= p.hscale;
  // edge falloff: rim rises (or drops) for boundary
  const edge = Math.max(Math.abs(nx), Math.abs(nz)) * 2; // 0..1
  if (p.boundary === 'cliffs') y -= Math.pow(Math.max(0, edge - 0.85) / 0.15, 2) * 40;
  else if (p.boundary === 'walls') y += Math.pow(Math.max(0, edge - 0.9) / 0.1, 2) * p.maxHeight * 0.8;
  // flatten around spawn / arena centers
  const flatR = p.flatRadius;
  for (const c of p.flatCenters) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < flatR * 1.8) { const k = THREE.MathUtils.smoothstep(d, flatR * 0.6, flatR * 1.8); y = THREE.MathUtils.lerp(c.y, y, k); }
  }
  return y;
}

export class Terrain {
  /**
   * Chunk meshes built so far, in build order. Stage-1b A: meshes are built
   * LAZILY (spawn-area-first, then streamed) — this is no longer the full
   * row-major grid. Use getChunkMesh(cx, cz) for grid-addressed access.
   */
  chunkMeshes: THREE.Mesh[] = [];
  /**
   * Stage-1b A: chunk meshes by chunkKey — the grid-addressed index. Meshes
   * are built on demand (ensureChunkMesh) and cached; the mesh stream only
   * toggles scene membership, never disposes geometry.
   */
  private readonly chunkMeshByKey = new Map<string, THREE.Mesh>();
  /** Shared biome ground material for all chunk meshes (cached, never disposed here). */
  private groundMat!: THREE.Material;
  /**
   * Legacy accessor: a chunk mesh. For small (single-chunk) worlds this IS
   * the whole terrain, exactly as before. For chunked worlds it is the spawn
   * chunk's mesh (always built synchronously in the constructor).
   */
  mesh: THREE.Mesh;
  /**
   * Stage-1 B: legacy single-body alias. In chunked worlds this is the body
   * of the spawn chunk — always resident. Prefer isChunkLoaded()/
   * loadedChunkBodies for chunk-aware code.
   */
  body: CANNON.Body;
  readonly size: number;
  readonly res: number;
  /** Actual chunk edge length in meters (size / chunks per side). */
  readonly chunkSize: number;
  /** Stage-1b A: the full-world float64 height grid is GONE (it was the cold-
   *  build bottleneck: res² pure-function samples up front, ~15s at 8km).
   *  Heights now come from the pure function per chunk, on demand — the
   *  values are bit-identical (same function, same world coords), and
   *  heightAt()/normalAt()/surfaceAt() already sampled it directly. */
  private cell: number;
  private hp: TerrainHeightParams;
  /** Stage-1b A: vertex-color inputs, derived once in the constructor (the old
   *  geometry loop's locals) so per-chunk builds stay deterministic. */
  private colorCtx!: {
    cGround: THREE.Color; cAlt: THREE.Color; cRock: THREE.Color;
    cPatchDark: THREE.Color; cPatchLight: THREE.Color;
  };
  /** Stage-1 B: chunk grid (A's canonical layout) driving physics + streaming. */
  private readonly grid: ChunkGrid;
  /** Stage-1 B: pages chunk physics bodies in/out by player distance. */
  private readonly bodyStream: ChunkStream;
  /** Stage-1 B: pages chunk meshes in/out of the scene (draw-call hygiene). */
  private readonly meshStream: ChunkStream;
  /** Stage-1 B: currently resident chunk bodies, keyed by chunkKey(cx, cz). */
  private readonly chunkBodies = new Map<string, CANNON.Body>();
  water?: THREE.Mesh;
  private waterMat?: THREE.MeshStandardMaterial;
  readonly maxHeight: number;
  walls: CANNON.Body[] = [];
  /**
   * Portals wave, workstream A: the transparent energy-field boundary mesh
   * (ONE mesh / ONE draw call, see gfx/EnergyField). Present only when
   * `spec.world.portals` is on; undefined otherwise. Wired to the frame
   * clock in Scatter.ts next to updateWater.
   */
  energyField?: THREE.Mesh;
  /** physics wave: surface-id derivation noise (seeded, independent of the
   *  height noise) + optional biome surface overrides (read via cast — the
   *  schema stays untouched and validation ignores unknown subfields). */
  private surfNoise: Noise2D;
  private bioSurface: string | undefined;
  private bioGround: string;
  /**
   * PORTALS-D: chunk key of the constructor's spawn chunk (used by
   * refreshPortalAliases; the legacy body/mesh aliases re-point at the
   * focus chunk after a park/unpark cycle).
   */
  private readonly spawnChunkKey: string;

  constructor(spec: GameSpec, physics: Physics, mats: MaterialLibrary, scene: THREE.Scene, opts: { flatRadius?: number; flatCenters?: THREE.Vector3[] } = {}) {
    const t = spec.world.terrain;
    this.size = t.size;
    this.maxHeight = t.maxHeight;
    this.surfNoise = new Noise2D((spec.meta.seed ^ 0x5f3a17) >>> 0);
    const bio = spec.custom?.biome;
    const bioFree = bio as { surface?: string; groundSurface?: string } | undefined;
    this.bioSurface = bioFree?.surface;
    this.bioGround = bioFree?.groundSurface ?? 'stone';
    // Workstream C: the resolved biome treatment (Studio override wins, else
    // seeded per seed/genre). Drives ground material, water tint, and the
    // palette blend below. Terrain GEOMETRY is untouched — shape stays
    // generator-driven so gameplay is unaffected.
    const biome = resolveBiomeDef(spec);
    const freq = bio?.terrainFrequency ?? 1;
    const hscale = bio?.heightScale ?? 1;
    const flat = opts.flatCenters ?? [new THREE.Vector3(0, 0, 0)];
    const flatR = opts.flatRadius ?? Math.max(14, this.size * 0.08);
    // Portals wave, workstream A: on portal-enabled maps the edge falloff is
    // neutralized ('none') so the player can walk straight through the energy
    // field into the transition trigger — a 'walls' rim or 'cliffs' drop at
    // the edge would block/launch the crossing. When portals are off this is
    // byte-identical to before.
    const hpBoundary = portalsEnabled(spec) ? 'none' : spec.world.boundary;
    this.hp = {
      seed: spec.meta.seed, size: this.size, type: t.type, maxHeight: t.maxHeight,
      roughness: t.roughness, freq, hscale,
      flatCenters: flat, flatRadius: flatR, boundary: hpBoundary,
    };

    // ---- chunk layout (open-world stage 1, worker A)
    const chunksPerSide = Math.max(1, Math.ceil(this.size / TERRAIN_CHUNK_TARGET));
    let cellsPerChunk: number;
    if (chunksPerSide === 1) {
      // legacy grid — the single chunk IS the old mesh, bit-identical
      this.res = Math.min(128, Math.max(32, Math.round(this.size / 2.5)));
      cellsPerChunk = this.res - 1;
    } else {
      // fixed ~2.5m cell so big worlds keep detail (the old res cap of 128
      // would have stretched cells to ~8m on a 1000m world)
      cellsPerChunk = Math.max(1, Math.round(this.size / chunksPerSide / TERRAIN_CHUNK_CELL));
      this.res = chunksPerSide * cellsPerChunk + 1;
    }
    this.chunkSize = this.size / chunksPerSide;
    this.cell = this.size / (this.res - 1);

    // ---- chunked geometry with vertex colors (stage-1b A: lazy per-chunk)
    //
    // The old code sampled a full-world res² height grid up front and built
    // every chunk mesh in the constructor — O(size²) cold build (~15s at
    // 8km). Now each chunk's geometry is built on demand by
    // buildChunkGeometry() from the pure height function, so the constructor
    // only pays for the spawn-area chunks (below) and the streaming queue
    // fills the rest within the per-frame budget. Values are bit-identical:
    // same function, same world coords, same float32 stores, and the normal
    // accumulation below reproduces the old global pass exactly (two-phase
    // ghost-ring loop — see buildChunkGeometry).
    //
    // NOTE: vertex colors are consumed RAW by the shader (no color-management
    // conversion), so write the palette's sRGB components directly. Using
    // `new THREE.Color(hex)` here would store linear-workspace values and make
    // the terrain ~7x darker than the authored palette (it rendered black at
    // night). convertLinearToSRGB() recovers the raw sRGB components.
    // Workstream C: blend the spec palette toward the biome's authored palette
    // (BIOME_PALETTE_BLEND in world/Biomes) so each biome reads distinctly
    // while Studio palette edits still visibly shift the look.
    const cGround = biomeTint(spec.theme.palette.ground, biome.palette.ground);
    const cAlt = biomeTint(spec.theme.palette.groundAlt, biome.palette.groundAlt);
    const cRock = biomeTint(spec.theme.palette.rock, biome.palette.rock);
    // Beauty wave: patch colors derived from the palette itself so new hues
    // never clash — dark earthy patches and sun-bleached patches that break
    // the flat procedural look. Baked into vertex colors: zero per-frame cost.
    const cPatchDark = cGround.clone().lerp(cRock, 0.35).multiplyScalar(0.72);
    const cPatchLight = cGround.clone().lerp(new THREE.Color(1, 1, 1), 0.28);
    this.colorCtx = { cGround, cAlt, cRock, cPatchDark, cPatchLight };
    // Workstream C: ground material comes from the biome treatment (cached,
    // shared — never disposed here). volcanic → ember-cracked basalt with
    // glowing veins; snow → glittering snowdrift; desert → cracked earth, etc.
    const mat = mats.biomeGroundDef(biome.ground, { repeat: this.size / 8 });
    mat.vertexColors = true;
    this.groundMat = mat;

    // ---- chunked physics + streaming (stage-1 workstream B): one static
    // cannon Heightfield per chunk, each sampling the pure height function
    // on the chunk's sub-grid — the SAME world coords the chunk meshes
    // sample, so physics and visuals agree exactly. Static bodies are cheap
    // collision data; the bodyStream pages them in/out of the physics world
    // by player distance, with hysteresis (no load/unload thrash) and a
    // per-frame build budget.
    //
    // The j-axis mirror fix from the single-body era is preserved PER CHUNK:
    // chunk data P[li][lj] = heightAt(−half+(i0+li)·cell, −half+(j1−lj)·cell),
    // body at (x0, 0, z1) with x0 = −half+i0·cell, z1 = −half+j1·cell, same
    // −90° X rotation — so cannon's local (li·e, lj·e) lands exactly on the
    // mesh's heights (B3). Adjacent chunks share edge sample rows exactly
    // (same pure function at the same world coords), so there is no
    // tunneling at seams.
    //
    // Grid parameters are derived from A's canonical chunk fields (never
    // recomputed independently — physics chunks MUST align with mesh chunks).
    const half = this.size / 2;
    const cps = Math.round(this.size / this.chunkSize); // == A's chunksPerSide
    this.grid = {
      chunksPerSide: cps,
      cellsPerChunk: (this.res - 1) / cps, // exact: A builds res = cps*cpc+1
      chunkSize: this.chunkSize,
      cell: this.cell,
      half,
      res: this.res,
    };
    // Stage-1b A: teleportSyncRadius — teleports/respawn (and the very first
    // update below) sync-build only the spawn-area chunks; the rest of
    // loadRadius drains through the per-frame budget. 1.6 chunks covers the
    // focus chunk plus its full 1-ring with margin.
    const teleportSyncRadius = this.chunkSize * 1.6;
    this.bodyStream = new ChunkStream({
      grid: this.grid,
      loadRadius: this.chunkSize * 2.5,
      unloadRadius: this.chunkSize * 4,
      teleportSyncRadius,
      lifecycle: {
        buildChunk: (cx, cz) => this.buildChunkBody(cx, cz, physics),
        releaseChunk: (cx, cz) => {
          const b = this.chunkBodies.get(chunkKey(cx, cz));
          if (b) { physics.remove(b); this.chunkBodies.delete(chunkKey(cx, cz)); }
        },
      },
    });
    // Meshes: stage-1b A builds chunk geometry LAZILY via ensureChunkMesh —
    // the mesh stream both builds (first page-in) and pages in/out of the
    // scene (draw-call hygiene). Radii cover the camera far plane (~1400m)
    // with margin so the horizon never shows holes; worker D's far-field
    // work owns tuning these further. Geometry stays cached once built —
    // streaming only toggles scene membership, never disposes.
    this.meshStream = new ChunkStream({
      grid: this.grid,
      loadRadius: MESH_STREAM_LOAD_RADIUS,
      unloadRadius: MESH_STREAM_UNLOAD_RADIUS,
      teleportSyncRadius,
      lifecycle: {
        buildChunk: (cx, cz) => {
          const m = this.ensureChunkMesh(cx, cz);
          if (m.parent !== scene) scene.add(m);
        },
        releaseChunk: (cx, cz) => {
          const m = this.chunkMeshByKey.get(chunkKey(cx, cz));
          if (m) scene.remove(m);
        },
      },
    });
    // Initial page-in around spawn: the world must be walkable on frame one.
    // The first update is a teleport — the teleportSyncRadius neighborhood
    // (focus chunk + 1-ring) builds synchronously and deterministically;
    // everything else streams in within the per-frame budget. Small worlds
    // are one chunk — identical to the old single-body behavior.
    const fc = this.hp.flatCenters[0];
    const spawnX = fc ? fc.x : 0, spawnZ = fc ? fc.z : 0;
    this.update(new THREE.Vector3(spawnX, 0, spawnZ));
    const oc = worldToChunk(spawnX, spawnZ, this.grid);
    this.body = this.chunkBodies.get(chunkKey(oc.cx, oc.cz))!;
    this.mesh = this.chunkMeshByKey.get(chunkKey(oc.cx, oc.cz))!;
    // PORTALS-D: remember the spawn chunk's key for alias refresh after
    // park/unpark cycles (refreshPortalAliases).
    this.spawnChunkKey = chunkKey(oc.cx, oc.cz);

    // ---- boundary
    // Portals wave, workstream A: portal-enabled maps get the transparent
    // energy field INSTEAD of wall/cliff boundary bodies+meshes. Arena
    // genres keep walls — the legacy branch below is untouched when portals
    // are off (byte-identical).
    if (portalsEnabled(spec)) {
      const dusk = spec.theme.timeOfDay === 'dusk' || spec.theme.timeOfDay === 'dawn';
      this.energyField = buildEnergyField(this.size, undefined, dusk);
      scene.add(this.energyField);
    } else if (spec.world.boundary !== 'wrap') {
      const wh = 60, wt = 4;
      const mk = (x: number, z: number, sx: number, sz: number) => { const b = physics.box([sx, wh, sz], [x, 0, z], { group: GROUP.WORLD }); this.walls.push(b); };
      mk(0, -half - wt / 2, this.size + wt * 2, wt); mk(0, half + wt / 2, this.size + wt * 2, wt);
      mk(-half - wt / 2, 0, wt, this.size); mk(half + wt / 2, 0, wt, this.size);
    }

    // ---- water plane (graphics wave D: stylized water with specular)
    // MeshStandardMaterial + onBeforeCompile injections:
    //  - world-space ripple normal (~7m primary + ~3.5m chop), transformed to
    //    view space — the old uv-space ripple had a ~290m wavelength, i.e.
    //    effectively flat; the old glint also mixed view-space normals with a
    //    world-space sun vector, now fixed via viewMatrix transforms
    //  - sun-aligned Blinn-Phong glint (blueprints refine dir/tint from the
    //    real sky sun via setWaterSun(); ACES in the grade pass rolls the
    //    highlights off instead of clipping them white)
    //  - fresnel term mirroring the sky tint at grazing angles — the cue that
    //    reads as water in the reference vistas (golden path at dusk)
    //  - per-biome deep tint + sky tint from the dusk grade (GenreGrade D2)
    // No planar reflections — uniforms + a few ALU, no per-frame CPU cost.
    if (t.water) {
      // Merge of D (shader) + C (content): the biome owns the water's authored
      // look (volcanic reads as lava, caves as dark teal, coastline as bright
      // teal); D's world-space ripple + sun glint + fresnel sky-mirror shader
      // does the rendering; at dusk the cinematic grade tint wins.
      const dusk = spec.theme.timeOfDay === 'dusk' || spec.theme.timeOfDay === 'dawn';
      // D2 seam: the BIOME_DUSK table is keyed by environment id, while the
      // biome's absolute fog/water overrides (workstream C's BiomeDef) win
      // over the table per the BiomeDefLike contract.
      const bgrade = gradeAtmosphere(spec.meta.genre, spec.theme.timeOfDay, {
        id: spec.theme.environment,
        fogColor: biome.fog.color,
        fogDensity: biome.fog.density,
        waterTint: biome.water.tint,
      });
      const bw = biome.water;
      const deepColor = (dusk && bgrade.waterTint) ? bgrade.waterTint : bw.tint;
      const wm = new THREE.MeshStandardMaterial({ color: deepColor, transparent: true, opacity: bw.opacity, roughness: 0.12, metalness: 0.35, emissive: bw.emissive ?? '#000000', emissiveIntensity: bw.emissive ? (bw.emissiveIntensity ?? 0.8) : 0 });
      wm.userData.uTime = { value: 0 };
      // default glint: the biome's authored glint color (dusk-warm for most
      // biomes, cool for snow/caves); blueprints refine it from the real sky
      // sun via setWaterSun() right after createSky().
      wm.userData.uSunDirW = { value: new THREE.Vector3(0.55, 0.28, 0.45).normalize() };
      wm.userData.uGlint = { value: new THREE.Color(bw.glint) };
      wm.userData.uSkyTint = { value: new THREE.Color(bgrade.waterSky ?? (dusk ? '#f0a868' : '#a8c8dc')) };
      // Stage 1b (workstream C): radial edge fade. The plane spans 3x the
      // world; on multi-km maps its rim falls inside the camera far plane and
      // would draw a hard water-vs-sky line. Past uFadeEnd the water is fully
      // transparent, so the rim dissolves into the fogged horizon. On stage-1
      // sizes (<=2000m) the fade zone sits beyond the quad (half-size 1.5x),
      // so the water renders byte-identical to before.
      const fadeStart = this.size > 2000 ? this.size * 1.02 : this.size * 1.55;
      const fadeEnd = this.size > 2000 ? this.size * 1.38 : this.size * 1.60;
      wm.userData.uFadeStart = { value: fadeStart };
      wm.userData.uFadeEnd = { value: fadeEnd };
      wm.customProgramCacheKey = () => 'xandria-water-v4';
      wm.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = wm.userData.uTime;
        shader.uniforms.uSunDirW = wm.userData.uSunDirW;
        shader.uniforms.uGlint = wm.userData.uGlint;
        shader.uniforms.uSkyTint = wm.userData.uSkyTint;
        shader.uniforms.uFadeStart = wm.userData.uFadeStart;
        shader.uniforms.uFadeEnd = wm.userData.uFadeEnd;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime; varying vec3 vWPos;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec3 uSunDirW; uniform vec3 uGlint; uniform vec3 uSkyTint; uniform float uFadeStart; uniform float uFadeEnd; varying vec3 vWPos; float gShimmer;')
          .replace('#include <color_fragment>', `#include <color_fragment>
            // radial edge fade (see above): dissolve the rim into the horizon
            diffuseColor.a *= 1.0 - smoothstep(uFadeStart, uFadeEnd, length(vWPos.xz));`)
          .replace('#include <normal_fragment_maps>', `
            float wv1 = sin(vWPos.x * 0.85 + uTime * 1.5) * sin(vWPos.z * 0.70 - uTime * 1.1);
            float wv2 = sin((vWPos.x + vWPos.z) * 1.70 - uTime * 2.2);
            float wv3 = sin(vWPos.x * 2.60 - uTime * 2.8) * sin(vWPos.z * 2.30 + uTime * 2.0);
            gShimmer = 0.5 + 0.5 * wv1 * wv2;
            vec3 wN = normalize(vec3(wv1 * 0.20 + wv2 * 0.09, 1.0, wv1 * 0.09 - wv3 * 0.13));
            normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            {
              vec3 Vv = normalize(vViewPosition);
              vec3 sunV = normalize((viewMatrix * vec4(normalize(uSunDirW), 0.0)).xyz);
              vec3 Hv = normalize(sunV + Vv);
              float wspec = pow(max(dot(normal, Hv), 0.0), 90.0);
              totalEmissiveRadiance += uGlint * wspec * (0.25 + 0.75 * gShimmer);
              float fres = pow(1.0 - max(dot(normal, Vv), 0.0), 3.0);
              totalEmissiveRadiance += uSkyTint * fres * 0.45;
            }`);
      };
      this.waterMat = wm;
      this.water = new THREE.Mesh(new THREE.PlaneGeometry(this.size * 3, this.size * 3), wm);
      this.water.rotation.x = -Math.PI / 2;
      this.water.position.y = t.waterLevel + (bio?.waterBias ?? 0);
      scene.add(this.water);
    }
  }

  /** Advance the water ripple clock. Called per frame only when water exists. */
  updateWater(dt: number) {
    if (this.waterMat) (this.waterMat.userData.uTime as { value: number }).value += dt;
  }

  /**
   * Portals wave, workstream A: advance the energy-field shader clock (one
   * shared uniform per frame; the animation is pure shader ALU). Called per
   * frame only when a field exists — wired in Scatter.ts next to updateWater.
   */
  updateField(dt: number) {
    if (this.energyField) updateEnergyField(dt);
  }

  /**
   * Stage-1b A: build one chunk's BufferGeometry on demand, bit-identical to
   * what the old whole-world constructor produced for the same chunk.
   *
   * Bit-identity argument (why lazy == old):
   * - heights: the pure function at the same world coords
   *   (−half + gi·cell, −half + gj·cell) — the old grid held exactly these
   *   float64 values; positions/UVs/colors sample the same float32 stores.
   * - normals: the old code accumulated face normals into one GLOBAL grid in
   *   chunk order (cj outer, ci inner), cells (ly outer, lx inner), faces
   *   (T1, T2), with Math.fround per add. For a chunk-owned vertex the
   *   incident faces live in this chunk plus its immediate neighbors. This
   *   method runs the same accumulation in three phases — ghost cells owned
   *   by chunks sorting BEFORE this chunk, then own cells, then ghost cells
   *   owned by chunks sorting AFTER — each phase in ly/lx cell order, which
   *   visits every incident face in EXACTLY the global order (left/top
   *   neighbors accumulate before this chunk's own faces, right/bottom
   *   after). Corner vertices (faces from 4 chunks) work out the same way.
   *   Single-chunk worlds get no ghost ring at all — identical to the legacy
   *   single mesh.
   * - the steep-slope rock recolor runs per chunk, as before.
   */
  private buildChunkGeometry(cx: number, cz: number): THREE.BufferGeometry {
    const { cellsPerChunk: cpc, res, cell, half } = this.grid;
    const hp = this.hp;
    const vps = cpc + 1; // verts per chunk side
    const i0 = cx * cpc, j0 = cz * cpc; // global index of this chunk's (0,0) vert
    // Stage-1b B (camera-relative rendering): vertex positions are stored
    // CHUNK-LOCAL (relative to the chunk origin) so float32 attribute
    // magnitudes stay ~chunkSize and shader math keeps sub-pixel precision at
    // any world size. The mesh carries the chunk origin (see ensureChunkMesh).
    // Colors and normals are computed from the exact f32 world coords
    // (fx/fz below), so generated content is bit-identical — only the
    // position attribute layout changes, i.e. how it's rendered, not what.
    const cx0 = -half + i0 * cell, cz0 = -half + j0 * cell;
    // float64 heights on the extended grid (chunk + 1-cell ghost ring,
    // clamped to the world edge). Positions are frounded from these on use —
    // exactly what storing into the old Float32Array posArr did.
    const gi0 = Math.max(0, i0 - 1), gi1 = Math.min(res - 1, i0 + cpc + 1);
    const gj0 = Math.max(0, j0 - 1), gj1 = Math.min(res - 1, j0 + cpc + 1);
    const ew = gi1 - gi0 + 1, ehRows = gj1 - gj0 + 1;
    const eh = new Float64Array(ew * ehRows);
    for (let gj = gj0; gj <= gj1; gj++) {
      for (let gi = gi0; gi <= gi1; gi++) {
        eh[(gj - gj0) * ew + (gi - gi0)] = terrainHeightAt(hp, -half + gi * cell, -half + gj * cell);
      }
    }
    const hgt = (gi: number, gj: number) => eh[(gj - gj0) * ew + (gi - gi0)];
    const owned = (gi: number, gj: number) => gi >= i0 && gi <= i0 + cpc && gj >= j0 && gj <= j0 + cpc;

    const geo = new THREE.BufferGeometry();
    const nv = vps * vps;
    const posArr = new Float32Array(nv * 3);
    const uvArr = new Float32Array(nv * 2);
    const colArr = new Float32Array(nv * 3);
    const { cGround, cAlt, cRock, cPatchDark, cPatchLight } = this.colorCtx;
    const noise = heightNoise(hp.seed);
    const tmp = new THREE.Color();
    for (let ly = 0; ly < vps; ly++) {
      for (let lx = 0; lx < vps; lx++) {
        // global grid indices — shared edge vertices get the SAME (x, z)
        // in every chunk that owns them (bit-identical, no cracks)
        const gi = i0 + lx, gj = j0 + ly;
        const vi = ly * vps + lx;
        const x = -half + gi * cell, z = -half + gj * cell;
        const y = hgt(gi, gj); // float64 — the color pass below used the float64 height
        posArr[vi * 3] = x - cx0; posArr[vi * 3 + 1] = y; posArr[vi * 3 + 2] = z - cz0;
        uvArr[vi * 2] = gi / (res - 1); uvArr[vi * 2 + 1] = 1 - gj / (res - 1);
        // the color noise must see the exact f32 world coords the legacy
        // build stored in the position attribute — fround(x) is bit-identical
        // to the old Float32Array store-then-read
        const fx = Math.fround(x), fz = Math.fround(z);
        const slopeN = noise.get(fx * 0.05, fz * 0.05);
        tmp.copy(cGround).lerp(cAlt, (slopeN + 1) / 2);
        const hn = THREE.MathUtils.clamp((y / Math.max(1, this.maxHeight)) - 0.6, 0, 1);
        tmp.lerp(cRock, hn * 1.2);
        // high-frequency patchiness: earthy hollows + bleached rises
        const patchN = noise.get(fx * 0.33 + 47.3, fz * 0.33 - 23.7);
        const pk = (patchN + 1) / 2;
        if (pk < 0.42) tmp.lerp(cPatchDark, ((0.42 - pk) / 0.42) * 0.6);
        else if (pk > 0.58) tmp.lerp(cPatchLight, ((pk - 0.58) / 0.42) * 0.4);
        colArr[vi * 3] = tmp.r; colArr[vi * 3 + 1] = tmp.g; colArr[vi * 3 + 2] = tmp.b;
      }
    }
    // same triangle pattern as the legacy PlaneGeometry: (a,b,d),(b,c,d)
    const idx: number[] = [];
    for (let ly = 0; ly < cpc; ly++) {
      for (let lx = 0; lx < cpc; lx++) {
        const a = lx + vps * ly, b = lx + vps * (ly + 1);
        const c = (lx + 1) + vps * (ly + 1), d = (lx + 1) + vps * ly;
        idx.push(a, b, d, b, c, d);
      }
    }
    geo.setIndex(idx);
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    const nacc = new Float32Array(nv * 3);
    // face-normal accumulation — the same math as three's computeVertexNormals
    // (cb = (pC-pB) x (pA-pB), summed per vertex with fround per add), but
    // over the chunk's own cells PLUS the ghost ring, in two phases so the
    // per-vertex add order matches the old global pass exactly (see doc).
    const pa = [0, 0, 0], pb = [0, 0, 0], pc = [0, 0, 0];
    const corner = (gi: number, gj: number, out: number[]) => {
      out[0] = Math.fround(-half + gi * cell);
      out[1] = Math.fround(hgt(gi, gj));
      out[2] = Math.fround(-half + gj * cell);
    };
    const addFace = (agi: number, agj: number, bgi: number, bgj: number, cgi: number, cgj: number) => {
      corner(agi, agj, pa); corner(bgi, bgj, pb); corner(cgi, cgj, pc);
      const cbx = pc[0] - pb[0], cby = pc[1] - pb[1], cbz = pc[2] - pb[2];
      const abx = pa[0] - pb[0], aby = pa[1] - pb[1], abz = pa[2] - pb[2];
      const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
      const corners: Array<[number, number]> = [[agi, agj], [bgi, bgj], [cgi, cgj]];
      for (const [gi, gj] of corners) {
        if (!owned(gi, gj)) continue;
        const k3 = ((gj - j0) * vps + (gi - i0)) * 3;
        nacc[k3] = Math.fround(nacc[k3] + nx);
        nacc[k3 + 1] = Math.fround(nacc[k3 + 1] + ny);
        nacc[k3 + 2] = Math.fround(nacc[k3 + 2] + nz);
      }
    };
    // Face-normal accumulation in three phases so the per-vertex add order
    // matches the old global pass exactly (see the method doc):
    //   phase 0 — ghost cells owned by chunks sorting BEFORE this chunk
    //             (cj outer, ci inner): the left/top neighbors' faces;
    //   phase 1 — this chunk's own cells (ly outer, lx inner), T1 then T2;
    //   phase 2 — ghost cells owned by chunks sorting AFTER this chunk:
    //             the right/bottom neighbors' faces.
    // Within each phase, cells run in ly/lx order — the neighbor's own cell
    // order. (Running own cells before phase 0 gets the left/top edges'
    // fround add-order wrong — verified bit-identical against the old pass.)
    const ghostCell = (gi: number, gj: number) => {
      addFace(gi, gj, gi, gj + 1, gi + 1, gj);
      addFace(gi, gj + 1, gi + 1, gj + 1, gi + 1, gj);
    };
    const ownCell = (gi: number, gj: number) => {
      addFace(gi, gj, gi, gj + 1, gi + 1, gj);       // T1 = (a,b,d)
      addFace(gi, gj + 1, gi + 1, gj + 1, gi + 1, gj); // T2 = (b,c,d)
    };
    for (let phase = 0; phase < 3; phase++) {
      for (let ly = -1; ly <= cpc; ly++) {
        for (let lx = -1; lx <= cpc; lx++) {
          const isOwn = lx >= 0 && lx < cpc && ly >= 0 && ly < cpc;
          if (phase === 1 && !isOwn) continue;
          if (phase !== 1 && isOwn) continue;
          const gi = i0 + lx, gj = j0 + ly;
          if (phase === 1) { ownCell(gi, gj); continue; }
          if (gi < 0 || gj < 0 || gi + 1 > res - 1 || gj + 1 > res - 1) continue;
          // owner chunk of this ghost cell (layout tiles [cx*cpc,(cx+1)*cpc])
          const oci = Math.floor(gi / cpc), ocj = Math.floor(gj / cpc);
          const before = ocj < cz || (ocj === cz && oci < cx);
          if (phase === 0 && !before) continue;
          if (phase === 2 && before) continue;
          ghostCell(gi, gj);
        }
      }
    }
    // normalize the accumulators (== three's normalizeNormals)
    const nrmArr = new Float32Array(nv * 3);
    for (let vi = 0; vi < nv; vi++) {
      const k3 = vi * 3;
      const l = Math.sqrt(nacc[k3] * nacc[k3] + nacc[k3 + 1] * nacc[k3 + 1] + nacc[k3 + 2] * nacc[k3 + 2]) || 1;
      nrmArr[k3] = nacc[k3] / l; nrmArr[k3 + 1] = nacc[k3 + 1] / l; nrmArr[k3 + 2] = nacc[k3 + 2] / l;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(nrmArr, 3));
    // steep slopes -> rock color (legacy pass, per chunk)
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    for (let k = 0; k < nrm.count; k++) {
      const ny = nrm.getY(k);
      if (ny < 0.75) {
        const f = THREE.MathUtils.clamp((0.75 - ny) / 0.3, 0, 1);
        tmp.setRGB(col.getX(k), col.getY(k), col.getZ(k)).lerp(cRock, f);
        col.setXYZ(k, tmp.r, tmp.g, tmp.b);
      }
    }
    col.needsUpdate = true;
    // Stage-1b B: the mesh carries the chunk origin (world frame) — see
    // ensureChunkMesh. Stored here so the offset subtracted from the
    // position attribute above is exactly the mesh translation.
    geo.userData.chunkOrigin = { x: cx0, z: cz0 };
    return geo;
  }

  /**
   * Stage-1b A: build (and cache) a chunk's mesh on demand. Idempotent.
   * Scene membership stays with the mesh stream — this only builds.
   */
  ensureChunkMesh(cx: number, cz: number): THREE.Mesh {
    const key = chunkKey(cx, cz);
    let m = this.chunkMeshByKey.get(key);
    if (!m) {
      const geo = this.buildChunkGeometry(cx, cz);
      m = new THREE.Mesh(geo, this.groundMat);
      // Stage-1b B: position attribute is chunk-local (see buildChunkGeometry);
      // the mesh carries the chunk origin so worldPos == position + attribute.
      // three.js composes modelViewMatrix in float64, keeping float32 shader
      // math sub-pixel-precise at any world size.
      const o = geo.userData.chunkOrigin as { x: number; z: number };
      m.position.set(o.x, 0, o.z);
      m.receiveShadow = true;
      m.castShadow = false;
      this.chunkMeshByKey.set(key, m);
      this.chunkMeshes.push(m);
    }
    return m;
  }

  /** Stage-1b A: the built mesh for chunk (cx,cz), or undefined if not built yet. */
  getChunkMesh(cx: number, cz: number): THREE.Mesh | undefined {
    return this.chunkMeshByKey.get(chunkKey(cx, cz));
  }

  /** Stage-1b A: number of chunk meshes built so far (instrumentation). */
  get builtMeshCount(): number {
    return this.chunkMeshByKey.size;
  }

  /**
   * Stage-1b A: build (and page into the physics world) a chunk's body on
   * demand, outside the stream budget. Idempotent — used for spawn-area
   * guarantees and test pre-warming.
   */
  ensureChunkBody(cx: number, cz: number): CANNON.Body {
    this.bodyStream.buildSync(cx, cz);
    return this.chunkBodies.get(chunkKey(cx, cz))!;
  }

  /** Chunk layout for worker B / engine.perf instrumentation. */
  getChunkStats(): { chunkCount: number; chunkSize: number } {
    const cps = this.grid.chunksPerSide;
    return { chunkCount: cps * cps, chunkSize: this.chunkSize };
  }

  /**
   * Align the water's fake sun glint with the real sky sun. Call once after
   * createSky() — e.g. `terrain.setWaterSun(sunDirFromSky, dusk ? '#ffb46b' : '#cfe8ff')`.
   * Never throws; ignores bad input.
   */
  setWaterSun(dir: THREE.Vector3 | null | undefined, tint: string | null | undefined): void {
    if (!this.waterMat) return;
    try {
      if (dir && Number.isFinite(dir.x + dir.y + dir.z)) {
        (this.waterMat.userData.uSunDirW as { value: THREE.Vector3 }).value.copy(dir).normalize();
      }
      if (typeof tint === 'string' && /^#[0-9a-fA-F]{6}$/.test(tint)) {
        (this.waterMat.userData.uGlint as { value: THREE.Color }).value.set(tint);
      }
    } catch {
      // water glint is cosmetic — never break the world over it
    }
  }

  /**
   * Stage-1 B: build (and page into the physics world) the static Heightfield
   * body for chunk (cx,cz). Samples the pure height function on the chunk's
   * sub-grid — bit-identical to the old shared-grid lookup (same function,
   * same world coords), so physics and visuals agree exactly, including at
   * chunk borders (shared edge samples; see the constructor note).
   */
  private buildChunkBody(cx: number, cz: number, physics: Physics): void {
    const { i0, i1, j0, j1 } = chunkCellRange(cx, cz, this.grid);
    const half = this.grid.half, cell = this.grid.cell;
    // j-mirror per chunk: P[li][lj] = heightAt(−half+(i0+li)·cell, −half+(j1−lj)·cell) (B3 fix, chunk-local).
    const data: number[][] = [];
    for (let li = 0; li <= i1 - i0; li++) {
      data[li] = [];
      for (let lj = 0; lj <= j1 - j0; lj++) {
        data[li][lj] = terrainHeightAt(this.hp, -half + (i0 + li) * cell, -half + (j1 - lj) * cell);
      }
    }
    const shape = new CANNON.Heightfield(data, { elementSize: cell });
    const b = new CANNON.Body({ mass: 0, material: physics.defaultMat, collisionFilterGroup: GROUP.WORLD });
    b.addShape(shape);
    // rotate so that heightfield's local (x, y) → world (x, z), local z → world y
    b.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    b.position.set(-half + i0 * cell, 0, -half + j1 * cell);
    physics.world.addBody(b);
    this.chunkBodies.set(chunkKey(cx, cz), b);
  }

  /**
   * Stage-1 B: per-frame streaming hook — page chunk physics bodies (tight
   * radii) and chunk meshes (far-plane-covering radii) in/out around the
   * focus point (the player). Single-chunk worlds short-circuit to a no-op.
   * Called by Engine.step every frame; blueprints may call it directly with
   * the exact player position instead of the engine's camera fallback.
   */
  update(playerPos: THREE.Vector3): void {
    this.bodyStream.update(playerPos);
    this.meshStream.update(playerPos);
  }

  /**
   * Height sample at world (x, z): the pure height function directly. Exact
   * at grid points (bit-identical to the old bilinear lookup there); off-grid
   * it samples the true surface instead of the bilinear approximation.
   */

  /** Stage-1 B: streaming counters for engine.perf (?perfoverlay=1). */
  getStreamStats(): { loaded: number; buildMs: number; queue: number } {
    const s = this.bodyStream;
    return { loaded: s.loadedCount, buildMs: s.buildMsEMA, queue: s.queueLength + this.meshStream.queueLength };
  }

  /** Stage-1 B: is the physics body for chunk (cx,cz) currently paged in? */
  isChunkLoaded(cx: number, cz: number): boolean {
    return this.bodyStream.isLoaded(cx, cz);
  }

  /** Stage-1 B: is the mesh for chunk (cx,cz) currently in the scene? */
  isChunkMeshLoaded(cx: number, cz: number): boolean {
    return this.meshStream.isLoaded(cx, cz);
  }

  /** Stage-1 B: currently resident chunk physics bodies. */
  get loadedChunkBodies(): CANNON.Body[] {
    return [...this.chunkBodies.values()];
  }

  /**
   * Stage-1 B: the resident physics body for chunk (cx,cz), or undefined when
   * the chunk is not currently paged in.
   */
  chunkBodyAt(cx: number, cz: number): CANNON.Body | undefined {
    return this.chunkBodies.get(chunkKey(cx, cz));
  }
  heightAt(x: number, z: number): number {
    return terrainHeightAt(this.hp, x, z);
  }

  normalAt(x: number, z: number): THREE.Vector3 {
    const e = this.cell;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z), hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    return new THREE.Vector3(hl - hr, 2 * e, hd - hu).normalize();
  }

  slopeAt(x: number, z: number): number { return 1 - this.normalAt(x, z).y; }

  /**
   * Physics wave: water surface Y at (x, z), or null when this terrain has no
   * water. The plane is level, so the level is position-independent.
   */
  waterLevelAt(x: number, z: number): number | null {
    void x; void z;
    return this.water ? this.water.position.y : null;
  }

  /**
   * Physics wave: surface id at (x, z) for the data-driven surface table
   * (engine/physics/Surfaces.ts). Derivation, in priority order:
   *   1. explicit biome override (custom.biome.surface)
   *   2. below (water level + margin) → 'shallow'
   *   3. steep slope → 'rock'
   *   4. moisture/patch noise → 'mud' | 'sand' | 'gravel'
   *   5. biome ground default (custom.biome.groundSurface ?? 'stone')
   * New biomes add table rows, not controller rows.
   */
  surfaceAt(x: number, z: number): string {
    if (this.bioSurface) return this.bioSurface;
    const wl = this.waterLevelAt(x, z);
    if (wl !== null && this.heightAt(x, z) < wl + 0.15) return 'shallow';
    if (this.slopeAt(x, z) > 0.45) return 'rock';
    const n = this.surfNoise.get(x * 0.02, z * 0.02);
    const m = this.surfNoise.get(x * 0.05 + 31.7, z * 0.05 - 11.2);
    if (m > 0.45) return 'mud';
    if (n > 0.35) return 'sand';
    if (n < -0.45) return 'gravel';
    return this.bioGround;
  }

  inBounds(x: number, z: number, margin = 6): boolean {
    const half = this.size / 2 - margin;
    return x > -half && x < half && z > -half && z < half;
  }

  /**
   * PORTALS-D: park this map's live payloads for a portal transition.
   *
   * Removes chunk physics bodies from the physics world, chunk meshes from
   * the scene, boundary walls from the physics world, and the water mesh
   * from the scene — WITHOUT disposing anything. Built chunk geometry stays
   * cached in chunkMeshByKey, so a cache revisit (unparkPortals + update)
   * restores visuals instantly and rebuilds only the cheap physics bodies.
   * The Terrain instance stays fully valid for a later unparkPortals() or
   * dispose(). Idempotent.
   */
  parkPortals(scene: THREE.Scene, physics: Physics): void {
    // bodyStream.reset(): releaseChunk removes each resident chunk body from
    // the physics world; meshStream.reset(): releaseChunk removes each paged
    // chunk mesh from the scene (geometry cache untouched). Both resets also
    // clear the paging state, so the next update() is a teleport and
    // sync-builds the arrival neighborhood.
    this.bodyStream.reset();
    this.meshStream.reset();
    for (const w of this.walls) physics.remove(w);
    if (this.water) scene.remove(this.water);
    // Portals wave (merge): the energy field is a per-map visual — a parked
    // map must not leave its field standing in the scene (all maps share the
    // same boundary coordinates, so a lingering field would double-blend
    // over the live map's field and cost a draw call per cached map).
    if (this.energyField) scene.remove(this.energyField);
  }

  /**
   * PORTALS-D: re-attach walls + water after parkPortals(). Chunk payloads
   * re-page through update(focus) — call terrain.update(arrivalFocus) next,
   * then refreshPortalAliases(focus). Safe to call on a freshly constructed
   * (never parked) Terrain too: already-attached walls/water are skipped.
   */
  unparkPortals(scene: THREE.Scene, physics: Physics): void {
    for (const w of this.walls) {
      if (!physics.world.bodies.includes(w)) physics.world.addBody(w);
    }
    if (this.water && this.water.parent !== scene) scene.add(this.water);
    // Portals wave (merge): re-attach the energy field removed by
    // parkPortals(). Safe on a freshly constructed terrain too (already
    // attached → skipped, mirroring the water guard).
    if (this.energyField && this.energyField.parent !== scene) scene.add(this.energyField);
  }

  /**
   * PORTALS-D: re-point the legacy spawn-chunk aliases (body/mesh) at the
   * focus chunk's payloads after a park/unpark cycle — the stream rebuilt
   * the bodies, so the old references point at removed objects. Call after
   * unparkPortals() + update(focus). No-ops when the focus chunk has no
   * resident payload yet (aliases keep their previous values).
   */
  refreshPortalAliases(focus: THREE.Vector3): void {
    const c = worldToChunk(focus.x, focus.z, this.grid);
    const k = chunkKey(c.cx, c.cz);
    const b = this.chunkBodies.get(k) ?? this.chunkBodies.get(this.spawnChunkKey);
    if (b) this.body = b;
    const m = this.chunkMeshByKey.get(k) ?? this.chunkMeshByKey.get(this.spawnChunkKey);
    if (m) this.mesh = m;
  }

  dispose(scene: THREE.Scene, physics: Physics) {
    // Stage-1 B: page out everything first — bodyStream.reset() removes all
    // resident chunk bodies from the physics world (the legacy `body` alias
    // is the spawn chunk's body), meshStream.reset() removes paged-in chunk
    // meshes from the scene — then dispose the built geometries (owned by
    // the terrain, never disposed by the mesh stream).
    this.bodyStream.reset();
    this.meshStream.reset();
    for (const m of this.chunkMeshByKey.values()) { scene.remove(m); m.geometry.dispose(); }
    this.chunkMeshByKey.clear();
    this.chunkMeshes = [];
    for (const w of this.walls) physics.remove(w);
    // Portals wave, workstream A: tear down the field mesh (geometry only —
    // the material is module-shared, never disposed).
    if (this.energyField) { disposeEnergyField(scene, this.energyField); this.energyField = undefined; }
    if (this.water) { scene.remove(this.water); this.water.geometry.dispose(); }
  }
}
