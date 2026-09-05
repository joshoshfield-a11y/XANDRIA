/** Heightfield terrain: vertex-colored, textured, with matching cannon Heightfield and boundary walls. */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { GameSpec } from '@spec';
import { Noise2D } from '../core/Rng';
import { MaterialLibrary, shade } from '../gfx/Materials';
import { GROUP, type Physics } from '../core/Physics';

export class Terrain {
  mesh: THREE.Mesh;
  body: CANNON.Body;
  readonly size: number;
  readonly res: number;
  private heights: number[][];
  private cell: number;
  water?: THREE.Mesh;
  readonly maxHeight: number;
  walls: CANNON.Body[] = [];

  constructor(spec: GameSpec, physics: Physics, mats: MaterialLibrary, scene: THREE.Scene, opts: { flatRadius?: number; flatCenters?: THREE.Vector3[] } = {}) {
    const t = spec.world.terrain;
    this.size = t.size;
    this.res = Math.min(128, Math.max(32, Math.round(t.size / 2.5)));
    this.cell = this.size / (this.res - 1);
    this.maxHeight = t.maxHeight;
    const noise = new Noise2D(spec.meta.seed);
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
        const base = noise.fbm(nx * 3 + 10, nz * 3 + 10, 5, 2, 0.5);
        switch (t.type) {
          case 'flat': y = base * 0.6; break;
          case 'hills': y = (base + 0.3) * t.maxHeight * (0.4 + t.roughness * 0.6); break;
          case 'mountains': y = Math.pow(Math.abs(base) + 0.15, 1.6) * t.maxHeight * 1.4 * (0.5 + t.roughness); break;
          case 'canyon': { const r = Math.abs(noise.get(nx * 2, nz * 2 + 5)); y = (r < 0.18 ? -0.6 : 0.8 + base * 0.5) * t.maxHeight; break; }
          case 'islands': { const d = Math.hypot(nx, nz) * 2; y = (base + 0.35 - d * d * 0.9) * t.maxHeight; break; }
          case 'platforms': y = Math.round((base + 1) * 3) * (t.maxHeight / 6); break;
        }
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
    const cGround = new THREE.Color(spec.theme.palette.ground);
    const cAlt = new THREE.Color(spec.theme.palette.groundAlt);
    const cRock = new THREE.Color(spec.theme.palette.rock);
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
    const kind = MaterialLibrary.groundKind(spec.theme.environment);
    const mat = mats.standard(kind, '#ffffff', { alt: shade('#ffffff', -0.1), repeat: this.size / 8, roughness: 0.95 });
    mat.vertexColors = true;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    scene.add(this.mesh);

    // ---- physics heightfield (cannon expects matrix[i][j] with x along i, y along j)
    const shape = new CANNON.Heightfield(h, { elementSize: this.cell });
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

    // ---- water plane
    if (t.water) {
      const wm = new THREE.MeshStandardMaterial({ color: spec.theme.environment === 'volcanic' ? '#ff5a1f' : '#2a6fb0', transparent: true, opacity: 0.75, roughness: 0.15, metalness: 0.3, emissive: spec.theme.environment === 'volcanic' ? '#ff3300' : '#000000', emissiveIntensity: 0.8 });
      this.water = new THREE.Mesh(new THREE.PlaneGeometry(this.size * 3, this.size * 3), wm);
      this.water.rotation.x = -Math.PI / 2;
      this.water.position.y = t.waterLevel;
      scene.add(this.water);
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
