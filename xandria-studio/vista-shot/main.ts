/**
 * Offline dusk-vista render for the env-art pass (tests/e2e/shots/inv-env-vista.png).
 * Composes the reference language with real engine modules: biome ground
 * (cracked desert), beam tower + glow beam backlit by the dusk sun, ruin
 * arches, a bridge over water, amber lamp posts / lanterns, water sun glint,
 * dusk grade + god rays.
 */
import * as THREE from 'three';
import { generateSpec } from '../src/generator/generate';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { Terrain } from '../src/engine/world/Terrain';
import { Physics } from '../src/engine/core/Physics';
import { createSky } from '../src/engine/gfx/Sky';
import { buildBeamTower, buildRuinArch, buildBridge } from '../src/engine/gfx/Landmarks';
import { makeLampPost, makeGroundLantern } from '../src/engine/gfx/AmberGlow';
import { LightShafts } from '../src/engine/gfx/LightShafts';
import { Rng } from '../src/engine/core/Rng';

const spec = generateSpec('epic dusk desert vista with river', {
  seed: 20261011, genre: 'third-person-action', environment: 'desert',
});
spec.theme.timeOfDay = 'dusk';
spec.world.terrain.water = true;
spec.world.terrain.waterLevel = 2.0;

const W = 1280, H = 720;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const physics = new Physics(spec.world.gravity);
const mats = new MaterialLibrary(spec);
const terrain = new Terrain(spec, physics, mats, scene);
const sky = createSky(spec, scene, 'high');
renderer.toneMappingExposure = sky.exposure;

// real sky sun direction (world space)
const sunDir = sky.sun.position.clone().sub(sky.sun.target.position).normalize();
const sunFlat = new THREE.Vector3(sunDir.x, 0, sunDir.z).normalize();

const rng = new Rng(20261011);
const pal = spec.theme.palette;
const lp = { primary: pal.primary, secondary: pal.secondary, accent: pal.accent, rock: pal.rock, ground: pal.ground };
const hAt = (x: number, z: number) => terrain.heightAt(x, z);

// --- composition: tower on the highest point near center
let tower = new THREE.Vector3(0, 0, 0), towerH = -1e9;
for (let gx = -70; gx <= 70; gx += 5) {
  for (let gz = -70; gz <= 70; gz += 5) {
    const h = hAt(gx, gz);
    if (h > towerH) { towerH = h; tower.set(gx, h, gz); }
  }
}
const tw = buildBeamTower(rng, mats, lp, { realLight: true });
tw.position.copy(tower);
scene.add(tw);

// ruin arches flanking the tower
for (const [ox, oz] of [[-24, 10], [20, -16], [-10, -30]] as const) {
  const arch = buildRuinArch(rng, mats, lp);
  const ax = tower.x + ox, az = tower.z + oz;
  arch.position.set(ax, hAt(ax, az), az);
  scene.add(arch);
}

// --- camera: opposite the sun, looking back toward it — tower backlit by dusk
const camPos = tower.clone().addScaledVector(sunFlat, -52);
camPos.y = hAt(camPos.x, camPos.z) + 8;
const lookAt = new THREE.Vector3(tower.x, tower.y + 15, tower.z);

// bridge over water somewhere in the view corridor (camera → tower)
let bsite: THREE.Vector3 | null = null;
for (let t = 0.15; t < 0.9 && !bsite; t += 0.04) {
  const px = camPos.x + (tower.x - camPos.x) * t + rng.range(-16, 16);
  const pz = camPos.z + (tower.z - camPos.z) * t + rng.range(-16, 16);
  if (hAt(px, pz) < 2.0) bsite = new THREE.Vector3(px, 2.0, pz);
}
if (bsite) {
  const bridge = buildBridge(rng, mats, lp, (lx, lz) => hAt(bsite!.x + lx, bsite!.z + lz), 24, 4.5);
  bridge.position.set(bsite.x, 2.0 + 1.4, bsite.z);
  // face the bridge across the view direction
  bridge.rotation.y = Math.atan2(tower.x - camPos.x, tower.z - camPos.z) + Math.PI / 2 + rng.range(-0.2, 0.2);
  scene.add(bridge);
}

// amber lamps flanking the camera foreground + lanterns scattered midground
const viewDir = lookAt.clone().sub(camPos).setY(0).normalize();
const sideDir = new THREE.Vector3(-viewDir.z, 0, viewDir.x);
for (const s of [-1, 1]) {
  const lamp = makeLampPost(rng, mats);
  const lp2 = camPos.clone().addScaledVector(viewDir, 10).addScaledVector(sideDir, 5.5 * s);
  lamp.position.set(lp2.x, hAt(lp2.x, lp2.z), lp2.z);
  scene.add(lamp);
}
for (let i = 0; i < 16; i++) {
  const lan = makeGroundLantern(rng, mats);
  const t = rng.range(0.15, 0.7);
  const lx = camPos.x + (tower.x - camPos.x) * t + rng.range(-18, 18);
  const lz = camPos.z + (tower.z - camPos.z) * t + rng.range(-18, 18);
  lan.position.set(lx, hAt(lx, lz), lz);
  scene.add(lan);
}

// water glint aligned to the real sky sun, warm dusk tint
terrain.setWaterSun(sunDir, '#ffb46b');

// god-ray shafts
const shafts = new LightShafts(scene, spec, sunDir, 'high');

// keep the shadow frustum + sky dome on the vista
sky.update(0, tower);

const cam = new THREE.PerspectiveCamera(55, W / H, 0.5, 2500);
cam.position.copy(camPos);
cam.lookAt(lookAt);

// settle: shadows, water clock, shafts
terrain.updateWater(1.2);
shafts.update(1.2);
renderer.shadowMap.needsUpdate = true;
renderer.render(scene, cam);
renderer.render(scene, cam);
(window as any).__shotReady = true;
