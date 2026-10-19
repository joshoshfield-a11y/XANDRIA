/**
 * Enemies wave, workstream B — hostile visual read, screenshot verification.
 *
 * Stages the four enemy silhouette families with their workstream-B visuals
 * (enemy armor sets on walker/brute, ember eye on drone, charcoal hull +
 * ember eye on turret) inside the real player page — the same studio-lineup
 * pattern as inv-voxel-lineup.spec.ts — and screenshots the lineup so the
 * hostile read (ember visor slits, spiked pauldrons, dark jagged palettes)
 * can be judged by eye.
 *
 * The staging uses page-side /src imports, which resolve only under
 * `vite dev` (the e2e config's `vite preview` serves dist, not sources),
 * so the test skips cleanly there instead of failing.
 *
 * Capture: start `npx vite --port 4181` in xandria-studio, then
 *   npx playwright test tests/e2e/enemies-visual.spec.ts
 * Output: ~/workspace/xandria/qa/gameplay/shots/enemies-b-lineup.png
 */
import { test, expect } from '@playwright/test';

// The staging is built via page-side /src imports, which resolve only under
// `vite dev` (the e2e config's `vite preview` serves dist, not sources).
// Point at a dev server: `npx vite --port 4181` in xandria-studio, then run
// this spec. VOXEL_DEV_PORT overrides the port when needed.
const DEV = `http://localhost:${process.env.VOXEL_DEV_PORT ?? 4181}`;
const SHOT = '/home/hatch/workspace/xandria/qa/gameplay/shots/enemies-b-lineup.png';

