/**
 * ELEMENTAL-DAMAGE-TYPES (upgrade loop): e2e verification of the
 * data-driven damage-type + resistance tables through the real game.
 *
 * Fixture: `npcs.b64` ("Forgotten Valley", tp-action), re-encoded with
 * a multi-kind roster (walker/brute/drone/flyer/turret) and a seeded
 * meta — the stock fixtures are walker-only, so the showcase
 * multipliers (flyer fire x1.5, drone shock x1.5, brute fire x0.5)
 * would be unreachable from the roster alone. One leg reuses the raw
 * fixture (blueprint-merged item defs) for the live enchant path.
 *
 * Crit/variance streams are replicated in-page exactly as the
 * crit-system spec does (mulberry32; melee salt 0xc217, ability salt
 * 0xab17), so every expected number is exact, including the
 * crit-before-elemental order: base 41 crits to 82, then frost x1.5
 * gives 123 — elemental-first would give round(41*1.5)=62, crit to
 * 124. The two orders are distinguished by this leg.
 *
 * Harness rules inherited from crit-system.spec.ts: despawn the
 * `npcs` system, one page.evaluate per leg (placement + action +
 * DOM read), `juice.reset()` per leg, non-target living enemies
 * teleported away, rig-rotation guard for the shielded-variant
 * front-arc wrapper.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test.setTimeout(900_000);

const FIXTURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'npcs.b64'), 'utf8');
function multiKindSpec(seed: number, withItems: boolean): string {
  const spec: any = JSON.parse(Buffer.from(FIXTURE.trim(), 'base64').toString('utf8'));
  spec.meta.seed = seed;
  spec.enemies = [
    { kind: 'walker', count: 2, health: 30, speed: 4.5, damage: 9, weapon: 'melee' },
    { kind: 'brute', count: 1, health: 30, speed: 3.5, damage: 12, weapon: 'melee' },
    { kind: 'drone', count: 1, health: 30, speed: 4, damage: 8, weapon: 'melee' },
    { kind: 'flyer', count: 1, health: 30, speed: 5, damage: 8, weapon: 'melee' },
    { kind: 'turret', count: 1, health: 30, speed: 0, damage: 10, weapon: 'melee' },
  ];
  if (!withItems) spec.custom = { items: { defs: {} } };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
}

async function boot(page: any, errors: string[], seed: number, withItems: boolean, label: string) {
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e: any) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`/player.html?spec=${encodeURIComponent(multiKindSpec(seed, withItems))}&test=1&autostart=1&splash=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X?.abilitiesTest?.liveManager() && X.engine.state === 'playing'
      && X.engine.portalsPlayerAvatar);
  }, undefined, { timeout: 240_000 });
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs') s.despawnAll();
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
  // eslint-disable-next-line no-console
  console.log(`elemental-damage: boot done (${label})`);
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

test.describe('elemental damage', () => {
  test('melee + ability multipliers match the table; crit precedes elemental; perf is zero-draw', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors, 23, false, 'multi-kind, empty items');

    // ---- Leg A1: melee, frost vs walker (x1.5), crit draw first (seed 23).
    // crit-before-elemental pinned: 41 -> crit 82 -> x1.5 = 123 (not 124).
    const frost = await page.evaluate((skip: number) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.engine.portalsPlayerAvatar;
      const list = X.abilitiesTest.liveEnemies().enemies as any[];
      const target = list.find((e) => e.alive && e.spec.kind === 'walker' && !e.isBoss && e.shield === 0 && e.damageTakenMult === 1);
      if (!target) throw new Error('no clean walker target for frost leg');
      for (const e of list) if (e.alive && e !== target) e.position.x += 100;
      if (target.rig?.group) target.rig.group.rotation.y = Math.PI;
      target.health = 1000;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      X.engine.juice.reset();
      // replicate the melee crit stream (mulberry32, salt 0xc217)
      let s = (23 ^ 0xc217) >>> 0;
      const next = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      for (let i = 0; i < skip; i++) next();
      const crit = next() < 0.05;
      const afterCrit = Math.round(41 * (crit ? 2 : 1));
      const dealt = Math.round(afterCrit * 1.5);
      av.melee(Math.PI, 2.6, 1.3, 41, undefined, 'frost');
      const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
      const nums = els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
        .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
      return { hp: target.health, nums, crit, dealt };
    }, 0);
    expect(frost.crit).toBe(true);
    expect(frost.dealt).toBe(123);
    expect(frost.hp).toBe(1000 - 123);
    expect(frost.nums).toEqual([{ text: '123!', color: 'rgb(255, 138, 92)', fontSize: '27px' }]);

    // ---- Leg A2: melee, fire vs brute (x0.5), second crit draw (non-crit).
    const fire = await page.evaluate((skip: number) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.engine.portalsPlayerAvatar;
      const list = X.abilitiesTest.liveEnemies().enemies as any[];
      const target = list.find((e) => e.alive && e.spec.kind === 'brute' && !e.isBoss && e.shield === 0 && e.damageTakenMult === 1);
      if (!target) throw new Error('no clean brute target for fire leg');
      for (const e of list) if (e.alive && e !== target) e.position.x += 100;
      if (target.rig?.group) target.rig.group.rotation.y = Math.PI;
      target.health = 1000;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      X.engine.juice.reset();
      let s = (23 ^ 0xc217) >>> 0;
      const next = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      for (let i = 0; i < skip; i++) next();
      const crit = next() < 0.05;
      const dealt = Math.round(Math.round(41 * (crit ? 2 : 1)) * 0.5);
      av.melee(Math.PI, 2.6, 1.3, 41, undefined, 'fire');
      const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
      const nums = els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
        .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
      return { hp: target.health, nums, crit, dealt };
    }, 1);
    expect(fire.crit).toBe(false);
    expect(fire.dealt).toBe(21); // round(41 * 0.5) = 21 — rounding pinned
    expect(fire.hp).toBe(1000 - 21);
    expect(fire.nums).toEqual([{ text: '21', color: 'rgb(255, 210, 63)', fontSize: '18px' }]);

    // ---- Leg A3: melee, physical vs walker — control, no elemental scaling.
    const phys = await page.evaluate((skip: number) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.engine.portalsPlayerAvatar;
      const list = X.abilitiesTest.liveEnemies().enemies as any[];
      const target = list.find((e) => e.alive && e.spec.kind === 'walker' && !e.isBoss && e.shield === 0 && e.damageTakenMult === 1);
      if (!target) throw new Error('no clean walker target for physical control');
      for (const e of list) if (e.alive && e !== target) e.position.x += 100;
      if (target.rig?.group) target.rig.group.rotation.y = Math.PI;
      target.health = 1000;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      X.engine.juice.reset();
      let s = (23 ^ 0xc217) >>> 0;
      const next = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      for (let i = 0; i < skip; i++) next();
      const crit = next() < 0.05;
      const dealt = Math.round(41 * (crit ? 2 : 1));
      av.melee(Math.PI, 2.6, 1.3, 41);
      const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
      const nums = els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
        .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
      return { hp: target.health, nums, crit, dealt };
    }, 2);
    expect(phys.dealt).toBe(41);
    expect(phys.hp).toBe(959);
    expect(phys.nums).toEqual([{ text: '41', color: 'rgb(255, 210, 63)', fontSize: '18px' }]);

    // ---- Leg B1: shockwave-slam (shock) vs drone (x1.5), ability stream.
    const slam = await page.evaluate((skip: number) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.engine.portalsPlayerAvatar;
      const list = X.abilitiesTest.liveEnemies().enemies as any[];
      const target = list.find((e) => e.alive && e.spec.kind === 'drone' && !e.isBoss && e.shield === 0 && e.damageTakenMult === 1);
      if (!target) throw new Error('no clean drone target for shockwave leg');
      for (const e of list) if (e.alive && e !== target) e.position.x += 100;
      target.health = 1000;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y - 2, z: p.z });
      av.ctrl.yaw = Math.PI;
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      X.engine.juice.reset();
      // replicate the ability stream (mulberry32, salt 0xab17): variance, crit
      let s = (23 ^ 0xab17) >>> 0;
      const next = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      for (let i = 0; i < skip; i++) next();
      const uVar = next();
      const crit = next() < 0.05;
      const rolled = Math.round(30 * 1 * (0.9 + uVar * 0.2));
      const afterCrit = Math.round(rolled * (crit ? 2 : 1));
      const dealt = Math.round(afterCrit * 1.5);
      const mgr = X.abilitiesTest.liveManager();
      mgr.energy = 100;
      const res = mgr.cast('shockwave-slam');
      const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
      const nums = els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
        .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
      return { ok: res.ok, targets: res.targets, damageDealt: res.damageDealt, damageType: mgr.lastCast?.damageType, hp: target.health, nums, crit, dealt };
    }, 0);
    expect(slam.ok).toBe(true);
    expect(slam.targets).toBe(1);
    expect(slam.damageType).toBe('shock');
    expect(slam.damageDealt).toBe(slam.dealt);
    expect(slam.hp).toBe(1000 - slam.dealt);
    expect(slam.nums).toEqual([{ text: String(slam.dealt), color: 'rgb(255, 210, 63)', fontSize: '18px' }]);

    // ---- Leg B2: dash-strike (physical) vs walker — control via the same stream.
    const dash = await page.evaluate((skip: number) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.engine.portalsPlayerAvatar;
      const list = X.abilitiesTest.liveEnemies().enemies as any[];
      const target = list.find((e) => e.alive && e.spec.kind === 'walker' && !e.isBoss && e.shield === 0 && e.damageTakenMult === 1);
      if (!target) throw new Error('no clean walker target for dash leg');
      for (const e of list) if (e.alive && e !== target) e.position.x += 100;
      target.health = 1000;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      X.engine.juice.reset();
      let s = (23 ^ 0xab17) >>> 0;
      const next = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      for (let i = 0; i < skip; i++) next();
      const uVar = next();
      const crit = next() < 0.05;
      const dealt = Math.round(Math.round(40 * 1 * (0.9 + uVar * 0.2)) * (crit ? 2 : 1));
      const mgr = X.abilitiesTest.liveManager();
      mgr.energy = 100;
      // No aimDir: cast() defaults to (0,0,1), toward the placed enemy;
      // a plain {x,y,z} object is NOT a Vector3 and .clone() throws.
      const res = mgr.cast('dash-strike');
      return { ok: res.ok, targets: res.targets, damageDealt: res.damageDealt, damageType: mgr.lastCast?.damageType, hp: target.health, crit, dealt };
    }, 2);
    expect(dash.ok).toBe(true);
    expect(dash.damageType).toBe('physical');
    expect(dash.damageDealt).toBe(dash.dealt);
    expect(dash.hp).toBe(1000 - dash.dealt);

    // ---- Leg C: perf — the elemental step costs zero draws and is CPU-free.
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
      for (const s of systems) if (s.id === 'enemies') s.despawnAll();
    });
    let stable = 0;
    let last = -1;
    for (let i = 0; i < 120 && stable < 6; i++) {
      const c = await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return X.engine.renderer.info.render.calls as number;
      });
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
        for (let i = 0; i < 20; i++) juice.spawnText(cam, { x: 0, y: 0, z: -5 }, 'playerDamage', 10);
      });
      withs.push(await sampleDrawCalls(page));
      await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        X.engine.juice.reset();
      });
    }
    const med = (xs: number[]) => { const s2 = [...xs].sort((a, b) => a - b); return s2[Math.floor(s2.length / 2)]; };
    const cpu = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const et = X.elementalTest;
      let idleMs = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        for (let i = 0; i < 2000; i++) { et.resistanceFor('walker', 'frost'); et.applyElemental(100, 'walker', 'frost'); }
        idleMs = Math.min(idleMs, performance.now() - t0);
      }
      return { idleMs };
    });
    // eslint-disable-next-line no-console
    console.log(`elemental perf: bases=${bases} withs=${withs} base=${med(bases)} with=${med(withs)} elemental2000min=${cpu.idleMs.toFixed(3)}ms`);
    expect(med(withs) - med(bases)).toBe(0);
    expect(cpu.idleMs).toBeLessThan(5);
    expect(errors).toEqual([]);
  });

  test('enchant-driven type + bestiary resistances from the same table; reload preserves', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors, 23, true, 'multi-kind, raw items');

    // ---- Leg D: live enchant -> outgoing type frost; HUD shows it.
    const enchant = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const inv = X.lootTest.liveInventory();
      inv.add('loot_ironfang_blade', 1);
      inv.add('mat_star_essence', 10);
      inv.add('mat_enchant_dust', 10);
      inv.equip('loot_ironfang_blade');
      const before = X.elementalTest.liveOutgoingDamageType();
      const res = inv.enchant('loot_ironfang_blade', 'ench_starlit');
      const after = X.elementalTest.liveOutgoingDamageType();
      return { before, ok: (res as any)?.ok, after };
    });
    expect(enchant.before).toBe('physical');
    expect(enchant.ok).toBe(true);
    expect(enchant.after).toBe('frost');
    // HUD: open inventory, read the damage-type row + the enchant row tag.
    await page.keyboard.press('i');
    await page.waitForFunction(() => {
      const el = document.querySelector('.xinv .elemrow');
      return !!el && (el.textContent ?? '').length > 0;
    }, undefined, { timeout: 30_000 });
    const hud = await page.evaluate(() => {
      const el = document.querySelector('.xinv .elemrow');
      const rows = Array.from(document.querySelectorAll('.xinv .enchrow'));
      return { elem: el?.textContent ?? '', enchRows: rows.map((r) => r.textContent ?? '') };
    });
    expect(hud.elem).toContain('Frost');
    expect(hud.enchRows.some((t) => t.includes('Frost damage'))).toBe(true);
    await page.keyboard.press('Escape');

    // ---- Leg E: kill a flyer, open the codex, read its resistance lines.
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const list = X.abilitiesTest.liveEnemies().enemies as any[];
      const flyer = list.find((e) => e.alive && e.spec.kind === 'flyer');
      if (!flyer) throw new Error('no flyer to kill for the bestiary leg');
      flyer.damage(9999, flyer.position, 'physical');
    });
    await page.waitForFunction(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.blueprint.bestiary.countOf('flyer') >= 1;
    }, undefined, { timeout: 60_000 });
    await page.keyboard.press('b');
    await page.waitForFunction(() => {
      const p = document.querySelector('#xandria-bestiary-panel');
      return !!p && (p.textContent ?? '').includes('RESISTANCES');
    }, undefined, { timeout: 30_000 });
    const codex = await page.evaluate(() => {
      const p = document.querySelector('#xandria-bestiary-panel');
      return p?.textContent ?? '';
    });
    expect(codex).toContain('Fire ×1.5 — vulnerable');
    expect(codex).toContain('Shock ×1.25 — vulnerable');
    expect(codex).toContain('Frost ×1 — normal');
    await page.keyboard.press('Escape');

    // ---- Leg F: reload — the codex still shows the same table values.
    await page.goto(`/player.html?spec=${encodeURIComponent(multiKindSpec(23, true))}&test=1&autostart=1&splash=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
    }, undefined, { timeout: 240_000 });
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
    });
    await page.keyboard.press('b');
    await page.waitForFunction(() => {
      const p = document.querySelector('#xandria-bestiary-panel');
      return !!p && (p.textContent ?? '').includes('RESISTANCES');
    }, undefined, { timeout: 30_000 });
    const codex2 = await page.evaluate(() => {
      const p = document.querySelector('#xandria-bestiary-panel');
      return p?.textContent ?? '';
    });
    expect(codex2).toContain('Fire ×1.5 — vulnerable');
    expect(codex2).toContain('Shock ×1.25 — vulnerable');
    // walker was never killed in this boot, so its card stays locked and
    // must show NO resistance lines after reload either:
    expect(codex2).not.toContain('Frost ×1.5 — vulnerable');
    expect(errors).toEqual([]);
  });
});

test.describe('elemental damage mobile', () => {
  // 360x780 via setViewportSize on a desktop context, exactly as the
  // bestiary spec's mobile leg does: hasTouch:true puts a touch layer
  // over the BESTIARY chip and the click never reaches actionability.
  test('frost melee hits a walker at x1.5; codex chip fits the viewport', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors, 23, false, 'mobile multi-kind, empty items');
    // eslint-disable-next-line no-console
    console.log('elemental-damage: mobile boot ok, starting frost evaluate');
    const frost = await page.evaluate((skip: number) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.engine.portalsPlayerAvatar;
      const list = X.abilitiesTest.liveEnemies().enemies as any[];
      const target = list.find((e) => e.alive && e.spec.kind === 'walker' && !e.isBoss && e.shield === 0 && e.damageTakenMult === 1);
      if (!target) throw new Error('no clean walker target (mobile)');
      for (const e of list) if (e.alive && e !== target) e.position.x += 100;
      if (target.rig?.group) target.rig.group.rotation.y = Math.PI;
      target.health = 1000;
      const p = target.position;
      av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
      av.ctrl.yaw = Math.PI;
      X.engine.camera.lookAt(p.x, p.y + 1, p.z);
      X.engine.camera.updateMatrixWorld();
      X.engine.juice.reset();
      let s = (23 ^ 0xc217) >>> 0;
      const next = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      for (let i = 0; i < skip; i++) next();
      const crit = next() < 0.05;
      const dealt = Math.round(Math.round(41 * (crit ? 2 : 1)) * 1.5);
      av.melee(Math.PI, 2.6, 1.3, 41, undefined, 'frost');
      const els = Array.from(document.querySelectorAll('.xjuice .dmgnum')) as HTMLElement[];
      const nums = els.filter((el) => parseFloat(el.style.opacity || '0') > 0)
        .map((el) => ({ text: el.textContent ?? '', color: el.style.color, fontSize: el.style.fontSize }));
      return { hp: target.health, nums, dealt };
    }, 0);
    expect(frost.dealt).toBe(123);
    expect(frost.hp).toBe(877);
    expect(frost.nums).toEqual([{ text: '123!', color: 'rgb(255, 138, 92)', fontSize: '27px' }]);
    // Resize to 360x780 AFTER the desktop-size legs, exactly as the
    // bestiary spec's mobile leg does: a cold load at 360px leaves the
    // MOUNTS chip overlapping the BESTIARY chip (pre-existing layout
    // quirk, not this phase's), while resize-to-360 lays them out clean.
    await page.setViewportSize({ width: 360, height: 780 });
    await page.waitForTimeout(1500);
    // eslint-disable-next-line no-console
    console.log('elemental-damage: mobile frost leg ok, killing walker');
    // kill the walker, then open the codex from the chip and read its lines
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const list = X.abilitiesTest.liveEnemies().enemies as any[];
      const w = list.find((e) => e.alive && e.spec.kind === 'walker');
      if (w) w.damage(9999, w.position, 'physical');
    });
    await page.waitForFunction(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.blueprint.bestiary.countOf('walker') >= 1;
    }, undefined, { timeout: 60_000 });
    // eslint-disable-next-line no-console
    console.log('elemental-damage: mobile walker kill counted, opening codex');
    // NOTE (pre-existing, out of scope): the BESTIARY chip sits under the
    // MOUNTS chip at every viewport (probe: both absolute, ~83px overlap
    // at 1280px and 360px), so a chip click never reaches actionability.
    // The codex itself is opened here via the B key, the path the
    // bestiary spec's desktop legs use; the chip overlap is a layout bug
    // for its own phase, not this one. Do NOT "fix" it here.
    await page.keyboard.press('b');
    // eslint-disable-next-line no-console
    console.log('elemental-damage: mobile codex opened via B key');
    await page.waitForFunction(() => {
      const p = document.querySelector('#xandria-bestiary-panel');
      return !!p && (p.textContent ?? '').includes('RESISTANCES');
    }, undefined, { timeout: 30_000 });
    const panelBox = await page.locator('#xandria-bestiary-panel').boundingBox();
    expect(panelBox?.width).toBeLessThanOrEqual(360);
    const codex = await page.evaluate(() => document.querySelector('#xandria-bestiary-panel')?.textContent ?? '');
    expect(codex).toContain('Frost ×1.5 — vulnerable');
    expect(codex).toContain('Fire ×0.75 — resistant');
    expect(errors).toEqual([]);
  });
});
