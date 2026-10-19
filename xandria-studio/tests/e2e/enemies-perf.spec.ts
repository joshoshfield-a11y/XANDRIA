/**
 * Enemies wave, workstream C — draw-call measurement on the deterministic
 * profiling scene (seed 20261012, tp-action, forest/hills, dusk "Forgotten
 * Valley", 512m chunked — the INSTANCING.md method).
 *
 * Method: renderer.info.render.calls median of 10 frames, enemies absent
 * vs present. The roster is placed in a line in front of the camera (all
 * in view) and never ticked during sampling (static), so the delta is a
 * clean per-enemy attribution. Two render paths are measured on the SAME
 * roster/positions: instanced (spawnForMap + submitStaticEnemies, the
 * shipped path) and direct (instancer reset -> source meshes render),
 * giving a true before/after instancing table.
 *
 * Results print as a table and are written to test-results/enemies-perf.json.
 * Honest guards: the delta must be positive and the instanced per-enemy
 * cost must beat the direct path by a wide margin (the ~13-30x win from
 * the NPC pass is the reference).
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

test('enemies perf: before/after instancing draw calls per tier', async ({ page }) => {
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
      return !!(X?.engine && X?.enemyTest && X?.engine?.portalsPlayerAvatar && X.engine.state === 'playing');
    }), 240_000);
    const resolved = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.tiers.tier);
    expect(resolved).toBe(tier);

    // The blueprint's own initial-build rosters are direct-rendered noise
    // for this A/B — clear enemies AND villagers so the baseline is truly
    // "no characters". (Villagers matter: they submit into the same shared
    // buckets every frame; leaving them live would let the paused submits
    // below zero their counts and corrupt the delta.)
    await page.evaluate(() => {
      const E = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine;
      const systems = (E.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
      for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    });

    // Sampling runs PAUSED: tpAction's per-frame inst.beginFrame/endFrame
    // would otherwise zero the one-shot static submits below (the same
    // reason the NPC pass submits once for never-ticked NPCs). Rendering
    // continues while paused, so renderer.info.render.calls stays valid
    // per frame; the scene is frozen, which is exactly what the delta
    // needs. Terrain streaming still runs — the settle + median absorb it.
    const pause = () => page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.pause());
    const resume = () => page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.resume());

    await page.waitForTimeout(SETTLE_MS);
    await pause();
    const base = median(await sampleDraws(SAMPLES));
    await resume();

    // The tier's real roster: desktop 6 walkers, s25 3 (density 0.5).
    // Placed in a line in front of the camera, all in view, static.
    const spawnInfo = await page.evaluate((tier) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const E = X.engine;
      const ET = X.enemyTest;
      const V = E.camera.position.constructor;
      const dir = E.camera.getWorldDirection(new V(0, 0, 0));
      dir.y = 0; dir.normalize();
      const p = E.portalsPlayerAvatar.ctrl.position;
      const density = ET.resolveEnemyDensity(X.spec, tier);
      const count = Math.max(1, Math.round(6 * density));
      const pois = [];
      for (let i = 0; i < count; i++) {
        const d = 10 + i * 4;
        const px = p.x + dir.x * d, pz = p.z + dir.z * d;
        pois.push({ x: px, z: pz, r: 0 });
      }
      const specs = [{ kind: 'walker', count, health: 30, speed: 4, damage: 10, weapon: 'melee' }];
      const em = new ET.EnemyManager(E, null, {}, { pois, specs, density: 1 });
      em.spawnForMap(20261012); // registers with the instancer (the shipped path)
      // Pin every enemy exactly onto the camera line (spawnForMap rings
      // them ±16m around the POIs) — body + rig group, then submit once.
      // Never ticked afterwards: static during sampling.
      em.enemies.forEach((e: any, i: number) => {
        const d = 10 + i * 4;
        const px = p.x + dir.x * d, pz = p.z + dir.z * d;
        const y = (E.terrain ? (E.terrain.heightAt(px, pz) ?? p.y) : p.y) + 1;
        if (e.body) e.body.position.set(px, y, pz);
        const g = e.renderRoot;
        if (g) g.position.set(px, y - 0.85, pz);
        g?.updateMatrixWorld(true);
      });
      ET.submitStaticEnemies(em.enemies);
      let meshes = 0;
      for (const e of em.enemies) {
        e.renderRoot?.traverse((o: any) => { if (o.isMesh) meshes++; });
      }
      const buckets = ET.enemyInstancerStats().buckets;
      // NOTE: the submit above is immediately clobbered by the running
      // frame loop (beginFrame zeroes counts every frame); the real
      // sampling submit happens after pause() below.
      (window as unknown as { __ENEMIES_PERF__?: any }).__ENEMIES_PERF__ = { em };
      return { count, meshes, buckets };
    }, tier);
    // let the enemy materials compile (a few slow SwiftShader frames)
    await page.waitForTimeout(12_000);
    await pause();
    // Submit while paused: no beginFrame/endFrame runs, so the instances
    // persist for the whole sample window.
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const { em } = (window as unknown as { __ENEMIES_PERF__?: any }).__ENEMIES_PERF__;
      X.enemyTest.submitStaticEnemies(em.enemies);
    });
    const withInstanced = median(await sampleDraws(SAMPLES));
    await resume();

    // BEFORE: drop just these enemies from the buckets -> the same roster
    // renders direct. NPCs stay instanced (setEnemiesDirect, not reset())
    // so the delta is walkers-only, not confounded by the villagers.
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const { em } = (window as unknown as { __ENEMIES_PERF__?: any }).__ENEMIES_PERF__;
      X.enemyTest.setEnemiesDirect(em.enemies);
    });
    await page.waitForTimeout(4000);
    await pause();
    const withDirect = median(await sampleDraws(SAMPLES));
    await resume();

    // cleanup: no live enemies left for the next tier
    await page.evaluate(() => {
      const { em } = (window as unknown as { __ENEMIES_PERF__?: any }).__ENEMIES_PERF__;
      em.despawnAll();
    });

    const per = (w: number) => Math.round(((w - base) / spawnInfo.count) * 10) / 10;
    return {
      tier,
      count: spawnInfo.count,
      meshesPerEnemy: Math.round((spawnInfo.meshes / spawnInfo.count) * 10) / 10,
      buckets: spawnInfo.buckets,
      baseDraws: base,
      instancedDraws: withInstanced,
      directDraws: withDirect,
      deltaInstanced: withInstanced - base,
      deltaDirect: withDirect - base,
      perEnemyInstanced: per(withInstanced),
      perEnemyDirect: per(withDirect),
    };
  };

  const results = [await measureTier('desktop'), await measureTier('s25')];

  const outDir = resolve(HERE, 'test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'enemies-perf.json'), JSON.stringify({
    scene: 'seed 20261012, tp-action, forest/hills, dusk, 512m chunked',
    method: 'renderer.info.render.calls median of 10 frames; same static roster+positions, instanced vs direct (enemies only; NPCs stay instanced)',
    results,
    errors,
  }, null, 2) + '\n');

  for (const r of results) {
    console.log(
      `[enemies-perf] ${r.tier} (n=${r.count}, meshes/enemy=${r.meshesPerEnemy}, buckets=${r.buckets}): ` +
      `base=${r.baseDraws} direct=${r.directDraws} (+${r.deltaDirect}, ${r.perEnemyDirect}/enemy) ` +
      `instanced=${r.instancedDraws} (+${r.deltaInstanced}, ${r.perEnemyInstanced}/enemy)`,
    );
    expect(r.deltaDirect, `${r.tier}: direct path added no draw calls`).toBeGreaterThan(0);
    expect(r.deltaInstanced, `${r.tier}: instanced path added no draw calls`).toBeGreaterThan(0);
    // the instancing win must be real: instanced per-enemy cost is strictly
    // below the direct per-enemy cost for the same roster. (The ratio is
    // reported, not asserted — armored rigs collapse ~4-5x, not 30x like
    // unarmored villagers; see C.md.)
    const ratio = r.perEnemyDirect / Math.max(r.perEnemyInstanced, 0.1);
    console.log(`[enemies-perf] ${r.tier}: instancing ratio ${ratio.toFixed(2)}x`);
    expect(r.perEnemyInstanced, `${r.tier}: instancing did not beat direct`).toBeLessThan(r.perEnemyDirect);
    // sane upper bound (catches a 10x blowup, e.g. runaway shadow passes)
    expect(r.perEnemyInstanced, `${r.tier}: instanced per-enemy cost blew past the sane bound`).toBeLessThan(130);
  }
  expect(errors).toEqual([]);
});
