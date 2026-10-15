/**
 * EnergyField — Portals wave, workstream A.
 *
 * The transparent energy-field boundary that replaces walls/cliffs on
 * portal-enabled maps. Four vertical quads (N/S/E/W) merged into ONE
 * BufferGeometry / ONE Mesh / ONE shared ShaderMaterial — exactly 1 draw
 * call on any map size (8km included: quads are world-sized, vertex count
 * is 16).
 *
 * Look: a translucent amber veil (XANDRIA's signature glow, AmberGlow.ts)
 * with three motion cues: vertical energy strands breathing slowly, light
 * ribbons flowing UPWARD, and a bright footprint where the field meets the
 * terrain. The upward flow is deliberate — rising energy reads as "walk
 * through me", the opposite of a solid wall. Dusk-friendly: the hot cores
 * peak above 1.0 so the bloom pass picks them up at dusk, while the veil
 * stays translucent enough to see the terrain through.
 *
 * Cost: ZERO per-frame CPU. The animation is one shared uTime uniform plus
 * ALU in the fragment shader. The only CPU touch is advancing uTime
 * (Terrain.updateField → module clock below); when the mesh isn't in the
 * scene nothing runs.
 *
 * Contract with workstream C (owns the `world.portals` spec schema):
 * `portalsEnabled` is re-exported from C's canonical typed check
 * (`spec.world.portals?.enabled === true`, src/spec/schema.ts).
 */
import * as THREE from 'three';
import { AMBER, AMBER_HOT } from './AmberGlow';

/**
 * Portals-wave contract: is this map portal-enabled? Delegates to workstream
 * C's canonical typed check (`spec.world.portals?.enabled === true`,
 * src/spec/schema.ts) — the merge-time fix point is now resolved.
 */
export { portalsEnabled } from '@spec';

/** Vertical extent of the field (m). Taller than any boundary rim (the
 *  'walls' rim rises 0.8*maxHeight ≈ 11m at maxHeight 14). */
export const ENERGY_FIELD_HEIGHT = 48;

/** Base color / hot band color — the XANDRIA amber signature. */
const FIELD_COLOR = AMBER;
const FIELD_HOT = AMBER_HOT;

let sharedMat: THREE.ShaderMaterial | null = null;

/**
 * The single shared energy-field material. Cached module-wide (like the
 * MaterialLibrary pattern): many portal maps over a session reuse it, and
 * it is NEVER disposed by owners — dispose only the per-map geometry.
 *
 * `dusk`: true boosts the hot-band peaks for the cinematic dusk grade so
 * the field stays legible against a dark sky.
 */
export function energyFieldMaterial(dusk = false): THREE.ShaderMaterial {
  if (sharedMat) {
    sharedMat.uniforms.uDusk.value = dusk ? 1 : 0;
    return sharedMat;
  }
  const c = new THREE.Color(FIELD_COLOR);
  const hot = new THREE.Color(FIELD_HOT);
  sharedMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Vector3(c.r, c.g, c.b) },
      uHot: { value: new THREE.Vector3(hot.r, hot.g, hot.b) },
      uDusk: { value: dusk ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;      // uv.x = meters along the edge, uv.y = 0..1 (bottom..top)
      varying vec3 vWPos;    // world position (for the along-wall shimmer)
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uHot;
      uniform float uDusk;
      varying vec2 vUv;
      varying vec3 vWPos;
      void main() {
        // Vertical energy strands (~12m apart), slowly breathing — the
        // fence-like structure that reads as a boundary wall rather than
        // sky decoration.
        float strand = pow(0.5 + 0.5 * sin(vUv.x * 0.52 + uTime * 0.8), 3.0);
        // Rising ribbons, rippling along the wall — the "walk through me"
        // motion cue (energy flowing upward, never a static slab).
        float rise = fract(vUv.y * 6.0 - uTime * 0.45
          + 0.18 * sin(vUv.x * 0.045 + uTime * 0.7));
        float band = smoothstep(0.0, 0.12, rise) * (1.0 - smoothstep(0.12, 0.55, rise));
        // Footprint glow: the bright line where the field meets the terrain —
        // anchors the wall to the ground (no top fade; it lives at the base).
        float base = 1.0 - smoothstep(0.0, 0.10, vUv.y);
        // Along-wall shimmer: ~18m wavelength drifting sideways.
        float sh = sin(vUv.x * 0.35 + uTime * 1.6) * sin(vUv.x * 0.13 - uTime * 0.9);
        // Slow global pulse so the field breathes instead of sitting static.
        float pulse = 0.85 + 0.15 * sin(uTime * 1.1);
        // The veil dissolves into the sky instead of ending in a hard line.
        float topFade = 1.0 - smoothstep(0.70, 1.0, vUv.y);
        float glow = max(band, strand * 0.8);
        float a = (0.20 + 0.30 * glow + 0.06 * sh) * pulse * topFade
                + 0.45 * base * pulse;
        vec3 col = mix(uColor, uHot, max(glow, base));
        // Hot cores peak ~2.5x (dusk) so the bloom pass catches them without
        // clipping to white — ACES rolls the highlights off amber.
        col *= (1.0 + 0.9 * max(glow, base)) * (1.0 + uDusk * 0.35);
        gl_FragColor = vec4(col, clamp(a, 0.0, 0.9));
      }
    `,
  });
  return sharedMat;
}

/**
 * Build the 4-edge field as ONE mesh: 4 vertical quads (16 verts, 8 tris)
 * baked into a single BufferGeometry at world coordinates. uv.x is meters
 * along the edge (band density independent of map size), uv.y is 0..1.
 * Returns the mesh (not added to any scene — the owner does that).
 */
export function buildEnergyField(size: number, height = ENERGY_FIELD_HEIGHT, dusk = false): THREE.Mesh {
  const half = size / 2;
  // positions, uvs, indices for the 4 quads (each: 4 verts, 2 tris)
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (x0: number, z0: number, x1: number, z1: number) => {
    const b = pos.length / 3;
    // (x0,z0) -> (x1,z1) is the edge, uv.x = meters from the edge start
    const len = Math.hypot(x1 - x0, z1 - z0);
    pos.push(x0, 0, z0, x1, 0, z1, x1, height, z1, x0, height, z0);
    uv.push(0, 0, len, 0, len, 1, 0, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  // N (z = -half), S (z = +half), W (x = -half), E (x = +half)
  quad(-half, -half, half, -half);
  quad(-half, half, half, half);
  quad(-half, -half, -half, half);
  quad(half, -half, half, half);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, energyFieldMaterial(dusk));
  m.castShadow = false;
  m.receiveShadow = false;
  m.frustumCulled = true;
  m.renderOrder = 5; // after opaque terrain, before particles/HUD
  m.userData.energyField = true; // marker for scene queries / tests
  return m;
}

/**
 * Advance the shared shader clock. One uniform write per frame, only when
 * a field exists — the shader ALU does the rest.
 */
export function updateEnergyField(dt: number): void {
  if (sharedMat) sharedMat.uniforms.uTime.value += dt;
}

/**
 * Remove the mesh from its scene and free the per-map geometry. The shared
 * material is module-owned and never disposed here (same contract as the
 * MaterialLibrary cache / AmberGlow instancer).
 */
export function disposeEnergyField(scene: THREE.Scene, mesh: THREE.Mesh): void {
  scene.remove(mesh);
  mesh.geometry.dispose();
}

/** Current shader time (tests / tooling). */
export function energyFieldTime(): number {
  return sharedMat ? sharedMat.uniforms.uTime.value : 0;
}
