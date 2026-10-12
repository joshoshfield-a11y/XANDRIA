/**
 * Filmic color-grade ShaderPass (polish wave, LOOK crew — plan item #7).
 *
 * lift/gamma/gain (ASC-CDL style) + saturation + vignette, ~20 lines of GLSL.
 * Runs after bloom on standard/high tiers only — retro keeps its own shader.
 * Per-genre parameters ride the GenreGrade system (GenreGrade.grade).
 *
 * This pass is ALWAYS the last pass in the chain when present (PostFX adds it
 * after bloom and never adds anything after it), so it also performs the
 * output transform: ACES tone mapping (via renderer.toneMappingExposure, which
 * Engine sets to the per-genre sky.exposure every frame) + sRGB encoding.
 *
 * D1 root-cause fix (fog/sky overexposure): in three r152+, tone mapping and
 * output color-space conversion apply ONLY when rendering to the screen through
 * materials that include the tonemapping/colorspace chunks (WebGLPrograms sets
 * toneMapping=NoToneMapping for any non-null render target). The chain renders
 * the scene into a HalfFloat target, so without these includes the pass wrote
 * linear HDR values straight to the canvas: the Preetham horizon band
 * (linear ~1.36-1.71) and bright fog colors clipped straight to white, and the
 * per-genre exposure tuning was silently dead on standard/high. The beauty
 * wave's mitigations (sky shader x0.45-0.55, fogLuminance<1, bloom threshold
 * 1.0) pushed values below the clip point, but ACES is what makes
 * overexposure structurally impossible — highlights now roll off instead of
 * clipping. No new passes, no new uniforms; the WebGLProgram prefix already
 * injects the tone-mapping/colorspace pars + the live toneMappingExposure
 * uniform for screen passes, so shader cost is unchanged.
 *
 * Cost: one fullscreen pass, ~1-2% GPU on the mobile floor.
 */
import * as THREE from 'three';
import type { ColorGrade } from './GenreGrade';

export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    lift: { value: new THREE.Vector3(0, 0, 0) },
    gamma: { value: new THREE.Vector3(1, 1, 1) },
    gain: { value: new THREE.Vector3(1, 1, 1) },
    saturation: { value: 1.0 },
    vignette: { value: 0.45 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec3 lift; uniform vec3 gamma; uniform vec3 gain;
    uniform float saturation; uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // lift (shadow tint) + gain (highlight tint); the lift is weighted by
      // (1 - luma) so it tints shadows without washing the highlights
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = c * gain + lift * (1.0 - luma);
      // per-channel gamma (identity 1.0)
      c = pow(max(c, vec3(0.0)), vec3(1.0) / max(gamma, vec3(0.05)));
      // saturation around luma
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, saturation);
      // filmic vignette: corners ~20-30% darker at the authored strengths
      vec2 q = vUv - vec2(0.5);
      c *= clamp(1.0 - dot(q, q) * vignette, 0.0, 1.0);
      gl_FragColor = vec4(c, 1.0);
      // D1: output transform — ACES tone mapping (uses the live
      // renderer.toneMappingExposure = per-genre sky.exposure) + sRGB encode.
      // This pass is always last, so these chunks resolve against the screen
      // (TONE_MAPPING defined, outputColorSpace = sRGB). Highlights roll off
      // instead of clipping to white.
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

/** Push a GenreGrade's color grade into a ShaderPass built on GradeShader. */
export function setGradeUniforms(pass: { uniforms: Record<string, { value: unknown }> }, grade: ColorGrade): void {
  (pass.uniforms.lift.value as THREE.Vector3).set(...grade.lift);
  (pass.uniforms.gamma.value as THREE.Vector3).set(...grade.gamma);
  (pass.uniforms.gain.value as THREE.Vector3).set(...grade.gain);
  (pass.uniforms.saturation.value as number) = grade.saturation;
  (pass.uniforms.vignette.value as number) = grade.vignette;
}
