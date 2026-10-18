/**
 * NPCs workstream C: draw-call measurement on the deterministic profiling
 * scene (seed 20261012, tp-action, forest/hills, dusk "Forgotten Valley",
 * 512m chunked build of the 2km scene — same seed/genre/biome/tod as
 * qa/graphics-fullscale/workers-env2/PROFILING.md; 512m keeps the
 * SwiftShader stream drain fast while the per-NPC cost is size-independent).
 *
 * Method (same as the graphics pass): forced renderer.info.reset() is
 * already the engine's per-frame behavior (autoReset=false + one manual
 * reset per frame), so renderer.info.render.calls IS the per-frame draw
 * count. Subsystem toggle: sample with NPCs absent, spawn the tier's
 * roster via A's spawnNpcsForMap + C's registration policy, sample again.
 *
 * NPCs are placed in a line in FRONT of the camera (all in view — no
 * frustum culling hiding cost) and are NOT ticked during sampling (static
 * villagers), so the delta is a clean per-NPC attribution. Results print
 * as a table and are written to test-results/npcs-perf.json.
 *
 * Honest guards (not a binding budget — the brief sets none): the delta
 * must be positive (NPCs actually render) and bounded above (catches an
 * accidental 10x blowup, e.g. runaway shadow passes).
 *
 * Caveats: SwiftShader headless renders ~1fps while chunks stream, so the
 * scene is UNSETTLED — relative deltas are valid, absolutes are not (same
 * caveat as the graphics profiling pass).
 */
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const SAMPLES = 10;
const GAP_MS = 1500;
const SETTLE_MS = 20_000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

test('npcs perf: draw-call delta per tier on the deterministic scene', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };

  const sampleDraws = async (n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(await page.evaluate(() =>
        (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.renderer.info.render.calls));
      await page.waitForTimeout(GAP_MS);
    }
    return out;
  };

  const measureTier = async (tier: 'desktop' | 's25') => {
    await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0&tier=${tier}`);
    await waitFor('boot', () => page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return !!(X?.engine && X?.npcTest && X?.engine?.portalsPlayerAvatar && X.engine.state === 'playing');
    }), 240_000);
    const resolved = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.tiers.tier);
    expect(resolved).toBe(tier);

    await page.waitForTimeout(SETTLE_MS);
    const base = await sampleDraws(SAMPLES);

    // Spawn the tier's roster in a line in front of the camera (all in
    // view). Static during sampling: no update() ticks, so wander can't
    // drift anyone out of frame mid-window.
    const spawnInfo = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any; __NPCS__?: any }).__XANDRIA__!;
      const E = X.engine;
      const T = X.npcTest;
      const count: number = T.resolveNpcCount(X.spec, E.tiers.tier);
      const V = E.camera.position.constructor;
      const dir = E.camera.getWorldDirection(new V(0, 0, 0));
      dir.y = 0; dir.normalize();
      const p = E.portalsPlayerAvatar.ctrl.position;
      const pois = [];
      for (let i = 0; i < count; i++) {
        const d = 8 + i * 4;
        const px = p.x + dir.x * d, pz = p.z + dir.z * d;
        const y = E.terrain ? (E.terrain.heightAt(px, pz) ?? p.y) : p.y;
        pois.push(new V(px, y, pz));
      }
      const npcs = T.spawnNpcsForMap(E, X.spec.meta.seed, { count, pois });
      T.registerNpcInteractables(E, npcs);
      // Instancing pass: the spawned NPCs are static (never ticked), so
      // submit them to the per-engine instancer once — this is what the
      // production manager path does every frame via NpcManager.update.
      T.submitStaticNpcs(npcs);
      let meshes = 0;
      for (const n of npcs) n.rig.group.traverse((o: any) => { if (o.isMesh) meshes++; });
      (window as unknown as { __NPCS__?: any }).__NPCS__ = npcs;
      return { count, meshes };
    });
    // let the NPC materials compile (a few slow SwiftShader frames)
    await page.waitForTimeout(12_000);
    const withNpcs = await sampleDraws(SAMPLES);

    const b = median(base);
    const w = median(withNpcs);
    return {
      tier,
      count: spawnInfo.count,
      meshesPerNpc: Math.round((spawnInfo.meshes / spawnInfo.count) * 10) / 10,
      baseDraws: b,
      withNpcsDraws: w,
      delta: w - b,
      perNpc: Math.round(((w - b) / spawnInfo.count) * 10) / 10,
    };
  };

  const results = [await measureTier('desktop'), await measureTier('s25')];

  const outDir = resolve(HERE, 'test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'npcs-perf.json'), JSON.stringify({
    scene: 'seed 20261012, tp-action, forest/hills, dusk, 512m chunked',
    method: 'renderer.info.render.calls median of 10 frames, NPCs absent vs present (static, all in view)',
    results,
    errors,
  }, null, 2) + '\n');

  for (const r of results) {
    console.log(
      `[npcs-perf] ${r.tier}: base=${r.baseDraws} with=${r.withNpcsDraws} (n=${r.count}) ` +
      `delta=+${r.delta} perNpc=${r.perNpc} meshesPerNpc=${r.meshesPerNpc}`,
    );
    // Honest guards: NPCs must actually render; per-NPC cost must stay
    // within a sane multiple of A's measured mesh bound (46-52, ≤60).
    // Shadow-casting meshes can double the count, so the bound is 130.
    expect(r.delta, `${r.tier}: NPCs added no draw calls`).toBeGreaterThan(0);
    expect(r.perNpc, `${r.tier}: per-NPC draw cost blew past the sane bound`).toBeLessThan(130);
  }
  expect(errors).toEqual([]);
});
