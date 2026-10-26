/**
 * Mounts wave — summon/dismiss via panel + hotkey, exact speed scalars,
 * stamina drain/regen per the tuning table, dismiss + reload + portal
 * preservation, and the INSTANCING.md perf leg.
 *
 * Flow (desktop): boot the deterministic "Forgotten Valley" scene (seed
 * 20261012, tp-action, 512m walled arena) with an empty custom.items table
 * -> despawn NPCs/enemies for a clean field -> N opens the mounts panel
 * (real key handler), 3 mount cards render -> click Summon on Swift
 * Strider (real DOM click) -> speed asserted exactly: on-foot velocity
 * median vs mounted velocity median, ratio 1.5 within tolerance, and
 * ctrl.speedScalar === 1.5 -> stamina drains at 8/s while moving and
 * regens at 15/s while idle, per engine.time -> Dismiss restores speed
 * 1.0 -> Escape close + pause/resume dance (shared panel behavior).
 * Reload leg: summon beetle, page.reload, profile restores the ride.
 * Portal leg (8km fixture): summon strider, cross north and back south —
 * the mount survives travel (avatar persists; manager is player-scoped,
 * never a portal entity).
 * Perf leg: A/B/A renderer.info.render.calls median, same view, dismissed
 * vs summoned vs dismissed, plus shared-instancer bucket delta.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the player is
 * teleported to open ground (never the reverse), all waits poll from
 * Node, all movement assertions key off engine.time, never wall time.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();
const PORTAL_RAW = readFileSync(
  '/home/hatch/workspace/xandria/qa/openworld/workers-portals/portal-8km.b64', 'utf8').trim();

const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);
const PORTAL_B64 = withItems(PORTAL_RAW);

const URL = `/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`;
const PORTAL_URL = `/player.html?spec=${encodeURIComponent(PORTAL_B64)}&test=1&autostart=1&splash=0`;

type X = { __XANDRIA__?: any };

const waitFor = async (
  page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number,
) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(200);
  }
};

/** Soft wait: returns true if the condition landed, false on timeout (no throw). */
const softWait = async (
  page: any, fn: () => Promise<boolean>, timeoutMs: number,
): Promise<boolean> => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await page.waitForTimeout(500);
  }
};

const bootWait = (page: any) => waitFor(page, 'boot', () => page.evaluate(() => {
  const X = (window as unknown as X).__XANDRIA__;
  return !!(X?.engine && X?.mountsTest && X?.blueprint?.mounts && X?.blueprint?.mountsPanel
    && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
}), 240_000);

const quietField = async (page: any) => {
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
};

const teleportOrigin = async (page: any) => {
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const y = E.terrain.heightAt(0, 0) + 3;
    E.portalsPlayerAvatar.ctrl.teleport(new V(0, y, 0));
  });
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Drive forward from origin and return the median planar speed after settle. */
const measureSpeed = async (page: any): Promise<number> => {
  await teleportOrigin(page);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.engine.input.inject(['forward'], null);
  });
  // settle: wait for >= 1.0 engine-second of movement (accel ramp done)
  const t0 = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.time);
  await waitFor(page, 'speed settle', () => page.evaluate((start: number) =>
    (window as unknown as X).__XANDRIA__!.engine.time >= start + 1.0, t0), 120_000);
  const samples: number[] = [];
  for (let i = 0; i < 6; i++) {
    const v = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const vel = X.engine.portalsPlayerAvatar.ctrl.velocity;
      return Math.hypot(vel.x, vel.z);
    });
    samples.push(v);
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.engine.input.inject([], null);
  });
  return median(samples);
};

/** Wait until engine.time advances by `secs`, then return the new time. */
const waitEngineSecs = async (page: any, secs: number): Promise<number> => {
  const t0 = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.time);
  await waitFor(page, `engine +${secs}s`, () => page.evaluate(([start, s]: number[]) =>
    (window as unknown as X).__XANDRIA__!.engine.time >= start + s, [t0, secs]), 300_000);
  return page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.time);
};

/** Click the panel button belonging to the card naming `name` (buttons are direct card children). */
const clickCardButton = async (page: any, name: string, label: string) => {
  await page.evaluate(([n, l]: string[]) => {
    const panel = document.querySelector('#xandria-mounts-panel') as HTMLElement;
    const btn = [...panel.querySelectorAll('button')].find((b) =>
      b.textContent === l && (b.parentElement?.textContent ?? '').includes(n));
    if (!btn) throw new Error(`no ${l} button in ${n} card`);
    btn.click();
  }, [name, label]);
};

