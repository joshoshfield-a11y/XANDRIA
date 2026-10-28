/**
 * Quest-waypoints: waypoint presentation for the tracked quest objective.
 *
 * Fixture: npcs.b64 (seed 20261012, tp-action) — the seeded story line is
 * talk -> kill -> craft -> gather, chained (quests.spec.ts).
 *
 * Desktop (1280x720):
 *  1. Accept the talk quest via the REAL dialogue button -> the waypoint
 *     resolves to the EXACT nearest live villager (independently
 *     recomputed in-page in the same evaluate), beacon drawn.
 *  2. Teleport near the waypoint -> its fog tile reveals -> the amber
 *     waypoint diamond paints on the minimap canvas (pixel assertion).
 *  3. Teleport far + face away -> the off-screen compass indicator shows,
 *     with zero intersections against the quest tracker / score / bars /
 *     minimap panel (hud-polish audit convention).
 *  4. Complete the quest (the real onTalk event path, dialogue-open
 *     wiring is proven by quests.spec.ts) -> waypoint clears: beacon
 *     off, compass hidden, minimap marker gone.
 *  5. Switch: turn in + accept the kill quest -> the waypoint switches
 *     to the nearest live enemy of the kill kind, exact position.
 *  6. Portal cycle (the exact despawnAll/spawnForMap functions
 *     PortalTransition invokes) -> the tracked waypoint survives: same
 *     quest, re-resolved to a live enemy on the new roster.
 *  7. Perf: draw-call medians with the waypoint active vs cleared on
 *     the same settled scene (INSTANCING.md method).
 *
 * Mobile (360x780, touch): accept via the manager seam, compass shows
 * off-screen, zero intersections against tracker / touch buttons /
 * minimap chip, waypoint clears on completion.
 *
 * Hardening (quests.spec.ts / workers-npcs INSTANCING.md): the player is
 * teleported to NPCs (never the reverse), all waits poll from Node, and
 * prompt targets are read via the sessions' live handles.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);

type X = { __XANDRIA__?: any };
type Box = { x: number; y: number; w: number; h: number; id: string };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function boot(page: any, errors: string[]): Promise<void> {
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  await waitFor('boot', () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine && X?.questTest && X?.waypointTest && X?.gatheringTest && X?.craftingTest
      && X?.blueprint?.quests && X?.blueprint?.npcs && X?.blueprint?.itemKit
      && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
  // Freeze ALL villagers right after boot (quests.spec.ts pattern):
  // wander would otherwise move the waypoint target between the
  // resolveNow() read and the independent nearest-villager recomputation.
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    for (const n of X.blueprint.npcs.npcs) { n.state = 'idle'; n.stateT = 1e9; }
  });
}

function harness(page: any) {
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  const teleport = (x: number, z: number): Promise<void> => page.evaluate(([x, z]: number[]) => {
    const X = (window as unknown as X).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const y = E.terrain.heightAt(x, z) + 3;
    E.portalsPlayerAvatar.ctrl.teleport(new V(x, y, z));
  }, [x, z]);
  const boxes = (sels: string[]): Promise<Box[]> => page.evaluate((sels: string[]) => {
    const out: Box[] = [];
    for (const s of sels) {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height, id: s });
    }
    return out;
  }, sels);
  return { waitFor, teleport, boxes };
}

const overlapPairs = (list: Box[]): Array<[Box, Box]> => {
  const hits: Array<[Box, Box]> = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + b.h) hits.push([a, b]);
    }
  }
  return hits;
};

/** Dialogue helpers (quests.spec.ts pattern, trimmed to accept-only). */
function dialogue(page: any, h: ReturnType<typeof harness>) {
  const collectVillagers = (): Promise<string[]> => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const npcs = X.blueprint.npcs.npcs.filter((n: any) => n.role === 'villager');
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const stations = X.craftingTest.liveStations().stations as any[];
    const rivals = [...nodes, ...stations].map((r: any) => r.root.position);
    const clearance = (n: any) => Math.min(...rivals.map((p: any) =>
      Math.hypot(p.x - n.position.x, p.z - n.position.z)));
    return npcs.filter((n: any) => clearance(n) > 4).map((n: any) => n.interactable.id);
  });
  const freezeVillagers = (ids: string[]): Promise<void> => page.evaluate((ids: string[]) => {
    const X = (window as unknown as X).__XANDRIA__;
    for (const n of X.blueprint.npcs.npcs) {
      if (ids.includes(n.interactable.id)) { n.state = 'idle'; n.stateT = 1e9; }
    }
  }, ids);
  const teleportNearVillager = (vid: string): Promise<void> => page.evaluate((vid: string) => {
    const X = (window as unknown as X).__XANDRIA__;
    const n = X.blueprint.npcs.npcs.find((n: any) => n.interactable.id === vid);
    const p = n.position;
    const V = X.engine.camera.position.constructor;
    X.engine.portalsPlayerAvatar.ctrl.teleport(new V(p.x + 2, p.y + 1, p.z));
  }, vid);
  const promptedVillager = (): Promise<string | null> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.questTest.liveTalkSession()?.promptedNpc?.interactable.id ?? null);
  const dialogueOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-dialogue-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });
  const clickQuestButton = async (action: string): Promise<void> => {
    await page.locator(`#xandria-dialogue-panel button[data-quest-action="${action}"]`).click();
  };
  const openVillagerDialogue = async (): Promise<string> => {
    const villagers = await collectVillagers();
    expect(villagers.length).toBeGreaterThanOrEqual(1);
    await freezeVillagers(villagers);
    for (let attempt = 0; attempt < 10; attempt++) {
      const vid = villagers[attempt % villagers.length];
      await teleportNearVillager(vid);
      try {
        await h.waitFor('villager talk prompt', async () => {
          const p = await promptedVillager();
          return !!p;
        }, 15_000);
      } catch { continue; }
      await page.keyboard.press('e');
      await h.waitFor('dialogue opens', dialogueOpen, 30_000);
      return (await promptedVillager()) ?? vid;
    }
    throw new Error('openVillagerDialogue: no prompt won after 10 attempts');
  };
  const closeDialogue = async (): Promise<void> => {
    await page.keyboard.press('e');
    await h.waitFor('dialogue closes', async () => !(await dialogueOpen()), 30_000);
  };
  return { collectVillagers, openVillagerDialogue, closeDialogue, clickQuestButton };
}

