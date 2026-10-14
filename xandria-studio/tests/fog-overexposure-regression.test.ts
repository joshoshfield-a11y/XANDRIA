/**
 * Graphics full-scale wave, workstream D (lighting/grading + water fixes).
 *
 * D1 — fog/sky overexposure regression. Root cause (verified against the
 * three.js 0.182 sources in node_modules): in three r152+, tone mapping and
 * output color-space conversion apply ONLY when rendering to the screen
 * through materials that include the tonemapping/colorspace chunks
 * (WebGLPrograms sets toneMapping=NoToneMapping for any non-null render
 * target). The standard/high post chain renders the scene into a HalfFloat
 * target, so the final GradeShader pass used to write linear HDR values
 * straight to the canvas: the Preetham horizon band (linear ~1.36-1.71) and
 * bright fog colors clipped straight to white, and renderer.toneMappingExposure
 * (the per-genre 0.52-0.72, wired via sky.exposure) was silently dead on
 * standard/high. The fix appends the output-transform includes to the final
 * grade pass — ACES makes overexposure structurally impossible (highlights
 * roll off instead of clipping) and the exposure tuning goes live. No new
 * passes, no new uniforms.
 *
 * D2 — per-biome cinematic dusk grading (extends GenreGrade, BiomeDefLike
 * seam for workstream C's Biomes.ts).
 * D3 — stylized water material (world-space ripple, fresnel, biome tints).
 *
 * B (graphics follow-up wave) — the same D1 bug class in the two remaining
 * final passes: RetroShader (always last when present) gets the two output-
 * transform includes; UnrealBloomPass when it is last (retro tier, bloom on,
 * retro filter off) gets them on its additive blend material — the base copy
 * already had ACES+sRGB via its internal MeshBasicMaterial, only the bloom
 * layer wrote raw linear HDR. When bloom is mid-chain the chunks compile to
 * no-ops, so the patch is safe unconditionally.
 *
 * DOM is stubbed (no jsdom here) — same pattern as terrain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  gradeAtmosphere,
  type Genre,
  type TimeOfDay,
  type BiomeDefLike,
} from '../src/engine/gfx/GenreGrade';
import { fogDensityScaleForWorldSize } from '../src/engine/gfx/FarField';
import { GradeShader } from '../src/engine/gfx/GradeShader';
import { RetroShader, patchBloomOutputTransform } from '../src/engine/gfx/PostFX';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { createSky } from '../src/engine/gfx/Sky';
import { Terrain } from '../src/engine/world/Terrain';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Physics } from '../src/engine/core/Physics';
import { generateSpec } from '../src/generator/generate';
import { ENVIRONMENTS } from '../src/spec/schema';

function makeEl(tag = 'div'): any {
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as Record<string, string>,
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

const GENRES: Genre[] = ['third-person-action', 'fps-arena', 'racing', 'platformer', 'top-down-shooter'];
const TODS: TimeOfDay[] = ['day', 'dusk', 'dawn', 'night'];
const WEATHERS = ['clear', 'fog', 'rain', 'snow', 'storm', 'ash'] as const;

/** three's ACESFilmicToneMapping (Narkowicz) — the exact operator the grade
 * pass now applies via #include <tonemapping_fragment>. */
function aces(x: number, exposure: number): number {
  const c = x * exposure;
  const num = c * (2.51 * c + 0.03);
  const den = c * (2.43 * c + 0.59) + 0.14;
  return Math.min(1, Math.max(0, num / den));
}

describe('D1 root cause: the final grade pass performs the output transform', () => {
  it('GradeShader includes the tone-mapping + color-space output chunks', () => {
    const fs = GradeShader.fragmentShader;
    expect(fs).toContain('#include <tonemapping_fragment>');
    expect(fs).toContain('#include <colorspace_fragment>');
  });

  it('the output transform runs AFTER the grade math (grade -> tonemap -> encode)', () => {
    const fs = GradeShader.fragmentShader;
    const gradeEnd = fs.indexOf('vignette, 0.0, 1.0)');
    expect(gradeEnd).toBeGreaterThan(-1);
    expect(fs.indexOf('<tonemapping_fragment>')).toBeGreaterThan(gradeEnd);
    expect(fs.indexOf('<colorspace_fragment>')).toBeGreaterThan(fs.indexOf('<tonemapping_fragment>'));
  });
});

