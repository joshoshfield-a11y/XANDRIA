/**
 * Companion-combat-depth wave — enemy retaliation against companions,
 * in the live player page (desktop AND 360x780, zero console/page
 * errors), plus a lightweight stance-switch perf leg (no new meshes,
 * so the bucket count must not move).
 *
 * Flow (desktop): boot the deterministic "Forgotten Valley" scene (seed
 * 20261012, tp-action) with an empty custom.items table -> despawn
 * NPCs -> summon the brawler from the panel -> TAUNT stance -> cull
 * every enemy but one pinned melee victim at the companion's feet ->
 * the victim hits the COMPANION (player HP untouched, exact damage
 * multiple, lastTarget 'companion') -> GUARD stance -> the victim
 * still hits the companion (guard draws aggro too — see the design
 * note in companionCombat.ts: a guard weight below the player's
 * would be unreachable in live play), but halved, and the companion
 * attacks nothing -> TAUNT again until the companion FALLS (dismissed
 * to the panel, player untouched) -> revive refuses with 0 scrap, then
 * pays exactly 25 scrap and restores full HP without auto-summoning
 * -> re-summon -> dismiss -> the victim hits the PLAYER again
 * (player-death path unchanged, exact damage multiple).
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the victim is
 * pinned every poll slice (never the reverse) and all waits poll from
 * Node.
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

const mgr = (page: any) => page.evaluate(() => {
  const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
  const m = X.companionTest.liveManager();
  return {
    activeId: m.activeCompanionId,
    live: !!m.live,
    stance: m.activeStance,
    roster: m.rosterView.map((s: any) => ({ defId: s.defId, name: s.name, hp: s.hp, stance: s.stance })),
  };
});

test('companion-combat: taunt -> guard -> fall -> revive -> player path, desktop', async ({ page }) => {
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
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 5000;
  });

  // ---- summon the brawler, set TAUNT from the panel ----
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.companionTest.livePanel().show());
  await page.click('[data-companion-summon="brawler"]');
  await waitFor(page, 'brawler summoned', async () => (await mgr(page)).activeId === 'brawler', 60_000);
  await page.click('[data-companion-stance="taunt"]');
  await waitFor(page, 'taunt set', async () => (await mgr(page)).stance === 'taunt', 30_000);

  // ---- cull every enemy but one melee victim; pin the victim at the companion's feet ----
  // The cull itself spawns splitter minis (variants onEnemyDeath), so
  // cull in passes until exactly the victim is alive — otherwise a mini
  // (different damage) pollutes the exact-damage assertions.
  const cullPass = () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const alive = X.blueprint.enemies.enemies.filter((e: any) => e.alive);
    const melee = alive.filter((e: any) => e.spec.kind === 'walker' || e.spec.kind === 'brute');
    const victim = (window as any).__combatVictim ?? melee[0] ?? alive[0];
    for (const e of alive) if (e !== victim) e.damage(1e6);
    victim.health = 10000;
    victim.maxHealth = 10000;
    (window as any).__combatVictim = victim;
    return X.blueprint.enemies.enemies.filter((e: any) => e.alive).length;
  });
  const clearLevelUps = () => waitFor(page, 'level-up queue cleared', async () => {
    const n = await page.locator('.lvlopt').count();
    if (n === 0) return true;
    await page.locator('.lvlopt').first().click();
    await page.waitForTimeout(500);
    return false;
  }, 120_000);
  for (let pass = 0; pass < 4; pass++) {
    await cullPass();
    // The cull grants a burst of XP, so LEVEL UP modals queue up: each
    // PAUSES the game and intercepts panel clicks until an upgrade is
    // picked. Click through the whole queue before touching the panel.
    await clearLevelUps();
    await page.waitForTimeout(3000); // let splitter minis spawn
    const alive = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.enemies.enemies.filter((e: any) => e.alive).length);
    if (alive === 1) break;
  }
  await waitFor(page, 'only the victim alive', () => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.enemies.enemies.filter((e: any) => e.alive).length === 1), 60_000);

  // ---- perf leg: stance switch moves zero buckets (no new meshes in this phase) ----
  const buckets = () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const inst = (X.blueprint.enemies as unknown as { instancer?: { bucketCount: number } }).instancer;
    return { buckets: inst?.bucketCount ?? -1, calls: X.engine.renderer.info.render.calls };
  });
  const beforeBuckets = (await buckets()).buckets;
  await page.click('[data-companion-stance="normal"]');
  await waitFor(page, 'normal set', async () => (await mgr(page)).stance === 'normal', 30_000);
  await page.click('[data-companion-stance="taunt"]');
  await waitFor(page, 'taunt re-set', async () => (await mgr(page)).stance === 'taunt', 30_000);
  const afterBuckets = (await buckets()).buckets;
  expect(afterBuckets, 'stance switch adds zero instanced buckets').toBe(beforeBuckets);
  console.log('COMPANION-COMBAT PERF', JSON.stringify({ beforeBuckets, afterBuckets }));

  // ---- TAUNT leg: victim hits the companion, never the player, exact damage ----
  // Per-hit tracking (not leg totals): the weather night multiplier can
  // change mid-leg, so each discrete HP drop is checked against the
  // multiplier at its own poll (current or previous poll, to tolerate
  // a day/night boundary straddling one poll window).
  const playerHp0 = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.health);
  await page.evaluate((hp) => {
    (window as any).__playerHp0 = hp;
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    (window as any).__hitDrops = [];
    (window as any).__hitPrevHp = X.companionTest.liveManager().rosterView.find((s: any) => s.defId === 'brawler')?.hp ?? -1;
    (window as any).__hitMultPrev = 1;
  }, playerHp0);
  await waitFor(page, 'taunt: companion takes hits, player untouched', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const m = X.companionTest.liveManager();
    const v = (window as any).__combatVictim;
    if (v?.alive && v.body && m.live) {
      v.body.position.set(m.live.root.position.x, m.live.root.position.y + 1, m.live.root.position.z);
      v.body.velocity.set(0, 0, 0);
    }
    const hp = m.rosterView.find((s: any) => s.defId === 'brawler')?.hp ?? -1;
    const mult = X.blueprint.weather?.enemyDamageMult?.(v.spec.kind) ?? 1;
    if (hp < (window as any).__hitPrevHp && hp > 0) {
      (window as any).__hitDrops.push({ drop: (window as any).__hitPrevHp - hp, multNow: mult, multPrev: (window as any).__hitMultPrev });
    }
    (window as any).__hitPrevHp = hp;
    (window as any).__hitMultPrev = mult;
    return (window as any).__hitDrops.length >= 2 && v?.lastTarget === 'companion'
      && X.engine.portalsPlayerAvatar.health === (window as any).__playerHp0;
  }), 240_000);
  const tauntDrops = await page.evaluate(() => (window as any).__hitDrops);
  const specDmg = await page.evaluate(() => (window as any).__combatVictim.spec.damage);
  expect(tauntDrops.length, 'taunt leg recorded hits').toBeGreaterThanOrEqual(2);
  for (const h of tauntDrops) {
    const ok = Math.abs(h.drop - specDmg * h.multNow) < 0.01 || Math.abs(h.drop - specDmg * h.multPrev) < 0.01;
    expect(ok, `taunt hit ${h.drop} matches raw ${specDmg} x mult ${h.multNow}/${h.multPrev}`).toBe(true);
  }
  const playerHp1 = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.health);
  expect(playerHp1, 'player HP untouched while taunt holds aggro').toBe(playerHp0);

  // ---- GUARD leg: victim pinned at the companion's feet, player beside them at finite HP ----
  // Reset the victim AFTER guard is set: while stance is still taunt the
  // companion damages it, which would break the guard-deals-no-damage assert.
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.companionTest.livePanel().show());
  await page.click('[data-companion-stance="guard"]');
  await waitFor(page, 'guard set', async () => (await mgr(page)).stance === 'guard', 30_000);
  await page.evaluate(() => { (window as any).__combatVictim.health = 10000; });
  const guardHp0 = (await mgr(page)).roster.find((s: any) => s.defId === 'brawler')!.hp;
  // Per-hit tracking like the taunt leg (weather mult drifts mid-leg).
  await page.evaluate((hp) => {
    (window as any).__hitDrops = [];
    (window as any).__hitPrevHp = hp;
    (window as any).__hitMultPrev = 1;
  }, guardHp0);
  await waitFor(page, 'guard: halved companion damage', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const m = X.companionTest.liveManager();
    const v = (window as any).__combatVictim;
    if (v?.alive && v.body && m.live) {
      v.body.position.set(m.live.root.position.x, m.live.root.position.y + 1, m.live.root.position.z);
      v.body.velocity.set(0, 0, 0);
    }
    const hp = m.rosterView.find((s: any) => s.defId === 'brawler')?.hp ?? -1;
    const mult = X.blueprint.weather?.enemyDamageMult?.(v.spec.kind) ?? 1;
    if (hp < (window as any).__hitPrevHp && hp > 0) {
      (window as any).__hitDrops.push({ drop: (window as any).__hitPrevHp - hp, multNow: mult, multPrev: (window as any).__hitMultPrev });
    }
    (window as any).__hitPrevHp = hp;
    (window as any).__hitMultPrev = mult;
    return (window as any).__hitDrops.length >= 2 && v?.lastTarget === 'companion';
  }), 240_000);
  const guardDrops = await page.evaluate(() => (window as any).__hitDrops);
  expect(guardDrops.length, 'guard leg recorded hits').toBeGreaterThanOrEqual(2);
  for (const h of guardDrops) {
    const halvedNow = Math.max(1, Math.floor(specDmg * h.multNow / 2));
    const halvedPrev = Math.max(1, Math.floor(specDmg * h.multPrev / 2));
    const ok = Math.abs(h.drop - halvedNow) < 0.01 || Math.abs(h.drop - halvedPrev) < 0.01;
    expect(ok, `guard hit ${h.drop} matches halved raw ${specDmg} x mult ${h.multNow}/${h.multPrev}`).toBe(true);
  }
  // Guard attacks nothing: the victim took no companion damage during the guard leg.
  const victimHpAfterGuard = await page.evaluate(() => (window as any).__combatVictim.health);
  expect(victimHpAfterGuard, 'guard companion deals no damage').toBe(10000);

  // ---- FALL leg: taunt again, pinned victim beats the companion down to 0 ----
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.companionTest.livePanel().show());
  await page.click('[data-companion-stance="taunt"]');
  await waitFor(page, 'taunt re-set for fall', async () => (await mgr(page)).stance === 'taunt', 30_000);
  await waitFor(page, 'companion falls', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const m = X.companionTest.liveManager();
    const v = (window as any).__combatVictim;
    if (v?.alive && v.body && m.live) {
      v.body.position.set(m.live.root.position.x, m.live.root.position.y + 1, m.live.root.position.z);
      v.body.velocity.set(0, 0, 0);
    }
    const entry = m.rosterView.find((s: any) => s.defId === 'brawler');
    return m.activeCompanionId === null && !m.live && entry?.hp === 0;
  }), 300_000);
  // The player never died to the fall: still at the finite HP it held
  // through the taunt leg (the victim targeted the companion throughout).
  const playerAlive = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.health > 0);
  expect(playerAlive, 'companion fall is never a player death').toBe(true);

  // ---- REVIVE leg: refuses below cost, pays exactly 25, no auto-summon ----
  // The cull itself banks scrap (seeded currency stream), so the wallet
  // is not empty here — the refusal proof only needs balance < 25.
  const wallet0 = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.wallet.balance);
  expect(wallet0, 'wallet below revive cost for the refusal').toBeLessThan(25);
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.companionTest.livePanel().show());
  await page.click('[data-companion-revive="brawler"]');
  await page.waitForTimeout(1000);
  expect((await mgr(page)).roster.find((s: any) => s.defId === 'brawler')?.hp,
    'revive refuses below cost').toBe(0);
  expect(await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.wallet.balance),
    'refused revive charges nothing').toBe(wallet0);
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.wallet.add(100));
  await page.click('[data-companion-revive="brawler"]');
  await waitFor(page, 'revived', async () => {
    const m = await mgr(page);
    return m.roster.find((s: any) => s.defId === 'brawler')?.hp === 120 && m.activeId === null;
  }, 30_000);
  const wallet1 = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.wallet.balance);
  expect(wallet1, 'revive costs exactly 25 scrap').toBe(wallet0 + 75);
  // Re-summon restores the live companion at full HP.
  await page.click('[data-companion-summon="brawler"]');
  await waitFor(page, 'brawler re-summoned', async () => {
    const m = await mgr(page);
    return m.activeId === 'brawler' && m.live
      && m.roster.find((s: any) => s.defId === 'brawler')?.hp === 120;
  }, 60_000);

  // ---- PLAYER-PATH leg: dismissed companion -> victim hits the player, exact damage ----
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.companionTest.livePanel().show());
  await page.click('[data-companion-dismiss="brawler"]');
  await waitFor(page, 'dismissed', async () => (await mgr(page)).activeId === null, 30_000);
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 5000;
    (window as any).__combatVictim.health = 10000;
  });
  // Per-hit tracking like the taunt leg (weather mult drifts mid-leg).
  await page.evaluate(() => {
    (window as any).__hitDrops = [];
    (window as any).__hitPrevHp = 5000;
    (window as any).__hitMultPrev = 1;
  });
  await waitFor(page, 'player takes hits again', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const v = (window as any).__combatVictim;
    const player = X.engine.portalsPlayerAvatar;
    if (v?.alive && v.body) {
      v.body.position.set(player.ctrl.position.x, player.ctrl.position.y + 1, player.ctrl.position.z);
      v.body.velocity.set(0, 0, 0);
    }
    const hp = player.health;
    const mult = X.blueprint.weather?.enemyDamageMult?.(v.spec.kind) ?? 1;
    if (hp < (window as any).__hitPrevHp && hp > 0) {
      (window as any).__hitDrops.push({ drop: (window as any).__hitPrevHp - hp, multNow: mult, multPrev: (window as any).__hitMultPrev });
    }
    (window as any).__hitPrevHp = hp;
    (window as any).__hitMultPrev = mult;
    return (window as any).__hitDrops.length >= 2 && v?.lastTarget === 'player';
  }), 240_000);
  const playerDrops = await page.evaluate(() => (window as any).__hitDrops);
  expect(playerDrops.length, 'player leg recorded hits').toBeGreaterThanOrEqual(2);
  for (const h of playerDrops) {
    const ok = Math.abs(h.drop - specDmg * h.multNow) < 0.01 || Math.abs(h.drop - specDmg * h.multPrev) < 0.01;
    expect(ok, `player hit ${h.drop} matches raw ${specDmg} x mult ${h.multNow}/${h.multPrev}`).toBe(true);
  }

  expect(errors, 'zero console/page errors').toEqual([]);
});

test.describe('companion-combat mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

  test('companion-combat: mobile chip -> panel -> summon -> taunt, 360x780', async ({ page }) => {
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
    await waitFor(page, 'healer summoned on mobile', async () =>
      (await mgr(page)).activeId === 'healer', 60_000);
    await page.click('[data-companion-stance="taunt"]');
    await waitFor(page, 'taunt set on mobile', async () =>
      (await mgr(page)).stance === 'taunt', 30_000);
    expect(errors, 'zero console/page errors').toEqual([]);
  });
});
