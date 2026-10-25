/**
 * Tutorial wave — data-driven first-run tutorial, desktop + 360x780.
 *
 * Desktop leg (full path, real actions only):
 *   boot with custom.tutorial.mode='force' on the deterministic "Forgotten
 *   Valley" tp-action scene (seed 20261012) + portals enabled -> the
 *   tutorial card shows STEP 1/7 MOVE -> injected 'forward' walks 6 m ->
 *   input.look nudge turns the camera -> input.tap('attack') swings (real
 *   melee path, enemy alive) -> kill the enemy via the real damage->die
 *   path, walk onto a drop (magnet/collect -> onPickup) -> harvest nodes
 *   via the real [E] prompt path until an equippable recipe is craftable,
 *   craft it at a workbench through the real panel (DOM click), equip the
 *   output via the real inventory.equip() path -> harvest/craft a second
 *   recipe -> walk through a real portal (teleport near the edge, steer
 *   camYaw, hold injected forward, PortalTrigger fires) -> tutorial done,
 *   Profile.tutorialSeen persisted, card gone.
 *   Zero console/page errors throughout.
 *
 * Mobile leg (360x780, dismiss path): fresh profile boots with the card
 * showing, the SKIP TUTORIAL button is really clicked, the seen flag
 * persists, and a reload never replays the tutorial.
 *
 * Hardening notes (per workers-npcs/INSTANCING.md caveat 6 and the
 * crafting/items-loot specs): all waits poll from Node in a loop (RAF
 * polling is unreliable here); level-up modals pause the engine so every
 * wait dismisses button.lvlopt first; the corpse tumble is short-circuited
 * (it runs at ~5% wall-clock speed under SwiftShader).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

// Same deterministic scene, plus: an empty item table (ensureCraftingItemDefs
// fills it at boot — inventory + stations + recipes), tutorial forced on for
// the test, portals enabled so the portal step is real.
const makeB64 = (tutorialMode: string) => {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  spec.custom.tutorial = { mode: tutorialMode };
  spec.world.portals = { enabled: true };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = makeB64('force');
// auto mode: the production path — the seen flag is the only replay gate.
const B64_AUTO = makeB64('auto');

type XAny = { __XANDRIA__?: any };

async function waitFor(page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(2000);
  }
}

async function dismissLevelUp(page: any) {
  const n: number = await page.evaluate(() => document.querySelectorAll('button.lvlopt').length);
  if (n > 0) {
    await page.evaluate(() => (document.querySelector('button.lvlopt') as HTMLButtonElement).click());
  }
}

async function boot(page: any, b64: string = B64) {
  await page.goto(`/player.html?spec=${encodeURIComponent(b64)}&test=1&autostart=1&splash=0`);
  await waitFor(page, 'boot', () => page.evaluate(() => {
    const X = (window as unknown as XAny).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing'
      && X.engine.portalsPlayerAvatar && X.engine.portalManager
      && X?.gatheringTest && X?.craftingTest && X?.lootTest
      && X?.tutorialTest?.live?.()?.active);
  }), 240_000);
}

const stepId = (page: any): Promise<string | null> =>
  page.evaluate(() => (window as unknown as XAny).__XANDRIA__.tutorialTest.live().stepId);

const cardLabel = (page: any): Promise<string | null> =>
  page.evaluate(() => document.querySelector('.tutcard .tutlabel')?.textContent ?? null);

async function waitStep(page: any, id: string, timeoutMs = 120_000) {
  await waitFor(page, `tutorial step ${id}`, async () => {
    await dismissLevelUp(page);
    return (await stepId(page)) === id;
  }, timeoutMs);
}

test('tutorial: full guided path move->look->attack->loot->equip->craft->portal, desktop', async ({ page }) => {
  test.setTimeout(1_800_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await boot(page);
  expect(await stepId(page)).toBe('move');
  expect(await cardLabel(page)).toContain('STEP 1/7');

  // ---- move: real forward input, 6 m ----
  await page.evaluate(() => {
    (window as unknown as XAny).__XANDRIA__!.engine.input.inject(['forward'], null);
  });
  await waitStep(page, 'look');
  await page.evaluate(() => {
    (window as unknown as XAny).__XANDRIA__!.engine.input.inject([], null);
  });
  expect(await cardLabel(page)).toContain('STEP 2/7');

  // ---- look: nudge the real look accumulator in small increments.
  // The manager snapshots its yaw/pitch baseline on the first tick after
  // the step starts, so a single blind nudge can be consumed by a frame
  // BEFORE that baseline exists (then nothing ever accumulates). Small
  // repeated nudges guarantee post-baseline accumulation (0.0026 rad/px).
  for (let i = 0; i < 20 && (await stepId(page)) !== 'attack'; i++) {
    await page.evaluate(() => {
      (window as unknown as XAny).__XANDRIA__!.engine.input.look.x += 60;
    });
    await page.waitForTimeout(1500);
  }
  await waitStep(page, 'attack');
  expect(await cardLabel(page)).toContain('STEP 3/7');

  // ---- attack: real attack edge -> melee swing -> onAttack. Re-tap if the
  // edge was consumed while paused (level-up modal); each tap is a real
  // swing through the melee path.
  for (let i = 0; i < 6 && (await stepId(page)) !== 'loot'; i++) {
    await dismissLevelUp(page);
    await page.evaluate(() => {
      (window as unknown as XAny).__XANDRIA__!.engine.input.tap('attack');
    });
    await page.waitForTimeout(3000);
  }
  await waitStep(page, 'loot');

  // ---- loot: kill the enemy via the real damage->die path, collect a drop ----
  const drops = await page.evaluate(() => {
    const X = (window as unknown as XAny).__XANDRIA__;
    const M = X.lootTest.liveManager();
    const W = X.lootTest.liveItemWorld();
    const before = W.liveItems.length;
    const victim = M.enemies.find((e: any) => e.alive);
    if (!victim) throw new Error('no live enemy to kill');
    (window as unknown as any).__VICTIM__ = victim;
    victim.damage(99999);
    if (victim.corpseT > 0.01) victim.corpseT = 0.01; // short-circuit the slow tumble
    return W.liveItems.slice(before).map((i: any) => ({
      itemId: i.id as string,
      x: i.mesh.position.x as number, y: i.mesh.position.y as number, z: i.mesh.position.z as number,
    }));
  });
  expect(drops.length, 'the kill dropped loot').toBeGreaterThan(0);
  // clean prompt field for the later harvest/craft legs (NPC/enemy prompts
  // would rival the node/station pills); the bot is unkillable for the test
  await page.evaluate(() => {
    const X = (window as unknown as XAny).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
  const invCount = (id: string): Promise<number> => page.evaluate((itemId: string) =>
    (window as unknown as XAny).__XANDRIA__.blueprint.itemKit.inventory.count(itemId), id);
  const panelOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-crafting-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });
  const promptedNodeId = (): Promise<string | null> => page.evaluate(() =>
    (window as unknown as XAny).__XANDRIA__.gatheringTest.liveSession()?.promptedNode?.interactable.id ?? null);
  const nodeSpots = await page.evaluate(() => {
    const X = (window as unknown as XAny).__XANDRIA__;
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const stations = X.craftingTest.liveStations().stations as any[];
    return nodes
      .filter((n: any) => stations.every((s: any) =>
        Math.hypot(s.root.position.x - n.root.position.x, s.root.position.z - n.root.position.z) > 5))
      .map((n: any) => ({
        id: n.interactable.id,
        material: ({ ore: 'mat_ore', fiber: 'mat_fiber', scrap: 'mat_scrap' } as any)[n.kind],
        x: n.root.position.x, y: n.root.position.y, z: n.root.position.z,
      }));
  });
  expect(nodeSpots.length).toBeGreaterThan(0);

  // Targeted harvest planner: pick the recipe with the fewest missing
  // HARVESTABLE materials, then harvest one node of the most-missing kind.
  // Each iteration is one node visit, so the loop is bounded and fast.
  // Pick the bench FIRST: prefer the workbench, fall back to whatever
  // station the map spawned. The planner must use THIS station's contract
  // id — the panel anchors to the pressed station and disables every
  // recipe gated to a different one.
  const chooseBench = (): Promise<{ x: number; y: number; z: number; stationId: string }> =>
    page.evaluate(() => {
      const X = (window as unknown as XAny).__XANDRIA__;
      const stations = X.craftingTest.liveStations().stations as any[];
      const s = stations.find((st: any) => st.stationId === 'station_workbench') ?? stations[0];
      if (!s) throw new Error('no crafting stations in this map');
      return { x: s.root.position.x, y: s.root.position.y, z: s.root.position.z, stationId: s.stationId };
    });
  type CraftPlan = { id: string; out: string; slot: string | null; missing: Array<{ material: string; need: number }> };
  const HARVESTABLE = new Set(['mat_ore', 'mat_fiber', 'mat_scrap']);
  const planCraft = (equippableOnly: boolean, stationId: string): Promise<CraftPlan | null> =>
    page.evaluate(([eqOnly, stId]) => {
      const X = (window as unknown as XAny).__XANDRIA__;
      const CT = X.craftingTest;
      const pool = CT.buildRecipePool(X.spec);
      const inv = X.blueprint.itemKit.inventory;
      const defs = X.spec.custom.items.defs;
      // Mirror the crafting panel's verdict inputs exactly (same level,
      // same skills, same anchored station) so a planned recipe's CRAFT
      // button is guaranteed enabled when the panel opens at this bench.
      const prog = X.blueprint.prog;
      const opts = {
        inventory: inv, defs, enabled: true,
        playerLevel: prog ? prog.level : 1,
        skills: X.blueprint.skills ?? null,
        stations: new Set([stId]),
      };
      let best: any = null;
      for (const r of pool) {
        if (eqOnly && !defs[r.output.itemId]?.slot) continue;
        const verdict = CT.checkCraft(pool, r.id, opts);
        // Only missing-ingredients is harvestable. Anything else
        // (missing-station, min-level, no-room, ...) can never become
        // craftable by harvesting — skip it, or the panel's CRAFT button
        // stays disabled and the click below deadlocks.
        if (!verdict.ok && verdict.reason !== 'missing-ingredients') continue;
        if (verdict.ok) return { id: r.id, out: r.output.itemId, slot: defs[r.output.itemId]?.slot ?? null, missing: [] };
        const missing = (verdict.missing ?? [])
          .filter((m: any) => ['mat_ore', 'mat_fiber', 'mat_scrap'].includes(m.itemId))
          .map((m: any) => ({ material: m.itemId, need: m.need }));
        if (missing.length !== (verdict.missing ?? []).length) continue; // needs unharvestable drops
        const total = missing.reduce((a: number, b: any) => a + b.need, 0);
        if (!best || total < best.total) best = { r, total, missing };
      }
      if (!best) return null;
      return { id: best.r.id, out: best.r.output.itemId, slot: defs[best.r.output.itemId]?.slot ?? null, missing: best.missing };
    }, [equippableOnly, stationId] as [boolean, string]);
  // Harvest ONE node of the given material via the real [E] prompt path.
  const harvestOne = async (material: string): Promise<boolean> => {
    const spots = (nodeSpots as any[]).filter((s: any) => s.material === material);
    for (const spot of spots) {
      await page.evaluate(([x, y, z]) => {
        const X = (window as unknown as XAny).__XANDRIA__;
        const V = X.engine.camera.position.constructor;
        X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
      }, [spot.x, spot.y, spot.z]);
      let prompted = false;
      try {
        await waitFor(page, `prompt shows ${spot.id}`, async () => (await promptedNodeId()) === spot.id, 10_000);
        prompted = true;
      } catch { continue; /* stale target or rival won — try next node */ }
      const before = await invCount(material);
      await page.keyboard.press('e');
      try {
        await waitFor(page, `material lands (${material})`, async () => (await invCount(material)) > before, 10_000);
        return true;
      } catch { /* harvest missed — try next node */ }
    }
    return false;
  };
  // Harvest until some (equippable-)recipe is craftable at the chosen
  // bench; bounded iterations.
  const harvestUntil = async (equippableOnly: boolean, stationId: string): Promise<CraftPlan> => {
    for (let i = 0; i < 12; i++) {
      const plan = await planCraft(equippableOnly, stationId);
      if (!plan) throw new Error('harvestUntil: no harvestable recipe candidate');
      if (plan.missing.length === 0) return plan;
      const top = [...plan.missing].sort((a, b) => b.need - a.need)[0];
      const ok = await harvestOne(top.material);
      if (!ok) throw new Error(`harvestUntil: could not harvest ${top.material}`);
    }
    throw new Error('harvestUntil: still missing materials after 12 harvests');
  };

  const craftAtBench = async (plan: CraftPlan, bench: { x: number; y: number; z: number }) => {
    await page.evaluate(([x, y, z]) => {
      const X = (window as unknown as XAny).__XANDRIA__;
      const V = X.engine.camera.position.constructor;
      X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
    }, [bench.x, bench.y, bench.z]);
    await waitFor(page, 'station prompt', async () => {
      const els = await page.evaluate(() => {
        const el = document.querySelector('#xandria-interact-prompt') as HTMLElement | null;
        return el && el.style.display === 'block' ? el.textContent : null;
      });
      return !!els && els.includes('Use ');
    }, 60_000);
    await page.keyboard.press('e');
    await waitFor(page, 'crafting panel opens', panelOpen, 30_000);
    // Stable selector: the panel stamps data-recipe-id on every CRAFT
    // button (the planner only picks recipes whose button is enabled at
    // this bench, so the click must land on an enabled button).
    await page.locator(`#xandria-crafting-panel button[data-recipe-id="${plan.id}"]`).click();
    await waitFor(page, 'crafted output lands', async () => (await invCount(plan.out)) > 0, 60_000);
    await page.keyboard.press('Escape');
    await waitFor(page, 'panel closes', async () => !(await panelOpen()), 30_000);
    return plan;
  };

  // walk onto every drop — the real magnet/collect path fires onPickup.
  // If the kill dropped equippable gear, equip it via the real
  // inventory.equip() path (fast path: no harvest/craft needed for equip).
  const gearDrop = await page.evaluate((ds) => {
    const X = (window as unknown as XAny).__XANDRIA__;
    const defs = X.spec.custom.items.defs;
    const g = ds.find((d: any) => defs[d.itemId]?.slot);
    return g ? { itemId: g.itemId, slot: defs[g.itemId].slot } : null;
  }, drops);
  for (const d of drops) {
    await page.evaluate(([x, y, z]) => {
      const X = (window as unknown as XAny).__XANDRIA__;
      const V = X.engine.camera.position.constructor;
      X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x, y + 1, z));
    }, [d.x, d.y, d.z]);
    await page.waitForTimeout(1500);
  }
  await waitStep(page, 'equip');
  if (gearDrop) {
    const equipped = await page.evaluate(([outId, slot]) => {
      const X = (window as unknown as XAny).__XANDRIA__;
      const inv = X.blueprint.itemKit.inventory;
      const res = inv.equip(outId);
      return { ok: !!res, equipped: inv.getEquipped(slot) };
    }, [gearDrop.itemId, gearDrop.slot]);
    expect(equipped.ok, 'equipped the dropped gear').toBe(true);
    await waitStep(page, 'craft');
  } else {
    // craft #1: equippable (fires while 'equip' is active — correctly ignored).
    // The bench is chosen before planning so the planner only considers
    // recipes whose CRAFT button is enabled at that station.
    const bench = await chooseBench();
    const gearPlan = await harvestUntil(true, bench.stationId);
    const gear = await craftAtBench(gearPlan, bench);
    expect(gear.slot, 'crafted recipe is equippable').toBeTruthy();
    // equip it via the same call the HUD's equip button makes
    const equipped = await page.evaluate(([outId, slot]) => {
      const X = (window as unknown as XAny).__XANDRIA__;
      const inv = X.blueprint.itemKit.inventory;
      const res = inv.equip(outId);
      return { ok: !!res, equipped: inv.getEquipped(slot) };
    }, [gear.out, gear.slot!]);
    expect(equipped.ok).toBe(true);
    expect(equipped.equipped).toBe(gear.out);
    await waitStep(page, 'craft');
  }

  // craft (for real this time — the 'craft' step is active): harvest until
  // any recipe is craftable at the chosen bench, then drive the real panel.
  const bench2 = await chooseBench();
  const craftPlan = await harvestUntil(false, bench2.stationId);
  await craftAtBench(craftPlan, bench2);
  await waitStep(page, 'portal');
  expect(await cardLabel(page)).toContain('STEP 7/7');

  // ---- portal: real traverse — teleport just inside the edge, steer the
  // camera rig to face it, hold injected forward until the trigger fires ----
  await page.evaluate(() => {
    const X = (window as unknown as XAny).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const HALF = 256; // terrain.size 512
    const tx = 100, tz = HALF - 11;
    const y = E.terrain.heightAt(tx, tz) + 3;
    E.streamFocus = new V(tx, y, tz);
    const av = E.portalsPlayerAvatar;
    av.ctrl.teleport(new V(tx, y, tz));
    const want = Math.PI; // walk +z (north)
    let d = (want - av.ctrl.camYaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    E.input.look.x = -d / 0.0026;
  });
  await page.waitForTimeout(8000); // let the look nudge apply
  await page.evaluate(() => {
    (window as unknown as XAny).__XANDRIA__!.engine.input.inject(['forward', 'sprint'], null);
  });
  // sanity: the avatar must actually be moving toward the edge (+z); fail
  // fast with a clear message instead of burning the transition timeout.
  // (If a transition already fired during the walk — arrival inset puts the
  // avatar at z=-136 on the new map — the z check is meaningless; the leg is
  // done and the transition wait below passes immediately.)
  const z0 = await page.evaluate(() => (window as unknown as XAny).__XANDRIA__.engine.portalsPlayerAvatar.ctrl.position.z);
  const t0 = await page.evaluate(() => (window as unknown as XAny).__XANDRIA__.engine.portalManager.transitions);
  await page.waitForTimeout(15000);
  const z1 = await page.evaluate(() => (window as unknown as XAny).__XANDRIA__.engine.portalsPlayerAvatar.ctrl.position.z);
  const t1 = await page.evaluate(() => (window as unknown as XAny).__XANDRIA__.engine.portalManager.transitions);
  if (t1 <= t0) {
    expect(z1, `avatar moving toward the north edge (z0=${z0} z1=${z1})`).toBeGreaterThan(z0 + 1);
  }
  await waitFor(page, 'portal transition', async () => {
    await dismissLevelUp(page);
    return page.evaluate(() => (window as unknown as XAny).__XANDRIA__.engine.portalManager.transitions >= 1);
  }, 300_000);
  await page.evaluate(() => {
    (window as unknown as XAny).__XANDRIA__!.engine.input.inject([], null);
  });

  // ---- done: seen flag persisted, card gone ----
  await waitFor(page, 'tutorial done', async () =>
    page.evaluate(() => (window as unknown as XAny).__XANDRIA__.tutorialTest.live().done === true), 60_000);
  // MERGE (save-slots): the profile now lives in the active slot of
  // xandria.slots.v1 — the legacy xandria.profile.v1 key is migration-only
  // input and is never updated by saves, so it reads stale here.
  const seen = await page.evaluate(() => {
    try {
      const st = JSON.parse(localStorage.getItem('xandria.slots.v1') ?? '{}');
      const active = (st.slots ?? []).find((s: any) => s.id === st.activeSlotId);
      return active?.profile?.tutorialSeen === true;
    } catch { return false; }
  });
  expect(seen, 'tutorialSeen persisted in the profile').toBe(true);
  expect(await page.evaluate(() => document.querySelector('.tutcard')), 'card removed').toBeNull();

  expect(errors).toEqual([]);
});

