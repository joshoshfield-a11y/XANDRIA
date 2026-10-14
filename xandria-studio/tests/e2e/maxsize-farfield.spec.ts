/**
 * Stage 1b workstream C: far-field LOD + atmosphere at the new max world size.
 *
 * Boots 2km and 8km worlds (spec blobs from scripts/maxsize-farfield-specs.ts
 * -> /tmp/ff-specs/*.b64), freezes the sim, frames the horizon from several
 * viewpoints, and captures before/after PNGs to
 * ~/workspace/xandria/qa/openworld/workers-max/.
 *
 * Camera procedure: engine.pause() ('modal' — no pause-menu overlay) stops
 * the blueprint camera rig; the render loop keeps drawing and ChunkStream
 * follows the camera (streamFocus is null), so each shot waits for the
 * stream queue to drain before capturing.
 *
 * Timing note: SwiftShader renders the 2km scene (~2.6M tris) at ~0.5fps, so
 * each page.screenshot needs a multi-minute timeout. One boot per spec blob;
 * the mobile viewport is covered by resizing the same page (the engine's
 * ResizeObserver handles it).
 *
 * Gate: ZERO console/page errors on desktop AND 360x780 mobile viewports.
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

const OUT = '/home/hatch/workspace/xandria/qa/openworld/workers-max';
// Primary: /tmp/ff-specs (regenerate via scripts/maxsize-farfield-specs.ts);
// fallback: the committed copy in workers-max/ff-specs (/tmp is ephemeral).
const SPECS = existsSync('/tmp/ff-specs/ff-2km-dusk-hills.b64')
  ? '/tmp/ff-specs'
  : '/home/hatch/workspace/xandria/qa/openworld/workers-max/ff-specs';

interface Frame { px: number; py: number; pz: number; tx: number; ty: number; tz: number }
interface Shot { name: string; frame: Frame; note: string }

const PLAN: { spec: string; shots: Shot[] }[] = [
  {
    spec: 'ff-2km-dusk-hills',
    shots: [
      { name: 'horizon-2km-after', frame: { px: -375, py: 75, pz: -375, tx: 500, ty: 10, tz: 500 }, note: '2km regression: far-field must match the stage-1 look' },
    ],
  },
  {
    spec: 'ff-8km-dusk-hills',
    shots: [
      { name: 'horizon-8km-after', frame: { px: -1500, py: 300, pz: -1500, tx: 2000, ty: 40, tz: 2000 }, note: '8km money shot: intentional horizon, dusk grade, no banding/blowout' },
      // traverse toward the far terrain: same target, camera closing in —
      // pops would show as discrete shell changes between these frames
      { name: 'traverse-8km-far', frame: { px: 500, py: 120, pz: 500, tx: 4000, ty: 0, tz: 4000 }, note: 'traverse A (far)' },
      { name: 'traverse-8km-mid', frame: { px: 1500, py: 120, pz: 1500, tx: 4000, ty: 0, tz: 4000 }, note: 'traverse B (mid)' },
      { name: 'traverse-8km-near', frame: { px: 2500, py: 120, pz: 2500, tx: 4000, ty: 0, tz: 4000 }, note: 'traverse C (near)' },
    ],
  },
  {
    spec: 'ff-8km-dusk-water',
    shots: [
      { name: 'water-rim-8km', frame: { px: 3200, py: 500, pz: 3200, tx: 9000, ty: -50, tz: 9000 }, note: 'water edgeless from the highest viewpoint' },
    ],
  },
  {
    spec: 'ff-8km-dusk-canyon',
    shots: [
      { name: 'canyon-8km', frame: { px: -2625, py: 150, pz: -3300, tx: -2625, ty: -20, tz: -3771 }, note: 'canyon: shell must not float above the floor near cliffs' },
    ],
  },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 360, height: 780 },
];

for (const { spec: specName, shots } of PLAN) {
  test(`farfield ${specName} (desktop + mobile)`, async ({ page }) => {
    test.setTimeout(3_600_000); // 8km cold build + per-shot stream drains + SwiftShader screenshots are slow
    const t0 = Date.now();
    const ts = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

    const b64 = readFileSync(`${SPECS}/${specName}.b64`, 'utf8').trim();
    await page.goto(`/player.html?test=1&spec=${b64}`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (window as any).__XANDRIA__?.engine?.state === 'playing',
      null, { timeout: 900_000 },
    );
    console.log(`[farfield] ${ts()} ${specName} booted`);
    await page.addStyleTag({ content: '.xhud{display:none!important}' });

    // NOTE: do NOT pause the engine — when paused, frames drop to ~0.1fps
    // (empirically) and the chunk stream never drains. We leave the sim
    // running and pin the stream focus to each shot's location (the
    // third-person camera rig would otherwise fight our camera placement).
    // The camera is set synchronously just before each screenshot to win the
    // race against the rig.
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(2000); // resize settles
      for (const s of shots) {
        // Pin the stream focus to the shot location so foreground chunks build
        // there regardless of where the gameplay camera is.
        await page.evaluate((frame) => {
          const X = (window as any).__XANDRIA__;
          X.engine.streamFocus = new (X.engine.camera.position.constructor)(
            frame.px, 0, frame.pz,
          );
        }, s.frame);
        await page.waitForFunction(() => {
          const t = (window as any).__XANDRIA__?.engine?.terrain;
          return t && t.getStreamStats().queue === 0;
        }, null, { timeout: 600000 });
        await page.waitForTimeout(1500); // grade/fog settle
        // Frame the shot and measure synchronously in one evaluate, then
        // screenshot immediately. The third-person rig calls
        // camera.position.copy() and camera.lookAt() every frame, so we
        // neutralize those mutators to keep our framing (proven necessary).
        const m: any = await page.evaluate((frame) => {
          const X = (window as any).__XANDRIA__;
          const cam = X.engine.camera;
          cam.position.set(frame.px, frame.py, frame.pz);
          cam.lookAt(frame.tx, frame.ty, frame.tz);
          cam.updateProjectionMatrix();
          cam.position.copy = () => cam.position;
          cam.position.set = () => cam.position;
          const protoLookAt = Object.getPrototypeOf(cam).lookAt.bind(cam);
          cam.lookAt = () => protoLookAt(frame.tx, frame.ty, frame.tz);
          const st = X.engine.terrain.getStreamStats();
          return {
            queue: st.queue,
            draws: X.engine.perf.drawCalls,
            tris: X.engine.perf.triangles,
            geos: X.engine.perf.geometries,
            far: cam.far,
            shellSegs: (X.engine as any).farTerrain?.segments ?? -1,
            shellBias: (X.engine as any).farTerrain?.bias ?? -999,
          };
        }, s.frame);
        await page.screenshot({ path: `${OUT}/${s.name}-${vp.name}.png`, timeout: 600_000 });
        console.log(
          `[farfield] ${ts()} ${s.name}-${vp.name} draws=${m.draws} ` +
          `tris=${(m.tris / 1000).toFixed(0)}k geos=${m.geos} queue=${m.queue} ` +
          `far=${m.far} shellSegs=${m.shellSegs} bias=${Number(m.shellBias).toFixed(2)}`,
        );
        expect(m.queue).toBe(0);
        expect(m.shellSegs).toBeGreaterThan(0);
      }
    }

    expect(errors).toEqual([]);
  });
}
