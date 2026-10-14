/** Heightfield terrain: vertex-colored, textured, with matching cannon Heightfield and boundary walls. */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { GameSpec } from '@spec';
import { Noise2D } from '../core/Rng';
import { MaterialLibrary, shade } from '../gfx/Materials';
import { gradeAtmosphere } from '../gfx/GenreGrade';
import { resolveBiomeDef, biomeTint } from './Biomes';
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
   * All chunk meshes, row-major (cj outer, ci inner). The whole world is
   * always built from chunks — small worlds are simply one chunk.
   */
  chunkMeshes: THREE.Mesh[] = [];
  /**
   * Legacy accessor: the first chunk mesh. For small (single-chunk) worlds
   * this IS the whole terrain, exactly as before.
   */
  mesh: THREE.Mesh;
  /**
   * Stage-1 B: legacy single-body alias. In chunked worlds this is the body
   * of the chunk containing the world origin (spawn area) — always resident.
   * Prefer isChunkLoaded()/loadedChunkBodies for chunk-aware code.
   */
  body: CANNON.Body;
  readonly size: number;
  readonly res: number;
  /** Actual chunk edge length in meters (size / chunks per side). */
  readonly chunkSize: number;
  private heights: number[][];
  private cell: number;
  private hp: TerrainHeightParams;
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
  /** physics wave: surface-id derivation noise (seeded, independent of the
   *  height noise) + optional biome surface overrides (read via cast — the
   *  schema stays untouched and validation ignores unknown subfields). */
  private surfNoise: Noise2D;
  private bioSurface: string | undefined;
  private bioGround: string;

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
    this.hp = {
      seed: spec.meta.seed, size: this.size, type: t.type, maxHeight: t.maxHeight,
      roughness: t.roughness, freq, hscale,
      flatCenters: flat, flatRadius: flatR, boundary: spec.world.boundary,
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

    // ---- heights: one shared world-space grid sampled through the pure function
    const h: number[][] = [];
    const half = this.size / 2;
    for (let i = 0; i < this.res; i++) {
      h[i] = [];
      for (let j = 0; j < this.res; j++) {
        h[i][j] = terrainHeightAt(this.hp, -half + i * this.cell, -half + j * this.cell);
      }
    }
    this.heights = h;

    // ---- chunked geometry with vertex colors
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
    const noise = heightNoise(spec.meta.seed);
    const vps = cellsPerChunk + 1; // verts per chunk side
    // Shared normal accumulators over the GLOBAL vertex grid (Float32Array +
    // Math.fround so per-add rounding matches the legacy computeVertexNormals
    // exactly). Adjacent chunks accumulate face normals into the same global
    // vertex, reproducing exactly what computeVertexNormals() would produce
    // on one merged mesh — seamless lighting across chunk borders.
    const nacc = new Float32Array(this.res * this.res * 3);
    const builds: Array<{ geo: THREE.BufferGeometry; keys: Uint32Array }> = [];
    for (let cj = 0; cj < chunksPerSide; cj++) {
      for (let ci = 0; ci < chunksPerSide; ci++) {
        const geo = new THREE.BufferGeometry();
        const nv = vps * vps;
        const posArr = new Float32Array(nv * 3);
        const uvArr = new Float32Array(nv * 2);
        const colArr = new Float32Array(nv * 3);
        const keys = new Uint32Array(nv);
        const tmp = new THREE.Color();
        for (let ly = 0; ly < vps; ly++) {
          for (let lx = 0; lx < vps; lx++) {
            // global grid indices — shared edge vertices get the SAME (x, z)
            // in every chunk that owns them (bit-identical, no cracks)
            const gi = ci * cellsPerChunk + lx, gj = cj * cellsPerChunk + ly;
            const vi = ly * vps + lx;
            const x = -half + gi * this.cell, z = -half + gj * this.cell;
            const y = h[gi][gj];
            posArr[vi * 3] = x; posArr[vi * 3 + 1] = y; posArr[vi * 3 + 2] = z;
            uvArr[vi * 2] = gi / (this.res - 1); uvArr[vi * 2 + 1] = 1 - gj / (this.res - 1);
            keys[vi] = gi * this.res + gj;
            // legacy read the coords back from the float32 position attribute —
            // the color noise must see the same rounded inputs to stay identical
            const fx = posArr[vi * 3], fz = posArr[vi * 3 + 2];
            const slopeN = noise.get(fx * 0.05, fz * 0.05);
            tmp.copy(cGround).lerp(cAlt, (slopeN + 1) / 2);
            const hn = THREE.MathUtils.clamp((y / Math.max(1, t.maxHeight)) - 0.6, 0, 1);
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
        for (let ly = 0; ly < cellsPerChunk; ly++) {
          for (let lx = 0; lx < cellsPerChunk; lx++) {
            const a = lx + vps * ly, b = lx + vps * (ly + 1);
            const c = (lx + 1) + vps * (ly + 1), d = (lx + 1) + vps * ly;
            idx.push(a, b, d, b, c, d);
          }
        }
        geo.setIndex(idx);
        geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
        geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
        // face-normal accumulation — the same math as three's
        // computeVertexNormals (cb = (pC-pB) x (pA-pB), summed per vertex),
        // but into the shared global grid so chunk borders shade seamlessly
        for (let f = 0; f < idx.length; f += 3) {
          const iA = idx[f] * 3, iB = idx[f + 1] * 3, iC = idx[f + 2] * 3;
          const cbx = posArr[iC] - posArr[iB], cby = posArr[iC + 1] - posArr[iB + 1], cbz = posArr[iC + 2] - posArr[iB + 2];
          const abx = posArr[iA] - posArr[iB], aby = posArr[iA + 1] - posArr[iB + 1], abz = posArr[iA + 2] - posArr[iB + 2];
          const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
          const kA = keys[idx[f]] * 3, kB = keys[idx[f + 1]] * 3, kC = keys[idx[f + 2]] * 3;
          nacc[kA] = Math.fround(nacc[kA] + nx); nacc[kA + 1] = Math.fround(nacc[kA + 1] + ny); nacc[kA + 2] = Math.fround(nacc[kA + 2] + nz);
          nacc[kB] = Math.fround(nacc[kB] + nx); nacc[kB + 1] = Math.fround(nacc[kB + 1] + ny); nacc[kB + 2] = Math.fround(nacc[kB + 2] + nz);
          nacc[kC] = Math.fround(nacc[kC] + nx); nacc[kC + 1] = Math.fround(nacc[kC + 1] + ny); nacc[kC + 2] = Math.fround(nacc[kC + 2] + nz);
        }
        builds.push({ geo, keys });
      }
    }
    // normalize the shared accumulators back into each chunk (== three's normalizeNormals)
    for (const { geo, keys } of builds) {
      const nrm = geo.attributes.normal as THREE.BufferAttribute;
      for (let vi = 0; vi < keys.length; vi++) {
        const k3 = keys[vi] * 3;
        const l = Math.sqrt(nacc[k3] * nacc[k3] + nacc[k3 + 1] * nacc[k3 + 1] + nacc[k3 + 2] * nacc[k3 + 2]) || 1;
        nrm.setXYZ(vi, nacc[k3] / l, nacc[k3 + 1] / l, nacc[k3 + 2] / l);
      }
    }
    // steep slopes -> rock color (legacy pass, per chunk)
    for (const { geo } of builds) {
      const nrm = geo.attributes.normal as THREE.BufferAttribute;
      const col = geo.attributes.color as THREE.BufferAttribute;
      const tmp = new THREE.Color();
      for (let k = 0; k < nrm.count; k++) {
        const ny = nrm.getY(k);
        if (ny < 0.75) {
          const f = THREE.MathUtils.clamp((0.75 - ny) / 0.3, 0, 1);
          tmp.setRGB(col.getX(k), col.getY(k), col.getZ(k)).lerp(cRock, f);
          col.setXYZ(k, tmp.r, tmp.g, tmp.b);
        }
      }
      col.needsUpdate = true;
    }
    // Workstream C: ground material comes from the biome treatment (cached,
    // shared — never disposed here). volcanic → ember-cracked basalt with
    // glowing veins; snow → glittering snowdrift; desert → cracked earth, etc.
    const mat = mats.biomeGroundDef(biome.ground, { repeat: this.size / 8 });
    mat.vertexColors = true;
    for (const { geo } of builds) {
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.castShadow = false;
      scene.add(m);
      this.chunkMeshes.push(m);
    }
    this.mesh = this.chunkMeshes[0];

    // ---- chunked physics + streaming (stage-1 workstream B): one static
    // cannon Heightfield per chunk, each built from a sub-matrix of the
    // shared world-space height grid above — the SAME grid worker A's chunk
    // meshes sample, so physics and visuals agree exactly. Static bodies are
    // cheap collision data; the bodyStream pages them in/out of the physics
    // world by player distance, with hysteresis (no load/unload thrash) and
    // a per-frame build budget.
    //
    // The j-axis mirror fix from the single-body era is preserved PER CHUNK:
    // chunk data P[li][lj] = h[i0+li][j1-lj], body at (x0, 0, z1) with
    // x0 = −half+i0·cell, z1 = −half+j1·cell, same −90° X rotation — so
    // cannon's local (li·e, lj·e) lands exactly on the mesh's h[i][j] (B3).
    // Adjacent chunks share edge sample rows exactly (one grid, 1-cell
    // overlap == shared edges), so there is no tunneling at seams.
    //
    // Grid parameters are derived from A's canonical chunk fields (never
    // recomputed independently — physics chunks MUST align with mesh chunks).
    const cps = Math.round(this.size / this.chunkSize); // == A's chunksPerSide
    this.grid = {
      chunksPerSide: cps,
      cellsPerChunk: (this.res - 1) / cps, // exact: A builds res = cps*cpc+1
      chunkSize: this.chunkSize,
      cell: this.cell,
      half,
      res: this.res,
    };
    this.bodyStream = new ChunkStream({
      grid: this.grid,
      loadRadius: this.chunkSize * 2.5,
      unloadRadius: this.chunkSize * 4,
      lifecycle: {
        buildChunk: (cx, cz) => this.buildChunkBody(cx, cz, physics),
        releaseChunk: (cx, cz) => {
          const b = this.chunkBodies.get(chunkKey(cx, cz));
          if (b) { physics.remove(b); this.chunkBodies.delete(chunkKey(cx, cz)); }
        },
      },
    });
    // Meshes: worker A builds every chunk mesh up front; the mesh stream
    // pages them in/out of the scene (draw-call hygiene). Radii cover the
    // camera far plane (~1400m) with margin so the horizon never shows
    // holes; worker D's far-field work owns tuning these further. Geometry
    // stays owned by A — streaming only toggles scene membership, never
    // disposes.
    this.meshStream = new ChunkStream({
      grid: this.grid,
      loadRadius: MESH_STREAM_LOAD_RADIUS,
      unloadRadius: MESH_STREAM_UNLOAD_RADIUS,
      lifecycle: {
        buildChunk: (cx, cz) => {
          const m = this.chunkMeshes[cz * cps + cx];
          if (m && m.parent !== scene) scene.add(m);
        },
        releaseChunk: (cx, cz) => {
          const m = this.chunkMeshes[cz * cps + cx];
          if (m) scene.remove(m);
        },
      },
    });
    // Initial page-in around spawn: the world must be walkable on frame one.
    // ChunkStream treats the first update as a teleport and pages everything
    // within loadRadius synchronously (deterministic). Small worlds are one
    // chunk — identical to the old single-body behavior.
    this.bodyStream.update(new THREE.Vector3(0, 0, 0));
    this.meshStream.update(new THREE.Vector3(0, 0, 0));
    const oc = worldToChunk(0, 0, this.grid);
    this.body = this.chunkBodies.get(chunkKey(oc.cx, oc.cz))!;

    // ---- boundary
    if (spec.world.boundary !== 'wrap') {
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
      wm.customProgramCacheKey = () => 'xandria-water-v3';
      wm.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = wm.userData.uTime;
        shader.uniforms.uSunDirW = wm.userData.uSunDirW;
        shader.uniforms.uGlint = wm.userData.uGlint;
        shader.uniforms.uSkyTint = wm.userData.uSkyTint;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime; varying vec3 vWPos;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec3 uSunDirW; uniform vec3 uGlint; uniform vec3 uSkyTint; varying vec3 vWPos; float gShimmer;')
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

  /** Chunk layout for worker B / engine.perf instrumentation. */
  getChunkStats(): { chunkCount: number; chunkSize: number } {
    return { chunkCount: this.chunkMeshes.length, chunkSize: this.chunkSize };
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
   * body for chunk (cx,cz). Samples the shared world-space height grid — the
   * same grid worker A's chunk meshes sample — so physics and visuals agree
   * exactly, including at chunk borders (shared edge samples; see the
   * constructor note).
   */
  private buildChunkBody(cx: number, cz: number, physics: Physics): void {
    const { i0, i1, j0, j1 } = chunkCellRange(cx, cz, this.grid);
    const half = this.grid.half, cell = this.grid.cell;
    // j-mirror per chunk: P[li][lj] = h[i0+li][j1-lj] (B3 fix, chunk-local).
    const data: number[][] = [];
    for (let li = 0; li <= i1 - i0; li++) {
      data[li] = [];
      for (let lj = 0; lj <= j1 - j0; lj++) data[li][lj] = this.heights[i0 + li][j1 - lj];
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

  dispose(scene: THREE.Scene, physics: Physics) {
    // Stage-1 B: page out everything first — bodyStream.reset() removes all
    // resident chunk bodies from the physics world (the legacy `body` alias
    // is the origin chunk's body), meshStream.reset() removes paged-in chunk
    // meshes from the scene — then dispose A's geometries (owned by A, never
    // disposed by the mesh stream).
    this.bodyStream.reset();
    this.meshStream.reset();
    for (const m of this.chunkMeshes) { scene.remove(m); m.geometry.dispose(); }
    this.chunkMeshes = [];
    for (const w of this.walls) physics.remove(w);
    if (this.water) { scene.remove(this.water); this.water.geometry.dispose(); }
  }
}
