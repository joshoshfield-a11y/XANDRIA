/**
 * R3-M1 + R3-N1 regression tests — REAL browser pages.
 *
 * R3-M1: the pre-boot `window.__XANDRIA__.registerEnemyKind` API must work in
 * a real page. The bundle is a deferred module, so no page script can run
 * between module evaluation and boot(); the inline classic <script> in
 * player.html (ahead of the bundle) installs a queue that the bundle drains
 * at module load. This test builds a modder page the way a modder would: a
 * classic <script> registering a custom kind + an injected spec using it,
 * then asserts the custom enemy actually spawns instead of the game silently
 * falling back to the default knight.
 *
 * R3-N1: an invalid injected spec must produce a loud, dismissible on-screen
 * banner, not just a console.warn.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE_TAG = '<script type="module"';

function buildModderPage(specJson: string, modderScript: string): string {
  const playerHtml = readFileSync('dist/player.html', 'utf8');
  // Inject the spec exactly like scripts/export.ts does (into <head>).
  const specSafe = specJson.replace(/<\/script/gi, '<\\/script');
  const withSpec = playerHtml.replace(
    '<head>',
    `<head><script>window.__XANDRIA_SPEC__=${specSafe};</script>`
  );
  // The modder's classic script goes before the deferred bundle module —
  // any classic script in the page runs before the module; this mirrors what
  // a modder pastes into an exported xandria-game.html.
  return withSpec.replace(MODULE_TAG, `${modderScript}${MODULE_TAG}`);
}

function stalkerSpecJson(): string {
  const spec: any = JSON.parse(readFileSync('tests/e2e/fixtures/export-spec.json', 'utf8'));
  spec.enemies[0].kind = 'stalker';
  return JSON.stringify(spec);
}

async function writePage(html: string, name: string): Promise<string> {
  const outPath = join(tmpdir(), name);
  writeFileSync(outPath, html);
  return outPath;
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
});

test('R3-M1: pre-boot registerEnemyKind works from a real page script — custom enemy spawns', async ({
  browser,
}) => {
  const modderScript = `<script>
    window.__XANDRIA__.registerEnemyKind('stalker', {
      base: 'walker', name: 'Stalker',
      tint: { shirt: '#1a0a2e', pants: '#0a0a12', accent: '#c97aff' },
      scale: 1.15,
    });
  </script>`;
  const outPath = await writePage(buildModderPage(stalkerSpecJson(), modderScript), 'xandria-e2e-preboot.html');

  const ctx = await browser.newContext({ offline: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('file://' + outPath + '?test=1', { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, {
    timeout: 30000,
  });

  const result = await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    return {
      specName: X.spec.meta.name,
      registered: [...X.engine.hooks.enemyKinds.keys()],
      enemies: X.blueprint.enemies.enemies.map((e: any) => ({
        kind: e.spec.kind,
        alive: e.alive,
        hasBody: !!e.body,
      })),
      warnErrors: X.errors.filter((m: string) => m.includes('invalid injected spec')),
    };
  });

  // The injected spec booted — NOT the default knight fallback.
  expect(result.specName).toBe('Emerald Realm');
  // The pre-boot queue drained into the module registry AND merged into the
  // per-engine Modding instance (round-2 isolation preserved: per-engine map).
  expect(result.registered).toContain('stalker');
  // The custom enemy actually spawned with a body and AI.
  const stalkers = result.enemies.filter((e: any) => e.kind === 'stalker');
  expect(stalkers.length).toBeGreaterThan(0);
  expect(stalkers.every((e: any) => e.alive && e.hasBody)).toBe(true);
  // No silent-fallback warning fired.
  expect(result.warnErrors).toEqual([]);
  const captured = await page.evaluate(() => (window as any).__XANDRIA_ERRORS ?? []);
  expect([...captured, ...errors]).toEqual([]);
  await ctx.close();
});

test('R3-N1: invalid injected spec shows a dismissible on-screen banner', async ({ browser }) => {
  const badSpec = JSON.stringify({ meta: { name: 'Broken' } });
  const outPath = await writePage(buildModderPage(badSpec, ''), 'xandria-e2e-badbannerspec.html');

  const ctx = await browser.newContext({ offline: true });
  const page = await ctx.newPage();
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.goto('file://' + outPath + '?test=1', { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, {
    timeout: 30000,
  });

  // Loud on-screen signal, not just a console.warn.
  const banner = page.locator('#xandria-spec-fallback');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('invalid');
  await expect(banner).toContainText('default game');
  expect(warnings.some((w) => w.includes('invalid injected spec'))).toBe(true);

  // The default game booted underneath.
  const specName = await page.evaluate(() => (window as any).__XANDRIA__.spec.meta.name);
  expect(specName).toBe('Ancient Realm');

  // Dismissible.
  await banner.getByRole('button', { name: 'Dismiss this notice' }).click();
  await expect(banner).toBeHidden();
  await ctx.close();
});