describe('D1 value bounds sweep (every genre x time-of-day x weather)', () => {
  it('exposure / fog density / fog luminance / sky scale stay in sane bounds', () => {
    for (const genre of GENRES) {
      for (const tod of TODS) {
        for (const weather of WEATHERS) {
          void weather; // weather feeds Sky's density base, not the grade
          const g = gradeAtmosphere(genre, tod);
          expect(g.exposure).toBeGreaterThanOrEqual(0.3);
          expect(g.exposure).toBeLessThanOrEqual(1.2);
          expect(g.fogDensity).toBeGreaterThan(0);
          expect(g.fogDensity).toBeLessThanOrEqual(1.5);
          if (tod === 'night') {
            // night is locked — the earlier night-lighting fix must not regress
            expect(g.exposure).toBe(1.05);
            expect(g.fogDensity).toBe(1.0);
            expect(g.fogLuminance).toBe(1.0);
            expect(g.sky).toBe(1.0);
            expect(g.biomeFog).toBeNull();
            expect(g.biomeFogDensity).toBeNull();
            expect(g.waterTint).toBeNull();
          } else {
            expect(g.fogLuminance).toBeGreaterThan(0);
            expect(g.fogLuminance).toBeLessThanOrEqual(1.0);
            expect(g.sky).toBeGreaterThan(0);
            expect(g.sky).toBeLessThanOrEqual(1.0);
          }
        }
      }
    }
  });

  it('ACES rolls the worst-case sky/fog inputs off instead of clipping white', () => {
    // Beauty wave measured the Preetham horizon band at linear ~1.36-1.71.
    // With the output transform live, even the UNMITIGATED sky (scale 1.0,
    // i.e. as if the sky x0.45-0.55 compile-time scale were removed) cannot
    // clip: ACES asymptotes below 1. The old pipeline wrote these values raw
    // and clipped anything > 1.0 to pure white.
    for (const genre of GENRES) {
      for (const tod of ['day', 'dusk', 'dawn'] as const) {
        const g = gradeAtmosphere(genre, tod);
        expect(aces(1.71 * 1.0, g.exposure)).toBeLessThan(1.0);
        expect(aces(1.71 * g.sky, g.exposure)).toBeLessThan(0.95);
        // worst-case fog: a pure-white palette fog, fully darkened only by
        // the grade's fogLuminance lever
        expect(aces(1.0 * g.fogLuminance, g.exposure)).toBeLessThan(0.95);
      }
    }
  });
});

describe('D1 createSky fog sweep (every genre x environment x day/dusk)', () => {
  const INTENTS: Array<[string, Genre]> = [
    ['sword adventure in ancient ruins', 'third-person-action'],
    ['neon fps arena at night', 'fps-arena'],
    ['desert racing grand prix', 'racing'],
    ['dreamy platformer', 'platformer'],
    ['top-down horde shooter', 'top-down-shooter'],
  ];

  it('fog density and color never approach white, background matches fog', () => {
    for (const [intent, genre] of INTENTS) {
      for (const env of ENVIRONMENTS) {
        for (const tod of ['day', 'dusk'] as const) {
          const spec = generateSpec(intent, { seed: 11, genre, environment: env });
          // force the time-of-day under test (intents carry their own)
          (spec.theme as { timeOfDay: string }).timeOfDay = tod;
          const scene = new THREE.Scene();
          const sky = createSky(spec, scene, 'high');
          try {
            const fog = scene.fog as THREE.FogExp2;
            expect(fog.density).toBeGreaterThan(0);
            expect(fog.density).toBeLessThanOrEqual(0.02);
            const lum = 0.2126 * fog.color.r + 0.7152 * fog.color.g + 0.0722 * fog.color.b;
            expect(lum).toBeLessThanOrEqual(0.85);
            expect((scene.background as THREE.Color).getHex()).toBe(fog.color.getHex());
            // the per-genre exposure actually reaches the renderer path
            expect(sky.exposure).toBe(gradeAtmosphere(genre, tod, env).exposure);
          } finally {
            sky.dispose();
          }
        }
      }
    }
  });
});

