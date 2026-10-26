/**
 * Companion-system wave — summon -> follow -> companion kill credited
 * to the player -> panel rename/dismiss -> campfire heal -> reload
 * preserves the companion, in the live player page (desktop AND
 * 360x780, zero console/page errors), plus the INSTANCING.md perf leg.
 *
 * Flow (desktop): boot the deterministic "Forgotten Valley" scene (seed
 * 20261012, tp-action) with an empty custom.items table -> despawn NPCs
 * and make the player invincible -> open the companion panel and SUMMON
 * the brawler with a real click -> follow asserted after a 20m player
 * teleport -> pin a weakened enemy at the companion's feet until the
 * companion kills it -> player XP and score both rise off that kill
 * (the existing onDeath path; loot rolls ride the same callback) ->
 * rename via the panel input -> dismiss via the panel button -> summon
 * the caster, rename it via the seam, refuse heal-at-campfire honestly
 * with no campfire live, craft + deploy a campfire, damage the caster,
 * heal it from the panel button -> reload the page and assert the
 * caster (renamed) is still summoned from the saved profile.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the player is
 * teleported to the enemy (never the reverse), all waits poll from Node,
 * enemy pinning re-applies every poll slice under SwiftShader's slow
 * frames, and game-time waits key off engine.time, never wall time.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const B64 = (() => {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
})();

const URL = `/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`;

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

const bootWait = (page: any) => waitFor(page, 'boot', () => page.evaluate(() => {
  const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
  return !!(X?.engine && X?.companionTest && X?.deployTest && X?.craftingTest
    && X?.blueprint?.companions && X?.blueprint?.companionPanel
    && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
}), 240_000);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

test('companions: summon -> follow -> kill credit -> panel -> campfire -> reload, desktop', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(URL);
  await bootWait(page);

  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs') s.despawnAll();
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const mgr = () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const m = X.companionTest.liveManager();
    return {
      activeId: m.activeCompanionId,
      live: !!m.live,
      roster: m.rosterView.map((s: any) => ({ defId: s.defId, name: s.name, hp: s.hp })),
      totalDamage: m.totalDamage,
      kills: m.kills,
      totalHealed: m.totalHealed,
    };
  });

  // ---- summon the brawler with a real panel click ----
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.companionTest.livePanel().show());
  await page.click('[data-companion-summon="brawler"]');
  await waitFor(page, 'brawler summoned', async () => (await mgr()).activeId === 'brawler' && (await mgr()).live, 60_000);
  const summoned = await mgr();
  expect(summoned.roster.find((s: any) => s.defId === 'brawler')?.name).toBe('Brak');

  // ---- follow: teleport the player 20m; the companion must re-anchor at its follow offset ----
  const followDist = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const m = X.companionTest.liveManager();
    const avatar = X.engine.portalsPlayerAvatar;
    avatar.ctrl.teleport(avatar.ctrl.position.clone().add(new (avatar.ctrl.position.constructor as any)(20, 0, 0)));
    return m.live.follow.dist;
  });
  await waitFor(page, 'companion follows', () => page.evaluate((followDist) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const m = X.companionTest.liveManager();
    if (!m.live) return false;
    const d = m.live.root.position.distanceTo(X.engine.portalsPlayerAvatar.ctrl.position);
    return Math.abs(d - followDist) < 1.5;
  }, followDist), 120_000);

  // ---- companion kill credited to the player (XP + score off the existing onDeath path) ----
  const before = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const prog = X.progressionTest.liveProgression();
    return { xp: prog.xp, level: prog.level, score: X.engine.score };
  });
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const enemies = X.blueprint.enemies.enemies.filter((e: any) => e.alive);
    enemies.sort((a: any, b: any) => b.health - a.health);
    const e = enemies[0];
    e.health = 12; // below any brawler roll (14-18): one companion hit kills it
    (window as any).__companionVictim = e;
  });
  await waitFor(page, 'companion kill', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const m = X.companionTest.liveManager();
    const e = (window as any).__companionVictim;
    if (e?.alive && e.body && m.live) {
      e.body.position.set(m.live.root.position.x, m.live.root.position.y + 1, m.live.root.position.z);
      e.body.velocity.set(0, 0, 0);
    }
    return !e?.alive && m.kills >= 1 && m.totalDamage > 0;
  }), 240_000);
  const after = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const prog = X.progressionTest.liveProgression();
    return { xp: prog.xp, level: prog.level, score: X.engine.score };
  });
  expect(after.xp > before.xp || after.level > before.level, 'companion kill grants player XP').toBe(true);
  expect(after.score, 'companion kill credits player score').toBeGreaterThan(before.score);

  // ---- rename via the panel input, dismiss via the panel button ----
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.companionTest.livePanel().show());
  await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Rename Brak"]') as HTMLInputElement;
    input.value = 'Tank';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitFor(page, 'renamed', async () =>
    (await mgr()).roster.find((s: any) => s.defId === 'brawler')?.name === 'Tank', 30_000);
  await page.click('[data-companion-dismiss="brawler"]');
  await waitFor(page, 'dismissed', async () => (await mgr()).activeId === null && !(await mgr()).live, 30_000);
  expect((await mgr()).roster.find((s: any) => s.defId === 'brawler')?.name, 'roster keeps the rename after dismiss').toBe('Tank');

  // ---- caster: summon + rename, then the campfire heal hook ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.companionTest.livePanel().show();
  });
  await page.click('[data-companion-summon="caster"]');
  await waitFor(page, 'caster summoned', async () => (await mgr()).activeId === 'caster', 60_000);
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.companionTest.liveManager().rename('caster', 'Sparky');
  });
  // honest refusal: no campfire live yet
  const refused = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.companionTest.liveManager().healAtCampfire());
  expect(refused, 'heal-at-campfire refuses with no campfire live').toBe(0);
  // craft + deploy a campfire, wound the caster, heal from the panel button
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const inv = X.blueprint.itemKit.inventory;
    inv.add('mat_fiber', 99); inv.add('mat_scrap', 99);
    const pool = X.craftingTest.buildRecipePool(X.spec);
    const r = X.craftingTest.craft(pool, 'recipe_deploy_campfire', { inventory: inv, defs: X.spec.custom.items.defs, stations: new Set() });
    if (!r.ok) throw new Error('campfire kit did not craft');
  });
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.tap('deploy'));
  await waitFor(page, 'campfire deployed', () => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.deployTest.liveManager().deployables.length === 1), 60_000);
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.companionTest.liveManager().damageActive(30);
    X.companionTest.livePanel().show();
  });
  await page.click('[data-companion-heal="caster"]');
  await waitFor(page, 'caster healed at campfire', async () => {
    const m = await mgr();
    const caster = m.roster.find((s: any) => s.defId === 'caster');
    return caster?.hp === 70;
  }, 60_000);

  // ---- reload preserves the summoned, renamed companion ----
  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem('xandria.slots.v1') ?? '';
    return { hasCompanions: raw.includes('companions'), hasSparky: raw.includes('Sparky') };
  });
  expect(stored, 'profile storage carries the companion save before reload').toEqual({ hasCompanions: true, hasSparky: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await bootWait(page);
  await waitFor(page, 'caster restored after reload', async () => {
    const m = await mgr();
    return m.activeId === 'caster' && m.live
      && m.roster.find((s: any) => s.defId === 'caster')?.name === 'Sparky';
  }, 60_000);

  expect(errors, 'zero console/page errors').toEqual([]);
});

test.describe('companions mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

  test('companions: mobile chip -> panel -> summon, 360x780', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
    await page.goto(URL);
    await bootWait(page);
    const chip = page.locator('#xandria-companions-chip');
    await expect(chip, 'COMPANIONS chip visible').toBeVisible();
    const box = await chip.boundingBox();
    expect(box, 'chip has a box').toBeTruthy();
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.locator('#xandria-companions-panel'), 'panel opens on chip tap').toBeVisible();
    await page.click('[data-companion-summon="healer"]');
    await waitFor(page, 'healer summoned on mobile', () => page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const m = X.companionTest.liveManager();
      return m.activeCompanionId === 'healer' && !!m.live;
    }), 60_000);
    expect(errors, 'zero console/page errors').toEqual([]);
  });
});

test('companions perf: instanced draw-call delta, desktop + s25', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  const sample = async (): Promise<{ calls: number; buckets: number; registered: number }> =>
    page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const inst = (X.blueprint.enemies as unknown as { instancer?: { bucketCount: number; registeredNpcCount: number } }).instancer;
      return {
        calls: X.engine.renderer.info.render.calls,
        buckets: inst?.bucketCount ?? -1,
        registered: inst?.registeredNpcCount ?? -1,
      };
    });
  const sampleDraws = async (n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push((await sample()).calls);
      await page.waitForTimeout(1500);
    }
    return out;
  };

  const results: Record<string, { base: number; with: number; after: number; delta: number; newBuckets: number }> = {};
  for (const tier of ['desktop', 's25']) {
    await page.goto(`${URL}&tier=${tier}`);
    await bootWait(page);
    const resolved = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.tiers.tier);
    expect(resolved).toBe(tier);
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
      for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    });
    await page.waitForTimeout(20_000); // settle under SwiftShader
    const baseBuckets = (await sample()).buckets;
    const base = median(await sampleDraws(10));
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      X.companionTest.liveManager().summon('brawler');
    });
    const n = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.companionTest.liveManager().live ? 1 : 0);
    expect(n).toBe(1);
    const withS = await sample();
    const withD = median(await sampleDraws(10));
    await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.companionTest.liveManager().dismiss());
    const after = median(await sampleDraws(10));
    results[tier] = {
      base, with: withD, after,
      delta: withD - base, newBuckets: withS.buckets - baseBuckets,
    };
    expect(Math.abs(after - base), `${tier}: no unexplained drift (base=${base} after=${after})`).toBeLessThanOrEqual(25);
  }
  // Reported in REPORT.md; the delta must be small (one follower, shared buckets).
  console.log('COMPANIONS PERF', JSON.stringify(results));
  for (const tier of ['desktop', 's25']) {
    expect(results[tier].delta, `${tier}: companion draw delta stays small`).toBeLessThanOrEqual(30);
  }
  expect(errors, 'zero console/page errors').toEqual([]);
});
