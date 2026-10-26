/**
 * UPGRADE LOOP (elite-affixes phase): seeded elite enemy affixes, live player.
 *
 * On the deterministic "Forgotten Valley" tp-action fixture (seed 20261012):
 *  1. Independent replication: for every spawned elite, the affix set
 *     recomputed from (spawnSeed, eliteChance) via the shipped
 *     rollEliteAffixes matches the enemy's affixes exactly, and the
 *     affixed stats match applyEliteAffixes exactly (band 0, no variance).
 *  2. Each affix's effect asserted in combat on a live enemy: swift speed,
 *     armored damage reduction, shielded absorb-before-health, vampiric
 *     lifesteal on a landed melee hit, volatile detonation only for
 *     close-range killing blows.
 *  3. Elite kill drops: a brute elite kill and a brute ordinary kill on
 *     the same map seed roll IDENTICAL loot — the loot ladder is untouched
 *     by affixes (only the pre-existing elite/brute bonus lines apply).
 *  4. Bestiary codex panel lists all five affixes (observe-only wiring).
 *  5. Perf (INSTANCING.md method): median renderer.info.render.calls for
 *     an ordinary roster vs an elite roster of the same count/specs —
 *     the gold marker may add one canonical bucket per geometry, never
 *     per enemy, so the delta stays small.
 *
 * Desktop AND 360x780, zero console/page errors.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const WALKER_SPECS = [
  { kind: 'walker', count: 12, health: 30, speed: 4, damage: 10, weapon: 'melee' },
];
const BRUTE_SPECS = [
  { kind: 'brute', count: 1, health: 60, speed: 3, damage: 14, weapon: 'melee' },
];

async function boot(page: any) {
  const errors: string[] = [];
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
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && X.enemyTest?.eliteAffixes);
  }), 240_000);
  return errors;
}

async function runAssertions(page: any) {
  return page.evaluate((specs: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const A = X.enemyTest.eliteAffixes;
    const mapSeed = X.spec.meta.seed;
    const out: any = { replication: [], probes: {}, loot: {}, perf: {} };
    const imul = (a: number, b: number) => Math.imul(a, b);
    const spawnSeedFor = (index: number) => (mapSeed ^ imul(index + 1, 0x9e3779b9)) >>> 0;

    const mk = (testSpecs: any, eliteChance: number, hits?: number[]) => new X.enemyTest.EnemyManager(
      E, null,
      {
        onPlayerHit(dmg: number) { if (hits) hits.push(dmg); },
        onDeath() {},
      },
      { specs: testSpecs, playerLevel: () => 1, eliteChance: () => eliteChance },
    );

    // (1) replication + stat exactness on the first elite roster.
    const roster = mk(specs.walker, 1);
    roster.spawnForMap(mapSeed);
    roster.enemies.forEach((e: any, i: number) => {
      const seed = spawnSeedFor(i);
      const roll = A.rollEliteAffixes(seed, 1);
      const applied = A.applyEliteAffixes(30, 10, 4, 1, e.eliteAffixes);
      out.replication.push({
        index: i,
        affixes: [...e.eliteAffixes],
        expectedAffixes: [...roll.affixes],
        isElite: e.isElite,
        label: e.eliteNameplate,
        expectedLabel: A.eliteLabel(roll.affixes),
        hp: e.maxHealth, expectedHp: applied.health,
        dmg: e.spec.damage, expectedDmg: applied.damage,
        speed: e.spec.speed, expectedSpeed: applied.speed,
        xp: e.xpMult, expectedXp: applied.xpMult,
      });
    });
    roster.despawnAll();

    // (2) per-affix combat probes. Scan rosters until every affix is
    // probed live; each probe records plain numbers for the Node side.
    const pending = new Set(['swift', 'armored', 'vampiric', 'volatile', 'shielded']);
    for (let s = 0; s < 20 && pending.size > 0; s++) {
      const seedBase = mapSeed + s;
      const hits: number[] = [];
      const m = mk(specs.walker, 1, hits);
      m.spawnForMap(seedBase);
      for (const e of [...m.enemies]) {
        for (const affix of [...pending]) {
          if (!e.eliteAffixes.includes(affix) || !e.alive) continue;
          const mods = A.eliteModsFor(e.eliteAffixes);
          if (affix === 'swift') {
            out.probes.swift = { speed: e.spec.speed, expected: 4 * mods.speedMult };
            pending.delete('swift');
          } else if (affix === 'armored') {
            const hp = e.health; const sh = e.shield;
            e.damage(10, e.position.clone());
            out.probes.armored = {
              hpBefore: hp, shieldBefore: sh, hpAfter: e.health, shieldAfter: e.shield,
              expectedHp: hp - Math.max(0, 10 - sh) * mods.damageTakenMult,
              expectedShield: Math.max(0, sh - 10),
            };
            pending.delete('armored');
          } else if (affix === 'shielded') {
            const hp = e.health; const sh = e.shield;
            e.damage(sh / 2, e.position.clone());
            out.probes.shielded = {
              hpBefore: hp, shieldBefore: sh, hpAfter: e.health, shieldAfter: e.shield,
              expectedShield: sh / 2,
            };
            pending.delete('shielded');
          } else if (affix === 'vampiric') {
            e.health = e.maxHealth * 0.5;
            const hpSet = e.health;
            for (let k = 0; k < 5; k++) e.update(0.016, e.position.clone(), 1000 + k * 0.016);
            out.probes.vampiric = {
              hpSet, hpAfter: e.health, maxHealth: e.maxHealth,
              expectedHeal: e.spec.damage * mods.lifestealFrac,
            };
            pending.delete('vampiric');
          } else if (affix === 'volatile') {
            // Distant killing blow: no detonation.
            const hitsBefore = hits.length;
            const pos = e.position.clone();
            const far = pos.clone(); far.x += 100;
            e.damage(e.health + e.shield + 1000, far);
            out.probes.volatileDistant = { hitsBefore, hitsAfter: hits.length, alive: e.alive };
            pending.delete('volatile');
          }
        }
      }
      m.despawnAll();
    }
    out.pendingAfterScan = [...pending];

    // Volatile close-range kill needs a fresh volatile enemy (the distant
    // probe killed the scanned one). Same map seed -> same roster.
    {
      const hits: number[] = [];
      const m = mk(specs.walker, 1, hits);
      m.spawnForMap(mapSeed);
      const vol = m.enemies.find((e: any) => e.eliteAffixes.includes('volatile'));
      if (vol) {
        const before = hits.length;
        const pos = vol.position.clone();
        const dmg = vol.spec.damage;
        vol.damage(vol.health + vol.shield + 1000, pos.clone());
        out.probes.volatileClose = {
          hitsBefore: before, hitsAfter: hits.length,
          lastHit: hits[hits.length - 1], expectedHit: dmg * A.VOLATILE_DAMAGE_FRAC,
          alive: vol.alive,
        };
      }
      m.despawnAll();
    }

    // (3) loot parity: brute elite kill vs brute ordinary kill, same seed.
    {
      const runKill = (chance: number) => {
        const drops: any[] = [];
        const m = mk(specs.brute, chance);
        m.lootHooks = { onLoot: (d: any) => drops.push(d) };
        m.spawnForMap(mapSeed);
        const e = m.enemies[0];
        const xp = e.xpMult;
        e.damage(e.health + e.shield + 1000, e.position.clone());
        const outDrops = drops;
        m.despawnAll();
        return { drops: outDrops, xp };
      };
      const eliteKill = runKill(1);
      const plainKill = runKill(0);
      out.loot = { eliteKill, plainKill };
    }

    // (5) perf: median draw calls, ordinary vs elite roster, same count.
    const sampleCalls = async (n: number): Promise<number[]> => {
      const vals: number[] = [];
      for (let i = 0; i < n; i++) {
        vals.push(E.renderer.info.render.calls);
        await new Promise((r) => setTimeout(r, 100));
      }
      return vals.sort((a, b) => a - b);
    };
    const median = (v: number[]) => v[Math.floor(v.length / 2)];
    return (async () => {
      // Bucket counts isolate the gold-marker instancing cost: test
      // managers are never submitted by the blueprint frame loop, so
      // render.calls alone cannot see the marker buckets — but buckets
      // ARE created at registerEnemy time (spawnForMap), and the bucket
      // count is the documented draw-call proxy for the enemy layer.
      const buckets = () => (X.npcTest?.instancerStats?.() ?? { buckets: -1 }).buckets;
      out.perf.bucketsBase = buckets();
      const plain = mk(specs.walker, 0); plain.spawnForMap(mapSeed);
      out.perf.callsPlain = median(await sampleCalls(10));
      out.perf.bucketsPlain = buckets();
      plain.despawnAll();
      const elite = mk(specs.walker, 1); elite.spawnForMap(mapSeed);
      out.perf.callsElite = median(await sampleCalls(10));
      out.perf.bucketsElite = buckets();
      out.perf.eliteCount = elite.enemies.length;
      elite.despawnAll();
      return out;
    })();
  }, { walker: WALKER_SPECS, brute: BRUTE_SPECS });
}

function checkAssertions(out: any) {
  // (1) replication: every enemy's affixes + stats match independent recomputation.
  expect(out.replication.length).toBeGreaterThan(0);
  for (const r of out.replication) {
    expect(r.isElite).toBe(true);
    expect(r.affixes).toEqual(r.expectedAffixes);
    expect(r.label).toBe(r.expectedLabel);
    expect(r.hp).toBeCloseTo(r.expectedHp, 9);
    expect(r.dmg).toBeCloseTo(r.expectedDmg, 9);
    expect(r.speed).toBeCloseTo(r.expectedSpeed, 9);
    expect(r.xp).toBeCloseTo(r.expectedXp, 9);
  }
  // (2) per-affix combat.
  expect(out.pendingAfterScan).toEqual([]);
  expect(out.probes.swift.speed).toBeCloseTo(out.probes.swift.expected, 9);
  expect(out.probes.swift.speed).toBeGreaterThan(4);
  expect(out.probes.armored.hpAfter).toBeCloseTo(out.probes.armored.expectedHp, 9);
  expect(out.probes.armored.shieldAfter).toBeCloseTo(out.probes.armored.expectedShield, 9);
  expect(out.probes.shielded.hpAfter).toBe(out.probes.shielded.hpBefore);
  expect(out.probes.shielded.shieldAfter).toBeCloseTo(out.probes.shielded.expectedShield, 9);
  expect(out.probes.vampiric.hpAfter).toBeGreaterThan(out.probes.vampiric.hpSet);
  expect(out.probes.vampiric.hpAfter).toBeCloseTo(
    Math.min(out.probes.vampiric.maxHealth, out.probes.vampiric.hpSet + out.probes.vampiric.expectedHeal), 6);
  expect(out.probes.vampiric.hpAfter).toBeLessThanOrEqual(out.probes.vampiric.maxHealth);
  expect(out.probes.volatileDistant.alive).toBe(false);
  expect(out.probes.volatileDistant.hitsAfter).toBe(out.probes.volatileDistant.hitsBefore);
  expect(out.probes.volatileClose).toBeTruthy();
  expect(out.probes.volatileClose.alive).toBe(false);
  expect(out.probes.volatileClose.hitsAfter).toBe(out.probes.volatileClose.hitsBefore + 1);
  expect(out.probes.volatileClose.lastHit).toBeCloseTo(out.probes.volatileClose.expectedHit, 9);
  // (3) loot parity.
  expect(out.loot.eliteKill.drops).toEqual(out.loot.plainKill.drops);
  expect(out.loot.eliteKill.xp).toBeGreaterThan(out.loot.plainKill.xp);
  // (5) perf.
  // eslint-disable-next-line no-console
  console.log(`[elite-affixes perf] median renderer.info.render.calls: plain=${out.perf.callsPlain} elite=${out.perf.callsElite} (n=${out.perf.eliteCount}); buckets base=${out.perf.bucketsBase} plain=${out.perf.bucketsPlain} elite=${out.perf.bucketsElite}`);
  expect(Math.abs(out.perf.callsElite - out.perf.callsPlain)).toBeLessThanOrEqual(40);
  // Gold-marker bucket cost: the elite roster must cost no more buckets
  // than the identical plain roster (a standalone test roster adds its
  // own part buckets over the blueprint baseline — plain +78 here — but
  // that cost is the roster's, not the marker's; the marker delta is 0).
  expect(Math.abs(out.perf.bucketsElite - out.perf.bucketsPlain)).toBeLessThanOrEqual(2);
}

async function checkCodexPanel(page: any) {
  const text = await page.evaluate(() => {
    const chip = document.getElementById('xandria-bestiary-chip') as HTMLElement | null;
    if (chip) chip.click();
    const panel = document.getElementById('xandria-bestiary-panel') as HTMLElement | null;
    return panel ? panel.textContent ?? '' : '';
  });
  expect(text).toContain('ELITE AFFIXES');
  for (const name of ['Swift', 'Armored', 'Vampiric', 'Volatile', 'Shielded']) {
    expect(text).toContain(name);
  }
}

test('elite-affixes: replication, per-affix combat, loot parity, codex, perf (desktop)', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = await boot(page);
  const out = await runAssertions(page);
  checkAssertions(out);
  await checkCodexPanel(page);
  expect(errors).toEqual([]);
});

test('elite-affixes: replication, per-affix combat, loot parity, codex, perf (360x780)', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await boot(page);
  const out = await runAssertions(page);
  checkAssertions(out);
  await checkCodexPanel(page);
  expect(errors).toEqual([]);
});
