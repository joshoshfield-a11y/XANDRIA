/**
 * AtmosphericScattering — port of the legacy OP-22 MATRIX Preetham sky module.
 * Physical sky (three's Sky addon) with turbidity/Rayleigh/Mie derived from the
 * GameSpec's time-of-day and weather, azimuth from the game seed. Used for
 * day/dusk/dawn; night keeps the stylized gradient dome with stars.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { GameSpec } from '@spec';
import { gradeAtmosphere } from './GenreGrade';

export interface AtmosphereRig {
  dome: THREE.Mesh;
  sunDir: THREE.Vector3;
  dispose(): void;
}

export function createAtmosphere(spec: GameSpec): AtmosphereRig {
  const { timeOfDay, weather } = spec.theme;
  const sky = new Sky();
  // The dome follows the camera every frame (see SkyRig.update), so it only
  // needs to comfortably enclose the view.
  // Open World stage 1 (workstream D): the dome no longer writes depth and
  // renders first in the opaque pass (classic skybox behavior). Before this,
  // the dome's 1000m depth shell occluded any terrain farther than 1000m
  // from the camera — invisible on 220m worlds, but it would have swallowed
  // the far field on 2km maps. Radius stays 1000, inside every camera far
  // plane (Engine.ts scales far >= 1400 with world size).
  sky.scale.setScalar(1000);
  (sky.material as THREE.Material).depthWrite = false;
  sky.renderOrder = -1;

  const dusk = timeOfDay === 'dusk' || timeOfDay === 'dawn';
  // Env-art dusk preset: the sun sits lower for a longer atmospheric path and
  // the air scatters harder — golden-hour warmth at the horizon. Day keeps
  // the authored values.
  const elevation = dusk ? 3 : 48;                     // degrees above horizon
  const azimuth = 100 + (spec.meta.seed % 160);        // deterministic per game

  const turbidity =
    weather === 'ash' ? 25 : weather === 'storm' ? 18 : weather === 'fog' ? 14
    : weather === 'rain' ? 12 : weather === 'snow' ? 9 : 6;
  const rayleigh = dusk ? 4.2 : 1.8;
  // Env-art dusk preset: a stronger solar aureole at golden hour so the sun
  // carries a warm glow (the reference vistas are ALL dusk). Day keeps the
  // authored values.
  const mieCoefficient = dusk ? 0.012
    : weather === 'clear' ? 0.004 : weather === 'ash' ? 0.02 : 0.009;
  const mieDirectionalG = 0.8;

  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);

  const u = sky.material.uniforms;
  u.turbidity.value = turbidity;
  u.rayleigh.value = rayleigh;
  u.mieCoefficient.value = mieCoefficient;
  u.mieDirectionalG.value = mieDirectionalG;
  u.sunPosition.value.copy(sunDir);

  // Beauty wave: the Preetham horizon band renders near-white at the authored
  // turbidity (measured on a CPU port of the shader). Scale the shader output
  // per genre so the sky holds color instead of clipping to white. Compile-time
  // constant — no new uniforms, no per-frame cost.
  const skyBright = gradeAtmosphere(spec.meta.genre, timeOfDay).sky;
  if (skyBright !== 1) {
    const mat = sky.material as THREE.ShaderMaterial;
    const patched = mat.fragmentShader.replace(
      'vec4( retColor, 1.0 )',
      `vec4( retColor * ${skyBright.toFixed(3)}, 1.0 )`,
    );
    if (patched !== mat.fragmentShader) mat.fragmentShader = patched;
  }

  sky.frustumCulled = false;
  return {
    dome: sky as unknown as THREE.Mesh,
    sunDir: sunDir.clone().normalize(),
    dispose() { sky.geometry.dispose(); (sky.material as THREE.Material).dispose(); },
  };
}
