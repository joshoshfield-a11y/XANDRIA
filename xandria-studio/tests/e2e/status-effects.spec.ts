/**
 * STATUS-EFFECTS (upgrade loop): e2e for the data-driven status system.
 * Conventions follow crit-system.spec.ts: the npcs.b64 fixture re-encoded
 * per seed, empty item table, boot + despawn the `npcs` portal system,
 * placement + action + read in ONE page.evaluate, game-time waits poll
 * engine.time (never wall-clock), codex opened via the B key (the
 * BESTIARY/MOUNTS chip overlap bug is pre-existing — never click the chip).
 *
 * Stat-math order under test: ability/melee damage is computed first
 * (variance, crit, resistance — all unchanged); the status chance roll
 * happens AFTER, on a dedicated seeded stream; tick damage is flat
 * table damage, bypassing shields, respecting damageTakenMult.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

function sceneB64(seed: number): string {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.meta.seed = seed;
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  spec.enemies = [{ kind: 'walker', count: 6, health: 30, speed: 4.5, damage: 9, weapon: 'melee' }];
  return Buffer.from(JSON.stringify(spec)).toString('base64');
}

/** Wait until engine.time reaches `t` (game time, polled from Node). */
async function waitTime(page: Page, t: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    const now = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X?.engine?.time ?? -1;
    });
    if (now >= t) return;
    if (Date.now() - start > 180_000) throw new Error(`waitTime timeout: ${label} (now=${now}, want>=${t})`);
    await page.waitForTimeout(200);
  }
}

async function gameTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.engine.time as number;
  });
}

/** Median of 10 render-call samples (INSTANCING.md method). */
async function medianCalls(page: Page): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    samples.push(await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.renderer.info.render.calls as number;
    }));
    await page.waitForTimeout(150);
  }
  samples.sort((a, b) => a - b);
  return samples[10];
}

async function boot(page: Page, errors: string[], specB64: string): Promise<void> {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`/player.html?spec=${encodeURIComponent(specB64)}&test=1&autostart=1&splash=0`);
  const start = Date.now();
  for (;;) {
    const ready = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return !!(X?.engine && X?.statusTest?.liveAvatar() && X?.abilitiesTest?.liveManager()
        && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
    }).catch(() => false);
    if (ready) break;
    if (Date.now() - start > 240_000) throw new Error('boot timeout');
    await page.waitForTimeout(250);
  }
  // Despawn the portal NPCs so only the enemy roster is live.
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = X.engine.portalEntities.systems as Array<{ id: string; despawnAll(): void }>;
    for (const s of systems) if (s.id === 'npcs') s.despawnAll();
  });
}

/** Teleport an enemy's physics body; position reads are clones, so the body must move. */
const MOVE_ENEMY = `
  const moveEnemy = (e, x, y, z) => {
    if (e.body) { e.body.position.set(x, y, z); e.body.velocity.setZero(); e.body.angularVelocity.setZero(); }
  };
`;

/** Park the player far from every enemy and make the avatar effectively unkillable. */
const PARK_PLAYER = `
  const av = X.statusTest.liveAvatar();
  av.health = 100000; av.maxHealth = 100000;
  const V = av.ctrl.position.constructor;
  av.ctrl.teleport(new V(500, 60, 500));
`;