describe('D2 per-biome cinematic dusk grading', () => {
  it('biome table entries are sane grade deltas', () => {
    const seen = new Set<string>();
    for (const env of ENVIRONMENTS) {
      const g = gradeAtmosphere('racing', 'dusk', env);
      const base = gradeAtmosphere('racing', 'dusk');
      if (g.fogTint !== base.fogTint || g.waterTint !== null) {
        seen.add(env);
        for (const v of g.grade.lift) expect(Math.abs(v)).toBeLessThanOrEqual(0.05);
        for (const v of g.grade.gain) expect(Math.abs(v - 1)).toBeLessThanOrEqual(0.16);
        expect(g.grade.saturation).toBeGreaterThanOrEqual(0.9);
        expect(g.grade.saturation).toBeLessThanOrEqual(1.25);
        if (g.waterTint) expect(g.waterTint).toMatch(/^#[0-9a-f]{6}$/);
        if (g.waterSky) expect(g.waterSky).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    // desert, volcanic, arctic, islands, dreamscape + forest/jungle/ruins/wasteland
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });

  it('desert dusk is hot amber; volcanic is ember; arctic is cold-blue', () => {
    const desert = gradeAtmosphere('racing', 'dusk', 'desert');
    expect(desert.fogTint).toBe('#ffa25e');
    expect(desert.waterTint).toBe('#2a7fb5');
    expect(desert.waterSky).toBe('#f2a768');
    expect(desert.grade.gain[0]).toBe(1.06); // warm highlights
    expect(desert.grade.saturation).toBe(1.12);

    const volcanic = gradeAtmosphere('third-person-action', 'dusk', 'volcanic');
    expect(volcanic.fogTint).toBe('#ff7a3c');
    expect(volcanic.waterTint).toBe('#ff5a1f');
    expect(volcanic.grade.lift[0]).toBe(0.03); // ember lift
    expect(volcanic.grade.gain[2]).toBe(0.85); // crushed blue

    const arctic = gradeAtmosphere('racing', 'dusk', 'arctic');
    expect(arctic.grade.lift[2]).toBe(0.02); // cool shadow lift
    expect(arctic.grade.gain[2]).toBe(1.05);
    expect(arctic.fogTint).toBe('#ffc890'); // warm horizon over cold land
  });

  it('unknown biome ids fall back to the genre dusk defaults', () => {
    const g = gradeAtmosphere('racing', 'dusk', 'not-a-biome');
    const base = gradeAtmosphere('racing', 'dusk');
    expect(g).toEqual(base);
  });

  it('biome tweaks are dusk-only: day and night ignore them', () => {
    const day = gradeAtmosphere('racing', 'day', 'volcanic');
    expect(day.waterTint).toBeNull();
    expect(day.biomeFog).toBeNull();
    expect(day.grade).toEqual(gradeAtmosphere('racing', 'day').grade);
    const night = gradeAtmosphere('racing', 'night', 'volcanic');
    expect(night.exposure).toBe(1.05); // locked
    expect(night.waterTint).toBeNull();
  });

  it('a BiomeDefLike object (workstream C seam) carries absolute fog/water overrides', () => {
    const like: BiomeDefLike = {
      id: 'desert',
      fogColor: '#112233',
      fogDensity: 0.009,
      waterTint: '#123456',
    };
    const g = gradeAtmosphere('racing', 'dusk', like);
    expect(g.biomeFog).toBe('#112233');
    expect(g.biomeFogDensity).toBe(0.009);
    expect(g.waterTint).toBe('#123456'); // object wins over the table
    expect(g.fogTint).toBe('#ffa25e'); // table still supplies the dusk look
  });

  it('createSky honors a BiomeDefLike object (absolute fog color/density)', () => {
    const spec = generateSpec('desert racing grand prix', { seed: 11, genre: 'racing' });
    (spec.theme as { timeOfDay: string }).timeOfDay = 'dusk';
    const like: BiomeDefLike = { id: 'desert', fogColor: '#112233', fogDensity: 0.009 };
    const scene = new THREE.Scene();
    const sky = createSky(spec, scene, 'high', like);
    try {
      const fog = scene.fog as THREE.FogExp2;
      // absolute density from the BiomeDefLike wins over weather x multiplier
      // (the world-size thin-out still applies on top — scale, not replace)
      expect(fog.density).toBe(0.009 * fogDensityScaleForWorldSize(spec.world.terrain.size));
      // absolute fog color still flows through fogLuminance + dusk fogTint
      const expected = new THREE.Color('#112233');
      expected.multiplyScalar(gradeAtmosphere('racing', 'dusk', like).fogLuminance);
      expected.lerp(new THREE.Color('#ffa25e'), 0.35); // desert dusk tint
      expect(fog.color.getHex()).toBe(expected.getHex());
    } finally {
      sky.dispose();
    }
    // ...while the string-id path keeps the weather-derived density
    const scene2 = new THREE.Scene();
    const sky2 = createSky(spec, scene2, 'high');
    try {
      expect((scene2.fog as THREE.FogExp2).density)
        .toBeCloseTo(0.0035 * gradeAtmosphere('racing', 'dusk', 'desert').fogDensity
          * fogDensityScaleForWorldSize(spec.world.terrain.size), 10);
    } finally {
      sky2.dispose();
    }
  });
});

describe('D3 stylized water material', () => {
  function buildTerrain(intent: string, opts: { genre?: Genre; environment?: string } = {}) {
    const spec = generateSpec(intent, {
      seed: 21,
      genre: opts.genre,
      environment: opts.environment as never,
    });
    (spec.theme as { timeOfDay: string }).timeOfDay = 'dusk';
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    return { spec, terrain };
  }

  it('islands dusk water uses the biome deep tint + warm fresnel sky tint', () => {
    const { terrain } = buildTerrain('tropical islands at dusk', { environment: 'islands' });
    expect(terrain.water).toBeDefined();
    const mat = terrain.water!.material as THREE.MeshStandardMaterial;
    // Merge contract (C+D): the biome's absolute water override wins over the
    // BIOME_DUSK table per D2's BiomeDefLike design — coastline biome tint.
    expect(mat.color.getHexString()).toBe('2a9fb0'); // BIOMES.coastline.water.tint
    expect((mat.userData.uSkyTint.value as THREE.Color).getHexString()).toBe('f0a868');
    expect(mat.customProgramCacheKey()).toBe('xandria-water-v4');
    // Stage 1b (workstream C): radial edge fade uniforms — on stage-1 sizes
    // the fade zone sits beyond the 3x quad, so the water is byte-identical.
    const wm = terrain.water!.material as THREE.MeshStandardMaterial;
    const fadeStart = (wm.userData.uFadeStart as { value: number }).value;
    const fadeEnd = (wm.userData.uFadeEnd as { value: number }).value;
    expect(fadeStart).toBeCloseTo(terrain.size * 1.55, 6);
    expect(fadeEnd).toBeCloseTo(terrain.size * 1.60, 6);
    // fade zone starts past the quad rim (1.5x): no-op on stage-1 sizes
    expect(fadeStart).toBeGreaterThan(terrain.size * 1.5);
  });

  it('volcanic water stays lava; day water uses the palette color', () => {
    const v = buildTerrain('volcanic lake at dusk', { environment: 'volcanic' });
    expect((v.terrain.water!.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('ff5a1f');
    const spec = generateSpec('forest lake', { seed: 21, environment: 'forest' });
    (spec.theme as { timeOfDay: string }).timeOfDay = 'day';
    const physics = new Physics(spec.world.gravity);
    const mats = new MaterialLibrary(spec);
    const scene = new THREE.Scene();
    const terrain = new Terrain(spec, physics, mats, scene);
    // day: the biome's authored water tint (merge contract: biome owns water
    // content), not the old hardcoded '#2a6fb0'
    expect((terrain.water!.material as THREE.MeshStandardMaterial).color.getHexString())
      .toBe('2a5f8a'); // BIOMES.forest.water.tint
  });

  it('onBeforeCompile injects world-space ripple + fresnel + glint wiring', () => {
    const { terrain } = buildTerrain('tropical islands at dusk', { environment: 'islands' });
    const mat = terrain.water!.material as THREE.MeshStandardMaterial;
    const fake = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <normal_fragment_maps>\n#include <emissivemap_fragment>\n}',
    };
    (mat.onBeforeCompile as (s: typeof fake) => void)(fake);
    // ripple is world-space (vWPos), not uv-space
    expect(fake.fragmentShader).toContain('vWPos.x * 0.85');
    expect(fake.fragmentShader).not.toContain('vUvW');
    // view-space fix: world normal -> view space via viewMatrix
    expect(fake.fragmentShader).toContain('(viewMatrix * vec4(wN, 0.0)).xyz');
    // fresnel sky-mirror term + sun glint
    expect(fake.fragmentShader).toContain('uSkyTint * fres');
    expect(fake.fragmentShader).toContain('uGlint * wspec');
    expect(fake.uniforms.uSkyTint).toBeDefined();
    expect(fake.uniforms.uTime).toBeDefined();
  });

  it('setWaterSun still refines the glint dir/tint (blueprint path intact)', () => {
    const { terrain } = buildTerrain('tropical islands at dusk', { environment: 'islands' });
    const mat = terrain.water!.material as THREE.MeshStandardMaterial;
    terrain.setWaterSun(new THREE.Vector3(0, 1, 0), '#cfe8ff');
    expect((mat.userData.uSunDirW.value as THREE.Vector3).toArray()).toEqual([0, 1, 0]);
    expect((mat.userData.uGlint.value as THREE.Color).getHexString()).toBe('cfe8ff');
  });
});

describe('B retro/bloom final passes: the D1 output-transform pattern', () => {
  it('RetroShader includes the tone-mapping + color-space output chunks', () => {
    const fs = RetroShader.fragmentShader;
    expect(fs).toContain('#include <tonemapping_fragment>');
    expect(fs).toContain('#include <colorspace_fragment>');
  });

  it('the retro output transform runs AFTER the authored retro math, inside main()', () => {
    const fs = RetroShader.fragmentShader;
    const gradeEnd = fs.indexOf('gl_FragColor = col;');
    expect(gradeEnd).toBeGreaterThan(-1);
    const tm = fs.indexOf('<tonemapping_fragment>');
    const cs = fs.indexOf('<colorspace_fragment>');
    expect(tm).toBeGreaterThan(gradeEnd);
    expect(cs).toBeGreaterThan(tm);
    // inside main(), not dangling after the closing brace
    expect(cs).toBeLessThan(fs.lastIndexOf('}'));
  });

  it('the authored retro character is preserved (pixelate/quantize/vignette pre-transform)', () => {
    const fs = RetroShader.fragmentShader;
    const firstInclude = fs.indexOf('<tonemapping_fragment>');
    for (const marker of [
      'floor(vUv / d + 0.5)', // pixelation
      'floor(col.rgb * quantize + 0.5) / quantize', // quantization
      'smoothstep(0.95, 0.45, dist * vignette * 2.0)', // vignette
    ]) {
      expect(fs).toContain(marker);
      expect(fs.indexOf(marker)).toBeLessThan(firstInclude);
    }
  });

  it('patchBloomOutputTransform appends the output chunks to the bloom blend material', () => {
    const bloom = new UnrealBloomPass(new THREE.Vector2(64, 64), 0.4, 0.6, 1.0);
    const mat = (bloom as unknown as { blendMaterial: THREE.ShaderMaterial }).blendMaterial;
    expect(mat.fragmentShader).not.toContain('<tonemapping_fragment>');
    patchBloomOutputTransform(bloom);
    const fs = mat.fragmentShader;
    expect(fs).toContain('#include <tonemapping_fragment>');
    expect(fs).toContain('#include <colorspace_fragment>');
    // the chunks land INSIDE main(), before its closing brace — after it
    // they would sit at global scope and fail shader compilation
    // (gl_FragColor assignments are only legal inside main)
    const cs = fs.indexOf('<colorspace_fragment>');
    expect(cs).toBeGreaterThan(fs.indexOf('gl_FragColor = opacity'));
    expect(cs).toBeLessThan(fs.lastIndexOf('}'));
    // the CopyShader body is intact, not clobbered
    expect(fs).toContain('texture2D( tDiffuse, vUv )');
  });

  it('patchBloomOutputTransform is idempotent', () => {
    const bloom = new UnrealBloomPass(new THREE.Vector2(64, 64), 0.4, 0.6, 1.0);
    patchBloomOutputTransform(bloom);
    patchBloomOutputTransform(bloom);
    const fs = (bloom as unknown as { blendMaterial: THREE.ShaderMaterial }).blendMaterial.fragmentShader;
    expect(fs.match(/tonemapping_fragment/g)).toHaveLength(1);
  });

  it('patchBloomOutputTransform fails loudly if three.js internals change', () => {
    expect(() => patchBloomOutputTransform({} as UnrealBloomPass)).toThrow(/blendMaterial not found/);
  });

  it('ACES rolls worst-case retro/bloom HDR inputs off instead of clipping white', () => {
    // Retro pass worst case: bloom-boosted HDR (emitters at 2.0+, blurred
    // mips) landing in the retro input at up to ~4.0 linear; bloom layer
    // worst case ~3.0 linear. Night exposure is 1.05 (locked); day/dusk/dawn
    // run 0.52-0.72. The old pipeline wrote these raw and clipped > 1.0.
    for (const exposure of [0.52, 0.72, 1.05]) {
      expect(aces(4.0, exposure)).toBeLessThan(1.0);
      expect(aces(3.0, exposure)).toBeLessThan(1.0);
      // mitigated sky band stays comfortably below the roll-off knee
      expect(aces(1.71 * 0.55, exposure)).toBeLessThan(0.9);
    }
  });
});