test('enemies B: hostile visual read — walker + brute + drone + turret lineup', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`${DEV}/player.html?test=1&intent=sword%20adventure%20in%20ancient%20ruins`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 120000 });

  const staged = await page.evaluate(async () => {
    const X = (window as any).__XANDRIA__;
    // page-side /src imports: live under vite dev only
    let gfx: any;
    try {
      const [C, V, M, T] = await Promise.all([
        // runtime-only vite-dev paths (tsc can't resolve these; the spec skips where they 404)
        // @ts-ignore
        import('/src/engine/gfx/Characters.ts'),
        // @ts-ignore
        import('/src/engine/gfx/VoxelArmor.ts'),
        // @ts-ignore
        import('/src/engine/gfx/Materials.ts'),
        // bare 'three' can't resolve at runtime in the browser; the direct
        // module file is served by vite dev as static JS (same three@182)
        // @ts-ignore
        import('/node_modules/three/build/three.module.js'),
      ]);
      gfx = { ...C, ...V, ...M, THREE: T };
    } catch (e) {
      return { skipped: true, reason: String(e) };
    }
    const { THREE } = gfx;
    const engine = X.engine;
    const scene = engine.scene;

    // freeze the sim (rendering keeps running), hide the HUD
    engine.pause();
    const hud = document.querySelector('.xhud') as HTMLElement | null;
    if (hud) hud.style.display = 'none';

    // hide the world (keep lights — they are not meshes)
    scene.traverse((o: any) => {
      if ((o.isMesh || o.isPoints || o.isLine) && o.visible) o.visible = false;
    });
    scene.background = new THREE.Color(0x4a4a50); // studio gray, like the reference lineup
    scene.fog = null;

    // ground plane so the lineup sits in something (receives the sun shadow)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0x35303a, roughness: 0.95, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // bright frontal key + cool fill + hemisphere lift — even lighting so
    // the armor reads and the visors glow against it
    const key = new THREE.DirectionalLight(0xfff2e0, 3.0);
    key.position.set(3, 6, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fb8ff, 1.0);
    fill.position.set(-6, 3, 4);
    scene.add(fill);
    scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x3a3a40, 0.7));

    // the lineup: one per enemy silhouette family, dressed exactly the way
    // the Enemy constructor dresses them (same tints, same armor sets,
    // same ember eye colors — see src/engine/game/EnemyAI.ts).
    // The rigs' fronts face +Z natively (visor slits at +Z), and the camera
    // sits at +Z — no yaw needed.
    const lineup: any[] = [];
    const stage = (group: any, x: number, y: number, z = 0) => {
      group.position.set(x, y, z);
      scene.add(group);
      lineup.push(group);
    };

    // walker: dark under-suit + ember accent, marauder armor, seeded like Enemy
    const walker = gfx.makeHumanoid(engine.mats,
      { shirt: '#2a1210', pants: '#1a1310', accent: '#ff2a00', skin: '#8f8a80', bulk: 1 }, 9001,
      { headStyle: 'helmet', armor: 'none' });
    gfx.applyEnemyArmor(walker, 'marauder', { origin: 'skin' });
    stage(walker.group, -4.4, 0);

    // brute: 1.7 bulk, brutehide plates + back spikes
    const brute = gfx.makeHumanoid(engine.mats,
      { shirt: '#1c1c20', pants: '#141214', accent: '#ff1a00', skin: '#8f8a80', bulk: 1.7 }, 9002,
      { headStyle: 'helmet', armor: 'none' });
    gfx.applyEnemyArmor(brute, 'brutehide', { origin: 'skin' });
    stage(brute.group, -1.5, 0);

    // drone: dark rust hull + ember eye (hovering, staged slightly forward
    // so it reads at lineup scale instead of a sky blob)
    const drone = gfx.makeDrone(engine.mats, '#402020', '#ff2a00', 9003);
    stage(drone.group, 1.5, 1.7, 2.5);

    // turret: charcoal hull + ember eye
    const turret = gfx.makeTurret(engine.mats, '#232326', '#ff2200');
    stage(turret.group, 4.3, 0);

    // run the walk cycle a touch so the lineup reads mid-stride, not T-posed
    for (let k = 0; k < 40; k++) {
      walker.animate(1.4 + k * 0.05, 3.2);
      brute.animate(1.4 + k * 0.05, 2.6);
      drone.animate(1.4 + k * 0.05, 0);
    }

    // lineup framing, chest height — wide enough for all four + spikes
    const cam = engine.camera;
    cam.position.set(0, 1.9, 10.5);
    cam.lookAt(0, 1.3, 0);
    cam.fov = 40;
    cam.updateProjectionMatrix();

    // diagnostics: ember emissive count + spike count, so the test can
    // assert the hostile read is actually present in the staged scene
    let ember = 0, spikes = 0, visorSlits = 0;
    for (const g of lineup) {
      g.traverse((o: any) => {
        if (!o.isMesh) return;
        const mat = o.material;
        const ud = o.userData ?? {};
        if (mat?.emissive && mat.emissiveIntensity > 0 &&
          !mat.emissive.equals(new THREE.Color(0x000000))) {
          const hex = '#' + mat.emissive.getHexString();
          const n = parseInt(hex.slice(1), 16);
          const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
          if (r > 180 && gg < r * 0.45 && b < r * 0.3) ember++;
        }
        if (ud.armorPiece === true && (o.geometry as any)?.type === 'ConeGeometry') spikes++;
        if (ud.armorPiece === true && ud.armorSlot === 'head' && mat?.emissive &&
          mat.emissiveIntensity > 0 && !mat.emissive.equals(new THREE.Color(0x000000))) visorSlits++;
      });
    }

    return {
      skipped: false, lineup: lineup.length, ember, spikes, visorSlits,
      errors: (window as any).__XANDRIA_ERRORS?.length ?? -1,
    };
  });

  test.skip(staged.skipped === true, 'enemy visual lineup needs vite dev (page-side /src imports): ' + (staged as any).reason);
  expect(staged.lineup).toBe(4);
  expect(staged.visorSlits, 'ember visor slits staged').toBeGreaterThanOrEqual(2); // walker + brute helms
  expect(staged.ember, 'ember emissive bits staged').toBeGreaterThanOrEqual(4);    // slits + drone/turret eyes
  expect(staged.spikes, 'pauldron/back spikes staged').toBeGreaterThanOrEqual(9); // 2x3 pauldron + 3 brutehide back
  expect(staged.errors).toBe(0);

  // let the filmic grade + visor emissive settle over a few frames
  await page.waitForTimeout(2000);
  await page.screenshot({ path: SHOT });

  const errs = await page.evaluate(() => (window as any).__XANDRIA_ERRORS);
  expect(errs).toEqual([]);
  expect(errors).toEqual([]);
});