/** Poll until the controller scalar reflects the mount (next engine frame under SwiftShader can take seconds). */
const waitScalar = (page: any, expected: number) => waitFor(page, `scalar ${expected}`, () => page.evaluate((e: number) =>
  (window as unknown as X).__XANDRIA__!.engine.portalsPlayerAvatar.ctrl.speedScalar === e, expected), 120_000);

const readMounts = (page: any) => page.evaluate(() => {
  const X = (window as unknown as X).__XANDRIA__;
  const mgr = X.mountsTest.liveManager();
  const avatar = X.engine.portalsPlayerAvatar;
  return {
    active: mgr.activeId as string | null,
    mult: mgr.speedMultiplier() as number,
    scalar: avatar.ctrl.speedScalar as number,
    stamina: mgr.activeId ? mgr.staminaOf(mgr.activeId) as number : -1,
    exhausted: mgr.state.exhausted as boolean,
    base: X.spec.player.speed as number,
  };
});

test('mounts: panel + summon + exact speed + stamina + dismiss, desktop', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(URL);
  await bootWait(page);
  await quietField(page);

  // ---- panel: N opens (real key handler), 3 mount cards render ----
  await page.keyboard.press('n');
  await waitFor(page, 'mounts panel opens on N', () => page.evaluate(() =>
    (document.getElementById('xandria-mounts-panel') as HTMLElement)?.style.display === 'flex'), 30_000);
  const panelText = await page.evaluate(() =>
    document.getElementById('xandria-mounts-panel')?.textContent ?? '');
  expect(panelText).toContain('Swift Strider');
  expect(panelText).toContain('Armored Beetle');
  expect(panelText).toContain('Gliding Drake-Lite');
  expect(panelText).toContain('×1.5 speed');

  // ---- on-foot baseline speed ----
  await page.evaluate(() => {
    const panel = document.querySelector('#xandria-mounts-panel') as HTMLElement;
    (panel.querySelector('button') as HTMLButtonElement).click(); // × closes; avoids the Escape-pause dance here
  });
  await waitFor(page, 'mounts panel closes on ×', () => page.evaluate(() =>
    (document.getElementById('xandria-mounts-panel') as HTMLElement)?.style.display === 'none'), 30_000);
  const foot = await measureSpeed(page);
  const base = (await readMounts(page)).base;
  expect(foot, `on-foot speed ≈ base ${base} (got ${foot})`).toBeGreaterThan(base * 0.85);
  expect(foot, `on-foot speed ≈ base ${base} (got ${foot})`).toBeLessThan(base * 1.15);

  // ---- summon via the real panel click path ----
  await page.keyboard.press('n');
  await waitFor(page, 'mounts panel re-opens', () => page.evaluate(() =>
    (document.getElementById('xandria-mounts-panel') as HTMLElement)?.style.display === 'flex'), 30_000);
  await clickCardButton(page, 'Swift Strider', 'Summon');
  const summoned = await readMounts(page);
  expect(summoned.active, 'strider summoned').toBe('swift-strider');
  expect(summoned.mult, 'strider multiplier exact').toBe(1.5);
  await waitScalar(page, 1.5);
  expect((await readMounts(page)).scalar, 'controller scalar exact').toBe(1.5);
  await page.evaluate(() => {
    const panel = document.querySelector('#xandria-mounts-panel') as HTMLElement;
    (panel.querySelector('button') as HTMLButtonElement).click();
  });
  await waitFor(page, 'mounts panel closes', () => page.evaluate(() =>
    (document.getElementById('xandria-mounts-panel') as HTMLElement)?.style.display === 'none'), 30_000);

  // ---- mounted speed: exactly 1.5x the on-foot measurement ----
  const mounted = await measureSpeed(page);
  const ratio = mounted / foot;
  expect(ratio, `mounted/foot speed ratio ≈ 1.5 (foot ${foot}, mounted ${mounted})`).toBeGreaterThan(1.35);
  expect(ratio, `mounted/foot speed ratio ≈ 1.5 (foot ${foot}, mounted ${mounted})`).toBeLessThan(1.65);

  // ---- stamina: drains 8/s while moving, regens 15/s while idle ----
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.engine.input.inject(['forward'], null);
  });
  const tMove0 = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.time);
  const s0 = (await readMounts(page)).stamina;
  await waitEngineSecs(page, 4);
  const tMove1 = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.time);
  const s1 = (await readMounts(page)).stamina;
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.engine.input.inject([], null);
  });
  const movedDt = tMove1 - tMove0;
  const drained = s0 - s1;
  expect(drained, `stamina drained ≈ 8/s over ${movedDt}s (${s0} -> ${s1})`).toBeGreaterThan(8 * movedDt * 0.7);
  expect(drained, `stamina drained ≈ 8/s over ${movedDt}s (${s0} -> ${s1})`).toBeLessThan(8 * movedDt * 1.3 + 2);
  const tIdle0 = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.time);
  await waitEngineSecs(page, 3);
  const tIdle1 = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.time);
  const s2 = (await readMounts(page)).stamina;
  const idleDt = tIdle1 - tIdle0;
  const regained = s2 - s1;
  expect(regained, `stamina regained ≈ 15/s over ${idleDt}s (${s1} -> ${s2})`).toBeGreaterThan(Math.min(15 * idleDt * 0.7, 100 - s1 - 1));
  expect(s2, 'stamina never exceeds the pool').toBeLessThanOrEqual(100);

  // ---- dismiss via panel restores speed 1.0 ----
  await page.keyboard.press('n');
  await waitFor(page, 'mounts panel opens for dismiss', () => page.evaluate(() =>
    (document.getElementById('xandria-mounts-panel') as HTMLElement)?.style.display === 'flex'), 30_000);
  await clickCardButton(page, 'Swift Strider', 'Dismiss');
  const dismissed = await readMounts(page);
  expect(dismissed.active, 'dismissed').toBeNull();
  await waitScalar(page, 1);
  expect((await readMounts(page)).scalar, 'scalar back to 1').toBe(1);

  // ---- Escape close + shared pause/resume dance ----
  await page.keyboard.press('Escape');
  await waitFor(page, 'mounts panel closes on Esc', () => page.evaluate(() =>
    (document.getElementById('xandria-mounts-panel') as HTMLElement)?.style.display === 'none'), 30_000);
  const paused = await softWait(page, () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__!.engine.state === 'paused'), 120_000);
  if (paused) {
    await page.keyboard.press('Escape');
    await waitFor(page, 'game resumes after second Escape', () => page.evaluate(() =>
      (window as unknown as X).__XANDRIA__!.engine.state === 'playing'), 300_000);
  }

  expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
});

