/**
 * Cheap god-ray-ish light shafts: additive vertical-gradient cylinders slanted
 * along the sun direction. No volumetrics, no extra render targets — one
 * draw call per shaft, opacity pulsing subtly. Counts scale with quality
 * (retro: 0). Skipped at night (the gradient dome + stars carry night mood).
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../Engine';
import { Rng } from '../core/Rng';
import { gradeAtmosphere } from './GenreGrade';

const SHAFT_COUNTS = { high: 7, standard: 4, retro: 0 } as const;

export class LightShafts {
  private group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];
  private time = 0;
  readonly count: number;

  constructor(scene: THREE.Scene, spec: GameSpec, sunDir: THREE.Vector3, quality: 'retro' | 'standard' | 'high') {
    this.count = spec.theme.timeOfDay === 'night' ? 0 : (SHAFT_COUNTS[quality] ?? 0);
    if (this.count <= 0) return;
    const rng = new Rng(spec.meta.seed ^ 0x51af7);
    const dusk = spec.theme.timeOfDay === 'dusk' || spec.theme.timeOfDay === 'dawn';
    const tint = new THREE.Color(dusk ? '#ffcf9a' : '#fff3d0');
    // Env-art pass: dusk grades stronger god-ray presence (grade.godRays 1.7).
    const rayBoost = gradeAtmosphere(spec.meta.genre, spec.theme.timeOfDay).godRays;
    const axis = sunDir.clone().negate(); // light travels sun -> ground
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize());
    for (let i = 0; i < this.count; i++) {
      const r = rng.range(1.2, 2.8);
      const h = rng.range(22, 34);
      const geo = new THREE.CylinderGeometry(r * 0.55, r, h, 10, 1, true);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: tint },
          uPhase: { value: rng.range(0, Math.PI * 2) },
          uTime: { value: 0 },
          uBase: { value: rng.range(0.015, 0.03) * rayBoost },
        },
        vertexShader: `
          varying vec2 vUv;
          void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform vec3 uColor; uniform float uPhase; uniform float uTime; uniform float uBase;
          varying vec2 vUv;
          void main(){
            // fade at top/bottom of the shaft; brightest in the upper third
            float v = sin(vUv.y * 3.14159);
            float a = v * v * uBase * (0.75 + 0.25 * sin(uTime * 0.5 + uPhase));
            gl_FragColor = vec4(uColor, a);
          }`,
        fog: false,
      });
      this.mats.push(mat);
      const m = new THREE.Mesh(geo, mat);
      m.quaternion.copy(q);
      // offset the cylinder's center so it spans from sky down toward ground
      m.position.set(rng.range(-70, 70), h * 0.28, rng.range(-70, 70));
      m.frustumCulled = false;
      this.group.add(m);
    }
    scene.add(this.group);
  }

  update(dt: number) {
    if (this.count <= 0) return;
    this.time += dt;
    for (const m of this.mats) m.uniforms.uTime.value = this.time;
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    for (const c of this.group.children) (c as THREE.Mesh).geometry.dispose();
    for (const m of this.mats) m.dispose();
    this.mats = [];
  }
}

/**
 * Blueprint hook: attach genre-appropriate light shafts to the running game.
 * One line per blueprint: `attachLightShafts(engine)`. Returns null on
 * retro tier or at night. Registers its own update — no per-frame CPU loops.
 */
export function attachLightShafts(engine: Engine): LightShafts | null {
  const quality = engine.effectiveQuality();
  const sunDir = engine.sky.sun.position.clone().normalize();
  const shafts = new LightShafts(engine.scene, engine.spec, sunDir, quality);
  if (shafts.count <= 0) return null;
  engine.onUpdate((dt) => shafts.update(dt));
  return shafts;
}
