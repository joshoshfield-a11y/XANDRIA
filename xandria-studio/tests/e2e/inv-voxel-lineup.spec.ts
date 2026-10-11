/**
 * Art-direction pass — voxel armor lineup beauty shot.
 * Four characters side by side in the four new armor skins (nomad,
 * desert-raider, emerald-guardian, void-scout), visors glowing, filmic grade
 * from the live engine pipeline — echoing the voxel reference framing.
 *
 * The shot is staged inside the real player page: the world is hidden, a
 * studio backdrop + ground plane is dropped in, and the rigs are built from
 * the engine's own modules via page-side /src imports. Those imports only
 * resolve under `vite dev` (the e2e config's `vite preview` serves dist, not
 * sources), so the test skips cleanly there instead of failing.
 *
 * Capture: start `npx vite --port 4180` in xandria-studio, then
 *   npx playwright test tests/e2e/inv-voxel-lineup.spec.ts
 * Output: tests/e2e/shots/inv-voxel-lineup.png
 */
import { test, expect } from '@playwright/test';

// The lineup is staged via page-side /src imports, which resolve only under
// `vite dev` (the e2e config's `vite preview` serves dist, not sources).
// Point at a dev server: `npx vite --port 4181` in xandria-studio, then run
// this spec. VOXEL_DEV_PORT overrides the port when needed.
const DEV = `http://localhost:${process.env.VOXEL_DEV_PORT ?? 4181}`;

const SKINS = ['nomad', 'desert-raider', 'emerald-guardian', 'void-scout'] as const;

test('artdir: voxel armor lineup (four skins, visors glowing)', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`${DEV}/player.html?test=1&intent=sword%20adventure%20in%20ancient%20ruins`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 60000 });

  const staged = await page.evaluate(async (skinIds: readonly string[]) => {
    const X = (window as any).__XANDRIA__;
    // page-side /src imports: live under vite dev only
    let gfx: any;
    try {
      const [C, S, M, T] = await Promise.all([
        // runtime-only vite-dev paths (tsc can't resolve these; the spec skips where they 404)
        // @ts-ignore
        import('/src/engine/gfx/Characters.ts'),
        // @ts-ignore
        import('/src/engine/gfx/Skins.ts'),
        // @ts-ignore
        import('/src/engine/gfx/Materials.ts'),
        // bare 'three' can't resolve at runtime in the browser; the direct
        // module file is served by vite dev as static JS (same three@182)
        // @ts-ignore
        import('/node_modules/three/build/three.module.js'),
      ]);
      gfx = { ...C, ...S, ...M, THREE: T };
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
    const hidden: any[] = [];
    scene.traverse((o: any) => {
      if ((o.isMesh || o.isPoints || o.isLine) && o.visible) { hidden.push(o); o.visible = false; }
    });
    scene.background = new THREE.Color(0x4a4a50); // studio gray, like the reference
    scene.fog = null;

    // ground plane so the lineup sits in something (receives the sun shadow)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0x565660, roughness: 0.95, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // bright frontal key + cool fill + hemisphere lift — the reference is
    // evenly lit, visors glowing against readable armor
    const key = new THREE.DirectionalLight(0xfff2e0, 3.0);
    key.position.set(3, 6, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fb8ff, 1.0);
    fill.position.set(-6, 3, 4);
    scene.add(fill);
    scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x3a3a40, 0.7));

    // the lineup: one rig per new skin, built from the engine's own modules
    const lineup: any[] = [];
    const rigs: any[] = [];
    skinIds.forEach((id, i) => {
      const rig = gfx.makeHumanoid(engine.mats, {}, 7000 + i, { headStyle: 'helmet', armor: 'none' });
      gfx.applySkin(rig, gfx.BUILT_IN_SKINS[id]);
      rig.group.position.set((i - 1.5) * 2.2, 0, 0);
      // idle breath + a touch of per-character phase so they don't mirror
      for (let k = 0; k < 30; k++) rig.animate(1.2 + i * 0.9 + k * 0.05, 0);
      scene.add(rig.group);
      lineup.push(rig.group);
      rigs.push(rig);
    });

    // straight-on lineup framing, chest height — tight like the reference
    const cam = engine.camera;
    cam.position.set(0, 1.6, 7.5);
    cam.lookAt(0, 1.0, 0);
    cam.fov = 36;
    cam.updateProjectionMatrix();

    return {
      skipped: false,
      rigs: rigs.length,
      armorPieces: lineup.reduce((n: number, g: any) => {
        let c = 0;
        g.traverse((o: any) => { if (o.isMesh && o.userData?.armorPiece) c++; });
        return n + c;
      }, 0),
      errors: (window as any).__XANDRIA_ERRORS?.length ?? -1,
    };
  }, SKINS);

  test.skip(staged.skipped === true, 'voxel lineup needs vite dev (page-side /src imports): ' + (staged as any).reason);
  expect(staged.rigs).toBe(4);
  expect(staged.armorPieces).toBeGreaterThan(30);
  expect(staged.errors).toBe(0);

  // let the filmic grade + visor emissive settle over a few frames
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/shots/inv-voxel-lineup.png' });

  const errs = await page.evaluate(() => (window as any).__XANDRIA_ERRORS);
  expect(errs).toEqual([]);
  expect(errors).toEqual([]);
});
