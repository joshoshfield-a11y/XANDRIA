/**
 * Polish wave — PARTICLES & ATMOSPHERE crew.
 *
 * - Particles dual blending paths: additive default (backward compatible,
 *   vehicle-crew seam) + alpha-blended normal path for smoke/dust.
 * - Juice combat helpers delegate into the new paths.
 * - Weather: quality-tier count scaling + per-genre mood tint.
 * - Grass: instanced tufts, quality-scaled, only in fitting environments.
 * - LightShafts: quality-scaled counts, skipped at night/retro.
 * - Terrain water: ripple clock advances.
 *
 * DOM is stubbed (no jsdom here) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Particles } from '../src/engine/gfx/Particles';
import { Juice } from '../src/engine/game/Juice';
import { Grass } from '../src/engine/world/Grass';
import { LightShafts } from '../src/engine/gfx/LightShafts';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { generateSpec } from '../src/generator/generate';

function makeEl(tag = 'div'): any {
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as Record<string, string>,
    className: '',
    textContent: '',
    clientWidth: 800,
    clientHeight: 600,
    appendChild(c: any) { el.children.push(c); return c; },
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
  };
  return el;
}

beforeEach(() => {
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head: makeEl('head'),
  };
});

const P = new THREE.Vector3(0, 2, 0);

function makeParticles(): { p: Particles; scene: THREE.Scene } {
  const scene = new THREE.Scene();
  const p = new Particles(scene, 1234);
  return { p, scene };
}

describe('Particles dual blending paths', () => {
  it('burst() defaults to additive — the vehicle-crew seam stays unchanged', () => {
    const { p } = makeParticles();
    p.burst(P, { count: 10 });
    expect(p.aliveCount('additive')).toBe(10);
    expect(p.aliveCount('normal')).toBe(0);
  });

  it('burst() routes blending:"normal" to the alpha-blended pool', () => {
    const { p } = makeParticles();
    p.burst(P, { count: 10, blending: 'normal' });
    expect(p.aliveCount('normal')).toBe(10);
    expect(p.aliveCount('additive')).toBe(0);
  });

  it('dust uses the normal path (smoke reads as smoke, not glow)', () => {
    const { p } = makeParticles();
    p.dust(P, 8);
    expect(p.aliveCount('normal')).toBe(8);
  });

  it('smokePuff uses the normal path', () => {
    const { p } = makeParticles();
    p.smokePuff(P, 5);
    expect(p.aliveCount('normal')).toBe(5);
  });

  it('explosion emits fire (additive) + smoke (normal)', () => {
    const { p } = makeParticles();
    p.explosion(P, 1);
    expect(p.aliveCount('additive')).toBeGreaterThan(0);
    expect(p.aliveCount('normal')).toBeGreaterThan(0);
  });

  it('sparks stay on the additive path (they are glow)', () => {
    const { p } = makeParticles();
    p.sparks(P, '#ffe08a', 6);
    expect(p.aliveCount('additive')).toBe(6);
    expect(p.aliveCount('normal')).toBe(0);
  });

  it('impactFX combines both paths', () => {
    const { p } = makeParticles();
    p.impactFX(P, 1);
    expect(p.aliveCount('additive')).toBeGreaterThan(0);
    expect(p.aliveCount('normal')).toBeGreaterThan(0);
  });

  it('update() advances both pools and reset() clears both', () => {
    const { p } = makeParticles();
    p.burst(P, { count: 20 });
    p.burst(P, { count: 10, blending: 'normal' });
    p.update(0.016);
    expect(p.aliveCount('additive')).toBe(20);
    expect(p.aliveCount('normal')).toBe(10);
    p.reset(999);
    expect(p.aliveCount('additive')).toBe(0);
    expect(p.aliveCount('normal')).toBe(0);
  });
});

describe('Juice combat helpers', () => {
  function makeJuice(): { j: Juice; p: Particles } {
    const scene = new THREE.Scene();
    const p = new Particles(scene, 42);
    const container = makeEl('div');
    const j = new Juice(container, p);
    return { j, p };
  }

  it('burst() forwards blending to the particle system', () => {
    const { j, p } = makeJuice();
    j.burst(P, { count: 6, blending: 'normal' });
    expect(p.aliveCount('normal')).toBe(6);
  });

  it('combatHit emits sparks + smoke and shakes', () => {
    const { j, p } = makeJuice();
    j.combatHit(P, 1);
    expect(p.aliveCount('additive')).toBeGreaterThan(0);
    expect(p.aliveCount('normal')).toBeGreaterThan(0);
    expect(j.trauma).toBeGreaterThan(0);
  });

  it('impact emits on both paths with a shake', () => {
    const { j, p } = makeJuice();
    j.impact(P, 1, '#8df2ff');
    expect(p.aliveCount('additive')).toBeGreaterThan(0);
    expect(p.aliveCount('normal')).toBeGreaterThan(0);
    expect(j.trauma).toBeGreaterThan(0);
  });

  it('muzzle emits flash + smoke wisp', () => {
    const { j, p } = makeJuice();
    j.muzzle(P);
    expect(p.aliveCount('additive')).toBeGreaterThan(0);
    expect(p.aliveCount('normal')).toBeGreaterThan(0);
  });

  it('deathFX explodes, shakes, and hit-stops', () => {
    const { j, p } = makeJuice();
    j.deathFX(P, 1);
    expect(p.aliveCount('additive')).toBeGreaterThan(0);
    expect(p.aliveCount('normal')).toBeGreaterThan(0);
    expect(j.trauma).toBeGreaterThan(0);
    expect(j.hitStopActive()).toBe(true);
  });

  it('driftSmoke helper emits alpha-blended smoke', () => {
    const { j, p } = makeJuice();
    j.driftSmoke(P);
    expect(p.aliveCount('normal')).toBe(3);
  });

  it('muzzle/deathFX fire the pooled flash hook when wired, no-op when not', () => {
    const { j } = makeJuice();
    const calls: unknown[][] = [];
    j.setFlash((...args: unknown[]) => { calls.push(args); });
    j.muzzle(P);
    j.deathFX(P, 1);
    expect(calls.length).toBe(2);
    // unwired juice must not throw
    const { j: j2 } = makeJuice();
    expect(() => { j2.muzzle(P); j2.deathFX(P, 1); }).not.toThrow();
  });
});

describe('Weather quality scaling + genre mood', () => {
  it('retro < standard < high counts', () => {
    const mk = (q: 'retro' | 'standard' | 'high') => {
      const { p } = makeParticles();
      p.setWeather('rain', 7, q);
      return p.weatherActiveCount();
    };
    const r = mk('retro'), s = mk('standard'), h = mk('high');
    expect(r).toBeLessThan(s);
    expect(s).toBeLessThan(h);
  });

  it('clear/fog still emit nothing', () => {
    const { p } = makeParticles();
    p.setWeather('clear', 7, 'high');
    expect(p.weatherActiveCount()).toBe(0);
    p.setWeather('fog', 7, 'high');
    expect(p.weatherActiveCount()).toBe(0);
  });

  it('fps-arena rain gets the bluer mood tint; default genre stays sky-blue', () => {
    const a = makeParticles();
    a.p.setWeather('rain', 7, 'high', 'fps-arena');
    const b = makeParticles();
    b.p.setWeather('rain', 7, 'high', 'third-person-action');
    expect(a.p.weatherColor()).toBe('#8fb8e8');
    expect(b.p.weatherColor()).toBe('#9db8d8');
    // mood density multiplier applies on top of the quality scale
    expect(a.p.weatherActiveCount()).toBeGreaterThan(b.p.weatherActiveCount());
  });

  it('platformer snow gets bigger sparkle flakes', () => {
    const { p } = makeParticles();
    p.setWeather('snow', 7, 'high', 'platformer');
    expect(p.weatherColor()).toBe('#eaf6ff');
  });
});

describe('Grass', () => {
  function buildTerrain(env: string): { terrain: Terrain; spec: any; scene: THREE.Scene } {
    const spec: any = generateSpec('a heroic knight adventure', { seed: 99 });
    spec.theme.environment = env;
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    return { terrain, spec, scene };
  }

  it('forest at high has more tufts than retro, none for neon-city', () => {
    const h = buildTerrain('forest');
    const gHigh = new Grass(h.spec, h.terrain, h.scene, { quality: 'high' });
    const r = buildTerrain('forest');
    const gRetro = new Grass(r.spec, r.terrain, r.scene, { quality: 'retro' });
    expect(gHigh.count).toBeGreaterThan(gRetro.count);
    expect(gRetro.count).toBeGreaterThan(0);
    const c = buildTerrain('neon-city');
    const gCity = new Grass(c.spec, c.terrain, c.scene, { quality: 'high' });
    expect(gCity.count).toBe(0);
  });

  it('desert is sparse vs forest (same tier)', () => {
    const f = buildTerrain('forest');
    const gf = new Grass(f.spec, f.terrain, f.scene, { quality: 'standard' });
    const d = buildTerrain('desert');
    const gd = new Grass(d.spec, d.terrain, d.scene, { quality: 'standard' });
    expect(gd.count).toBeGreaterThan(0);
    expect(gd.count).toBeLessThan(gf.count);
  });

  it('update() only advances the wind clock without throwing', () => {
    const h = buildTerrain('forest');
    const g = new Grass(h.spec, h.terrain, h.scene, { quality: 'high' });
    expect(() => g.update(0.016)).not.toThrow();
  });
});

describe('LightShafts', () => {
  function specFor(timeOfDay: string): any {
    const spec: any = generateSpec('a heroic knight adventure', { seed: 5 });
    spec.theme.timeOfDay = timeOfDay;
    return spec;
  }

  it('retro/night build zero shafts; high builds seven', () => {
    const scene = new THREE.Scene();
    const sunDir = new THREE.Vector3(0.45, 0.75, 0.35).normalize();
    const retro = new LightShafts(scene, specFor('day'), sunDir, 'retro');
    expect(retro.count).toBe(0);
    const night = new LightShafts(scene, specFor('night'), sunDir, 'high');
    expect(night.count).toBe(0);
    const high = new LightShafts(scene, specFor('day'), sunDir, 'high');
    expect(high.count).toBe(7);
    const std = new LightShafts(scene, specFor('day'), sunDir, 'standard');
    expect(std.count).toBe(4);
  });

  it('update() pulses without throwing', () => {
    const scene = new THREE.Scene();
    const s = new LightShafts(scene, specFor('day'), new THREE.Vector3(0, 1, 0), 'high');
    expect(() => s.update(0.016)).not.toThrow();
  });
});

describe('Terrain water animation', () => {
  it('updateWater advances the ripple clock when water exists', () => {
    const spec: any = generateSpec('a heroic knight adventure', { seed: 11 });
    spec.world.terrain.water = true;
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    expect(terrain.water).toBeDefined();
    expect(() => terrain.updateWater(0.016)).not.toThrow();
    // no water: no-op
    spec.world.terrain.water = false;
    const dry = new Terrain(spec, physics, mats, new THREE.Scene());
    expect(() => dry.updateWater(0.016)).not.toThrow();
  });
});
