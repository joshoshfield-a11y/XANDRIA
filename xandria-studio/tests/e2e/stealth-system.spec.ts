/**
 * STEALTH-SYSTEM (upgrade loop) — live player page e2e.
 *
 * Detection is radius + noise only (no line-of-sight — disclosed in
 * stealth.ts and the phase REPORT.md). Awareness gates chase/attack
 * with weights unaware 0 / suspicious 0 / alerted 100; a strike from
 * unaware takes the CRIT_TABLE multiplier once (25 -> 50, base table)
 * and consumes NO crit draw. Sneak is hold-Ctrl (fixed secondary) /
 * hold-SNEAK touch button; sneaking halves speed and silences movement.
 *
 * Fixture: the npcs.b64 "Forgotten Valley" scene, meta.seed forced to 23
 * (the crit spec's seed, so the melee crit stream replicates identically
 * and the sneak strike's no-draw property is provable).
 *
 * Atomicity rules (crit spec): placement + action + read in ONE
 * evaluate; juice.reset() at each leg's start; non-target enemies moved
 * 200m away via their physics bodies; shield/affix damage mods zeroed
 * on the target so HP drops are exact.
 *
 * Zero console/page errors throughout, desktop + 360x780 (touch leg).
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
    return !!(X?.engine && X?.stealthTest && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs') s.despawnAll();
    const av = X.engine.portalsPlayerAvatar;
    av.health = av.maxHealth = 1e9;
  });
}

/** Move every living enemy except `keep` 200m away (physics bodies). */
const BANISH_OTHERS = `
  for (const e of X.abilitiesTest.liveEnemies().enemies) {
    if (!e.alive || e === keep) continue;
    if (e.body) { e.body.position.x += 200; e.body.position.z += 200; }
  }
`;

/** Calm every living enemy: player 200m away until all are unaware. */
async function calmAll(page: any) {
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    // Far from the spawn ring AND from the +200/+200 banish zone used
    // by the legs (banished enemies sit near (+200, +200)).
    av.ctrl.teleport({ x: -300, y: 60, z: -300 });
  });
  await waitFor(page, 'calm', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.abilitiesTest.liveEnemies();
    return M.enemies.filter((e: any) => e.alive).every((e: any) => e.awareness === 'unaware');
  // testMode advances 1/6 sim-second per rendered frame (10 substeps x
  // 1/60), so the 4s suspicion decay needs ~24 frames; SwiftShader
  // frames are seconds-long, hence the long wall-clock budget.
  }), 180_000, 1000);
}

const READ_NUMS = `
  const els = Array.from(document.querySelectorAll('.xjuice .dmgnum'));
  const nums = els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
    .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
`;