test('mounts: dismiss + reload restores the ride, desktop', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(URL);
  await bootWait(page);
  await quietField(page);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.mountsTest.liveManager().summon('armored-beetle');
  });
  expect((await readMounts(page)).active, 'beetle summoned before reload').toBe('armored-beetle');

  await page.reload();
  await bootWait(page);
  const restored = await readMounts(page);
  expect(restored.active, 'reload restores the active mount from the profile').toBe('armored-beetle');
  expect(restored.mult, 'restored multiplier exact').toBe(1.25);
  await waitScalar(page, 1.25);
  expect((await readMounts(page)).scalar, 'restored controller scalar exact').toBe(1.25);

  // leave the profile on foot so later runs start clean
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.mountsTest.liveManager().dismiss();
  });
  expect((await readMounts(page)).active, 'cleanup dismiss').toBeNull();
  expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
});

test('mounts: portal round-trip keeps the mount, desktop 8km', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(PORTAL_URL);
  await bootWait(page);
  await quietField(page);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.mountsTest.liveManager().summon('swift-strider');
  });
  expect((await readMounts(page)).active, 'strider summoned before travel').toBe('swift-strider');

  const walkThrough = async (edge: 'N' | 'S', fromTransitions: number) => {
    await page.evaluate((edge: 'N' | 'S') => {
      const X = (window as unknown as X).__XANDRIA__;
      const E = X.engine;
      const V = E.camera.position.constructor;
      const HALF = 4000;
      const tx = 100;
      const tz = edge === 'N' ? HALF - 11 : -(HALF - 11);
      const y = E.terrain.heightAt(tx, tz) + 3;
      E.streamFocus = new V(tx, y, tz);
      E.portalsPlayerAvatar.ctrl.teleport(new V(tx, y, tz));
      const want = edge === 'N' ? Math.PI : 0;
      let d = (want - E.portalsPlayerAvatar.ctrl.camYaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      E.input.look.x = -d / 0.0026;
    }, edge);
    await page.waitForTimeout(8000);
    await page.evaluate(() => {
      (window as unknown as X).__XANDRIA__!.engine.input.inject(['forward', 'sprint'], null);
    });
    await waitFor(page, `transition to ${fromTransitions + 1}`, () => page.evaluate((n: number) =>
      (window as unknown as X).__XANDRIA__!.engine.portalManager.transitions >= n, fromTransitions + 1), 300_000);
    await page.evaluate(() => {
      (window as unknown as X).__XANDRIA__!.engine.input.inject([], null);
    });
  };

  await walkThrough('N', 0);
  await waitFor(page, 'minimap arrives on a new map', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.minimap.activeKey !== '0,0'), 600_000);
  const away = await readMounts(page);
  expect(away.active, 'mount survives portal travel north').toBe('swift-strider');

  await walkThrough('S', 1);
  await waitFor(page, 'minimap back on origin', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.minimap.activeKey === '0,0'), 600_000);
  const back = await readMounts(page);
  expect(back.active, 'mount survives the portal round trip').toBe('swift-strider');

  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.mountsTest.liveManager().dismiss();
  });
  expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
});

