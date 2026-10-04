/**
 * Arena dressing (blueprint layer): per-chapter props + lighting mood shifts,
 * racing roadside dressing + crowd, platformer parallax background layers.
 * All placement is deterministic from the passed rng.
 */
import * as THREE from 'three';
import type { Engine } from '../engine/Engine';
import type { GameSpec } from '@spec';
import type { Rng } from '../engine/core/Rng';

/** Hemisphere tint per chapter — subtle mood rotation through the campaign. */
const CHAPTER_TINTS = ['#ffffff', '#ffd9b0', '#b0e0ff', '#e6b0ff', '#b0ffd9'];

export interface DressArea {
  cx: number;
  cz: number;
  half: number;
  yAt: (x: number, z: number) => number;
}

/**
 * ChapterDresser — clears the previous chapter's props and places a fresh
 * set (pillars, crystals, wreckage), then shifts the hemisphere light tint
 * and fog density for a per-chapter mood change.
 */
export class ChapterDresser {
  private group: THREE.Group | null = null;
  private baseFog: number | null = null;

  constructor(private engine: Engine) {}

  dress(spec: GameSpec, stage: number, rng: Rng, area: DressArea, opts: { floating?: boolean } = {}): void {
    this.clear();
    const group = new THREE.Group();
    const pal = spec.theme.palette;
    const n = 4 + stage * 2;
    for (let i = 0; i < n; i++) {
      const kind = opts.floating ? 1 : rng.int(0, 2); // floating courses get crystals only
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(10, Math.max(11, area.half));
      const x = area.cx + Math.cos(a) * r;
      const z = area.cz + Math.sin(a) * r;
      const y = area.yAt(x, z);
      let mesh: THREE.Object3D;
      if (kind === 0) {
        const h = rng.range(3, 7);
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.55, 0.85, h, 7),
          this.engine.mats.standard('rock', pal.secondary, { roughness: 0.95 }),
        );
        mesh.position.set(x, y + h / 2, z);
      } else if (kind === 1) {
        const s = rng.range(0.7, 1.6);
        mesh = new THREE.Mesh(new THREE.OctahedronGeometry(s, 0), this.engine.mats.glow(pal.accent, 1.6));
        mesh.position.set(x, y + s * (opts.floating ? 2.2 : 0.9), z);
        mesh.rotation.y = rng.range(0, Math.PI);
      } else {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(rng.range(1, 2.4), rng.range(0.5, 1.2), rng.range(1, 2)),
          this.engine.mats.standard('metal', '#3a3f46', { roughness: 0.7, metalness: 0.5 }),
        );
        mesh.position.set(x, y + 0.4, z);
        mesh.rotation.set(rng.range(-0.4, 0.4), rng.range(0, Math.PI * 2), rng.range(-0.3, 0.3));
      }
      mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
      group.add(mesh);
    }
    this.engine.scene.add(group);
    this.group = group;
    // mood shift: hemisphere tint rotates per chapter, fog thickens slightly
    this.engine.sky.hemi.color.set(CHAPTER_TINTS[stage % CHAPTER_TINTS.length]).lerp(new THREE.Color(pal.accent), 0.25);
    const fog = this.engine.scene.fog as THREE.FogExp2 | null;
    if (fog && typeof fog.density === 'number') {
      if (this.baseFog === null) this.baseFog = fog.density;
      fog.density = this.baseFog * (1 + stage * 0.12);
    }
  }

  clear(): void {
    if (this.group) {
      this.engine.scene.remove(this.group);
      disposeGroup(this.group);
      this.group = null;
    }
  }

  dispose(): void { this.clear(); }
}

function disposeGroup(root: THREE.Group): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const list = Array.isArray(m.material) ? m.material : [m.material];
    for (const mm of list) (mm as THREE.Material).dispose();
  });
}

export interface RaceTrack {
  curve: THREE.CatmullRomCurve3;
  width: number;
}

/**
 * Racing roadside dressing: lamp posts along the circuit, banner arches, and
 * three grandstands with deterministic instanced crowds. Returns an update
 * closure for the waving pennants.
 */