test('tutorial: dismiss path + reload never replays, 360x780', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.setViewportSize({ width: 360, height: 780 });

  // auto mode: the production replay contract (fresh profile -> unseen)
  await boot(page, B64_AUTO);
  expect(await stepId(page)).toBe('move');
  expect(await cardLabel(page)).toContain('STEP 1/7');

  // the real Skip button. The tutorial card sets pointer-events:auto on
  // its own rule (the .xhud root is pointer-events:none), so this is a
  // genuine user-grade click — no force flag; if the button ever stops
  // being clickable this must fail loudly.
  await page.locator('.tutcard button', { hasText: 'SKIP TUTORIAL' }).click();
  await waitFor(page, 'tutorial dismissed', async () =>
    page.evaluate(() => (window as unknown as XAny).__XANDRIA__.tutorialTest.live().done === true), 30_000);
  // MERGE (save-slots): see the full-path leg — profile lives in the active slot.
  const seen = await page.evaluate(() => {
    try {
      const st = JSON.parse(localStorage.getItem('xandria.slots.v1') ?? '{}');
      const active = (st.slots ?? []).find((s: any) => s.id === st.activeSlotId);
      return active?.profile?.tutorialSeen === true;
    } catch { return false; }
  });
  expect(seen, 'tutorialSeen persisted after dismiss').toBe(true);

  // reload with the seen profile: in auto mode the tutorial must NOT replay
  await page.reload();
  await waitFor(page, 'reboot after reload', () => page.evaluate(() => {
    const X = (window as unknown as XAny).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing' && X?.tutorialTest?.live);
  }), 240_000);
  const mgr = await page.evaluate(() => {
    const m = (window as unknown as XAny).__XANDRIA__.tutorialTest.live();
    return { active: m.active, done: m.done, stepId: m.stepId };
  });
  expect(mgr.active, 'tutorial stays dormant after reload').toBe(false);
  expect(mgr.done).toBe(true);
  expect(await page.evaluate(() => document.querySelector('.tutcard')), 'no card after reload').toBeNull();

  expect(errors).toEqual([]);
});
