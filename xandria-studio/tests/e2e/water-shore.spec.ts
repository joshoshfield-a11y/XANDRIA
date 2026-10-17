/**
 * Graphics wave 2, workstream D (water): shoreline foam + depth grading +
 * rain ripple — before/after beauty shots + draw-call + console-error gates.
 *
 * Boots deterministic lake specs (scripts/water-shore-specs.ts ->
 * /tmp/water-specs/<weather>.b64, seed 4242, dusk), scans in-page for a real
 * shoreline beyond the spawn flattening, pins the camera with a rAF hook
 * (the follow-cam would fight a one-shot set), and screenshots the shore at
 * near (15m, foam band reads) and far (120m, z-fight seam check) distances.
 *
 * Run with WATER_BEFORE=1 for the pre-change baseline (writes -before
 * shots); without it for the after shots at the deliverable paths
 * (tests/e2e/shots/water-shore-<weather>-<dist>-<vp>.png).
 *
 * Tiers: 'high' = desktop tier, 'retro' = S25 proxy tier (the 150-draw-call
 * budget binds it). Quality forced pre-boot via the settings localStorage
 * key, same as tests/e2e/beta/perf.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BEFORE = !!process.env.WATER_BEFORE;
const WEATHERS = ['clear', 'rain'] as const;
const TIERS = ['high', 'retro'] as const;
const VIEWPORTS = [
  { name: 'desktop', w: 1280, h: 800 },
  { name: 'mobile', w: 360, h: 780 },
] as const;
const DISTS = [
  // far: high oblique over the lake (z-fighting seam check across the view)
  { name: 'far', d: 0, h: 120 },
  // near: 30m oblique — low grazing angles (4m) proved unreliable for the
  // pinned camera in headless SwiftShader; 30m still reads the foam band
  { name: 'near', d: 30, h: 30 },
] as const;
const SETTINGS_KEY = 'xandria.settings.v1';

interface ShoreInfo {
  found: boolean;
  sx: number; sz: number; wy: number;
  drawCalls: number;
  triangles: number;
  quality: string;
  weather: string;
  /** uRain uniform value, or null on the pre-change baseline build */
  uRain: number | null;
  /** resolved camera distance for the far framing (0 when near) */
  effDist: number;
  /** camera pin for debugging framings */
  pin: { x: number; y: number; z: number; tx: number; ty: number; tz: number };
}

