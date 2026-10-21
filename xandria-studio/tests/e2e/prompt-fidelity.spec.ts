/**
 * prompt-fidelity wave: generate-and-boot e2e across 10 prompt archetypes.
 *
 * Every archetype goes through the REAL player boot path
 * (player.html?intent=... -> generateSpec -> blueprint -> Engine) on desktop
 * and on 360x780, and must reach engine state 'playing' with ZERO
 * console/page errors. Nonsense/empty prompts must degrade to the
 * deterministic fallback game, never an error page.
 */
import { test, expect } from '@playwright/test';

const ARCHETYPES: { name: string; intent: string | null; expectGenre?: string }[] = [
  { name: 'clear genre', intent: 'neon cyberpunk fps arena deathmatch', expectGenre: 'fps-arena' },
  { name: 'biome-heavy', intent: 'frozen arctic blizzard survival expedition', expectGenre: 'third-person-action' },
  { name: 'mechanic-heavy', intent: 'epic sword adventure with a boss battle, crafting and side quests in ancient ruins', expectGenre: 'third-person-action' },
  { name: 'ambiguous', intent: 'game' },
  { name: 'adversarial/nonsense', intent: 'asdfghjkl qwerty zxcvbnm 12345' },
  { name: 'empty intent (default game)', intent: null },
  { name: 'unicode/emoji', intent: '🎮🐉🔥 dragon fire multiplayer battle' },
  { name: 'racing mechanic-heavy', intent: 'desert rally racing grand prix at dusk', expectGenre: 'racing' },
  { name: 'tower-defense waves', intent: 'tower defense, 6 waves, defend the base at night', expectGenre: 'tower-defense' },
  { name: 'very long prompt', intent: 'epic sword adventure through ancient ruins at dusk '.repeat(40) },
];

const bootOne = async (page: any, arch: (typeof ARCHETYPES)[number]): Promise<string[]> => {
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  const q = arch.intent === null ? '' : `&intent=${encodeURIComponent(arch.intent)}`;
  await page.goto(`/player.html?test=1&autostart=1&splash=0${q}`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => (window as any).__XANDRIA__?.engine?.state === 'playing',
    null, { timeout: 60000 },
  );
  const info = await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    return { genre: X?.spec?.meta?.genre ?? null, name: X?.spec?.meta?.name ?? null };
  });
  if (!info.genre) errors.push('[spec] missing spec after boot');
  if (arch.expectGenre && info.genre !== arch.expectGenre) {
    errors.push(`[genre] expected ${arch.expectGenre}, got ${info.genre}`);
  }
  return errors;
};

test('prompt-fidelity: 10 archetypes boot clean on desktop', async ({ page }) => {
  test.setTimeout(900_000);
  const failures: string[] = [];
  for (const arch of ARCHETYPES) {
    const errors = await bootOne(page, arch);
    if (errors.length) failures.push(`${arch.name}: ${errors.join(' | ')}`);
  }
  expect(failures).toEqual([]);
});

test('prompt-fidelity: 10 archetypes boot clean at 360x780', async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const failures: string[] = [];
  for (const arch of ARCHETYPES) {
    const errors = await bootOne(page, arch);
    if (errors.length) failures.push(`${arch.name}: ${errors.join(' | ')}`);
  }
  expect(failures).toEqual([]);
});