test('quest-waypoints: accept -> exact waypoint, minimap + compass, complete clears, switch + portal preserve (desktop)', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  await boot(page, errors);
  const h = harness(page);
  const dlg = dialogue(page, h);

  const mgr = {
    status: (id: string): Promise<string> => page.evaluate((id) =>
      (window as unknown as X).__XANDRIA__.questTest.liveManager().statusOf(id), id),
    defs: (): Promise<Array<{ id: string; name: string; objectives: Array<{ id: string; kind: string; target: string; count: number }> }>> =>
      page.evaluate(() => (window as unknown as X).__XANDRIA__.questTest.liveManager().defs
        .map((d: any) => ({ id: d.id, name: d.name, objectives: d.objectives }))),
  };

  const defs = await mgr.defs();
  const talkQuest = defs[0];
  const killQuest = defs[1];
  expect(talkQuest.objectives[0].kind).toBe('talk');
  expect(killQuest.objectives[0].kind).toBe('kill');
  const talkCount = talkQuest.objectives[0].count;
  const killKind = killQuest.objectives[0].target;

  // ---- perf baseline: waypoint cleared, settled view (sampled again
  // after the kill quest activates, at this SAME view, for the pair) ----
  await page.waitForTimeout(20_000);
  const sampleDraws = async (n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(await page.evaluate(() =>
        (window as unknown as X).__XANDRIA__.engine.renderer.info.render.calls));
      await page.waitForTimeout(1500);
    }
    return out;
  };

  // ---- 1. accept via the real dialogue button ----
  await dlg.openVillagerDialogue();
  await dlg.clickQuestButton(`accept:${talkQuest.id}`);
  await h.waitFor('quest accepted', async () => (await mgr.status(talkQuest.id)) === 'active', 30_000);
  await dlg.closeDialogue();

  // ---- 2. waypoint = exact nearest live villager (same-evaluate check) ----
  const wpTalk = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const wp = X.waypointTest.live().resolveNow();
    const pp = X.engine.portalsPlayerAvatar.ctrl.position;
    let best: any = null;
    let bd = Infinity;
    for (const n of X.blueprint.npcs.npcs) {
      if (n.role !== 'villager') continue;
      const d2 = (n.position.x - pp.x) ** 2 + (n.position.z - pp.z) ** 2;
      if (d2 < bd) { bd = d2; best = n; }
    }
    return {
      wp: wp ? { questId: wp.questId, kind: wp.objective.kind, x: wp.position.x, y: wp.position.y, z: wp.position.z } : null,
      nearest: best ? { x: best.position.x, y: best.position.y, z: best.position.z } : null,
      beacon: X.waypointTest.live().beaconVisible,
    };
  });
  console.log('[waypoints] talk waypoint: ' + JSON.stringify(wpTalk));
  expect(wpTalk.wp, 'waypoint resolves after accept').toBeTruthy();
  expect(wpTalk.wp!.kind).toBe('talk');
  expect(wpTalk.wp!.questId).toBe(talkQuest.id);
  expect(Math.abs(wpTalk.wp!.x - wpTalk.nearest!.x), 'waypoint x = nearest villager').toBeLessThan(0.5);
  expect(Math.abs(wpTalk.wp!.z - wpTalk.nearest!.z), 'waypoint z = nearest villager').toBeLessThan(0.5);
  expect(wpTalk.beacon, 'in-world beacon drawn').toBe(true);

  // ---- 3. minimap marker: teleport near the waypoint, fog reveals, pixel check ----
  await h.teleport(wpTalk.wp!.x + 30, wpTalk.wp!.z);
  await h.waitFor('minimap waypoint marker paints', () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const live = X.waypointTest.live();
    const wp = live.current;
    if (!wp) return false;
    const M = X.engine.minimap;
    const state = M.fogStateFor(M.activeKey);
    if (!state || !state.fog.isRevealed(wp.position.x, wp.position.z)) return false;
    const half = 256, W = 208;
    const px = ((wp.position.x + half) / (half * 2)) * W;
    const py = ((half - wp.position.z) / (half * 2)) * W;
    const canvas = document.querySelector('#xandria-minimap canvas') as HTMLCanvasElement;
    if (!canvas) return false;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.getImageData(Math.max(0, Math.floor(px) - 7), Math.max(0, Math.floor(py) - 7), 15, 15);
    let amber = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (r > 200 && g >= 120 && g <= 220 && b < 120) amber++;
    }
    return amber > 0;
  }), 180_000);

  // ---- 4. compass: stand 200m to the SIDE of the waypoint (perpendicular
  // to the camera's real forward — the rig owns view yaw, ctrl.camYaw
  // is a stale setup snapshot) so the waypoint projects off-screen.
  const far = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const wp = X.waypointTest.live().current!;
    const V = X.engine.camera.position.constructor;
    const dir = X.engine.camera.getWorldDirection(new V(0, 0, 0));
    dir.y = 0; dir.normalize();
    // Perpendicular candidates; take the one with more arena room.
    const cands = [
      { x: wp.position.x - dir.z * 200, z: wp.position.z + dir.x * 200 },
      { x: wp.position.x + dir.z * 200, z: wp.position.z - dir.x * 200 },
    ].map((c) => ({ x: Math.max(-240, Math.min(240, c.x)), z: Math.max(-240, Math.min(240, c.z)) }));
    cands.sort((a, b) =>
      (Math.hypot(b.x - wp.position.x, b.z - wp.position.z) - Math.hypot(a.x - wp.position.x, a.z - wp.position.z)));
    return { tx: cands[0].x, tz: cands[0].z, wx: wp.position.x, wz: wp.position.z };
  });
  await h.teleport(far.tx, far.tz);
  await h.waitFor('compass shows off-screen', () => page.evaluate(() => {
    const s = (window as unknown as X).__XANDRIA__.waypointTest.live().compassState();
    return !!s && s.visible;
  }), 180_000);
  const compassBoxes = await h.boxes([
    '#xandria-compass',
    '#xandria-quest-tracker',
    '.xhud .score',
    '.xhud .bars',
    '#xandria-minimap .mbox',
  ]);
  console.log('[waypoints] compass boxes: ' + JSON.stringify(compassBoxes));
  const compassBox = compassBoxes.find((b) => b.id === '#xandria-compass');
  expect(compassBox, 'compass element laid out').toBeTruthy();
  // Only pairs involving the compass count: the tracker and the score
  // panel already overlap each other in the base HUD (pre-existing).
  const hits = overlapPairs(compassBoxes).filter(([a, b]) =>
    a.id === '#xandria-compass' || b.id === '#xandria-compass');
  expect(hits, 'compass intersects no HUD chip, got: ' + JSON.stringify(hits)).toEqual([]);
  const compassDist = await page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.waypointTest.live().compassState()?.distanceM ?? 0);
  expect(compassDist, 'compass distance is the real player->waypoint distance').toBeGreaterThan(100);

  // ---- 5. complete -> waypoint clears everywhere ----
  await page.evaluate((count) => {
    const X = (window as unknown as X).__XANDRIA__;
    const M = X.questTest.liveManager();
    for (let i = 0; i < count; i++) M.onTalk('villager');
  }, talkCount);
  await h.waitFor('talk quest complete', async () => (await mgr.status(talkQuest.id)) === 'complete', 30_000);
  const cleared = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const live = X.waypointTest.live();
    live.resolveNow();
    const s = live.compassState();
    return {
      current: live.current,
      beacon: live.beaconVisible,
      compassVisible: s?.visible ?? false,
      minimapMarker: live.minimapMarker(),
    };
  });
  console.log('[waypoints] after complete: ' + JSON.stringify(cleared));
  expect(cleared.current, 'waypoint clears on completion').toBeNull();
  expect(cleared.beacon, 'beacon off on completion').toBe(false);
  expect(cleared.compassVisible, 'compass hidden on completion').toBe(false);
  expect(cleared.minimapMarker, 'minimap marker gone on completion').toBeNull();

  // ---- perf pair at ONE settled view: cleared sample here (waypoint
  // off), then turn in + accept the kill quest and sample active at
  // the identical camera view — no teleports between the two samples,
  // so the delta isolates the beacon's 2 instanced meshes. ----
  const drawsCleared = median(await sampleDraws(10));
  await page.evaluate((id) => {
    const X = (window as unknown as X).__XANDRIA__;
    X.questTest.liveManager().turnIn(id);
  }, talkQuest.id);
  await h.waitFor('kill quest available', async () => (await mgr.status(killQuest.id)) === 'available', 30_000);
  await page.evaluate((id) => {
    const X = (window as unknown as X).__XANDRIA__;
    X.questTest.liveManager().accept(id);
  }, killQuest.id);
  await h.waitFor('kill quest active', async () => (await mgr.status(killQuest.id)) === 'active', 30_000);
  const drawsActive = median(await sampleDraws(10));
  console.log(`[waypoints] perf draws median: cleared=${drawsCleared} active=${drawsActive} delta(active-cleared)=${drawsActive - drawsCleared}`);
  expect(drawsActive - drawsCleared, 'beacon draw delta is the 2 instanced meshes, within SwiftShader noise').toBeLessThanOrEqual(6);
  expect(drawsActive - drawsCleared, 'beacon actually draws when active').toBeGreaterThanOrEqual(-2);

  // ---- 6. switch: the waypoint follows the newly active kill quest ----
  const wpKill = await page.evaluate(([kind]) => {
    const X = (window as unknown as X).__XANDRIA__;
    const wp = X.waypointTest.live().resolveNow();
    const M = X.engine.portalsPlayerAvatar.enemies;
    const pp = X.engine.portalsPlayerAvatar.ctrl.position;
    let best: any = null;
    let bd = Infinity;
    for (const e of M.enemies) {
      if (!e.alive || e.spec.kind !== kind) continue;
      const d2 = (e.position.x - pp.x) ** 2 + (e.position.z - pp.z) ** 2;
      if (d2 < bd) { bd = d2; best = e; }
    }
    return {
      wp: wp ? { questId: wp.questId, kind: wp.objective.kind, x: wp.position.x, z: wp.position.z } : null,
      nearest: best ? { x: best.position.x, z: best.position.z } : null,
    };
  }, [killKind]);
  console.log('[waypoints] kill waypoint: ' + JSON.stringify(wpKill));
  expect(wpKill.wp, 'waypoint switches to the kill quest').toBeTruthy();
  expect(wpKill.wp!.kind).toBe('kill');
  expect(wpKill.wp!.questId).toBe(killQuest.id);
  expect(wpKill.nearest, 'a live enemy of the kill kind exists').toBeTruthy();
  expect(Math.abs(wpKill.wp!.x - wpKill.nearest!.x), 'kill waypoint x = nearest enemy').toBeLessThan(1.5);
  expect(Math.abs(wpKill.wp!.z - wpKill.nearest!.z), 'kill waypoint z = nearest enemy').toBeLessThan(1.5);

  // ---- 7. portal cycle preserves the tracked waypoint (re-resolved) ----
  const beforeCycle = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return { questId: X.waypointTest.live().current?.questId ?? null };
  });
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const systems = X.engine.portalEntities.systems as Array<{ id: string; despawnAll(): void; spawnForMap(s: number): void }>;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.spawnForMap(X.spec.meta.seed);
  });
  const afterCycle = await page.evaluate(([kind]) => {
    const X = (window as unknown as X).__XANDRIA__;
    const wp = X.waypointTest.live().resolveNow();
    const M = X.engine.portalsPlayerAvatar.enemies;
    const pp = X.engine.portalsPlayerAvatar.ctrl.position;
    let best: any = null;
    let bd = Infinity;
    for (const e of M.enemies) {
      if (!e.alive || e.spec.kind !== kind) continue;
      const d2 = (e.position.x - pp.x) ** 2 + (e.position.z - pp.z) ** 2;
      if (d2 < bd) { bd = d2; best = e; }
    }
    return {
      wp: wp ? { questId: wp.questId, kind: wp.objective.kind, x: wp.position.x, z: wp.position.z } : null,
      nearest: best ? { x: best.position.x, z: best.position.z } : null,
      status: X.questTest.liveManager().statusOf(wp?.questId ?? ''),
    };
  }, [killKind]);
  console.log('[waypoints] after portal cycle: ' + JSON.stringify(afterCycle));
  expect(afterCycle.wp, 'waypoint survives the portal cycle').toBeTruthy();
  expect(afterCycle.wp!.questId, 'same tracked quest after the cycle').toBe(beforeCycle.questId);
  expect(afterCycle.status).toBe('active');
  expect(afterCycle.nearest, 'enemies respawned on the new roster').toBeTruthy();
  expect(Math.abs(afterCycle.wp!.x - afterCycle.nearest!.x)).toBeLessThan(1.5);
  expect(Math.abs(afterCycle.wp!.z - afterCycle.nearest!.z)).toBeLessThan(1.5);

  await page.screenshot({ path: resolve(HERE, 'screenshots/quest-waypoints-desktop.png') });
  expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
});