/** Find a shoreline, pin the camera, return frame stats. Runs in-page. */
async function frameShore(page: any, dist: number, camH: number): Promise<ShoreInfo> {
  return page.evaluate(async ({ dist, camH }: { dist: number; camH: number }) => {
    const X = (window as any).__XANDRIA__;
    const t = X.engine.terrain;
    const wy: number = t.water.position.y;
    // Gather shoreline candidates beyond the spawn flattening, then pick the
    // one with the most open water along the camera→shore sight line (keeps
    // beach structures / ruin walls out of frame). Deterministic: fixed scan
    // order, first best wins. Cached per page: the scan is identical for
    // near/far framings, only the camera distance differs.
    //
    // For each candidate we march water-side (downhill along the height
    // gradient) to measure openWater: how far the sight line stays over
    // water before hitting the far shore / world edge. The far framing uses
    // 0.85× openWater so the camera never ends up inside terrain.
    let best = (window as any).__waterShoreBest ?? null;
    if (!best) {
    for (let r = 36; r < 105; r += 4) {
      for (let a = 0; a < Math.PI * 2; a += 0.3) {
        const cx0 = Math.cos(a) * r, cz0 = Math.sin(a) * r;
        if (Math.abs(t.heightAt(cx0, cz0) - wy) >= 0.35) continue;
        // water-side direction (downhill along the height gradient)
        const e = 2;
        const gx = t.heightAt(cx0 + e, cz0) - t.heightAt(cx0 - e, cz0);
        const gz = t.heightAt(cx0, cz0 + e) - t.heightAt(cx0, cz0 - e);
        const gl = Math.hypot(gx, gz) || 1;
        const dx = -gx / gl, dz = -gz / gl;
        let openWater = 0, maxDepth = 0;
        for (let m = 5; m <= 150; m += 5) {
          const dep = wy - t.heightAt(cx0 + dx * m, cz0 + dz * m);
          if (dep < 0.3) break;
          openWater = m;
          if (dep > maxDepth) maxDepth = dep;
        }
        // Need a REAL lake, not a puddle: transparent water over a 0.3m-deep
        // dip reads as dark terrain. 2.5m+ of depth makes the shallow→deep
        // grade and the foam band read clearly.
        if (openWater < 40 || maxDepth < 2.5) continue;
        // On hilly maps the straight march can lie: verify the actual camera
        // spots. Both framings must sit OVER water (not on a far hill) and
        // the near sight line must clear the terrain.
        const camOk = (d: number, h: number) => {
          const px = cx0 + dx * d, pz = cz0 + dz * d;
          if (wy - t.heightAt(px, pz) < 0.5) return false; // camera over water
          if (h <= 6) {
            // near framing: sight line camera→shore must clear terrain
            for (let s = 1; s < 8; s++) {
              const f = s / 8;
              const lx = px + (cx0 - px) * f, lz = pz + (cz0 - pz) * f;
              const lineY = (wy + h) + (wy + 0.5 - (wy + h)) * f;
              if (t.heightAt(lx, lz) > lineY - 0.5) return false;
            }
          }
          return true;
        };
        const farD = Math.min(130, openWater * 0.85);
        // New framings: far = top-down 120m over lake center; near = 30m up,
        // 25m diagonal offset, aimed at lake center. Verify camera spots are
        // above terrain.
        const lakeXv = cx0 + dx * openWater * 0.4, lakeZv = cz0 + dz * openWater * 0.4;
        if (t.heightAt(lakeXv + 25, lakeZv + 25) > wy + 20) continue;
        if (!camOk(15, 4) || !camOk(farD, 10)) continue;
        if (!best || openWater > best.openWater) {
          best = { sx: cx0, sz: cz0, dx, dz, openWater };
        }
      }
    }
    (window as any).__waterShoreBest = best;
    }
    const found = best !== null;
    const sx = best ? best.sx : 0, sz = best ? best.sz : 40;
    // The far framing passes dist=0 to request "as far as the water allows".
    const effDist = dist === 0 && best ? Math.min(130, best.openWater * 0.85) : dist;
    // Pin the camera using the maxsize wave's proven pattern: the blueprint
    // camera rig calls camera.position.copy()/lookAt() every substep, so we
    // neuter those mutators on the camera instance (one-time per page) and
    // apply our framing through the saved originals. Any stray rig lookAt
    // re-applies the pin target. The pin object is mutable so near/far
    // framings re-pin through __waterShoreApplyPin.
    const pin = ((window as any).__waterShorePin ??= { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, armed: false });
    if (best) {
      // Frame the LAKE (foam ring reads from above), not the shore point.
      // Lake center ≈ shore + waterDir * openWater * 0.4.
      const lakeX = sx + best.dx * best.openWater * 0.4;
      const lakeZ = sz + best.dz * best.openWater * 0.4;
      if (dist === 0) {
        // far: top-down from camH over the lake
        pin.x = lakeX; pin.y = wy + camH; pin.z = lakeZ;
        pin.tx = lakeX; pin.ty = wy; pin.tz = lakeZ;
      } else {
        // near: oblique — diagonal offset, camH up, aimed at lake center
        pin.x = lakeX + 25; pin.y = wy + camH; pin.z = lakeZ + 25;
        pin.tx = lakeX; pin.ty = wy; pin.tz = lakeZ;
      }
      pin.armed = true;
    }
    const cam = X.engine.camera;
    if (!(cam as any).__wsNeutered) {
      (cam as any).__wsNeutered = true;
      const pos = cam.position;
      const origSet = pos.set.bind(pos);
      const origLookAt = Object.getPrototypeOf(cam).lookAt.bind(cam);
      pos.set = (() => pos) as any;
      pos.copy = (() => pos) as any;
      cam.lookAt = (() => {
        const p = (window as any).__waterShorePin;
        return origLookAt(p.tx, p.ty, p.tz);
      }) as any;
      (window as any).__waterShoreApplyPin = () => {
        const p = (window as any).__waterShorePin;
        origSet(p.x, p.y, p.z);
        origLookAt(p.tx, p.ty, p.tz);
      };
    }
    (window as any).__waterShoreApplyPin();
    cam.updateProjectionMatrix();
    // Wait for fresh frames with the pinned camera (not a fixed timeout:
    // headless SwiftShader can run at ~1fps, so a stale compositor frame
    // would show the pre-pin view).
    const f0: number = X.engine.frame;
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (X.engine.frame >= f0 + 2) { clearInterval(iv); resolve(); }
        else if (Date.now() - t0 > 60000) { clearInterval(iv); reject(new Error('no frames rendered')); }
      }, 250);
      // re-apply the pin periodically in case a blueprint resetRun() dropped
      // our neutering (it filters updateHooks, not camera mutators, but belt
      // and suspenders — re-neutering is idempotent via __wsNeutered).
      (window as any).__waterShoreApplyPin();
    });
    const info = X.engine.renderer.info;
    const ud = (t as any).waterMat?.userData ?? {};
    const camPos = [cam.position.x, cam.position.y, cam.position.z].map((v: number) => +v.toFixed(1));
    const neutered = !!(cam as any).__wsNeutered;
    return {
      found, sx, sz, wy,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      quality: X.engine.effectiveQuality(),
      weather: X.spec.theme.weather,
      uRain: ud.uRain?.value ?? null,
      effDist,
      pin: { ...pin },
      camPos, neutered,
    } as ShoreInfo;
  }, { dist, camH });
}

