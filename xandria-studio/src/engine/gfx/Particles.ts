/**
 * Pooled particle system on THREE.Points. Effects: explosion, sparks, smoke, muzzle, dust,
 * magic, weather (rain/snow/ash falling columns around the camera).
 */
import * as THREE from 'three';
import { Rng } from '../core/Rng';
import type { Weather } from '@spec';

const MAX = 4096;

interface Particle {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  color: THREE.Color;
  gravity: number;
  drag: number;
}

export class Particles {
  private points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pool: Particle[] = [];
  private positions = new Float32Array(MAX * 3);
  private colors = new Float32Array(MAX * 3);
  private sizes = new Float32Array(MAX);
  private rng: Rng;
  private cursor = 0;

  // weather
  private weatherPoints: THREE.Points | null = null;
  private weatherVel: THREE.Vector3[] = [];
  private weatherKind: Weather | null = null;
  private weatherCount = 0;

  constructor(scene: THREE.Scene, seed: number) {
    this.rng = new Rng(seed);
    for (let i = 0; i < MAX; i++) {
      this.pool.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, maxLife: 1, size: 1, color: new THREE.Color(), gravity: 0, drag: 0 });
      this.positions[i * 3 + 1] = -9999;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geo.setAttribute('psize', new THREE.BufferAttribute(this.sizes, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float psize; attribute vec3 color; varying vec3 vColor;
        void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = psize * (240.0 / max(1.0,-mv.z)); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        varying vec3 vColor;
        void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c);
          if (d > 0.5) discard; float a = smoothstep(0.5, 0.1, d);
          gl_FragColor = vec4(vColor, a); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.scene = scene;
  }
  private scene: THREE.Scene;

  private emit(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number, color: THREE.Color, gravity = 0, drag = 0) {
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % MAX;
    p.alive = true; p.pos.copy(pos); p.vel.copy(vel);
    p.life = life; p.maxLife = life; p.size = size; p.color.copy(color);
    p.gravity = gravity; p.drag = drag;
  }

