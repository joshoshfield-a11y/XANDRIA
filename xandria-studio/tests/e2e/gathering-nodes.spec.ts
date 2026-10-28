/**
 * Upgrade loop, gathering-nodes phase — in the live player page:
 * - seeded map -> identical node roster across two boots AND across a
 *   manual portalEntities despawn/spawn round-trip (the exact functions
 *   PortalTransition invokes)
 * - harvest via the real [E] prompt path grants the EXACT table materials
 *   (oracle replication of the per-node rng draw order, computed in-spec)
 * - a harvested node depletes, then regrows per the NODE_DEFS table
 *   (herb: 45s) and is harvestable again
 * - portal re-entry preserves node state: a harvested node is still
 *   depleted after the round-trip, then regrows on its remaining wait
 * - minimap markers: live + fog-revealed nodes marked, depleted ones not
 * Desktop + 360x780, zero console/page errors.
 *
 * Patterns follow crafting.spec.ts (teleport to the node, prompt read via
 * the session's promptedNode, never the reverse) and crafting-portal.spec.ts
 * (manual despawnAll/spawnForMap as the portal-leg stand-in).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

// Same deterministic scene, plus an empty item table so the blueprint
// builds the item kit (ensureCraftingItemDefs fills the crafting defs at
// boot; crafting is enabled by default).
const B64 = (() => {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
})();

// ---------------------------------------------------------------------------
// Independent oracle: mulberry32 + the spawn/yield draw orders, written
// here from the algorithm — not imported from game code. Only the table
// values (base/variance) are read from the live NODE_DEFS seam.
// ---------------------------------------------------------------------------
function oracleRng(seed: number) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min: number, max: number) => min + (max - min) * next(),
    int: (min: number, max: number) => Math.floor(min + (max + 1 - min) * next()),
  };
}

/** Expected grant for one node: rotation draw, scale draw, then yield int. */
function oracleYield(mapSeed: number, index: number, kind: string, defs: Record<string, { yieldBase: number; yieldVariance: number }>): number {
  const rng = oracleRng((mapSeed ^ 0x43524146 ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  rng.range(0, Math.PI * 2);
  rng.range(0.9, 1.15);
  const def = defs[kind];
  return def.yieldBase + rng.int(0, def.yieldVariance);
}

test('gathering-nodes: seeded roster, exact harvest, regrow, portal state, minimap', async ({ page }) => {
  test.setTimeout(1_800_000);
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

  const boot = async () => {
    await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
    await waitFor('boot', () => page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return !!(X?.engine && X?.gatheringTest && X?.craftingTest && X?.blueprint?.stations
        && X?.blueprint?.itemKit && X.engine.state === 'playing'
        && X.engine.portalsPlayerAvatar && X.gatheringTest.liveManager());
    }), 240_000);
    // Clean prompt field: NPCs/enemies are not under test here (their own
    // specs cover them); despawn so the [E] target is unambiguous.
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
      for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
      X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
    });
    // Tutorial gate: the Forgotten Valley fixture opens the tutorial,
    // which freezes engine.time (world updates stall) until dismissed —
    // teleports do not count as movement, so dismiss it explicitly and
    // prove the clock runs before any timing-sensitive leg.
    const skip = page.getByRole('button', { name: /SKIP TUTORIAL/i });
    if (await skip.isVisible({ timeout: 5000 }).catch(() => false)) await skip.click();
    await waitFor('clock runs', async () => {
      const t0 = await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.time);
      await page.waitForTimeout(1500);
      const t1 = await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.time);
      return t1 > t0;
    }, 30_000);
  };

  type Spot = { id: string; kind: string; index: number; mapSeed: number; x: number; y: number; z: number };
  const nodeSpots = (): Promise<Spot[]> => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const stations = X.craftingTest.liveStations().stations as any[];
    return nodes
      .filter((n: any) => stations.every((s: any) =>
        Math.hypot(s.root.position.x - n.root.position.x, s.root.position.z - n.root.position.z) > 5))
      .map((n: any) => {
        const parts = (n.interactable.id as string).split('-');
        return {
          id: n.interactable.id, kind: n.kind,
          mapSeed: parseInt(parts[2], 16), index: parseInt(parts[3], 10),
          x: n.root.position.x, y: n.root.position.y, z: n.root.position.z,
        };
      });
  });
  const rosterSig = (): Promise<string> => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return (X.gatheringTest.liveManager().nodes as any[])
      .map((n: any) => `${n.kind}@${n.root.position.x.toFixed(3)},${n.root.position.z.toFixed(3)}`)
      .sort().join(';');
  });
  const nodeState = (id: string): Promise<{ depleted: boolean; state: string; remaining: number; enabled: boolean } | null> => page.evaluate((id) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const n = (X.gatheringTest.liveManager().nodes as any[]).find((m: any) => m.interactable.id === id);
    return n ? { depleted: n.isDepleted, state: n.nodeState, remaining: n.regrowRemaining, enabled: n.interactable.enabled } : null;
  }, id);
  const invCount = (id: string): Promise<number> => page.evaluate((id) =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.itemKit.inventory.count(id), id);
  const promptedId = (): Promise<string | null> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__
      .gatheringTest.liveSession()?.promptedNode?.interactable.id ?? null);
  const nodeDefs = (): Promise<Record<string, { yieldBase: number; yieldVariance: number; respawnSeconds: number; materialId: string }>> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.gatheringTest.NODE_DEFS);
  const markers = (): Promise<Array<{ id: string; kind: string; x: number; z: number }>> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.minimap.gatheringMarkers());

  /**
   * Fast-forward a respawn wait through the engine's own step() — the
   * exact function the RAF loop calls (10 substeps per call in testMode,
   * so step(1) advances 10s of game time per rendered frame). Rationale:
   * SwiftShader renders this scene at ~0.3fps here, so 45s of game time
   * would take ~11 min of passive waiting per regrow leg; the lifecycle
   * code (collapse / await / regrow / re-register) is the real code,
   * only the wall-clock rate is accelerated. The live loop is proven to
   * drive the lifecycle first (the 'awaiting' waits below), and every
   * re-harvest still goes through the real [E] prompt path.
   */
  const fastForwardUntilLive = async (id: string) => {
    for (let i = 0; i < 12; i++) {
      const st = await nodeState(id);
      if (st !== null && !st.depleted && st.enabled) return;
      await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        (X.engine as unknown as { step(dt: number): void }).step(1);
      });
    }
    const st = await nodeState(id);
    expect(st !== null && !st.depleted && st.enabled, 'node regrows via fast-forward').toBe(true);
  };

  /** Teleport next to a node, wait for its prompt, press E, return the inventory delta.
   * The prompt arbitrates by nearest eligible, so a fixed +1.5m offset can
   * land closer to a neighboring node than to the target (observed: ore-8
   * beating fiber-15). Try the offset away from the nearest neighbor first,
   * then the four cardinals, until the intended node prompts. */
  const harvestViaPrompt = async (spot: Spot): Promise<number> => {
    const material = defs[spot.kind].materialId;
    const roster = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return (X.gatheringTest.liveManager().nodes as any[])
        .map((n: any) => ({ id: n.interactable.id, x: n.root.position.x, z: n.root.position.z }));
    });
    const others = roster.filter((n) => n.id !== spot.id);
    let nearest = others[0];
    for (const n of others) {
      if (Math.hypot(n.x - spot.x, n.z - spot.z) < Math.hypot(nearest.x - spot.x, nearest.z - spot.z)) nearest = n;
    }
    const away: [number, number] = nearest
      ? [spot.x - nearest.x, spot.z - nearest.z]
      : [1, 0];
    const alen = Math.hypot(away[0], away[1]) || 1;
    const offsets: Array<[number, number]> = [
      [away[0] / alen * 1.5, away[1] / alen * 1.5],
      [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5],
    ];
    let prompted = false;
    for (const [dx, dz] of offsets) {
      await page.evaluate(([x, y, z]) => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        const V = X.engine.camera.position.constructor;
        X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x, y, z));
      }, [spot.x + dx, spot.y + 1, spot.z + dz]);
      for (let i = 0; i < 8; i++) {
        if ((await promptedId()) === spot.id) { prompted = true; break; }
        await page.waitForTimeout(2000);
      }
      if (prompted) break;
    }
    expect(prompted, `intended node prompts: ${spot.id}`).toBe(true);
    const before = await invCount(material);
    await page.keyboard.press('e');
    await waitFor(`material lands (${spot.kind})`, async () => (await invCount(material)) > before, 25_000);
    return (await invCount(material)) - before;
  };

  // ---- boot 1: roster + exact harvest -------------------------------------
  await boot();
  const sig1 = await rosterSig();
  expect(sig1.length, 'roster respawned').toBeGreaterThan(0);
  const defs = await nodeDefs();
  const spots = await nodeSpots();
  const herb = spots.find((s) => s.kind === 'herb');
  const crystal = spots.find((s) => s.kind === 'crystal');
  expect(herb, 'a herb patch spawns away from stations').toBeDefined();
  expect(crystal, 'a crystal cluster spawns away from stations').toBeDefined();

  // exact grants: oracle replication of the per-node rng draw order
  for (const spot of [herb!, crystal!]) {
    const delta = await harvestViaPrompt(spot);
    const expected = oracleYield(spot.mapSeed, spot.index, spot.kind, defs);
    expect(delta, `exact grant for ${spot.kind} node ${spot.index}`).toBe(expected);
    const st = await nodeState(spot.id);
    expect(st, `nodeState present for ${spot.kind} ${spot.id}`).not.toBeNull();
    expect(st?.depleted, 'node depletes on harvest').toBe(true);
  }

  // ---- minimap markers: live + revealed marked, depleted not ------------
  // teleport next to a fresh live node: its tile reveals, so it marks
  const fresh = (await nodeSpots()).find((s) => s.kind === 'ore');
  expect(fresh).toBeDefined();
  await page.evaluate(([x, y, z]) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const V = X.engine.camera.position.constructor;
    X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
  }, [fresh!.x, fresh!.y, fresh!.z]);
  await page.waitForTimeout(3000); // ticks reveal the tile + refresh the scan
  const marks = await markers();
  // Identity-based, not positional: a second live node may sit within 2m
  // of the harvested one, so proximity alone cannot prove the depleted
  // node is unmarked.
  expect(marks.some((m) => m.id === fresh!.id), 'live revealed node is marked').toBe(true);
  expect(marks.some((m) => m.id === herb!.id), 'depleted node is NOT marked').toBe(false);

  // ---- regrow per table: the herb node comes back and pays again --------
  // The live loop drives the collapse first (awaiting proves the loop,
  // not just the synchronous harvest, moved the node), and the remaining
  // wait reads the table value (45s) — then fast-forward the wait itself.
  await waitFor('herb node collapses via live loop', async () =>
    (await nodeState(herb!.id))?.state === 'awaiting', 120_000);
  const herbWait = (await nodeState(herb!.id))!.remaining;
  expect(herbWait, 'herb wait equals the table respawn (45s)').toBeGreaterThan(40);
  expect(herbWait, 'herb wait equals the table respawn (45s)').toBeLessThanOrEqual(defs.herb.respawnSeconds);
  await fastForwardUntilLive(herb!.id);
  const delta2 = await harvestViaPrompt(herb!);
  expect(delta2, 'regrown herb node grants again').toBe(oracleYield(herb!.mapSeed, herb!.index, 'herb', defs));

  // ---- portal re-entry preserves node state ------------------------------
  // harvest a second herb node, then run the exact departure/arrival
  // functions (portalEntities.despawnAll / spawnForMap) for its map seed
  const herb2 = (await nodeSpots()).find((s) => s.kind === 'herb' && s.id !== herb!.id);
  expect(herb2, 'a second herb patch for the portal leg').toBeDefined();
  await harvestViaPrompt(herb2!);
  await waitFor('herb2 collapses via live loop', async () => (await nodeState(herb2!.id))?.state === 'awaiting', 120_000);
  await page.evaluate((seed) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.engine.portalEntities.despawnAll();
    X.engine.portalEntities.spawnForMap(seed);
    // keep the prompt field clean after the arrival respawn
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
  }, herb2!.mapSeed);
  expect(await rosterSig(), 'portal round-trip preserves the identical roster').toBe(sig1);
  const afterTrip = await nodeState(herb2!.id);
  expect(afterTrip?.depleted, 'portal trip preserves the depleted state').toBe(true);
  expect(afterTrip!.remaining, 'remaining wait preserved (not reset, not live)').toBeGreaterThan(0);
  expect(afterTrip!.remaining, 'remaining wait never exceeds the table value').toBeLessThanOrEqual(defs.herb.respawnSeconds);
  await fastForwardUntilLive(herb2!.id);
  const delta3 = await harvestViaPrompt(herb2!);
  expect(delta3, 'portal-preserved node grants after regrow').toBe(oracleYield(herb2!.mapSeed, herb2!.index, 'herb', defs));

  // ---- boot 2 (same spec): identical roster ------------------------------
  await boot();
  expect(await rosterSig(), 'second boot reproduces the identical roster').toBe(sig1);

  // ---- mobile leg: harvest at 360x780 ------------------------------------
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  const mobileSpot = (await nodeSpots()).find((s) => s.kind === 'fiber');
  expect(mobileSpot, 'a fiber thicket for the mobile leg').toBeDefined();
  const mDelta = await harvestViaPrompt(mobileSpot!);
  expect(mDelta, 'mobile harvest grants the exact fiber yield')
    .toBe(oracleYield(mobileSpot!.mapSeed, mobileSpot!.index, 'fiber', defs));

  expect(errors).toEqual([]);
});
