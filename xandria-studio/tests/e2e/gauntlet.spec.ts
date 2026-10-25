/**
 * Gauntlet mode e2e — seeded boss-gauntlet runs.
 *
 * Desktop + 360x780, zero console/page errors throughout:
 *  1. Title screen shows the gauntlet button (label has today's UTC date),
 *     the boss-order line (deep-equal to this spec's INDEPENDENT replication
 *     of the generator), and the board: 8 rows (today + last 7 days),
 *     newest first.
 *  2. Clicking gauntlet starts the run with the pinned seed — the in-page
 *     tuple is deep-equal to the independent replication and
 *     spec.meta.seed matches; round 1's live arena matches
 *     planBossArena(roundSeed(0)).
 *  3. Killing the boss through the real die() path advances the round: the
 *     player heals between rounds, round 2's arena matches
 *     planBossArena(roundSeed(1)), and the bar shows the round-2 boss name.
 *  4. Killing all 5 bosses wins the run through the real objectives path;
 *     the result persists to localStorage (roundsCleared 5, score > 0);
 *     reloading shows the board row with the result.
 *  5. Mobile leg: title board + gauntlet start render cleanly at 360x780.
 *
 * Notes: this spec runs WITHOUT ?test=1 so the real title screen shows and
 * profile persistence actually writes (testMode skips both). splash=0 removes
 * the unskippable overlay so the gauntlet button is clickable. Boss kills go
 * through enemy.damage() — the real die() -> onKill -> round-advance path,
 * not an injected shortcut. The player gets 1e9 max health (test-only) so
 * boss telegraphs can't end the run mid-spec; the heal leg sets health to
 * half first so the heal is observable.
 */
import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// INDEPENDENT replication of the pinned gauntlet generator.
// Own copy of the algorithm (mulberry32 + salt + tuple shape + round seeds +
// arena placement); any change to the game's pinned formula must update this
// replica or the spec fails loud.
// ---------------------------------------------------------------------------
const GAUNTLET_SALT = 0x6a57;
const BOSS_SALT = 0xb055;
const BOSS_IDS = ['the-warden', 'ember-titan', 'void-herald'];
const BOSS_NAMES: Record<string, string> = {
  'the-warden': 'THE WARDEN',
  'ember-titan': 'EMBER TITAN',
  'void-herald': 'VOID HERALD',
};
const BOSS_RADII: Record<string, number> = {
  'the-warden': 26,
  'ember-titan': 32,
  'void-herald': 24,
};
const BOSS_SHORT: Record<string, string> = {
  'the-warden': 'WARDEN',
  'ember-titan': 'EMBER TITAN',
  'void-herald': 'VOID HERALD',
};

function makeRng(seed: number) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min: number, max: number) => min + (max - min) * next(),
    pick: <T>(arr: readonly T[]) => arr[Math.floor(next() * arr.length)],
  };
}

