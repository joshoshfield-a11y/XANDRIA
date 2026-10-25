/**
 * Graphics-overhaul Pass 0 spike demo (branch-only, not shipped).
 * Left: humanoid with the baked spike-shirt texture (palette tinted).
 * Right: same rig with the canvas 'digital' pattern skin, for comparison.
 * Ground: baked spike-ground via Materials.biomeGroundDef's baked branch.
 * Sets window.__SPIKE_READY__ once the baked pixels have actually loaded.
 */
import * as THREE from 'three';
import { defaultSpec } from '@spec';
import { MaterialLibrary } from '@engine/gfx/Materials';
import { makeHumanoid } from '@engine/gfx/Characters';
import { BUILT_IN_SKINS, applySkin } from '@engine/gfx/Skins';
import { bakedTexture, bakedNormalTexture } from '@engine/gfx/BakedTextures';

// Pass A demo: four built-in skins, left to right.
const DEMO_SKINS = ['default', 'stealth', 'desertnomad', 'spectral'] as const;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#101820');
scene.fog = new THREE.FogExp2('#101820', 0.03);
scene.add(new THREE.HemisphereLight('#cfe8ff', '#1a2028', 1.1));
const sun = new THREE.DirectionalLight('#fff2d8', 1.6);
sun.position.set(4, 8, 5);
scene.add(sun);

const aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 100);
// Portrait viewports need the camera pulled back or the pair gets cropped.
camera.position.set(0, 1.7, aspect >= 1 ? 5.6 : 5.6 / aspect * 1.45);
camera.lookAt(0, 0.95, 0);

const mats = new MaterialLibrary(defaultSpec());
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  mats.biomeGroundDef(
    { kind: 'ground', base: '#ffffff', alt: '#ffffff', roughness: 0.95, baked: 'ground-grass' },
    { repeat: 4 },
  ),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const rigs = DEMO_SKINS.map((id, i) => {
  const rig = makeHumanoid(mats, {}, 42 + i);
  rig.group.position.x = -1.95 + i * 1.3;
  applySkin(rig, BUILT_IN_SKINS[id]);
  scene.add(rig.group);
  return rig;
});

const status = document.getElementById('status')!;
const texReady = (t: THREE.Texture | null) => {
  const img = t?.image as { complete?: boolean; naturalWidth?: number } | undefined;
  return !!img && img.complete === true && (img.naturalWidth ?? 0) > 0;
};
const t0 = performance.now();
function frame(t: number) {
  requestAnimationFrame(frame);
  const s = t / 1000;
  for (const rig of rigs) rig.animate(s, 0.7);
  renderer.render(scene, camera);
  const ready = ['spike-shirt', 'fabric-carbon', 'fabric-camo', 'accent-runes'].every((id) => texReady(bakedTexture(id)))
    && texReady(bakedTexture('ground-grass')) && texReady(bakedTexture('pants-denim')) && texReady(bakedTexture('skin-matte'));
  if (ready && !(window as unknown as { __SPIKE_READY__?: boolean }).__SPIKE_READY__) {
    (window as unknown as { __SPIKE_READY__?: boolean }).__SPIKE_READY__ = true;
    status.textContent = 'baked textures loaded';
  } else if (!ready && performance.now() - t0 > 15000) {
    (window as unknown as { __SPIKE_READY__?: boolean }).__SPIKE_READY__ = true;
    status.textContent = 'texture wait timed out (screenshot anyway)';
  }
}
requestAnimationFrame(frame);