export function dressRacing(
  engine: Engine,
  track: RaceTrack,
  rng: Rng,
  spec: GameSpec,
  yAt: (x: number, z: number) => number,
): (dt: number, t: number) => void {
  const group = new THREE.Group();
  const mats = engine.mats;
  const wavers: THREE.Object3D[] = [];

  // lamp posts every ~6% of the lap, alternating sides
  for (let i = 0; i < 16; i++) {
    const tt = i / 16;
    const p = track.curve.getPointAt(tt);
    const tan = track.curve.getTangentAt(tt);
    const side = i % 2 === 0 ? 1 : -1;
    const bx = p.x + -tan.z * side * (track.width / 2 + 5);
    const bz = p.z + tan.x * side * (track.width / 2 + 5);
    const by = yAt(bx, bz);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 6, 6), mats.flat('#2a2e36', { metalness: 0.6, roughness: 0.4 }));
    pole.position.set(bx, by + 3, bz);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), mats.glow(spec.theme.palette.accent, 2));
    lamp.position.set(bx, by + 6.2, bz);
    group.add(pole, lamp);
  }

  // banner arches over the track
  for (const tt of [0.125, 0.375, 0.625, 0.875]) {
    const p = track.curve.getPointAt(tt);
    const tan = track.curve.getTangentAt(tt);
    const arch = new THREE.Mesh(new THREE.TorusGeometry(track.width / 2 + 2, 0.3, 8, 24, Math.PI), mats.glow(spec.theme.palette.accent, 1.2));
    arch.position.copy(p).add(new THREE.Vector3(0, 0.5, 0));
    arch.rotation.y = Math.atan2(tan.x, tan.z);
    group.add(arch);
  }

  // grandstands with instanced crowds
  const crowdGeo = new THREE.BoxGeometry(0.45, 0.95, 0.35);
  const crowdMat = mats.flat('#ffffff', { roughness: 0.9 });
  const shirtColors = [spec.theme.palette.primary, spec.theme.palette.secondary, spec.theme.palette.accent, '#e8e4da', '#3f6fd8', '#e8a13c'];
  for (const gt of [0.12, 0.45, 0.78]) {
    const p = track.curve.getPointAt(gt);
    const tan = track.curve.getTangentAt(gt);
    const nx = -tan.z, nz = tan.x;
    const sx = p.x + nx * (track.width / 2 + 11);
    const sz = p.z + nz * (track.width / 2 + 11);
    const sy = yAt(sx, sz);
    // stepped stand
    for (let s = 0; s < 3; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(14, 0.8, 2.2), mats.standard('concrete', '#5a5e66', { roughness: 0.9 }));
      step.position.set(sx - nx * s * 2.1, sy + 0.4 + s * 0.9, sz - nz * s * 2.1);
      step.rotation.y = Math.atan2(-nx, -nz);
      group.add(step);
    }
    // crowd: one instanced mesh per stand
    const count = 42;
    const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, count);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    const yaw = Math.atan2(-nx, -nz);
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 14), seat = i % 14;
      const lx = (seat - 6.5) * 0.95;
      m4.makeRotationY(yaw);
      m4.setPosition(
        sx - nx * row * 2.1 + Math.cos(yaw) * lx,
        sy + 1.35 + row * 0.9,
        sz - nz * row * 2.1 - Math.sin(yaw) * lx,
      );
      crowd.setMatrixAt(i, m4);
      col.set(shirtColors[rng.int(0, shirtColors.length - 1)]);
      col.offsetHSL(0, 0, rng.range(-0.08, 0.08));
      crowd.setColorAt(i, col);
    }
    crowd.instanceMatrix.needsUpdate = true;
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    group.add(crowd);
    // pennant poles at the stand corners
    for (const px of [-8, 8]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 7, 6), mats.flat('#2a2e36', { metalness: 0.5, roughness: 0.5 }));
      pole.position.set(sx + Math.cos(yaw) * px, sy + 3.5, sz - Math.sin(yaw) * px);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), new THREE.MeshBasicMaterial({ color: spec.theme.palette.accent, side: THREE.DoubleSide }));
      flag.position.set(sx + Math.cos(yaw) * px + 0.85, sy + 6.4, sz - Math.sin(yaw) * px);
      group.add(pole, flag);
      wavers.push(flag);
    }
  }

  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  engine.scene.add(group);

  let wi = 0;
  return (_dt: number, t: number) => {
    wi = 0;
    for (const f of wavers) {
      f.rotation.y = Math.sin(t * 3 + wi * 1.7) * 0.45;
      wi++;
    }
  };
}

/**
 * Platformer parallax: three distant ridge layers (canvas silhouettes) that
 * drift at fractions of the camera's x for depth. Course runs along +x, the
 * side camera sits at +z looking -z, so layers sit at negative z.
 */
export class ParallaxLayers {
  private layers: { mesh: THREE.Mesh; factor: number }[] = [];
  private engine: Engine;

  constructor(engine: Engine, rng: Rng, spec: GameSpec, courseY: number) {
    this.engine = engine;
    const pal = spec.theme.palette;
    const defs = [
      { z: -70, h: 90, factor: 0.12, c: shade(pal.sky, 0.5) },
      { z: -130, h: 140, factor: 0.3, c: shade(pal.sky, 0.35) },
      { z: -230, h: 200, factor: 0.55, c: shade(pal.sky, 0.22) },
    ];
    for (const d of defs) {
      const tex = makeRidgeTexture(rng, d.c);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1100, d.h), mat);
      mesh.position.set(0, courseY + d.h * 0.22, d.z);
      mesh.renderOrder = -10;
      engine.scene.add(mesh);
      this.layers.push({ mesh, factor: d.factor });
    }
  }

  update(camX: number): void {
    for (const l of this.layers) l.mesh.position.x = camX * l.factor;
  }

  dispose(): void {
    for (const l of this.layers) {
      this.engine.scene.remove(l.mesh);
      l.mesh.geometry.dispose();
      const m = l.mesh.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
    }
    this.layers = [];
  }
}

function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

function makeRidgeTexture(rng: Rng, color: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 256;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, 1024, 256);
  // two overlapping ridges for depth
  for (const [base, amp, col] of [[190, 60, color], [225, 34, color]] as const) {
    ctx.beginPath();
    ctx.moveTo(0, 256);
    let y = base - rng.range(0, amp);
    ctx.lineTo(0, y);
    for (let x = 0; x <= 1024; x += 64) {
      y = base - rng.range(0, amp);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(1024, 256);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, base - amp, 0, 256);
    grad.addColorStop(0, col);
    grad.addColorStop(1, col + '00');
    ctx.fillStyle = grad;
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