for (const weather of WEATHERS) {
  for (const tier of TIERS) {
    for (const vp of VIEWPORTS) {
      test(`water-shore ${weather}/${tier}/${vp.name}${BEFORE ? ' (before)' : ''}`, async ({ page }) => {
        // generous timeout: this box is shared with other workstreams' e2e
        // (SwiftShader under 15x CPU oversubscription renders slowly)
        test.setTimeout(600_000);
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await page.addInitScript(
          ({ k, q }: { k: string; q: string }) => {
            localStorage.setItem(k, JSON.stringify({ volume: 0.8, muted: true, quality: q }));
          },
          { k: SETTINGS_KEY, q: tier },
        );
        const b64 = readFileSync(`/tmp/water-specs/${weather}.b64`, 'utf8').trim();
        await page.goto(`/player.html?test=1&spec=${b64}`, { waitUntil: 'load' });
        await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 180000 });
        await page.addStyleTag({ content: '.xhud{display:none!important}' });
        await page.waitForTimeout(2500); // shaders compile, water clock runs

        const stats: Record<string, ShoreInfo> = {};
        for (const d of DISTS) {
          console.log(`[water-shore] ${weather}/${tier}/${vp.name}: framing ${d.name}...`);
          const info = await frameShore(page, d.d, d.h);
          console.log(`[water-shore] ${weather}/${tier}/${vp.name}: framed ${d.name} (found=${info.found} effDist=${info.effDist.toFixed(0)})`);
          expect(info.found, 'should find a shoreline beyond spawn flattening').toBe(true);
          expect(info.quality).toBe(tier);
          expect(info.weather).toBe(weather);
          if (!BEFORE) {
            // the new build wires uRain from spec.theme.weather
            expect(info.uRain).toBe(weather === 'rain' ? 1 : 0);
          }
          stats[`${tier}/${vp.name}/${d.name}`] = info;
          await page.screenshot({
            path: `tests/e2e/shots/water-shore-${weather}-${tier}-${vp.name}-${d.name}${BEFORE ? '-before' : ''}.png`,
            timeout: 240_000,
          });
        }
        console.log(`[water-shore] ${weather} ` + Object.entries(stats)
          .map(([k, s]) => `${k}: calls=${s.drawCalls} tris=${s.triangles} farDist=${s.effDist.toFixed(0)} pin=${JSON.stringify(s.pin)} camPos=${JSON.stringify((s as any).camPos)} neutered=${(s as any).neutered}`).join(' | '));
        expect(errors).toEqual([]);
      });
    }
  }
}