function todayUtcDate(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function gauntletSeedForDate(dateStr: string): number {
  return (GAUNTLET_SALT ^ parseInt(dateStr.replace(/-/g, ''), 10)) >>> 0;
}

function replicateGauntlet(seed: number): string[] {
  const rng = makeRng(seed);
  const bosses: string[] = [];
  for (let i = 0; i < 5; i++) {
    let id = rng.pick(BOSS_IDS);
    if (bosses.length && id === bosses[bosses.length - 1]) {
      id = BOSS_IDS[(BOSS_IDS.indexOf(id) + 1) % BOSS_IDS.length];
    }
    bosses.push(id);
  }
  return bosses;
}

function roundSeed(seed: number, i: number): number {
  return ((seed ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0);
}

function planArena(mapSeed: number, radius: number) {
  const rng = makeRng((mapSeed ^ BOSS_SALT) >>> 0);
  const ang = rng.range(0, Math.PI * 2);
  const dist = rng.range(70, 110);
  return { x: Math.cos(ang) * dist, z: Math.sin(ang) * dist, radius };
}

const INTENT = 'neon fps arena at night';

async function gotoTitle(page: any) {
  const errors: string[] = [];
  page.on('console', (msg: any) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (e: any) => errors.push(String(e.message ?? e)));
  await page.goto(`/player.html?intent=${encodeURIComponent(INTENT)}&splash=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'title', null, { timeout: 60000 });
  return errors;
}

async function waitFor(label: string, page: any, fn: () => Promise<boolean>, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(500);
  }
}

function readEngine(page: any) {
  return page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    const enc = X.engine.bossWiring?.encounter ?? null;
    const boss = enc?.liveBoss ?? null;
    return {
      state: X.engine.state as string,
      seed: X.spec.meta.seed as number,
      bosses: (X.engine.gauntlet?.gauntlet.bosses ?? null) as string[] | null,
      roundsCleared: (X.engine.gauntlet?.roundsCleared ?? -1) as number,
      arena: enc?.liveArena ? { x: enc.liveArena.x, z: enc.liveArena.z, radius: enc.liveArena.radius } : null,
      bossBound: !!boss,
      bossAlive: !!boss && (boss as { alive?: boolean }).alive !== false,
      bossId: boss ? (boss.isBoss as boolean) : null,
      barName: (document.querySelector('#xandria-boss-bar .bb-name') as HTMLElement)?.textContent ?? null,
      barVisible: (() => {
        const bar = document.getElementById('xandria-boss-bar');
        return !!bar && bar.style.display !== 'none';
      })(),
    };
  });
}

// MERGE (level-up modal): on the merged tree a boss kill levels the player
// (scaled boss XP) and the level-up modal PAUSES the game until an upgrade
// is picked — the director cannot bind the next boss until it is settled,
// exactly as a player picking an upgrade mid-gauntlet would. Poll briefly
// for the modal after each kill; no-op when no level was gained.
async function settleLevelUp(page: any): Promise<void> {
  const t0 = Date.now();
  let clicks = 0;
  for (;;) {
    const n = await page.locator('.lvlopt').count();
    if (n > 0 && clicks < 5) {
      try { await page.locator('.lvlopt').first().click({ timeout: 2000 }); } catch { /* modal vanished mid-click */ }
      clicks++;
      await page.waitForTimeout(500);
      continue;
    }
    if (n === 0 && clicks > 0) return; // settled
    if (n === 0 && Date.now() - t0 > 6000) return; // never appeared
    if (n > 0) return; // modal survived 5 picks; don't spin forever
    await page.waitForTimeout(500);
  }
}

test('gauntlet: title board, seeded run, round advance + heal, 5-boss win persists', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = await gotoTitle(page);
  const today = todayUtcDate();
  const seed = gauntletSeedForDate(today);
  const bosses = replicateGauntlet(seed);
  const orderLine = bosses.map((b) => BOSS_SHORT[b]).join(' → ');

  // --- leg 1: title screen entry + board ---
  const gbtn = page.locator('.gauntlet-btn');
  await expect(gbtn).toBeVisible();
  expect((await gbtn.textContent()) ?? '').toContain(`GAUNTLET ${today}`);
  expect((await page.locator('.gauntlet-line').textContent()) ?? '').toBe(orderLine);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.gauntlet-board-row')].map((r) => ({
      date: (r.querySelector('.gbr-date') as HTMLElement).textContent,
      bosses: (r.querySelector('.gbr-bosses') as HTMLElement).textContent,
      result: (r.querySelector('.gbr-result') as HTMLElement).textContent,
      today: r.classList.contains('today'),
    })),
  );
  expect(rows).toHaveLength(8);
  expect(rows[0].today).toBe(true);
  expect(rows[0].date).toBe('TODAY');
  expect(rows[0].bosses).toBe(orderLine);
  expect(rows[0].result).toBe('—');
  expect(rows[7].today).toBe(false);

  // --- leg 2: start the gauntlet; pinned tuple + world seed ---
  await gbtn.click();
  await waitFor('playing', page, async () =>
    (await page.evaluate(() => (window as any).__XANDRIA__.engine.state)) === 'playing', 60000);
  // test-only: the bot must survive boss telegraphs for the whole spec
  await page.evaluate(() => {
    const av = (window as any).__XANDRIA__.engine.portalsPlayerAvatar;
    av.maxHealth = 1e9;
    av.health = 1e9;
  });
  const eng = await readEngine(page);
  expect(eng.seed, 'world seed is the pinned gauntlet seed').toBe(seed);
  expect(eng.bosses, 'in-page tuple deep-equals the independent replication').toEqual(bosses);

  // --- leg 3: round-1 arena matches the independent seed replication ---
  await waitFor('boss 1 bind', page, async () => (await readEngine(page)).bossBound, 60000);
  const r1 = await readEngine(page);
  const a1 = planArena(roundSeed(seed, 0), BOSS_RADII[bosses[0]]);
  expect(r1.arena, 'round-1 arena placed').not.toBeNull();
  expect(r1.arena!.x).toBeCloseTo(a1.x, 6);
  expect(r1.arena!.z).toBeCloseTo(a1.z, 6);
  expect(r1.arena!.radius).toBe(a1.radius);
  expect(r1.barVisible, 'boss bar shown').toBe(true);
  expect(r1.barName).toBe(BOSS_NAMES[bosses[0]]);

  // --- leg 4: real kill advances the round + heals between rounds ---
  const afterKill1 = await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    av.health = av.maxHealth / 2; // half health so the heal is observable
    const boss = X.engine.bossWiring.encounter.liveBoss;
    const before = X.engine.gauntlet.roundsCleared as number;
    boss.damage(99999); // the real die() path
    return {
      before,
      after: X.engine.gauntlet.roundsCleared as number,
      health: av.health as number,
      maxHealth: av.maxHealth as number,
    };
  });
  expect(afterKill1.after, 'real kill advanced the round').toBe(afterKill1.before + 1);
  expect(afterKill1.health, 'healed 50% max between rounds').toBe(afterKill1.maxHealth);
  await settleLevelUp(page);
  await waitFor('boss 2 bind', page, async () => {
    const e = await readEngine(page);
    return e.roundsCleared === 1 && e.bossBound && e.bossAlive;
  }, 60000);
  const r2 = await readEngine(page);
  const a2 = planArena(roundSeed(seed, 1), BOSS_RADII[bosses[1]]);
  expect(r2.arena!.x).toBeCloseTo(a2.x, 6);
  expect(r2.arena!.z).toBeCloseTo(a2.z, 6);
  expect(r2.barName).toBe(BOSS_NAMES[bosses[1]]);

  // --- leg 5: kill the remaining bosses; the 5th wins the run for real ---
  // (each round's boss must be bound — and alive — before the kill; the bind
  // lands a tick or two after the director spawns the round's brute)
  for (let k = 0; k < 4; k++) {
    if (k > 0) {
      await waitFor(`boss ${k + 2} bind`, page, async () => {
        const e = await readEngine(page);
        return e.bossBound && e.bossAlive && e.roundsCleared === k + 1;
      }, 60000);
    }
    await page.evaluate(() => {
      (window as any).__XANDRIA__.engine.bossWiring.encounter.liveBoss.damage(99999);
    });
    await settleLevelUp(page);
    const want = k + 2;
    await waitFor(`round ${want} clear`, page, async () =>
      (await readEngine(page)).roundsCleared === want, 60000);
  }
  await waitFor('victory', page, async () =>
    (await page.evaluate(() => (window as any).__XANDRIA__.engine.state)) === 'won', 60000);

  // --- leg 6: result persists; reload shows it on the board ---
  // MERGE (save-slots): gauntlet results live in the active slot's profile.
  const stored = await page.evaluate((dateStr: string) => {
    try {
      const st = JSON.parse(localStorage.getItem('xandria.slots.v1') ?? '{}');
      const active = (st.slots ?? []).find((s: any) => s.id === st.activeSlotId);
      return active?.profile?.gauntletResults?.[dateStr] ?? null;
    } catch { return null; }
  }, today);
  expect(stored, 'gauntlet result persisted').not.toBeNull();
  expect(stored.roundsCleared).toBe(5);
  expect(stored.won).toBe(true);
  expect(stored.seed).toBe(seed);
  expect(stored.score).toBeGreaterThan(0);

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'title', null, { timeout: 60000 });
  const row0 = await page.evaluate(() => {
    const r = document.querySelector('.gauntlet-board-row.today');
    return {
      result: (r?.querySelector('.gbr-result') as HTMLElement)?.textContent ?? null,
      line: (document.querySelector('.gauntlet-line') as HTMLElement)?.textContent ?? null,
    };
  });
  expect(row0.result).toContain('R5/5');
  expect(row0.line).toContain('best');

  // --- leg 7: mobile leg at 360x780 ---
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(2000);
  await expect(page.locator('.gauntlet-btn')).toBeVisible();
  await expect(page.locator('.gauntlet-board')).toBeVisible();

  expect(errors, 'zero console/page errors').toEqual([]);
});
