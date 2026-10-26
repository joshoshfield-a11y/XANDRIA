/**
 * DAMAGE-NUMBERS (upgrade loop) — live player page e2e.
 *
 * Desktop: boot the deterministic "Forgotten Valley" tp-action scene
 * (seed 9 — chosen so the FIRST ability variance draw is a top-decile
 * crit: mulberry32((9 ^ 0xab17)) first draw u = 0.9221, dash-strike
 * damage 43 at damageMult 1) -> melee number (exact "25", playerDamage
 * style) -> dash-strike crit number -> enemy-damage + heal numbers ->
 * kill numbers incl. "+20 XP" -> toggle off clears + suppresses ->
 * reload restores the setting.
 *
 * ATOMICITY RULE (learned the hard way): placement, action, and DOM
 * read share ONE page.evaluate call per leg, and each leg starts with
 * juice.reset(). Between two evaluates the engine ticks, and an enemy
 * already in range swings on the first tick (attackCd starts 0) —
 * interleaving a retaliation number into the sequence. Inside one JS
 * turn, no engine tick can interleave. (Wall-clock expiry waits do NOT
 * work here: in ?test=1 mode dt is a fixed 1/60 per rendered frame, so
 * at SwiftShader frame rates a 0.9s number life is many wall-seconds.)
 * The placement lines are therefore duplicated inline in each leg
 * (Playwright serializes evaluate functions, so a shared helper cannot
 * be referenced from inside them).
 *
 * Mobile (360x780, hasTouch): a real combat number never overlaps the
 * quest tracker or any touch button (DOM-rect intersection check).
 *
 * Perf leg: floating numbers are a DOM overlay — draw-call delta must
 * be exactly 0, and idle juice.update() must stay near-free.
 *
 * Zero console/page errors throughout (same errors-array pattern as
 * the combat-abilities spec).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

// Same deterministic scene, empty item table (parity with the skills
// spec), and seed 9 for the guaranteed first-cast crit (see header).
// Enemy HP stays at the default 30 so the kill leg can finish a walker
// with two 25-damage melees.
const B64 = (() => {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  spec.meta = spec.meta ?? {};
  spec.meta.seed = 9;
  return Buffer.from(JSON.stringify(spec)).toString('base64');
})();

async function waitFor(page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 1000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(intervalMs);
  }
}

async function boot(page: any, errors: string[]) {
  page.on('pageerror', (e: any) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
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

async function sampleDrawCalls(page: any): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 4; i++) {
    samples.push(await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.renderer.info.render.calls as number;
    }));
    await page.waitForTimeout(100);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

async function readDrawCalls(page: any): Promise<number> {
  return page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.engine.renderer.info.render.calls as number;
  });
}


test.describe('damage numbers', () => {
  test('seeded combat produces the exact number sequence incl. crit styling', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors);

    // Leg 1 — melee: one number, exact text + playerDamage style.
    const melee = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      X.engine.juice.reset();
      const av = X.engine.portalsPlayerAvatar;
      const target = X.abilitiesTest.liveEnemies().enemies.find((e: any) => e.alive);
      if (!target) throw new Error('no living enemy to place before');
      // Hermetic: melee/dash are AoE and walkers cluster on the player —
      // move every other living enemy 100m away so only the target is hit.
      for (const e of X.abilitiesTest.liveEnemies().enemies.filter((e: any) => e.alive && e !== target)) e.position.x += 100;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      // Snap the camera onto the target: a teleport does not move the
      // camera yaw, and a number behind the camera is hidden by design
      // (Juice.place hides projected z > 1). lookAt + matrix update so
      // the same-turn projection sees the new orientation.
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      av.melee(Math.PI, 2.6, 1.3, 25);
      const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
      return els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
        .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
    });
    expect(melee).toEqual([{ text: '25', color: 'rgb(255, 210, 63)', fontSize: '18px' }]);

    // Leg 2 — ability crit: first manager draw is the seeded top-decile
    // roll (u = 0.9221 -> 43 damage, crit style). cast() with no aimDir
    // defaults to (0,0,1) — exactly toward the placed enemy.
    const crit = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      X.engine.juice.reset();
      const av = X.engine.portalsPlayerAvatar;
      const target = X.abilitiesTest.liveEnemies().enemies.find((e: any) => e.alive);
      if (!target) throw new Error('no living enemy to place before');
      // Hermetic: melee/dash are AoE and walkers cluster on the player —
      // move every other living enemy 100m away so only the target is hit.
      for (const e of X.abilitiesTest.liveEnemies().enemies.filter((e: any) => e.alive && e !== target)) e.position.x += 100;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      // Snap the camera onto the target: a teleport does not move the
      // camera yaw, and a number behind the camera is hidden by design
      // (Juice.place hides projected z > 1). lookAt + matrix update so
      // the same-turn projection sees the new orientation.
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      // Raise HP so the 43-damage crit does NOT kill (a kill would add
      // a "+20 XP" number to this leg's exact assertion).
      target.health = 1000;
      const m = X.abilitiesTest.liveManager();
      const res = m.cast('dash-strike');
      const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
      const nums = els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
        .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
      return { damageDealt: res.damageDealt, nums };
    });
    expect(crit.damageDealt).toBe(43);
    expect(crit.nums).toEqual([{ text: '43!', color: 'rgb(255, 138, 92)', fontSize: '27px' }]);

    // Leg 3 — damage taken + heal: enemyDamage ('−' prefix, danger
    // role) then heal ('+' prefix, good role, actual restored only:
    // 100 -> 80 -> heal 30 restores 20).
    const dmgHeal = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      X.engine.juice.reset();
      const av = X.engine.portalsPlayerAvatar;
      // Pin state: enemy swings between legs may have chipped HP and
      // left i-frames, which would swallow damage(20) outright.
      av.health = av.maxHealth;
      (av as unknown as { iframes: number }).iframes = 0;
      av.damage(20);
      av.heal(30);
      const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
      return els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
        .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
    });
    // Multiset (see leg 4 note): pool slot order is not spawn order
    // once the cursor wraps, so DOM order can scramble the pair.
    const sortedDmgHeal = [...dmgHeal].sort((a, b) => a.text.localeCompare(b.text));
    expect(sortedDmgHeal).toEqual([
      { text: '−20', color: 'rgb(255, 77, 94)', fontSize: '18px' },
      { text: '+20', color: 'rgb(143, 227, 168)', fontSize: '18px' },
    ].sort((a, b) => a.text.localeCompare(b.text)));

    // Leg 4 — kill: two melees finish a 30-HP walker; the kill grants
    // xpPerKill * the target's xpMult as its own number (info role).
    // Hermetic: melee is AoE and walkers cluster on the player, so all
    // OTHER living enemies are teleported 100m away first — otherwise a
    // second walker dies and adds its own XP number.
    const kill = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      X.engine.juice.reset();
      const av = X.engine.portalsPlayerAvatar;
      const living = X.abilitiesTest.liveEnemies().enemies.filter((e: any) => e.alive);
      const target = living[0];
      if (!target) throw new Error('no living enemy to place before');
      for (const e of living.slice(1)) e.position.x += 100;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      // Snap the camera onto the target: a teleport does not move the
      // camera yaw, and a number behind the camera is hidden by design
      // (Juice.place hides projected z > 1). lookAt + matrix update so
      // the same-turn projection sees the new orientation.
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      // Pin HP to 30: the first living enemy may be the one leg 2 left
      // at 957 HP — two 25s must kill it for the XP leg.
      target.health = 30;
      const xpMult = target.xpMult ?? 1;
      av.melee(Math.PI, 2.6, 1.3, 25);
      av.melee(Math.PI, 2.6, 1.3, 25);
      const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
      return {
        xpMult,
        nums: els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
          .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize })),
      };
    });
    // Multiset, not sequence: pool slot order is NOT spawn order once the
    // cursor wraps (cap 20), so DOM order can scramble a leg's numbers.
    // The first kill also unlocks the first-blood achievement (+25 XP)
    // on top of the kill XP (+20 * xpMult).
    const sortedKill = [...kill.nums].sort((a, b) => a.text.localeCompare(b.text));
    expect(sortedKill).toEqual([
      { text: '25', color: 'rgb(255, 210, 63)', fontSize: '18px' },
      { text: '25', color: 'rgb(255, 210, 63)', fontSize: '18px' },
      { text: '+25 XP', color: 'rgb(125, 211, 252)', fontSize: '16px' },
      { text: `+${20 * kill.xpMult} XP`, color: 'rgb(125, 211, 252)', fontSize: '16px' },
    ].sort((a, b) => a.text.localeCompare(b.text)));

    // Leg 5 — toggle off: clears live numbers and suppresses new ones.
    const toggle = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      X.engine.juice.reset();
      const av = X.engine.portalsPlayerAvatar;
      const target = X.abilitiesTest.liveEnemies().enemies.find((e: any) => e.alive);
      if (!target) throw new Error('no living enemy to place before');
      // Hermetic: melee/dash are AoE and walkers cluster on the player —
      // move every other living enemy 100m away so only the target is hit.
      for (const e of X.abilitiesTest.liveEnemies().enemies.filter((e: any) => e.alive && e !== target)) e.position.x += 100;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      // Snap the camera onto the target: a teleport does not move the
      // camera yaw, and a number behind the camera is hidden by design
      // (Juice.place hides projected z > 1). lookAt + matrix update so
      // the same-turn projection sees the new orientation.
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      const read = () => {
        const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
        return els.filter((el) => parseFloat(el.style.opacity || '0') > 0).length;
      };
      av.melee(Math.PI, 2.6, 1.3, 25);
      const before = read();
      X.engine.settings.set({ floatingText: false });
      X.engine.applySettings();
      const cleared = read();
      av.melee(Math.PI, 2.6, 1.3, 25);
      const suppressed = read();
      return { before, cleared, suppressed };
    });
    expect(toggle.before).toBeGreaterThan(0);
    expect(toggle.cleared).toBe(0);
    expect(toggle.suppressed).toBe(0);

    // Leg 6 — reload restores the persisted setting (still off), then
    // turning it back on restores numbers.
    await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
    await waitFor(page, 'reboot', () => page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return !!(X?.engine && X?.abilitiesTest?.liveManager() && X.engine.state === 'playing'
        && X.engine.portalsPlayerAvatar);
    }), 240_000);
    const restored = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.settings.data.floatingText;
    });
    expect(restored).toBe(false);
    const backOn = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      X.engine.juice.reset();
      const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
      for (const s of systems) if (s.id === 'npcs') s.despawnAll();
      X.engine.settings.set({ floatingText: true });
      X.engine.applySettings();
      const av = X.engine.portalsPlayerAvatar;
      const target = X.abilitiesTest.liveEnemies().enemies.find((e: any) => e.alive);
      if (!target) throw new Error('no living enemy to place before');
      // Hermetic: melee/dash are AoE and walkers cluster on the player —
      // move every other living enemy 100m away so only the target is hit.
      for (const e of X.abilitiesTest.liveEnemies().enemies.filter((e: any) => e.alive && e !== target)) e.position.x += 100;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      // Snap the camera onto the target: a teleport does not move the
      // camera yaw, and a number behind the camera is hidden by design
      // (Juice.place hides projected z > 1). lookAt + matrix update so
      // the same-turn projection sees the new orientation.
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      av.melee(Math.PI, 2.6, 1.3, 25);
      const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
      return els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
        .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
    });
    expect(backOn).toEqual([{ text: '25', color: 'rgb(255, 210, 63)', fontSize: '18px' }]);

    expect(errors).toEqual([]);
  });

  test('perf: floating numbers add zero draw calls; idle update is near-free', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors);
    // Drift-stable scene (INSTANCING.md method): despawn enemies so the
    // only delta between samples is the numbers themselves.
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
      for (const s of systems) if (s.id === 'enemies') s.despawnAll();
    });
    // Settle-wait: the scene's draw count is NOT run-stable (439 vs 573
    // vs ~900 across runs — streaming/settling transients), so wait for
    // a plateau before measuring. Then INTERLEAVE base/with rounds so
    // any residual slow drift hits both arms equally.
    let stable = 0;
    let last = -1;
    for (let i = 0; i < 120 && stable < 6; i++) {
      const c = await readDrawCalls(page);
      stable = (c === last) ? stable + 1 : 0;
      last = c;
      await page.waitForTimeout(250);
    }
    const bases: number[] = [];
    const withs: number[] = [];
    for (let r = 0; r < 3; r++) {
      bases.push(await sampleDrawCalls(page));
      await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        const juice = X.engine.juice;
        const cam = X.engine.camera;
        const wp = { x: 0, y: 0, z: -5 };
        for (let i = 0; i < 20; i++) juice.spawnText(cam, wp, 'playerDamage', 10);
      });
      withs.push(await sampleDrawCalls(page));
      await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        X.engine.juice.reset();
      });
    }
    const med = (xs: number[]) => {
      const s2 = [...xs].sort((a, b) => a - b);
      return s2[Math.floor(s2.length / 2)];
    };
    const base = med(bases);
    const withNumbers = med(withs);
    const perf = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const juice = X.engine.juice;
      const cam = X.engine.camera;
      const wp = { x: 0, y: 0, z: -5 };
      // Min-of-3: a single loop pass under load spikes; the minimum is
      // the contention-free cost (standard microbenchmark practice).
      let idleMs = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        for (let i = 0; i < 2000; i++) juice.update(0.016, cam);
        idleMs = Math.min(idleMs, performance.now() - t0);
      }
      for (let i = 0; i < 20; i++) juice.spawnText(cam, wp, 'playerDamage', 10);
      const t1 = performance.now();
      for (let i = 0; i < 2000; i++) juice.update(0.016, cam);
      const activeMs = performance.now() - t1;
      return { idleMs, activeMs };
    });
    // eslint-disable-next-line no-console
    console.log(`damage-numbers perf: bases=${bases} withs=${withs} base=${base} withNumbers=${withNumbers} idle2000min=${perf.idleMs.toFixed(2)}ms active2000=${perf.activeMs.toFixed(2)}ms`);
    expect(withNumbers - base).toBe(0);
    expect(perf.idleMs).toBeLessThan(5);
    expect(errors).toEqual([]);
  });
});

test.describe('damage numbers mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('numbers never cover the quest tracker or ability buttons', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors);
    const overlap = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.engine.portalsPlayerAvatar;
      const target = X.abilitiesTest.liveEnemies().enemies.find((e: any) => e.alive);
      if (!target) throw new Error('no living enemy to place before');
      // Hermetic: melee/dash are AoE and walkers cluster on the player —
      // move every other living enemy 100m away so only the target is hit.
      for (const e of X.abilitiesTest.liveEnemies().enemies.filter((e: any) => e.alive && e !== target)) e.position.x += 100;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      // Snap the camera onto the target: a teleport does not move the
      // camera yaw, and a number behind the camera is hidden by design
      // (Juice.place hides projected z > 1). lookAt + matrix update so
      // the same-turn projection sees the new orientation.
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      av.melee(Math.PI, 2.6, 1.3, 25);
      const nums = (Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[])
        .filter((el) => parseFloat(el.style.opacity || '0') > 0);
      const rects = (sel: string) => (Array.from(document.querySelectorAll(sel)) as HTMLElement[])
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      const tracker = rects('#xandria-quest-tracker');
      const buttons = rects('.tbtn');
      const hits = (a: DOMRect, b: DOMRect) =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const bad: string[] = [];
      for (const n of nums) {
        const r = n.getBoundingClientRect();
        if (tracker.some((t) => hits(r, t))) bad.push(`tracker:${n.textContent}`);
        if (buttons.some((b) => hits(r, b))) bad.push(`button:${n.textContent}`);
      }
      return {
        count: nums.length,
        trackerFound: tracker.length > 0,
        buttonCount: buttons.length,
        bad,
      };
    });
    expect(overlap.count).toBeGreaterThan(0);
    expect(overlap.buttonCount).toBeGreaterThan(0);
    expect(overlap.bad).toEqual([]);
    expect(errors).toEqual([]);
  });
});
