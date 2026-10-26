/**
 * CRIT-SYSTEM (upgrade loop) — live player page e2e.
 *
 * Crits are real now: the damage-numbers wave's display-only crit
 * highlight is retired (see that spec's leg 2, now a plain 43 at seed 9).
 *
 * Seeds (mulberry32, verified offline against the game's Rng):
 *   - seed 23 melee stream (seed ^ 0xc217): draws 0.0134 (crit), 0.1936,
 *     0.7076, 0.0789, 0.0494 (crit), 0.7141 — so the first melee crits
 *     for 50 (25 x 2.0) and a 5-melee run yields 25/25/25/50!/25.
 *   - seed 15 ability stream (seed ^ 0xab17): variance draw 0.8528
 *     (43 base), crit draw 0.0410 < 0.05 — dash-strike crits for 86.
 * Both scenes use the empty item table (parity with the damage-numbers
 * spec), so the crit context is the base table: 5% chance, x2.0.
 *
 * Legs share the damage-numbers spec's atomicity rules: placement +
 * action + DOM read in ONE page.evaluate, juice.reset() at each leg's
 * start, camera snapped onto the target, non-target living enemies
 * teleported away (melee/dash are AoE).
 *
 * Zero console/page errors throughout, desktop + 360x780.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

function sceneB64(seed: number): string {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  spec.meta = spec.meta ?? {};
  spec.meta.seed = seed;
  return Buffer.from(JSON.stringify(spec)).toString('base64');
}

async function waitFor(page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 1000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(intervalMs);
  }
}

async function boot(page: any, errors: string[], b64: string) {
  page.on('pageerror', (e: any) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(b64)}&test=1&autostart=1&splash=0`);
  await waitFor(page, 'boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X?.abilitiesTest?.liveManager() && X.engine.state === 'playing'
      && X.engine.portalsPlayerAvatar);
  }), 240_000);
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs') s.despawnAll();
  });
}

// Shared placement snippet, inlined per leg (Playwright serializes
// evaluate functions, so no shared helper can be referenced from inside).
const PLACE = `
  const av = X.engine.portalsPlayerAvatar;
  const target = X.abilitiesTest.liveEnemies().enemies.find((e) => e.alive);
  if (!target) throw new Error('no living enemy to place before');
  for (const e of X.abilitiesTest.liveEnemies().enemies.filter((e) => e.alive && e !== target)) e.position.x += 100;
  const p = target.position;
  av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
  av.ctrl.yaw = Math.PI;
  X.engine.camera.lookAt(p.x, p.y + 1, p.z);
  X.engine.camera.updateMatrixWorld();
`;
const READ_NUMS = `
  const els = Array.from(document.querySelectorAll('.xjuice .dmgnum'));
  const nums = els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
    .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
`;

test.describe('crit system', () => {
  test('seeded melee crit + independent replication + ability crit + panel', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors, sceneB64(23));

    // Leg A — first melee at seed 23 crits: 25 x 2.0 = 50, crit style.
    const legA = await page.evaluate(new Function(`
      const X = (window).__XANDRIA__;
      X.engine.juice.reset();
      ${PLACE}
      target.health = 1000;
      // Shielded-variant targets take x0.3 from front hits (pre-existing
      // enemies-wave mechanic, unrelated to crits): turn the target's
      // rig around so this strike lands from behind at full damage.
      if (target.rig?.group) target.rig.group.rotation.y = Math.PI;
      const before = target.health;
      av.melee(Math.PI, 2.6, 1.3, 25);
      const after = target.health;
      ${READ_NUMS}
      return { before, after, nums };
    `) as () => any);
    expect(legA.before).toBe(1000);
    expect(legA.after).toBe(950);
    expect(legA.nums).toEqual([{ text: '50!', color: 'rgb(255, 138, 92)', fontSize: '27px' }]);

    // Leg B — independent replication: reimplement mulberry32 + the
    // base table in the test and predict melee draws 2..6 of the seed-23
    // stream; the game must match draw for draw.
    const legB = await page.evaluate(new Function(`
      const X = (window).__XANDRIA__;
      X.engine.juice.reset();
      ${PLACE}
      target.health = 1000;
      for (let i = 0; i < 5; i++) av.melee(Math.PI, 2.6, 1.3, 25);
      ${READ_NUMS}
      // Independent replication (no game code): mulberry32 + base table.
      let s = (23 ^ 0xc217) >>> 0 || 0x9e3779b9;
      const next = () => {
        let t = (s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      next(); // leg A consumed draw 1
      const expected = [];
      for (let i = 0; i < 5; i++) {
        const u = next();
        const crit = u < 0.05;
        expected.push(crit
          ? { text: '50!', color: 'rgb(255, 138, 92)', fontSize: '27px' }
          : { text: '25', color: 'rgb(255, 210, 63)', fontSize: '18px' });
      }
      const sort = (a, b) => a.text.localeCompare(b.text);
      return { observed: [...nums].sort(sort), expected: [...expected].sort(sort) };
    `) as () => any);
    expect(legB.observed).toEqual(legB.expected);
    expect(legB.expected.filter((n: any) => n.text === '50!')).toHaveLength(1);

    // Leg C — reload at seed 15: dash-strike crits for 86, lastCast.crits 1.
    await page.goto(`/player.html?spec=${encodeURIComponent(sceneB64(15))}&test=1&autostart=1&splash=0`);
    await waitFor(page, 'reboot', () => page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return !!(X?.engine && X?.abilitiesTest?.liveManager() && X.engine.state === 'playing'
        && X.engine.portalsPlayerAvatar);
    }), 240_000);
    const legC = await page.evaluate(new Function(`
      const X = (window).__XANDRIA__;
      X.engine.juice.reset();
      const systems = X.engine.portalEntities.systems;
      for (const s of systems) if (s.id === 'npcs') s.despawnAll();
      ${PLACE}
      target.health = 1000;
      const m = X.abilitiesTest.liveManager();
      const res = m.cast('dash-strike');
      ${READ_NUMS}
      return { damageDealt: res.damageDealt, crits: m.lastCast?.crits ?? null, nums };
    `) as () => any);
    expect(legC.damageDealt).toBe(86);
    expect(legC.crits).toBe(1);
    expect(legC.nums).toEqual([{ text: '86!', color: 'rgb(255, 138, 92)', fontSize: '27px' }]);

    // Leg D — inventory panel surfaces live crit stats (base table here).
    await page.keyboard.press('i');
    await page.waitForSelector('.xinv .critrow', { timeout: 10_000 });
    const panel = await page.evaluate(() => {
      const row = document.querySelector('.xinv .critrow');
      return row?.textContent ?? '';
    });
    expect(panel).toContain('CRIT 5% chance');
    expect(panel).toContain('×2.0 damage');
    expect(panel).toContain('weapon: common');
    expect(panel).toContain('smithing rank 1');
    await page.keyboard.press('i');

    expect(errors).toEqual([]);
  });
});

test.describe('crit system mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('melee crit renders on mobile with zero errors', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors, sceneB64(23));
    const leg = await page.evaluate(new Function(`
      const X = (window).__XANDRIA__;
      X.engine.juice.reset();
      ${PLACE}
      target.health = 1000;
      av.melee(Math.PI, 2.6, 1.3, 25);
      ${READ_NUMS}
      return nums;
    `) as () => any);
    expect(leg).toEqual([{ text: '50!', color: 'rgb(255, 138, 92)', fontSize: '27px' }]);
    expect(errors).toEqual([]);
  });
});