test.describe('stealth system', () => {
  test('sneak-past, standing escalation, noise, sneak-attack bonus, perf', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    await boot(page, errors, sceneB64(23));
    await calmAll(page);

    const buckets0: any = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.enemyTest.enemyInstancerStats();
    });

    // ---- Leg A: sneak-past at 20m (inside standing radius, outside
    // sneak radius) stays unaware; HUD chip shows SNEAKING. ----
    await page.keyboard.down('Control');
    await page.waitForFunction(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.portalsPlayerAvatar.ctrl.sneaking === true;
    }, undefined, { timeout: 60_000 });
    const legA = await page.evaluate(new Function(`
      const X = (window).__XANDRIA__;
      const M = X.abilitiesTest.liveEnemies();
      const keep = M.enemies.find((e) => e.alive);
      ${BANISH_OTHERS}
      const av = X.engine.portalsPlayerAvatar;
      const p = keep.position;
      av.ctrl.teleport({ x: p.x + 20, y: p.y + 2, z: p.z });
      return { awareness: keep.awareness, sneakRadius: keep.effectiveDetectionRadius(true),
               standRadius: keep.effectiveDetectionRadius(false), sneaking: av.ctrl.sneaking,
               frame: X.engine.frame };
    `) as () => any);
    expect(legA.sneaking).toBe(true);
    expect(legA.standRadius).toBeGreaterThan(20);
    expect(legA.sneakRadius).toBeLessThan(20);
    // Exposure proof: wait until 2 rendered frames have run with the
    // player in range (SwiftShader frames are seconds-long; a fixed
    // wall-clock wait proves nothing about enemy updates).
    await page.waitForFunction((f0: number) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.frame >= f0 + 2;
    }, legA.frame, { timeout: 120_000 });
    const legA2 = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const M = X.abilitiesTest.liveEnemies();
      const keep = M.enemies.find((e: any) => e.alive);
      const chip = document.querySelector('[data-sneak-chip]') as HTMLElement | null;
      return { awareness: keep.awareness, state: (keep as any).state, chipVisible: !!chip && chip.style.display !== 'none' };
    });
    expect(legA2.awareness).toBe('unaware');
    expect(legA2.state).toBe('idle');
    expect(legA2.chipVisible).toBe(true);

    // ---- Leg B: release Ctrl at 20m -> standing detection escalates
    // through suspicious to alerted, enemy chases; chip hides. ----
    await page.keyboard.up('Control');
    await waitFor(page, 'alerted standing', () => page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const M = X.abilitiesTest.liveEnemies();
      const keep = M.enemies.find((e: any) => e.alive);
      return keep.awareness === 'alerted';
    }), 30_000, 500);
    const legB = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const M = X.abilitiesTest.liveEnemies();
      const keep = M.enemies.find((e: any) => e.alive);
      const chip = document.querySelector('[data-sneak-chip]') as HTMLElement | null;
      return { state: (keep as any).state, sneaking: X.engine.portalsPlayerAvatar.ctrl.sneaking,
               chipVisible: !!chip && chip.style.display !== 'none' };
    });
    expect(legB.state).toBe('chase');
    expect(legB.sneaking).toBe(false);
    expect(legB.chipVisible).toBe(false);
    await calmAll(page);

    // ---- Leg C: noise — an attack swing in empty air, from outside
    // the sneak radius but inside the 14m attack-noise radius, makes
    // the enemy suspicious (never alerted), and it keeps wandering. ----
    await page.keyboard.down('Control');
    const legCSetup = await page.evaluate(new Function(`
      const X = (window).__XANDRIA__;
      const M = X.abilitiesTest.liveEnemies();
      const S = X.stealthTest;
      const cands = M.enemies.filter((e) => e.alive);
      let keep = null, dist = 0;
      for (const e of cands) {
        const r = e.effectiveDetectionRadius(true);
        if (r + 0.5 < S.STEALTH_TABLE.attackNoiseRadius) { keep = e; dist = r + 0.5; break; }
      }
      if (!keep) throw new Error('no enemy with sneak radius inside attack-noise radius');
      ${BANISH_OTHERS.replace('keep', 'keep')}
      const av = X.engine.portalsPlayerAvatar;
      const p = keep.position;
      av.ctrl.teleport({ x: p.x + dist, y: p.y + 2, z: p.z });
      return { dist, sneakRadius: keep.effectiveDetectionRadius(true),
               attackNoise: S.STEALTH_TABLE.attackNoiseRadius, awareness: keep.awareness };
    `) as () => any);
    expect(legCSetup.dist).toBeGreaterThan(legCSetup.sneakRadius);
    expect(legCSetup.dist).toBeLessThan(legCSetup.attackNoise);
    expect(legCSetup.awareness).toBe('unaware');
    await page.waitForTimeout(1000);
    const legCPre = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const M = X.abilitiesTest.liveEnemies();
      return M.enemies.find((e: any) => e.alive).awareness;
    });
    expect(legCPre).toBe('unaware');
    // Swing in empty air, facing AWAY from the enemy (no hit, no damage):
    // the onAttack noise event alone must make it suspicious.
    await page.evaluate(new Function(`
      const X = (window).__XANDRIA__;
      X.engine.juice.reset();
      const M = X.abilitiesTest.liveEnemies();
      const keep = M.enemies.find((e) => e.alive);
      const av = X.engine.portalsPlayerAvatar;
      const ep = keep.position, pp = av.ctrl.position;
      const dx = ep.x - pp.x, dz = ep.z - pp.z;
      av.ctrl.yaw = Math.atan2(-dx, -dz) - Math.PI;
      av.melee(av.ctrl.yaw, 2.6, 1.3, 25);
      return keep.awareness;
    `) as () => any);
    await waitFor(page, 'suspicious from noise', () => page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const M = X.abilitiesTest.liveEnemies();
      return M.enemies.find((e: any) => e.alive).awareness === 'suspicious';
    }), 15_000, 500);
    const legC = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const M = X.abilitiesTest.liveEnemies();
      const keep = M.enemies.find((e: any) => e.alive);
      return { awareness: keep.awareness, state: (keep as any).state, health: keep.health };
    });
    expect(legC.awareness).toBe('suspicious');
    expect(legC.state).toBe('idle');
    await page.keyboard.up('Control');
    await calmAll(page);

    // ---- Leg D1: sneak-attack bonus — one atomic evaluate: teleport,
    // face, neutralize affix mods, read awareness BEFORE the strike,
    // strike, read HP + floating number. ----
    await page.keyboard.down('Control');
    const legD1 = await page.evaluate(new Function(`
      const X = (window).__XANDRIA__;
      X.engine.juice.reset();
      const M = X.abilitiesTest.liveEnemies();
      const keep = M.enemies.find((e) => e.alive && (e.spec.kind === 'walker' || e.spec.kind === 'brute'));
      if (!keep) throw new Error('no ground-kind enemy for the melee leg');
      ${BANISH_OTHERS}
      const av = X.engine.portalsPlayerAvatar;
      const p = keep.position;
      av.ctrl.teleport({ x: p.x + 2, y: p.y, z: p.z });
      const dx = p.x - av.ctrl.position.x, dz = p.z - av.ctrl.position.z;
      av.ctrl.yaw = Math.atan2(dx, dz) - Math.PI;
      // Shielded/elite mods would scale the HP drop (pre-existing
      // enemies-wave mechanics, unrelated to stealth): neutralize.
      keep.shield = 0; keep.damageTakenMult = 1;
      if (keep.rig?.group) keep.rig.group.rotation.y = Math.PI;
      keep.health = 1000;
      const beforeAwareness = keep.awareness;
      const before = keep.health;
      av.melee(av.ctrl.yaw, 2.6, 1.3, 25);
      const after = keep.health;
      ${READ_NUMS}
      return { beforeAwareness, before, after, awarenessAfter: keep.awareness, nums };
    `) as () => any);
    await page.keyboard.up('Control');
    expect(legD1.beforeAwareness).toBe('unaware');
    expect(legD1.before).toBe(1000);
    expect(legD1.after).toBe(950);
    expect(legD1.awarenessAfter).toBe('alerted');
    expect(legD1.nums).toEqual([{ text: '50!', color: 'rgb(255, 138, 92)', fontSize: '27px' }]);

    // ---- Leg D2: the sneak strike consumed NO crit draw — the next
    // 5 melees replicate the seed-23 stream from draw 1, exactly as
    // the crit spec's leg B proves for a non-sneak first strike. ----
    const legD2 = await page.evaluate(new Function(`
      const X = (window).__XANDRIA__;
      X.engine.juice.reset();
      const M = X.abilitiesTest.liveEnemies();
      const keep = M.enemies.find((e) => e.alive && (e.spec.kind === 'walker' || e.spec.kind === 'brute'));
      if (!keep) throw new Error('no ground-kind enemy for the replication leg');
      ${BANISH_OTHERS}
      const av = X.engine.portalsPlayerAvatar;
      const p = keep.position;
      av.ctrl.teleport({ x: p.x + 2, y: p.y, z: p.z });
      const dx = p.x - av.ctrl.position.x, dz = p.z - av.ctrl.position.z;
      av.ctrl.yaw = Math.atan2(dx, dz) - Math.PI;
      keep.shield = 0; keep.damageTakenMult = 1;
      if (keep.rig?.group) keep.rig.group.rotation.y = Math.PI;
      keep.health = 1000;
      for (let i = 0; i < 5; i++) av.melee(av.ctrl.yaw, 2.6, 1.3, 25);
      ${READ_NUMS}
      let s = (23 ^ 0xc217) >>> 0 || 0x9e3779b9;
      const next = () => {
        let t = (s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
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
    expect(legD2.observed).toEqual(legD2.expected);
    // Draws 1 and 5 of the seed-23 stream crit (0.0134, 0.0494) —
    // the replication must contain exactly two crits, proving the
    // sneak strike consumed no draw (had it consumed one, the five
    // strikes would replicate draws 2-6: exactly one crit).
    expect(legD2.expected.filter((n: any) => n.text === '50!')).toHaveLength(2);

    // ---- Leg E: perf — stealth adds no instanced buckets; draw calls
    // are sampled (median of 5) standing-calm vs sneaking for the record. ----
    const perf = await page.evaluate(async () => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const sample = async () => {
        const calls: number[] = [];
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          calls.push(X.engine.renderer.info.render.calls);
        }
        calls.sort((a, b) => a - b);
        return calls[2];
      };
      const calm = await sample();
      return { calm, buckets: X.enemyTest.enemyInstancerStats() };
    });
    await page.keyboard.down('Control');
    await page.waitForFunction(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.portalsPlayerAvatar.ctrl.sneaking === true;
    }, undefined, { timeout: 60_000 });
    const perfSneak = await page.evaluate(async () => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const calls: number[] = [];
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        calls.push(X.engine.renderer.info.render.calls);
      }
      calls.sort((a, b) => a - b);
      return { sneaking: calls[2], sneakingFlag: X.engine.portalsPlayerAvatar.ctrl.sneaking };
    });
    await page.keyboard.up('Control');
    expect(perfSneak.sneakingFlag).toBe(true);
    expect(perf.buckets.buckets).toBe(buckets0.buckets);
    console.log(`STEALTH PERF ${JSON.stringify({ bucketsBefore: buckets0.buckets, bucketsAfter: perf.buckets.buckets, callsCalm: perf.calm, callsSneaking: perfSneak.sneaking })}`);

    expect(errors).toEqual([]);
  });

  test('mobile: SNEAK touch button hold toggles sneak + chip, sneak-past at 360x780', async ({ browser }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 360, height: 780 } });
    const page = await ctx.newPage();
    try {
      await boot(page, errors, sceneB64(23));
      await calmAll(page);

      // The SNEAK button exists in the touch layout and drives sneak
      // through the real pointer path (hold -> pressAction).
      const btn = await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        const el = Array.from(document.querySelectorAll('.tbtn')).find((e) => e.textContent === 'SNEAK') as HTMLElement | undefined;
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        return { found: true, w: r.width, h: r.height };
      });
      expect(btn.found).toBe(true);
      expect(btn.w).toBeGreaterThanOrEqual(44);
      expect(btn.h).toBeGreaterThanOrEqual(44);

      // The sneak flag updates on the next physics step after the
      // pointer event, so dispatch, wait, then read.
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.tbtn')).find((e) => e.textContent === 'SNEAK') as HTMLElement;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }));
      });
      await page.waitForFunction(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return X.engine.portalsPlayerAvatar.ctrl.sneaking === true;
      }, undefined, { timeout: 60_000 });
      const hold = await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        const chip = document.querySelector('[data-sneak-chip]') as HTMLElement | null;
        return { sneaking: X.engine.portalsPlayerAvatar.ctrl.sneaking,
                 chipVisible: !!chip && chip.style.display !== 'none' };
      });
      expect(hold.sneaking).toBe(true);
      expect(hold.chipVisible).toBe(true);
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.tbtn')).find((e) => e.textContent === 'SNEAK') as HTMLElement;
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
      });
      await page.waitForFunction(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return X.engine.portalsPlayerAvatar.ctrl.sneaking === false;
      }, undefined, { timeout: 60_000 });
      const release = await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return { sneaking: X.engine.portalsPlayerAvatar.ctrl.sneaking };
      });
      expect(release.sneaking).toBe(false);

      // Sneak-past at 360x780 via the button hold path.
      await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        const el = Array.from(document.querySelectorAll('.tbtn')).find((e) => e.textContent === 'SNEAK') as HTMLElement;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }));
        const M = X.abilitiesTest.liveEnemies();
        const keep = M.enemies.find((e: any) => e.alive);
        for (const e of M.enemies) {
          if (!e.alive || e === keep) continue;
          if (e.body) { e.body.position.x += 200; e.body.position.z += 200; }
        }
        const av = X.engine.portalsPlayerAvatar;
        const p = keep.position;
        av.ctrl.teleport({ x: p.x + 20, y: p.y + 2, z: p.z });
      });
      await page.waitForFunction(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return X.engine.portalsPlayerAvatar.ctrl.sneaking === true;
      }, undefined, { timeout: 60_000 });
      const frame0 = await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return X.engine.frame;
      });
      await page.waitForFunction((f0: number) => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return X.engine.frame >= f0 + 2;
      }, frame0, { timeout: 120_000 });
      const mobile = await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        const M = X.abilitiesTest.liveEnemies();
        const keep = M.enemies.find((e: any) => e.alive);
        return { awareness: keep.awareness, state: (keep as any).state };
      });
      expect(mobile.awareness).toBe('unaware');
      expect(mobile.state).toBe('idle');
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.tbtn')).find((e) => e.textContent === 'SNEAK') as HTMLElement;
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
      });
      await page.screenshot({ path: '/tmp/stealth-mobile.png' });
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
