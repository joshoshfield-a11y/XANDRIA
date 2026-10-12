/** Heightfield terrain: vertex-colored, textured, with matching cannon Heightfield and boundary walls. */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { GameSpec } from '@spec';
import { Noise2D } from '../core/Rng';
import { MaterialLibrary, shade } from '../gfx/Materials';
import { gradeAtmosphere } from '../gfx/GenreGrade';
import { resolveBiomeDef, biomeTint } from './Biomes';
import { GROUP, type Physics } from '../core/Physics';

export class Terrain {
  mesh: THREE.Mesh;
  body: CANNON.Body;
  readonly size: number;
  readonly res: number;
  private heights: number[][];
  private cell: number;
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
    this.res = Math.min(128, Math.max(32, Math.round(t.size / 2.5)));
    this.cell = this.size / (this.res - 1);
    this.maxHeight = t.maxHeight;
    const noise = new Noise2D(spec.meta.seed);
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
    const h: number[][] = [];
    const half = this.size / 2;
    const flat = opts.flatCenters ?? [new THREE.Vector3(0, 0, 0)];
    const flatR = opts.flatRadius ?? Math.max(14, this.size * 0.08);
    for (let i = 0; i < this.res; i++) {
      h[i] = [];
      for (let j = 0; j < this.res; j++) {
        const x = -half + i * this.cell, z = -half + j * this.cell;
        let y = 0;
        const nx = x / this.size, nz = z / this.size;
        const base = noise.fbm(nx * 3 * freq + 10, nz * 3 * freq + 10, 5, 2, 0.5);
        switch (t.type) {
          case 'flat': y = base * 0.6; break;
          case 'hills': y = (base + 0.3) * t.maxHeight * (0.4 + t.roughness * 0.6); break;
          case 'mountains': y = Math.pow(Math.abs(base) + 0.15, 1.6) * t.maxHeight * 1.4 * (0.5 + t.roughness); break;
          case 'canyon': { const r = Math.abs(noise.get(nx * 2 * freq, nz * 2 * freq + 5)); y = (r < 0.18 ? -0.6 : 0.8 + base * 0.5) * t.maxHeight; break; }
          case 'islands': { const d = Math.hypot(nx, nz) * 2; y = (base + 0.35 - d * d * 0.9) * t.maxHeight; break; }
          case 'platforms': y = Math.round((base + 1) * 3) * (t.maxHeight / 6); break;
        }
        y *= hscale;
        // edge falloff: rim rises (or drops) for boundary
        const edge = Math.max(Math.abs(nx), Math.abs(nz)) * 2; // 0..1
        if (spec.world.boundary === 'cliffs') y -= Math.pow(Math.max(0, edge - 0.85) / 0.15, 2) * 40;
        else if (spec.world.boundary === 'walls') y += Math.pow(Math.max(0, edge - 0.9) / 0.1, 2) * t.maxHeight * 0.8;
        // flatten around spawn / arena centers
        for (const c of flat) {
          const d = Math.hypot(x - c.x, z - c.z);
          if (d < flatR * 1.8) { const k = THREE.MathUtils.smoothstep(d, flatR * 0.6, flatR * 1.8); y = THREE.MathUtils.lerp(c.y, y, k); }
        }
        h[i][j] = y;
      }
    }
    this.heights = h;