test.describe('mobile 360x780', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('quest-waypoints: compass clear of tracker + touch buttons, clears on complete', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    await boot(page, errors);
    const h = harness(page);
    const defs = await page.evaluate(() =>
      (window as unknown as X).__XANDRIA__.questTest.liveManager().defs
        .map((d: any) => ({ id: d.id, objectives: d.objectives })));
    const talkQuest = defs[0];
    const talkCount = talkQuest.objectives[0].count;
    await page.evaluate((id) => {
      const X = (window as unknown as X).__XANDRIA__;
      X.questTest.liveManager().accept(id);
    }, talkQuest.id);
    await h.waitFor('waypoint resolves on mobile', () => page.evaluate(() =>
      !!(window as unknown as X).__XANDRIA__.waypointTest.live().resolveNow()), 120_000);

    // Stand 200m to the SIDE of the waypoint (perpendicular to the
    // camera's real forward — the rig owns view yaw) so it projects
    // off-screen and the compass shows.
    const far = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const wp = X.waypointTest.live().current!;
      const V = X.engine.camera.position.constructor;
      const dir = X.engine.camera.getWorldDirection(new V(0, 0, 0));
      dir.y = 0; dir.normalize();
      const cands = [
        { x: wp.position.x - dir.z * 200, z: wp.position.z + dir.x * 200 },
        { x: wp.position.x + dir.z * 200, z: wp.position.z - dir.x * 200 },
      ].map((c) => ({ x: Math.max(-240, Math.min(240, c.x)), z: Math.max(-240, Math.min(240, c.z)) }));
      cands.sort((a, b) =>
        (Math.hypot(b.x - wp.position.x, b.z - wp.position.z) - Math.hypot(a.x - wp.position.x, a.z - wp.position.z)));
      return { tx: cands[0].x, tz: cands[0].z };
    });
    await h.teleport(far.tx, far.tz);
    await h.waitFor('compass shows on mobile', () => page.evaluate(() => {
      const s = (window as unknown as X).__XANDRIA__.waypointTest.live().compassState();
      return !!s && s.visible;
    }), 180_000);
    const boxes = await h.boxes([
      '#xandria-compass',
      '#xandria-quest-tracker',
      '.xtouch .pausebtn',
      '.xtouch .tbtn',
      '#xandria-minimap .mchip',
      '.xhud .bars',
    ]);
    console.log('[waypoints] mobile boxes: ' + JSON.stringify(boxes));
    const hits = overlapPairs(boxes).filter(([a, b]) =>
      a.id === '#xandria-compass' || b.id === '#xandria-compass');
    expect(hits, 'compass intersects nothing on 360x780, got: ' + JSON.stringify(hits)).toEqual([]);
    await page.screenshot({ path: resolve(HERE, 'screenshots/quest-waypoints-mobile.png') });

    // Complete -> clears.
    await page.evaluate(([id, count]) => {
      const X = (window as unknown as X).__XANDRIA__;
      const M = X.questTest.liveManager();
      for (let i = 0; i < count; i++) M.onTalk('villager');
      return M.statusOf(id);
    }, [talkQuest.id, talkCount]);
    await h.waitFor('quest complete on mobile', () => page.evaluate((id) =>
      (window as unknown as X).__XANDRIA__.questTest.liveManager().statusOf(id) === 'complete', talkQuest.id), 30_000);
    const cleared = await page.evaluate(() => {
      const live = (window as unknown as X).__XANDRIA__.waypointTest.live();
      live.resolveNow();
      return { current: live.current, beacon: live.beaconVisible };
    });
    expect(cleared.current).toBeNull();
    expect(cleared.beacon).toBe(false);
    expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
  });
});
