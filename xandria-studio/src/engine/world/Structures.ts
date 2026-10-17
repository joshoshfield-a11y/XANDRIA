/**
 * Built structures: city blocks, arena cover, floating platforms, race tracks.
 * Every mesh gets a matching physics body. Track = closed CatmullRom loop with ribbon road,
 * barrier walls, checkpoint gates and a start/finish gantry.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import { Rng } from '../core/Rng';
import { GROUP, type Physics } from '../core/Physics';
import type { MaterialLibrary } from '../gfx/Materials';
import type { Terrain } from './Terrain';
import { resolveBiomeDef } from './Biomes';
import { scatterGrid } from './ChunkGrid';
import { placeLandmarks, type LandmarkOpts, type LandmarkResult, type LandmarkKind } from '../gfx/Landmarks';
import { placeStructureSets, type StructureSetOpts, type StructureSetResult } from '../gfx/StructureSets';

export class Structures {
  group = new THREE.Group();

  constructor(private physics: Physics, private mats: MaterialLibrary) {}

  private addBox(size: [number, number, number], pos: [number, number, number], mat: THREE.Material, opts: { ry?: number; mass?: number; shadow?: boolean } = {}): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    m.position.set(...pos);
    if (opts.ry) m.rotation.y = opts.ry;
    m.castShadow = opts.shadow ?? true;
    m.receiveShadow = true;
    this.group.add(m);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, opts.ry ?? 0, 0));
    this.physics.box(size, pos, { mass: opts.mass ?? 0, group: GROUP.WORLD, quaternion: q });
    return m;
  }

  /** City block grid centered at origin. Leaves a plaza at the center. */
  city(spec: GameSpec, terrain: Terrain, count: number, seed: number) {
    const rng = new Rng(seed ^ 0xc171);
    const pal = spec.theme.palette;
    const neon = spec.theme.environment === 'neon-city';
    const wallMat = this.mats.standard(neon ? 'panel' : 'concrete', neon ? '#2a2f45' : '#7d8288', { roughness: 0.85 });
    const accMat = this.mats.glow(pal.accent, neon ? 2.2 : 0.6);
    const half = terrain.size / 2 - 15;
    for (let i = 0; i < count; i++) {
      const x = rng.range(-half, half), z = rng.range(-half, half);
      if (Math.hypot(x, z) < 24) continue; // central plaza
      const w = rng.range(6, 14), d = rng.range(6, 14), h = rng.range(6, neon ? 34 : 22);
      const y = terrain.heightAt(x, z);
      this.addBox([w, h, d], [x, y + h / 2 - 0.5, z], wallMat);
      // glowing window band
      if (neon && rng.chance(0.7)) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.35, d + 0.1), accMat);
        band.position.set(x, y + h * rng.range(0.4, 0.9), z);
        this.group.add(band);
      }
      // rooftop antenna
      if (rng.chance(0.3)) this.addBox([0.3, 3, 0.3], [x, y + h + 1, z], this.mats.flat('#444a55'));
    }
  }

  /** Arena cover: crates, walls, pillars scattered in a radius. */
  arenaCover(spec: GameSpec, terrain: Terrain, count: number, radius: number, seed: number) {
    const rng = new Rng(seed ^ 0xa3e1);
    const crate = this.mats.standard('panel', '#5d6672', { roughness: 0.7, metalness: 0.3 });
    const crate2 = this.mats.standard('metal', '#7a6a4a', { roughness: 0.6, metalness: 0.4 });
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(radius * 0.25, radius);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = terrain.heightAt(x, z);
      const kind = rng.next();
      if (kind < 0.45) {
        const s = rng.range(1.2, 2.4);
        this.addBox([s, s, s], [x, y + s / 2, z], rng.chance(0.5) ? crate : crate2, { ry: rng.range(0, Math.PI) });
        if (rng.chance(0.4)) this.addBox([s * 0.8, s * 0.8, s * 0.8], [x, y + s + s * 0.4, z], crate2, { ry: rng.range(0, Math.PI) });
      } else if (kind < 0.75) {
        // low wall
        this.addBox([rng.range(3, 6), 1.6, 0.5], [x, y + 0.8, z], crate, { ry: rng.range(0, Math.PI) });
      } else {
        // pillar
        const h = rng.range(3, 6);
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, h, 8), crate);
        p.position.set(x, y + h / 2, z);
        p.castShadow = true; p.receiveShadow = true;
        this.group.add(p);
        this.physics.cylinder(0.6, 0.7, h, [x, y + h / 2, z], { group: GROUP.WORLD });
      }
    }
  }

  /** Perimeter wall ring for arenas (visual + physical). */
  arenaWalls(center: THREE.Vector3, radius: number, height: number) {    const segs = Math.max(12, Math.round(radius / 4));
    const mat = this.mats.standard('panel', '#4a5058', { roughness: 0.7 });
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const x = center.x + Math.cos(a0) * radius;
      const z = center.z + Math.sin(a0) * radius;
      const chord = 2 * radius * Math.sin(Math.PI / segs);
      this.addBox([chord + 0.5, height, 1], [x, center.y + height / 2, z], mat, { ry: -a0 + Math.PI / 2 });
    }
  }

  /**
   * Environment art-direction pass: 1–3 seeded landmarks per world
   * (beam towers, ruin arches, bridges) from gfx/Landmarks. Kinds follow the
   * environment mix × genre bias (desert→arches, volcanic→towers,
   * racing→bridges, …); every landmark registers instanced amber rune strips
   * + lamp posts. `kinds` forces explicit per-kind counts. Adds static
   * physics colliders for each landmark. Returns the placement report.
   *
   * Blueprint hook: `structures.landmarks(spec, terrain, scene, seed, {
   *   exclusion: [...] })` — one line, right after Scatter.
   */
  landmarks(spec: GameSpec, terrain: Terrain, scene: THREE.Scene, seed: number, opts: {
    exclusion?: Array<{ x: number; z: number; r: number }>;
    kinds?: Partial<Record<LandmarkKind, number>>;
    quality?: 'retro' | 'standard' | 'high';
    maxRealLights?: number;
  } = {}): LandmarkResult {
    const rng = new Rng((seed ^ 0x1a4d) >>> 0);
    const pal = spec.theme.palette;
    const t = spec.world.terrain;
    // Workstream C: the biome's authored landmark mix is the default `kinds`
    // (desert canyons → arches, volcanic → beam towers, coastline → bridges);
    // an explicit opts.kinds still wins.
    const biome = resolveBiomeDef(spec);
    const landmarkOpts: LandmarkOpts = {
      mats: this.mats,
      pal: { primary: pal.primary, secondary: pal.secondary, accent: pal.accent, rock: pal.rock, ground: pal.ground },
      heightAt: (x, z) => terrain.heightAt(x, z),
      genre: spec.meta.genre,
      env: spec.theme.environment,
      quality: opts.quality,
      half: terrain.size / 2 - 12,
      exclusion: opts.exclusion,
      kinds: opts.kinds ?? biome.landmarks,
      waterLevel: t.water ? t.waterLevel : undefined,
      maxRealLights: opts.maxRealLights,
      addCollider: (size, pos) => { this.physics.box(size, pos, { mass: 0, group: GROUP.WORLD }); },
    };
    const result = placeLandmarks(scene, rng, landmarkOpts);
    this.group.add(result.group);
    // Graphics wave 2, workstream A: trampled aprons around landmark bases +
    // worn paths from spawn toward nearby landmarks, baked into terrain
    // vertex colors (zero new draw calls — Terrain.addWearPoints repaints in
    // place and future chunk builds pick it up). Corridors only for
    // landmarks within ~220m of spawn; distant ones get aprons only.
    const sx = terrain.spawnXZ.x, sz = terrain.spawnXZ.z;
    const discs = result.placed.map((p) => ({
      x: p.pos.x, z: p.pos.z, radius: p.radius * 1.8 + 5, strength: 0.45,
    }));
    const paths: Array<{ ax: number; az: number; bx: number; bz: number; width: number; strength: number }> = [];
    for (const p of result.placed) {
      const d = Math.hypot(p.pos.x - sx, p.pos.z - sz);
      if (d > 40 && d < 220) {
        paths.push({ ax: sx, az: sz, bx: p.pos.x, bz: p.pos.z, width: 4.5, strength: 0.4 });
      }
    }
    terrain.addWearPoints(discs, paths);
    return result;
  }

  /**
   * Graphics wave 2 (workstream C): per-biome structure sets.
   *
   * Expands the landmark pass with the biome's authored architectural
   * set-pieces — desert canyon ruins, forest/plains watchtowers, snow
   * shrines, volcanic obsidian spires, coastline docks + lighthouses, cave
   * crystal formations. Composition: a hero cluster (3 structures + amber
   * rune ring) 30–55m from spawn as the arrival vignette, then
   * chunk-deterministic satellite clusters across the map.
   *
   * Seeding: `seed` must be the map's derived build seed (blueprints pass
   * spec.meta.seed, which the portals wave stamps as
   * deriveMapSeed(worldSeed, mx, my)) — every map regenerates identically.
   * Satellite placement rolls per chunk from chunkSeed(mapSeed, salt, cx, cz),
   * so the same chunk always yields the same structures whatever the load
   * order; the result's collidersByChunk map lets workstream E stream the
   * static colliders through the ChunkStream lifecycle later.
   *
   * Draw calls stay flat: every structure emits into one shared Instancer
   * (the AmberGlow pattern) — one draw per material bucket (rock, dark,
   * amber, teal) for the whole map. Adds static physics colliders.
   *
   * Blueprint hook: `structures.structureSets(spec, terrain, scene,
   * spec.meta.seed, { exclusion: [...] })` — one line, right after
   * structures.landmarks(...).
   */
  structureSets(spec: GameSpec, terrain: Terrain, scene: THREE.Scene, seed: number, opts: {
    exclusion?: Array<{ x: number; z: number; r: number }>;
    quality?: 'retro' | 'standard' | 'high';
    /** Graphics wave 2 (E): tier density multiplier for satellite clusters. */
    densityMul?: number;
    /** Graphics wave 2 (E): s25 disables structure shadows (diet for C's +5). */
    structureShadows?: boolean;
  } = {}): StructureSetResult {
    const rng = new Rng((seed ^ 0x57c7) >>> 0);
    const biome = resolveBiomeDef(spec);
    const t = spec.world.terrain;
    const setOpts: StructureSetOpts = {
      mats: this.mats,
      biome,
      heightAt: (x, z) => terrain.heightAt(x, z),
      mapSeed: seed >>> 0,
      quality: opts.quality,
      densityMul: opts.densityMul,
      structureShadows: opts.structureShadows,
      half: terrain.size / 2 - 12,
      grid: scatterGrid(terrain),
      exclusion: opts.exclusion,
      waterLevel: t.water ? t.waterLevel : undefined,
      addCollider: (size, pos) => { this.physics.box(size, pos, { mass: 0, group: GROUP.WORLD }); },
    };
    const result = placeStructureSets(scene, rng, setOpts);
    this.group.add(result.group);
    return result;
  }

  /**
   * Floating platform course. Returns platform list (top y and center) for gameplay wiring.
   */
  platforms(seed: number, count: number, start: THREE.Vector3, dir: THREE.Vector3, opts: { gapMin?: number; gapMax?: number; sizeMin?: number; sizeMax?: number; riseMax?: number } = {}) {
    const rng = new Rng(seed ^ 0x9a1f);
    const list: { pos: THREE.Vector3; size: THREE.Vector3 }[] = [];
    const matA = this.mats.standard('rock', '#7d7568', { roughness: 0.95 });
    const matB = this.mats.standard('panel', '#5d6672', { roughness: 0.8 });
    const cur = start.clone();
    const d = dir.clone().normalize();
    // starting pad
    list.push({ pos: cur.clone(), size: new THREE.Vector3(8, 1, 8) });
    this.addBox([8, 1, 8], [cur.x, cur.y - 0.5, cur.z], matA);
    const side = new THREE.Vector3(-d.z, 0, d.x);
    for (let i = 1; i < count; i++) {
      const gap = rng.range(opts.gapMin ?? 3.4, opts.gapMax ?? 5.6);
      cur.addScaledVector(d, gap);
      cur.addScaledVector(side, rng.range(-2.4, 2.4));
      cur.y += rng.range(-0.8, opts.riseMax ?? 1.6);
      cur.y = Math.max(1.2, cur.y);
      const sx = rng.range(opts.sizeMin ?? 2.6, opts.sizeMax ?? 4.6);
      const sz = rng.range(opts.sizeMin ?? 2.6, opts.sizeMax ?? 4.6);
      const plat = { pos: cur.clone(), size: new THREE.Vector3(sx, 1, sz) };
      list.push(plat);
      this.addBox([sx, 1, sz], [cur.x, cur.y - 0.5, cur.z], rng.chance(0.7) ? matA : matB, { ry: rng.range(-0.2, 0.2) });
      // occasional moving platform marker pole / decor
      if (rng.chance(0.25)) {
        const deco = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.2, 5), this.mats.glow('#7af7ff', 1.5));
        deco.position.set(cur.x + sx * 0.3, cur.y + 0.6, cur.z + sz * 0.3);
        this.group.add(deco);
      }
    }
    return list;
  }

  /**
   * Race track: closed loop. Flattens terrain under the ribbon (via flatCenters passed to Engine),
   * builds road mesh + barriers + checkpoint gates. Returns waypoints for AI/checkpoints.
   */
  track(spec: GameSpec, terrain: Terrain, seed: number): { curve: THREE.CatmullRomCurve3; waypoints: THREE.Vector3[]; width: number; startPos: THREE.Vector3; startHeading: number } {
    const rng = new Rng(seed ^ 0x7ac1);
    const width = 12;
    const R = terrain.size * 0.32;
    const n = 14;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = R * rng.range(0.68, 1.15);
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.6);
    // sample + set y from terrain
    const waypoints = curve.getSpacedPoints(200).map((p) => new THREE.Vector3(p.x, terrain.heightAt(p.x, p.z) + 0.25, p.z));
    const loop = new THREE.CatmullRomCurve3(waypoints, true, 'centripetal', 0.5);
    const samples = loop.getSpacedPoints(400);

    // road ribbon
    const roadGeo = new THREE.BufferGeometry();
    const verts: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const tangent = loop.getTangentAt(i / samples.length).setY(0).normalize();
      const side = new THREE.Vector3().crossVectors(tangent, up).multiplyScalar(width / 2);
      verts.push(p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z);
      uvs.push(0, i / 4, 1, i / 4);
    }
    for (let i = 0; i < samples.length; i++) {
      const a = i * 2, b = ((i + 1) % samples.length) * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    roadGeo.setIndex(idx);
    roadGeo.computeVertexNormals();
    const road = new THREE.Mesh(roadGeo, this.mats.standard('asphalt', '#3a3d42', { roughness: 0.95 }));
    road.receiveShadow = true;
    this.group.add(road);

    // barriers: instanced low walls on both edges
    const barrierGeo = new THREE.BoxGeometry(2.2, 1, 0.5);
    const barrierMat = this.mats.standard('concrete', '#c8c9cd', { roughness: 0.9 });
    const accentMat = this.mats.glow(spec.theme.palette.accent, 0.8);
    const bCount = Math.floor(samples.length / 2) * 2;
    const barriers = new THREE.InstancedMesh(barrierGeo, barrierMat, bCount);
    barriers.castShadow = true;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    let bi = 0;
    for (let i = 0; i < samples.length; i += 2) {
      const p = samples[i];
      const tangent = loop.getTangentAt(i / samples.length).setY(0).normalize();
      const side = new THREE.Vector3().crossVectors(tangent, up);
      const yaw = Math.atan2(tangent.x, tangent.z);
      q.setFromEuler(new THREE.Euler(0, yaw, 0));
      for (const s of [-1, 1]) {
        const bp = new THREE.Vector3(p.x + side.x * s * (width / 2 + 0.6), p.y + 0.5, p.z + side.z * s * (width / 2 + 0.6));
        m4.compose(bp, q, new THREE.Vector3(1, 1, 1));
        barriers.setMatrixAt(bi++, m4);
        if (i % 6 === 0) {
          this.physics.box([2.4, 2, 0.8], [bp.x, bp.y, bp.z], { group: GROUP.WORLD, quaternion: q });
        }
      }
    }
    barriers.count = bi;
    barriers.instanceMatrix.needsUpdate = true;
    this.group.add(barriers);

    // start gantry
    const startPos = samples[0].clone();
    const t0 = loop.getTangentAt(0).setY(0).normalize();
    const side0 = new THREE.Vector3().crossVectors(t0, up);
    const gantryMat = this.mats.flat('#2c3038', { metalness: 0.6, roughness: 0.4 });
    for (const s of [-1, 1]) {
      this.addBox([0.6, 7, 0.6], [startPos.x + side0.x * s * (width / 2 + 1), startPos.y + 3.5, startPos.z + side0.z * s * (width / 2 + 1)], gantryMat);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(width + 3, 1, 0.8), accentMat);
    beam.position.copy(startPos).add(new THREE.Vector3(0, 6.6, 0));
    beam.rotation.y = Math.atan2(t0.x, t0.z);
    this.group.add(beam);

    const startHeading = Math.atan2(t0.x, t0.z);
    return { curve: loop, waypoints: samples.filter((_, i) => i % 10 === 0), width, startPos, startHeading };
  }
}
