/**
 * AtmosphericScattering — port of the legacy OP-22 MATRIX Preetham sky module.
 * Physical sky (three's Sky addon) with turbidity/Rayleigh/Mie derived from the
 * GameSpec's time-of-day and weather, azimuth from the game seed. Used for
 * day/dusk/dawn; night keeps the stylized gradient dome with stars.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { GameSpec } from '@spec';

export interface AtmosphereRig {
  dome: THREE.Mesh;
  sunDir: THREE.Vector3;
  dispose(): void;
}

export function createAtmosphere(spec: GameSpec): AtmosphereRig {
  const { timeOfDay, weather } = spec.theme;
  const sky = new Sky();
  sky.scale.setScalar(450000);

  const dusk = timeOfDay === 'dusk' || timeOfDay === 'dawn';
  const elevation = dusk ? 4 : 48;                     // degrees above horizon
  const azimuth = 100 + (spec.meta.seed % 160);        // deterministic per game

  const turbidity =
    weather === 'ash' ? 25 : weather === 'storm' ? 18 : weather === 'fog' ? 14
    : weather === 'rain' ? 12 : weather === 'snow' ? 9 : 6;
  const rayleigh = dusk ? 3.2 : 1.8;
  const mieCoefficient = weather === 'clear' ? 0.004 : weather === 'ash' ? 0.02 : 0.009;
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

  sky.frustumCulled = false;
  return {
    dome: sky as unknown as THREE.Mesh,
    sunDir: sunDir.clone().normalize(),
    dispose() { sky.geometry.dispose(); (sky.material as THREE.Material).dispose(); },
  };
}
