/**
 * Post-processing: UnrealBloom when spec.theme.bloom, plus an optional retro pixelation pass.
 * Falls back to plain rendering if the composer fails to build (e.g. exotic drivers).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { GameSpec } from '@spec';

const RetroShader = {
  uniforms: { tDiffuse: { value: null }, pixelSize: { value: 2.0 }, resolution: { value: new THREE.Vector2(1, 1) }, vignette: { value: 0.35 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float pixelSize; uniform vec2 resolution; uniform float vignette;
    varying vec2 vUv;
    void main(){
      vec2 d = pixelSize / resolution;
      vec2 uv = pixelSize > 0.0 ? floor(vUv / d + 0.5) * d : vUv;
      vec4 col = texture2D(tDiffuse, uv);
      // slight color quantization for the retro feel
      col.rgb = floor(col.rgb * 24.0 + 0.5) / 24.0;
      float dist = distance(vUv, vec2(0.5));
      col.rgb *= smoothstep(0.95, 0.45, dist * vignette * 2.0);
      gl_FragColor = col;
    }`,
};

export class PostFX {
  private composer: EffectComposer | null = null;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private retroPass: ShaderPass | null = null;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, spec: GameSpec) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    try {
      this.composer = new EffectComposer(renderer);
      this.composer.addPass(new RenderPass(scene, camera));
      if (spec.theme.bloom) {
        const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.45, 0.6, 0.82);
        this.composer.addPass(bloom);
      }
      if (spec.theme.retroFilter) {
        this.retroPass = new ShaderPass(RetroShader);
        this.composer.addPass(this.retroPass);
        this.resize(innerWidth, innerHeight);
      }
    } catch {
      this.composer = null;
    }
  }

  resize(w: number, h: number) {
    this.composer?.setSize(w, h);
    if (this.retroPass) {
      (this.retroPass.uniforms.resolution.value as THREE.Vector2).set(w, h);
    }
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() { this.composer?.dispose(); }
}