test.describe('mobile 360x780', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('mounts: chip opens panel at 360px, summon works', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

    await page.goto(URL);
    await bootWait(page);
    await quietField(page);

    await page.locator('#xandria-mounts-chip').click({ force: true, timeout: 15000 });
    await waitFor(page, 'mounts panel opens via chip', () => page.evaluate(() =>
      (document.getElementById('xandria-mounts-panel') as HTMLElement)?.style.display === 'flex'), 30_000);
    const box = await page.locator('#xandria-mounts-panel').boundingBox();
    expect(box, 'mounts panel visible at 360px').toBeTruthy();
    expect(box!.x + box!.width, 'panel fits the 360px viewport').toBeLessThanOrEqual(360);
    await clickCardButton(page, 'Gliding Drake-Lite', 'Summon');
    const summoned = await readMounts(page);
    expect(summoned.active, 'drake-lite summoned on mobile').toBe('drake-lite');
    expect(summoned.mult, 'drake-lite multiplier exact').toBe(1.75);

    await page.evaluate(() => {
      (window as unknown as X).__XANDRIA__!.mountsTest.liveManager().dismiss();
    });
    expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
  });
});

test('mounts perf: instanced draw-call delta, desktop', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(URL);
  await bootWait(page);
  await quietField(page);
  await teleportOrigin(page);

  // NOTE (SwiftShader sampling lag, measured 2026-10-26): renderer.info
  // .render.calls only updates when a frame completes, and a frame here
  // takes ~6-13 wall-seconds — so short sample windows read one stale
  // frame (an earlier revision of this leg read a flat 301 for all three
  // phases). A distribution probe showed the true steady-state delta is
  // +13 calls (301 -> 314) with the scene-mesh count flipping
  // immediately (+7). This leg therefore settles 20s after each state
  // change (past the observed lag) and asserts the scene-mesh delta
  // alongside the call delta.
  const sample = async (): Promise<{ calls: number; meshes: number }> => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__!;
    let meshes = 0;
    X.engine.scene.traverse((o: any) => { if (o.isInstancedMesh) meshes++; });
    return { calls: X.engine.renderer.info.render.calls, meshes };
  });
  const sampleDraws = async (n: number): Promise<{ calls: number[]; meshes: number[] }> => {
    const calls: number[] = [];
    const meshes: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = await sample();
      calls.push(s.calls);
      meshes.push(s.meshes);
      await page.waitForTimeout(1000);
    }
    return { calls, meshes };
  };
  const buckets = async () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__!.mountsTest.instancerStats());

  const baseS = await sampleDraws(5);
  const baseCalls = median(baseS.calls);
  const baseMeshes = median(baseS.meshes);
  const baseBuckets = await buckets();
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.mountsTest.liveManager().summon('swift-strider');
  });
  await page.waitForTimeout(20000);
  const mountedS = await sampleDraws(5);
  const mountedCalls = median(mountedS.calls);
  const mountedMeshes = median(mountedS.meshes);
  const mountedBuckets = await buckets();
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.mountsTest.liveManager().dismiss();
  });
  await page.waitForTimeout(20000);
  const backS = await sampleDraws(5);
  const backCalls = median(backS.calls);
  const backMeshes = median(backS.meshes);
  const backBuckets = await buckets();
  // eslint-disable-next-line no-console
  console.log('mounts perf (median render.calls, 5 samples):', JSON.stringify({
    base: baseCalls, mounted: mountedCalls, back: backCalls,
    baseMeshes, mountedMeshes, backMeshes,
    baseBuckets, mountedBuckets, backBuckets,
  }));
  expect(mountedCalls - baseCalls, 'summoned mount draw delta is small (instanced pools only)')
    .toBeGreaterThan(0);
  expect(mountedCalls - baseCalls, 'summoned mount draw delta is small (instanced pools only)')
    .toBeLessThanOrEqual(20);
  expect(mountedMeshes - baseMeshes, 'summon adds instanced meshes').toBeGreaterThan(0);
  expect(backCalls, 'dismiss returns draw calls to baseline').toBeLessThanOrEqual(baseCalls + 5);
  expect(backMeshes, 'dismiss returns scene meshes to baseline').toBe(baseMeshes);
  expect(backBuckets.buckets, 'dismiss returns buckets to baseline').toBeLessThanOrEqual(baseBuckets.buckets + 1);

  expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
});
