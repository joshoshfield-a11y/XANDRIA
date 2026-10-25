/**
 * Graphics Pass D demo (branch, follows the spike-demo pattern).
 * Five boxes, one per baked surf tile, through the real standard()
 * path — the same materials Props/structures get in-game. Ground is
 * the baked grass tile for context. Sets window.__SURF_READY__ once
 * all five baked map images have actually loaded, so screenshots
 * capture pixels, not placeholders.
 */
import * as THREE from 'three';
import { defaultSpec } from '@spec';
import { MaterialLibrary } from '@engine/gfx/Materials';

const SURF: Array<{ kind: 'rock' | 'metal' | 'wood' | 'panel' | 'concrete'; hex: string }> = [
  { kind: 'rock', hex: '#a8a29a' },
  { kind: 'metal', hex: '#8b9096' },
  { kind: 'wood', hex: '#8a7a66' },
  { kind: 'panel', hex: '#7d838a' },
  { kind: 'concrete', hex: '#9d9a94' },
];

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#101820');
scene.fog = new THREE.FogExp2('#101820', 0.02);
scene.add(new THREE.HemisphereLight('#cfe8ff', '#1a2028', 1.1));
const sun = new THREE.DirectionalLight('#fff2d8', 1.6);
sun.position.set(4, 8, 5);
scene.add(sun);

const aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 100);
camera.position.set(0, 2.0, aspect >= 1 ? 7.2 : 7.2 / aspect * 1.45);
camera.lookAt(0, 0.7, 0);

const mats = new MaterialLibrary(defaultSpec());
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(24, 24),
  mats.biomeGroundDef(
    { kind: 'ground', base: '#ffffff', alt: '#ffffff', roughness: 0.95, baked: 'ground-grass' },
    { repeat: 4 },
  ),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const boxes = SURF.map((s, i) => {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 1.15, 1.15),
    mats.standard(s.kind, s.hex),
  );
  mesh.position.set(-2.9 + i * 1.45, 0.575, 0);
  scene.add(mesh);
  return mesh;
});

const status = document.getElementById('status')!;
const texReady = (t: THREE.Texture | null) => {
  const img = t?.image as { complete?: boolean; naturalWidth?: number } | undefined;
  return !!img && img.complete === true && (img.naturalWidth ?? 0) > 0;
};

function tick() {
  requestAnimationFrame(tick);
  const ready = boxes.every((b) => texReady((b.material as THREE.MeshStandardMaterial).map));
  if (ready && !(window as any).__SURF_READY__) {
    (window as any).__SURF_READY__ = true;
    status.textContent = 'textures loaded';
  }
  renderer.render(scene, camera);
}
tick();