  burst(pos: THREE.Vector3, opts: { count?: number; color?: string; color2?: string; speed?: number; life?: number; size?: number; gravity?: number; up?: number } = {}) {
    const count = opts.count ?? 20;
    const c1 = new THREE.Color(opts.color ?? '#ffcc55');
    const c2 = new THREE.Color(opts.color2 ?? opts.color ?? '#ff6622');
    const tmp = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      tmp.set(this.rng.gaussian(0, 1), this.rng.gaussian(0, 1), this.rng.gaussian(0, 1)).normalize()
        .multiplyScalar((opts.speed ?? 6) * (0.4 + this.rng.next() * 0.6));
      tmp.y += opts.up ?? 2;
      const c = c1.clone().lerp(c2, this.rng.next());
      this.emit(pos, tmp, (opts.life ?? 0.7) * (0.5 + this.rng.next() * 0.5), (opts.size ?? 1.6) * (0.6 + this.rng.next() * 0.8), c, opts.gravity ?? -9, 0.98);
    }
  }

  explosion(pos: THREE.Vector3, scale = 1) {
    this.burst(pos, { count: 40, color: '#ffdd66', color2: '#ff3311', speed: 10 * scale, life: 0.8, size: 2.6 * scale, up: 4 });
    this.burst(pos, { count: 18, color: '#333333', color2: '#666666', speed: 4 * scale, life: 1.6, size: 3.2 * scale, gravity: 2, up: 3 });
  }
  sparks(pos: THREE.Vector3, color = '#ffe08a', count = 10) {
    this.burst(pos, { count, color, color2: '#ffffff', speed: 7, life: 0.35, size: 1.1, gravity: -18 });
  }
  dust(pos: THREE.Vector3, count = 6) {
    this.burst(pos, { count, color: '#9a8f7a', color2: '#c9bfa8', speed: 1.6, life: 0.7, size: 1.6, gravity: 1.5, up: 0.8 });
  }
  magic(pos: THREE.Vector3, color = '#7af7ff', count = 14) {
    this.burst(pos, { count, color, color2: '#ffffff', speed: 3, life: 0.9, size: 1.4, gravity: 2, up: 2 });
  }
  trail(pos: THREE.Vector3, color: string) {
    this.emit(pos, new THREE.Vector3(this.rng.gaussian(0, 0.4), this.rng.gaussian(0, 0.4), this.rng.gaussian(0, 0.4)), 0.4, 1.2, new THREE.Color(color), 0, 0.9);
  }

  /** Ambient weather. Call once. */
  setWeather(kind: Weather, seed: number) {
    if (kind === 'clear' || kind === 'fog') return;
    this.weatherKind = kind;
    this.weatherCount = kind === 'storm' ? 900 : kind === 'rain' ? 600 : kind === 'snow' ? 500 : 400;
    const wgeo = new THREE.BufferGeometry();
    const wpos = new Float32Array(this.weatherCount * 3);
    const wrng = new Rng(seed ^ 4242);
    this.weatherVel = [];
    for (let i = 0; i < this.weatherCount; i++) {
      wpos[i * 3] = wrng.range(-60, 60);
      wpos[i * 3 + 1] = wrng.range(0, 50);
      wpos[i * 3 + 2] = wrng.range(-60, 60);
      const fall = kind === 'snow' ? wrng.range(1.5, 3) : kind === 'ash' ? wrng.range(1, 2) : wrng.range(18, 26);
      this.weatherVel.push(new THREE.Vector3(kind === 'storm' ? -6 : wrng.range(-0.5, 0.5), -fall, wrng.range(-0.5, 0.5)));
    }
    wgeo.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
    const color = kind === 'snow' ? '#ffffff' : kind === 'ash' ? '#8a8578' : '#9db8d8';
    const wmat = new THREE.PointsMaterial({ color, size: kind === 'snow' ? 0.35 : 0.22, transparent: true, opacity: kind === 'ash' ? 0.7 : 0.85, depthWrite: false });
    this.weatherPoints = new THREE.Points(wgeo, wmat);
    this.weatherPoints.frustumCulled = false;
    this.scene.add(this.weatherPoints);
  }

  /** Follow the camera so weather is always around the player. */
  updateWeather(camPos: THREE.Vector3, dt: number) {
    if (!this.weatherPoints) return;
    const attr = this.weatherPoints.geometry.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < this.weatherCount; i++) {
      const v = this.weatherVel[i];
      arr[i * 3] += v.x * dt; arr[i * 3 + 1] += v.y * dt; arr[i * 3 + 2] += v.z * dt;
      if (this.weatherKind === 'snow') arr[i * 3] += Math.sin(arr[i * 3 + 1] * 0.6 + i) * dt * 0.8;
      if (arr[i * 3 + 1] < camPos.y - 10) {
        arr[i * 3] = camPos.x + (this.rng.next() - 0.5) * 120;
        arr[i * 3 + 1] = camPos.y + 30 + this.rng.next() * 20;
        arr[i * 3 + 2] = camPos.z + (this.rng.next() - 0.5) * 120;
      }
    }
    attr.needsUpdate = true;
  }

  update(dt: number) {
    for (let i = 0; i < MAX; i++) {
      const p = this.pool[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; this.positions[i * 3 + 1] = -9999; this.sizes[i] = 0; continue; }
      p.vel.y += p.gravity * dt;
      p.vel.multiplyScalar(Math.pow(p.drag, dt * 60));
      p.pos.addScaledVector(p.vel, dt);
      const k = p.life / p.maxLife;
      this.positions[i * 3] = p.pos.x; this.positions[i * 3 + 1] = p.pos.y; this.positions[i * 3 + 2] = p.pos.z;
      this.colors[i * 3] = p.color.r * k; this.colors[i * 3 + 1] = p.color.g * k; this.colors[i * 3 + 2] = p.color.b * k;
      this.sizes[i] = p.size * (0.5 + k * 0.5);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.psize.needsUpdate = true;
  }
}
