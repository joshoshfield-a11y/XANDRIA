/**
 * Crafting wave, workstream C — draw-call measurement for the crafting
 * layer on the deterministic profiling scene (seed 20261012, tp-action,
 * forest/hills, dusk "Forgotten Valley", 512m chunked — the INSTANCING.md
 * method).
 *
 * Method: renderer.info.render.calls median of 10 frames, crafting layer
 * absent vs present. Three legs per tier: base (nodes + stations
 * despawned), nodes-only, nodes + stations. The rosters are never ticked
 * during sampling (static); one-shot submitStaticLayer while PAUSED (the
 * blueprint's per-frame begin/end would otherwise zero the submits —
 * rendering continues while paused, so the counts stay valid). NPCs and
 * enemies are despawned first so the baseline is truly "no characters".
 *
 * This verifies workstream B's claim (per-node draws in single digits) by
 * measurement and prices the new station layer per tier.
 *
 * Results print as a table and are written to
 * test-results/crafting-perf.json.
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
const COMPILE_MS = 12_000;
const SEED = 20261012;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

test('crafting perf: nodes + stations layer draw calls per tier', async ({ page }) => {
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
      return !!(X?.engine && X?.gatheringTest && X?.craftingTest && X?.engine?.portalsPlayerAvatar && X.engine.state === 'playing');
    }), 240_000);
    const resolved = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.tiers.tier);
    expect(resolved).toBe(tier);

    // "No characters" baseline: drop NPCs, enemies, nodes and stations.
    await page.evaluate(() => {
      const E = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine;
      const systems = (E.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
      for (const s of systems) s.despawnAll();
    });

    const pause = () => page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.pause());
    const resume = () => page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.resume());

    await page.waitForTimeout(SETTLE_MS);
    await pause();
    const base = median(await sampleDraws(SAMPLES));
    await resume();

    // Nodes leg: the tier's real roster (18 at density 1 — no tier scaling
    // for gathering), spawned via the shipped spawnForMap path.
    const nodeInfo = await page.evaluate((seed) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const gm = X.gatheringTest.liveManager();
      gm.spawnForMap(seed);
      return { count: gm.nodes.length };
    }, SEED);
    await page.waitForTimeout(COMPILE_MS);
    await pause();
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      X.craftingTest.submitStaticLayer(X.gatheringTest.liveManager().nodes);
    });
    const withNodes = median(await sampleDraws(SAMPLES));
    const nodeBuckets = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.craftingTest.craftingInstancerStats().buckets);
    await resume();

    // Stations leg: the 4-station roster on top of the nodes.
    const stationInfo = await page.evaluate((seed) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const sm = X.craftingTest.liveStations();
      sm.spawnForMap(seed);
      return { count: sm.stations.length };
    }, SEED);
    await page.waitForTimeout(COMPILE_MS);
    await pause();
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      X.craftingTest.submitStaticLayer(X.craftingTest.liveStations().stations);
    });
    const withBoth = median(await sampleDraws(SAMPLES));
    const bothBuckets = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.craftingTest.craftingInstancerStats().buckets);
    await resume();

    // cleanup: no live crafting entities left for the next tier
    await page.evaluate(() => {
      const E = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine;
      const systems = (E.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
      for (const s of systems) if (s.id === 'gathering' || s.id === 'stations') s.despawnAll();
    });

    const nodeDelta = withNodes - base;
    const stationDelta = withBoth - withNodes;
    return {
      tier,
      nodeCount: nodeInfo.count,
      stationCount: stationInfo.count,
      nodeBuckets,
      bothBuckets,
      baseDraws: base,
      nodesDraws: withNodes,
      bothDraws: withBoth,
      nodeDelta,
      stationDelta,
      perNode: Math.round((nodeDelta / nodeInfo.count) * 10) / 10,
      perStation: Math.round((stationDelta / stationInfo.count) * 10) / 10,
    };
  };

  const results = [await measureTier('desktop'), await measureTier('s25')];

  const outDir = resolve(HERE, 'test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'crafting-perf.json'), JSON.stringify({
    scene: 'seed 20261012, tp-action, forest/hills, dusk, 512m chunked',
    method: 'renderer.info.render.calls median of 10 frames, paused one-shot submits; base (no characters) vs nodes-only vs nodes+stations',
    results,
    errors,
  }, null, 2) + '\n');

  for (const r of results) {
    console.log(
      `[crafting-perf] ${r.tier} (nodes=${r.nodeCount}, stations=${r.stationCount}, ` +
      `nodeBuckets=${r.nodeBuckets}, bothBuckets=${r.bothBuckets}): ` +
      `base=${r.baseDraws} nodes=${r.nodesDraws} (+${r.nodeDelta}, ${r.perNode}/node) ` +
      `both=${r.bothDraws} (+${r.stationDelta} stations, ${r.perStation}/station)`,
    );
    expect(r.nodeDelta, `${r.tier}: node layer added no draw calls`).toBeGreaterThan(0);
    expect(r.stationDelta, `${r.tier}: station layer added no draw calls`).toBeGreaterThan(0);
    // workstream B's claim, verified by measurement: per-node draws in single digits
    expect(r.perNode, `${r.tier}: per-node draws not in single digits`).toBeLessThan(10);
    // stations are bigger builds (~5-8 parts); sane upper bound
    expect(r.perStation, `${r.tier}: per-station cost blew past the sane bound`).toBeLessThan(20);
  }
  expect(errors).toEqual([]);
});