    // ---- geometry with vertex colors
    const geo = new THREE.PlaneGeometry(this.size, this.size, this.res - 1, this.res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
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
    const tmp = new THREE.Color();
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), z = pos.getZ(k);
      const i = Math.round((x + half) / this.cell), j = Math.round((z + half) / this.cell);
      const y = h[Math.min(this.res - 1, Math.max(0, i))][Math.min(this.res - 1, Math.max(0, j))];
      pos.setY(k, y);
      const slopeN = noise.get(x * 0.05, z * 0.05);
      tmp.copy(cGround).lerp(cAlt, (slopeN + 1) / 2);
      const hn = THREE.MathUtils.clamp((y / Math.max(1, t.maxHeight)) - 0.6, 0, 1);
      tmp.lerp(cRock, hn * 1.2);
      // high-frequency patchiness: earthy hollows + bleached rises
      const patchN = noise.get(x * 0.33 + 47.3, z * 0.33 - 23.7);
      const pk = (patchN + 1) / 2;
      if (pk < 0.42) tmp.lerp(cPatchDark, ((0.42 - pk) / 0.42) * 0.6);
      else if (pk > 0.58) tmp.lerp(cPatchLight, ((pk - 0.58) / 0.42) * 0.4);
      colors[k * 3] = tmp.r; colors[k * 3 + 1] = tmp.g; colors[k * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    // steep slopes -> rock color
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      const ny = nrm.getY(k);
      if (ny < 0.75) { const f = THREE.MathUtils.clamp((0.75 - ny) / 0.3, 0, 1); tmp.setRGB(colors[k * 3], colors[k * 3 + 1], colors[k * 3 + 2]).lerp(cRock, f); colors[k * 3] = tmp.r; colors[k * 3 + 1] = tmp.g; colors[k * 3 + 2] = tmp.b; }
    }
    geo.attributes.color.needsUpdate = true;
    // Workstream C: ground material comes from the biome treatment (cached,
    // shared — never disposed here). volcanic → ember-cracked basalt with
    // glowing veins; snow → glittering snowdrift; desert → cracked earth, etc.
    const mat = mats.biomeGroundDef(biome.ground, { repeat: this.size / 8 });
    mat.vertexColors = true;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    scene.add(this.mesh);

    // ---- physics heightfield (cannon expects matrix[i][j] with x along i, y along j)
    // The body rotation (-90° about X) + position map local (i·e, j·e) to world
    // (−half+i·e, +half−j·e), i.e. the j axis comes out Z-mirrored relative to
    // the visual mesh and heightAt(), which place h[i][j] at z = −half+j·e.
    // Mirror the data along j so physics grid sample (i,j) collides exactly
    // where heightAt()/the mesh put h[i][j] (B3).
    const phys: number[][] = [];
    for (let i = 0; i < this.res; i++) {
      phys[i] = [];
      for (let j = 0; j < this.res; j++) phys[i][j] = h[i][this.res - 1 - j];
    }
    const shape = new CANNON.Heightfield(phys, { elementSize: this.cell });
    this.body = new CANNON.Body({ mass: 0, material: physics.defaultMat, collisionFilterGroup: GROUP.WORLD });
    this.body.addShape(shape);
    // rotate so that heightfield's local (x, y) → world (x, z), local z → world y
    this.body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.body.position.set(-half, 0, half);
    physics.world.addBody(this.body);

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

  /** Bilinear height sample at world (x,z). */
  heightAt(x: number, z: number): number {
    const half = this.size / 2;
    const fi = (x + half) / this.cell, fj = (z + half) / this.cell;
    const i = Math.floor(fi), j = Math.floor(fj);
    const cl = (v: number) => Math.min(this.res - 1, Math.max(0, v));
    const i0 = cl(i), i1 = cl(i + 1), j0 = cl(j), j1 = cl(j + 1);
    const tx = THREE.MathUtils.clamp(fi - i, 0, 1), tz = THREE.MathUtils.clamp(fj - j, 0, 1);
    const a = this.heights[i0][j0], b = this.heights[i1][j0], c = this.heights[i0][j1], d = this.heights[i1][j1];
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), tz);
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
   * New biomes add table rows, not controller branches.
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
    scene.remove(this.mesh); this.mesh.geometry.dispose();
    physics.remove(this.body);
    for (const w of this.walls) physics.remove(w);
    if (this.water) { scene.remove(this.water); this.water.geometry.dispose(); }
  }
}
