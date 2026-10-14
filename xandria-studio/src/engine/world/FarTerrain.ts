/**
 * FarTerrain — low-res far-field shell (Open World stage 1, workstream D).
 *
 * One whole-world low-res mesh (64x64) rendered UNDER the detail/streamed
 * terrain on big maps, so the horizon reads as intentional land instead of
 * fog void or a GPU-clipped edge. It is deliberately dumb:
 *
 * - Heights come from `terrain.heightAt()` — bilinear of the detail height
 *   grid, so the silhouette is consistent with the visible mesh by
 *   construction (worker B's chunked terrain keeps heightAt, so this seam
 *   survives the streaming refactor).
 * - Vertex colors use the same recipe as Terrain.ts (same Noise2D seed, same
 *   world coords → identical noise values) over the shared cached biome
 *   ground material, so the shell reads as the same land at distance.
 * - A downward y-bias (farShellBias: covers the measured max shell-vs-detail
 *   interpolation error per terrain type) keeps it below the detail mesh
 *   everywhere — no z-fighting, no polygon-offset fragility. The bias is a
 *   few meters at the chunk-stream boundary and invisible under fog.
 * - One draw call, no shadows in or out, never frustum-culled.
 * - Stage 1b: resolution tiers (farShellSegmentsForWorldSize) keep the
 *   absolute cell <= ~64m on multi-km maps; the shell stays static (never
 *   swaps or follows the camera), so there are no LOD transitions to pop.
 *
 * Gated to big worlds (FAR_TERRAIN_MIN_SIZE) by the Engine — small worlds
 * render byte-identical without it.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import { Noise2D } from '../core/Rng';
import type { MaterialLibrary } from '../gfx/Materials';
import { farShellBias, farShellSegmentsForWorldSize } from '../gfx/FarField';
import { resolveBiomeDef, biomeTint } from './Biomes';
import type { Terrain } from './Terrain';

/**
 * Shell resolution (segments per side) for stage-1 sizes (<=2000m) — one
 * draw call, ~8k tris. Larger worlds use farShellSegmentsForWorldSize()
 * tiers (96/128); every tier is still exactly one draw call.
 */
export const FAR_TERRAIN_SEGMENTS = 64;

export class FarTerrain {
  readonly mesh: THREE.Mesh;
  readonly size: number;
  readonly bias: number;
  /** segments per side actually built (resolution tier for this world size) */
  readonly segments: number;

  constructor(spec: GameSpec, terrain: Terrain, mats: MaterialLibrary, scene: THREE.Scene) {
    const size = terrain.size;
    this.size = size;
    const SEG = farShellSegmentsForWorldSize(size);
    this.segments = SEG;
    // Downward bias: covers the measured max shell-vs-detail interpolation
    // error per terrain type (see farShellBias) so the shell never pokes
    // through the detail mesh — no z-fighting, no polygon-offset fragility.
    // The shell is static (never swaps/follows), so there are no LOD
    // transitions to pop; depth precision at the overlap zone is ~cm (the
    // near:far ratio is held constant per FarField.ts), far below the bias.
    const t = spec.world.terrain;
    const heightScale = (spec.custom?.biome as { heightScale?: number } | undefined)?.heightScale ?? 1;
    this.bias = farShellBias(t.type, t.maxHeight, heightScale);

    const half = size / 2;
    const maxH = Math.max(1, t.maxHeight);

    // Same color recipe as Terrain.ts — same Noise2D(seed), same world
    // coords, so slope/patch noise values are identical to the detail mesh.
    const biome = resolveBiomeDef(spec);
    const noise = new Noise2D(spec.meta.seed);
    const cGround = biomeTint(spec.theme.palette.ground, biome.palette.ground);
    const cAlt = biomeTint(spec.theme.palette.groundAlt, biome.palette.groundAlt);
    const cRock = biomeTint(spec.theme.palette.rock, biome.palette.rock);
    const cPatchDark = cGround.clone().lerp(cRock, 0.35).multiplyScalar(0.72);
    const cPatchLight = cGround.clone().lerp(new THREE.Color(1, 1, 1), 0.28);
    const tmp = new THREE.Color();

    const n = SEG + 1;
    const positions = new Float32Array(n * n * 3);
    const colors = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    let k = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -half + (i / SEG) * size;
        const z = -half + (j / SEG) * size;
        const h = terrain.heightAt(x, z);
        positions[k * 3] = x;
        positions[k * 3 + 1] = h + this.bias;
        positions[k * 3 + 2] = z;
        // vertex color: ground→alt by slope noise, rock blend by height —
        // Terrain.ts's formula verbatim (uses the unbiased height)
        const slopeN = noise.get(x * 0.05, z * 0.05);
        tmp.copy(cGround).lerp(cAlt, (slopeN + 1) / 2);
        const hn = THREE.MathUtils.clamp(h / maxH - 0.6, 0, 1);
        tmp.lerp(cRock, hn * 1.2);
        const patchN = noise.get(x * 0.33 + 47.3, z * 0.33 - 23.7);
        const pk = (patchN + 1) / 2;
        if (pk < 0.42) tmp.lerp(cPatchDark, ((0.42 - pk) / 0.42) * 0.6);
        else if (pk > 0.58) tmp.lerp(cPatchLight, ((pk - 0.58) / 0.42) * 0.4);
        colors[k * 3] = tmp.r;
        colors[k * 3 + 1] = tmp.g;
        colors[k * 3 + 2] = tmp.b;
        // UVs match Terrain's PlaneGeometry (0..1 across) so the shared
        // cached ground texture tiles identically to the detail mesh.
        uvs[k * 2] = i / SEG;
        uvs[k * 2 + 1] = j / SEG;
        k++;
      }
    }
    const indices: number[] = [];
    for (let j = 0; j < SEG; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(indices);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.computeVertexNormals();

    // Same cached material as the detail terrain (vertexColors already on) —
    // the shell is lit and textured exactly like the land it sits under.
    const mat = mats.biomeGroundDef(biome.ground, { repeat: size / 8 });
    mat.vertexColors = true;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Rendered in the normal opaque pass; the downward bias (not renderOrder)
    // keeps it behind the detail mesh — no draw-order coupling with the
    // streaming chunks.
    scene.add(this.mesh);
  }

  dispose(): void {
    const scene = this.mesh.parent;
    if (scene) scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    // material is MaterialLibrary-cached/shared — never disposed here.
  }
}