test.describe('status effects', () => {
  test('tick damage/duration/slow/stun, refresh, chain, seeded ability rolls, rest cleanse, codex, perf', async ({ page }) => {
    test.setTimeout(600_000);
    const errors: string[] = [];
    await boot(page, errors, sceneB64(23));

    // --- Leg 1: exact tick damage + duration for all four statuses ---------
    // One fresh high-HP walker per status (tracked by roster index);
    // force-apply via the funnel with roll 0 (always passes) so the leg
    // asserts the TICK contract, not the chance roll (the roll is covered
    // by the seeded ability leg below).
    const TICK_CASES = [
      { id: 'burn', tick: 3, interval: 1, duration: 4, total: 12 },
      { id: 'frost-slow', tick: 1, interval: 1, duration: 3, total: 3 },
      { id: 'shock', tick: 2, interval: 0.5, duration: 2, total: 8 },
      { id: 'poison', tick: 2, interval: 1, duration: 5, total: 10 },
    ];
    for (let i = 0; i < TICK_CASES.length; i++) {
      const c = TICK_CASES[i];
      const started = await page.evaluate(new Function(`
        const X = window.__XANDRIA__;
        ${PARK_PLAYER}
        const mgr = X.statusTest.liveEnemies();
        const idx = ${i};
        const target = mgr.enemies[idx];
        target.health = 1000;
        const out = target.applyStatus('${c.id}', { roll: 0, now: X.engine.time });
        return { applied: out.applied, t0: X.engine.time, hp0: target.health };
      `) as () => { applied: boolean; t0: number; hp0: number });
      expect(started.applied).toBe(true);
      // Mid-leg: exactly one tick after the first interval.
      await waitTime(page, started.t0 + c.interval + 0.15, `${c.id} first tick`);
      const mid = await page.evaluate(new Function(`
        const X = window.__XANDRIA__;
        const target = X.statusTest.liveEnemies().enemies[${i}];
        return { hp: target.health, ids: target.activeStatuses() };
      `) as () => { hp: number; ids: string[] });
      expect(mid.ids).toEqual([c.id]);
      expect(mid.hp).toBe(started.hp0 - c.tick);
      // End: expiry reached, total damage exact, instance pruned.
      await waitTime(page, started.t0 + c.duration + 0.3, `${c.id} expiry`);
      const end = await page.evaluate(new Function(`
        const X = window.__XANDRIA__;
        const target = X.statusTest.liveEnemies().enemies[${i}];
        return { hp: target.health, ids: target.activeStatuses() };
      `) as () => { hp: number; ids: string[] });
      expect(end.ids).toEqual([]);
      expect(end.hp).toBe(started.hp0 - c.total);
    }

    // --- Leg 2: refresh extends without stacking (roster index 4) ----------
    const refreshed = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      ${PARK_PLAYER}
      const target = X.statusTest.liveEnemies().enemies[4];
      target.health = 1000;
      target.applyStatus('burn', { roll: 0, now: X.engine.time });
      return { t0: X.engine.time, hp0: target.health };
    `) as () => { t0: number; hp0: number });
    await waitTime(page, refreshed.t0 + 1.5, 'refresh window');
    const reapplied = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const target = X.statusTest.liveEnemies().enemies[4];
      const out = target.applyStatus('burn', { roll: 0, now: X.engine.time });
      const ids = target.activeStatuses();
      return { refreshed: out.refreshed, count: ids.length, hp: target.health, tRefresh: X.engine.time };
    `) as () => { refreshed: boolean; count: number; hp: number; tRefresh: number });
    expect(reapplied.refreshed).toBe(true);
    expect(reapplied.count).toBe(1); // one instance, not a stack
    expect(reapplied.hp).toBe(refreshed.hp0 - 3); // exactly one tick so far
    // The old expiry (t0+4) passes with the instance still alive: the
    // refresh extended it. Ticks at 1,2,3,4 have fired by t0+4.2.
    await waitTime(page, refreshed.t0 + 4.2, 'old expiry passed');
    const stillActive = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const target = X.statusTest.liveEnemies().enemies[4];
      return { hp: target.health, ids: target.activeStatuses() };
    `) as () => { hp: number; ids: string[] });
    expect(stillActive.ids).toEqual(['burn']);
    expect(stillActive.hp).toBe(refreshed.hp0 - 12);
    // Expiry is measured from the ACTUAL refresh frame (evaluate latency
    // under SwiftShader makes the refresh land after t0+1.5), so wait
    // from tRefresh, not from t0.
    await waitTime(page, reapplied.tRefresh + 4 + 0.3, 'refreshed expiry');
    const refreshedEnd = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const target = X.statusTest.liveEnemies().enemies[4];
      return { hp: target.health, ids: target.activeStatuses() };
    `) as () => { hp: number; ids: string[] });
    expect(refreshedEnd.ids).toEqual([]);
    expect(refreshedEnd.hp).toBe(refreshed.hp0 - 15); // 1 tick + 4 ticks, never double

    // --- Leg 3: frost-slow halves chase displacement (roster index 5) ------
    const slow = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const av = X.statusTest.liveAvatar();
      av.health = 100000; av.maxHealth = 100000;
      const target = X.statusTest.liveEnemies().enemies[5];
      target.health = 1000;
      const p = target.position;
      const V = av.ctrl.position.constructor;
      av.ctrl.teleport(new V(p.x + 15, p.y + 0.5, p.z));
      return { t0: X.engine.time, x: p.x, z: p.z };
    `) as () => { t0: number; x: number; z: number });
    await waitTime(page, slow.t0 + 1.0, 'slow baseline window');
    const slowMid = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const target = X.statusTest.liveEnemies().enemies[5];
      const p = target.position;
      target.applyStatus('frost-slow', { roll: 0, now: X.engine.time });
      return { t1: X.engine.time, x: p.x, z: p.z, mult: target.statusSpeedMult() };
    `) as () => { t1: number; x: number; z: number; mult: number });
    expect(slowMid.mult).toBe(0.5);
    await waitTime(page, slowMid.t1 + 1.0, 'slow window');
    const slowEnd = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const target = X.statusTest.liveEnemies().enemies[5];
      const p = target.position;
      return { x: p.x, z: p.z };
    `) as () => { x: number; z: number });
    const dUnslowed = Math.hypot(slowMid.x - slow.x, slowMid.z - slow.z);
    const dSlowed = Math.hypot(slowEnd.x - slowMid.x, slowEnd.z - slowMid.z);
    expect(dUnslowed).toBeGreaterThan(2); // the walker was chasing
    expect(dSlowed).toBeGreaterThan(0.3); // still moving, not frozen
    expect(dSlowed / dUnslowed).toBeGreaterThan(0.3);
    expect(dSlowed / dUnslowed).toBeLessThan(0.7); // ~0.5 expected

    // --- Leg 4: shock stun freezes movement + chains to the nearest foe ---
    const chain = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      ${MOVE_ENEMY}
      ${PARK_PLAYER}
      const mgr = X.statusTest.liveEnemies();
      const alive = mgr.enemies;
      const primary = alive[0]; const near = alive[1]; const far = alive[2];
      primary.health = 1000; near.health = 1000; far.health = 1000;
      // Primary 3m from the player park point, near 3m from primary (inside
      // the 5m chain radius), far 100m away (outside it).
      moveEnemy(primary, 500, 60, 503);
      moveEnemy(near, 500, 60, 506);
      moveEnemy(far, 600, 60, 600);
      for (const e of alive.slice(3)) moveEnemy(e, 700, 60, 700);
      const n = X.statusTest.applyStatusWithChain(primary, alive, 'shock', 0, X.engine.time);
      const p = primary.position;
      return { n, t0: X.engine.time, px: p.x, pz: p.z,
        primaryIds: primary.activeStatuses(),
        nearIds: near.activeStatuses(),
        farIds: far.activeStatuses() };
    `) as () => { n: number; t0: number; px: number; pz: number; primaryIds: string[]; nearIds: string[]; farIds: string[] });
    expect(chain.n).toBe(2);
    expect(chain.primaryIds).toEqual(['shock']);
    expect(chain.nearIds).toEqual(['shock']);
    expect(chain.farIds).toEqual([]);
    await waitTime(page, chain.t0 + 1.0, 'stun window');
    const stunEnd = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const primary = X.statusTest.liveEnemies().enemies[0];
      const p = primary.position;
      return { x: p.x, z: p.z, stunned: primary.isStunned() };
    `) as () => { x: number; z: number; stunned: boolean });
    expect(stunEnd.stunned).toBe(true);
    expect(Math.hypot(stunEnd.x - chain.px, stunEnd.z - chain.pz)).toBeLessThan(0.15);

    // --- Leg 5: seeded ability-path replication ----------------------------
    // The status stream is dedicated (seed ^ STATUS_ABILITY_SALT) and draws
    // once per damaging hit, in roster order. No ability has been cast yet
    // this boot, so draw 1 = shockwave-slam, draw 2 = dash-strike.
    // Target: roster index 3 (never statused before); the rest are parked
    // 200m away so exactly one enemy is in range per cast.
    const predicted = (() => {
      let s = (23 ^ 0x5717) >>> 0 || 0x9e3779b9;
      const next = () => {
        let t = (s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      return { shock: next() < 0.3, frost: next() < 0.35 };
    })();
    const abilityLeg = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      ${MOVE_ENEMY}
      const av = X.statusTest.liveAvatar();
      av.health = 100000; av.maxHealth = 100000;
      const mgr = X.statusTest.liveEnemies();
      const alive = mgr.enemies;
      const target = alive[3];
      target.health = 1000;
      const p = target.position;
      const V = av.ctrl.position.constructor;
      av.ctrl.teleport(new V(p.x, p.y + 0.5, p.z - 3));
      for (let i = 0; i < alive.length; i++) if (i !== 3) moveEnemy(alive[i], 700, 60, 700);
      const m = X.statusTest.liveAbilities();
      const res = m.cast('shockwave-slam');
      const ids = target.activeStatuses();
      // Skip the wait: reset energy/cooldowns (test-only) so the second
      // real cast can fire immediately; the cast itself is real. The
      // default dash aim is +z, where the target sits 3m away.
      m.energy = 100;
      for (const k of ['dash-strike', 'shockwave-slam']) m.cooldowns.set(k, 0);
      const res2 = m.cast('dash-strike');
      const ids2 = target.activeStatuses();
      return { shockOk: res.ok, ids, dashOk: res2.ok, ids2 };
    `) as () => { shockOk: boolean; ids: string[]; dashOk: boolean; ids2: string[] });
    expect(abilityLeg.shockOk).toBe(true);
    expect(abilityLeg.ids).toEqual(predicted.shock ? ['shock'] : []);
    expect(abilityLeg.dashOk).toBe(true);
    // Both casts happen in one frame, so the shock instance (if any) is
    // still active when the dash roll lands; insertion order is shock,
    // then frost-slow.
    const expected2 = [...(predicted.shock ? ['shock'] : []), ...(predicted.frost ? ['frost-slow'] : [])];
    expect(abilityLeg.ids2).toEqual(expected2);

    // --- Leg 6: player burn ticks, camp rest clears -------------------------
    const playerLeg = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      ${MOVE_ENEMY}
      const av = X.statusTest.liveAvatar();
      av.health = 50; av.maxHealth = 100;
      av.clearStatuses();
      const mgr = X.statusTest.liveEnemies();
      for (const e of mgr.enemies) moveEnemy(e, 700, 60, 700);
      const V = av.ctrl.position.constructor;
      av.ctrl.teleport(new V(500, 60, 500));
      const out = av.applyStatus('burn', { roll: 0, now: X.engine.time });
      return { applied: out.applied, t0: X.engine.time, hp0: av.health };
    `) as () => { applied: boolean; t0: number; hp0: number });
    expect(playerLeg.applied).toBe(true);
    await waitTime(page, playerLeg.t0 + 1.15, 'player burn tick');
    const playerMid = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.statusTest.liveAvatar();
      return { hp: av.health, ids: av.activeStatuses() };
    });
    expect(playerMid.ids).toEqual(['burn']);
    expect(playerMid.hp).toBe(playerLeg.hp0 - 3);
    const restLeg = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const camp = X.statusTest.liveCamp();
      // The cleanse under test rides rest(); the rest point itself is
      // already covered by camp.spec.ts, so unlock it directly here.
      camp.built_ = ['rest'];
      const res = camp.rest();
      const av = X.statusTest.liveAvatar();
      return { ok: res.ok, hp: av.health, ids: av.activeStatuses() };
    `) as () => { ok: boolean; hp: number; ids: unknown[] });
    expect(restLeg.ok).toBe(true);
    expect(restLeg.ids).toEqual([]);
    expect(restLeg.hp).toBe(100);
    // No further ticks after the cleanse.
    await waitTime(page, playerLeg.t0 + 2.3, 'post-rest window');
    const afterRest = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.statusTest.liveAvatar();
      return { hp: av.health, ids: av.activeStatuses() };
    });
    expect(afterRest.ids).toEqual([]);
    expect(afterRest.hp).toBe(100);

    // --- Leg 7: perf — statuses active must not add draw calls -------------
    // Settle first: the player lands at ground level next to a parked
    // enemy and nothing chases, so both samples see the same settled
    // scene (INSTANCING.md: deterministic scene, median of samples).
    await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      ${MOVE_ENEMY}
      const av = X.statusTest.liveAvatar();
      av.health = 100000; av.maxHealth = 100000;
      av.clearStatuses();
      const mgr = X.statusTest.liveEnemies();
      // Ground-level placement (terrain height, no 60m fall): the fall
      // changed the visible scene between samples and faked a -379 delta.
      const hAt = (x, z) => (X.engine.terrain ? X.engine.terrain.heightAt(x, z) ?? 0 : 0);
      for (const e of mgr.enemies) moveEnemy(e, 700, hAt(700, 700) + 1, 700);
      const V = av.ctrl.position.constructor;
      av.ctrl.teleport(new V(500, hAt(500, 500) + 1, 500));
    `) as () => void);
    const tSettle = await gameTime(page);
    await waitTime(page, tSettle + 2.0, 'perf settle');
    const callsBefore = await medianCalls(page);
    await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const mgr = X.statusTest.liveEnemies();
      for (const e of mgr.enemies) {
        e.health = 1000;
        e.applyStatus('burn', { roll: 0, now: X.engine.time });
        e.applyStatus('poison', { roll: 0, now: X.engine.time });
      }
    `) as () => void);
    const tNow = await gameTime(page);
    await waitTime(page, tNow + 1.5, 'burst expiry');
    const callsAfter = await medianCalls(page);
    // Perf evidence for REPORT.md (median of 20 samples, settled scene).
    console.log(`PERF status-effects: baseline=${callsBefore} active=${callsAfter} delta=${callsAfter - callsBefore}`);
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(1);

    // --- Leg 8: bestiary codex shows status lines from the same table ------
    await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const av = X.statusTest.liveAvatar();
      const mgr = X.statusTest.liveEnemies();
      const target = mgr.enemies.find((e) => e.alive);
      target.health = 5;
      const p = target.position;
      const V = av.ctrl.position.constructor;
      av.ctrl.teleport(new V(p.x, p.y + 0.5, p.z - 2.0));
      av.melee(Math.PI, 2.6, 1.3, 25);
    `) as () => void);
    await page.waitForTimeout(500);
    await page.keyboard.press('b');
    await page.waitForFunction(() => {
      const el = document.getElementById('xandria-bestiary-panel') as HTMLElement | null;
      return el?.style.display === 'flex';
    }, undefined, { timeout: 30_000 });
    const codexText = await page.evaluate(
      () => document.getElementById('xandria-bestiary-panel')!.textContent ?? '');
    expect(codexText).toContain('STATUS EFFECTS');
    expect(codexText).toContain('Burn — 3 damage every 1s for 4s (12 total)');
    expect(codexText).toContain('Frost Slow — 1 damage every 1s for 3s');
    expect(codexText).toContain('Shock — 2 damage every 0.5s for 2s (8 total)');
    expect(codexText).toContain('Poison — 2 damage every 1s for 5s (10 total)');
    await page.keyboard.press('Escape');

    expect(errors).toEqual([]);
  });
});

test.describe('status effects mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('burn ticks on mobile + codex fits the viewport, zero errors', async ({ page }) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    await boot(page, errors, sceneB64(23));
    const started = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      ${PARK_PLAYER}
      const target = X.statusTest.liveEnemies().enemies[0];
      target.health = 1000;
      target.applyStatus('burn', { roll: 0, now: X.engine.time });
      return { t0: X.engine.time, hp0: target.health };
    `) as () => { t0: number; hp0: number });
    await waitTime(page, started.t0 + 1.15, 'mobile burn tick');
    const mid = await page.evaluate(new Function(`
      const X = window.__XANDRIA__;
      const target = X.statusTest.liveEnemies().enemies[0];
      return { hp: target.health, ids: target.activeStatuses() };
    `) as () => { hp: number; ids: string[] });
    expect(mid.ids).toEqual(['burn']);
    expect(mid.hp).toBe(started.hp0 - 3);
    await page.keyboard.press('b');
    await page.waitForFunction(() => {
      const el = document.getElementById('xandria-bestiary-panel') as HTMLElement | null;
      return el?.style.display === 'flex';
    }, undefined, { timeout: 30_000 });
    const box = await page.evaluate(() => {
      const el = document.getElementById('xandria-bestiary-panel') as HTMLElement | null;
      const r = el!.getBoundingClientRect();
      return { width: r.width, left: r.left };
    });
    expect(box.width).toBeLessThanOrEqual(360);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(errors).toEqual([]);
  });
});
