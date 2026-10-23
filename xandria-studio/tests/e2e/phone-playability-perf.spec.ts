/**
 * QA fix wave 2026-10-22 (phone-playability), F3(d) — perf ratchet gate on
 * the user's exact reported session: prompt "A cyberpunk rpg shooter"
 * (seed 2242542926), third-person-action, quality high, s25 tier.
 *
 * Method (the house method from enemies-perf): wait for state 'playing',
 * settle 20 s so chunk streaming reaches its resident state, then take
 * renderer.info.render.calls as a median of 10 samples 1.5 s apart.
 *
 * Measured on this method (SwiftShader, 2026-10-22):
 *   pre-fix:  444 draws, 814,602 tris, 2,897 physics bodies, shadow 2048, MSAA 4
 *   post-fix: 446 draws, 838,922 tris,   529 physics bodies, shadow 1024, MSAA 2
 *
 * Read that honestly: this wave's wins are the tier ceilings (shadow
 * resolution quartered in texels, MSAA halved, detail layer off) and the
 * physics census (−82% bodies; per-chunk scatter bodies 86 → 3 via merged
 * compound colliders). The DRAW-CALL census did not move — instanced pools
 * cost one call per pool per pass regardless of instance counts, and the
 * s25 budget is 150 draws against a measured ~446. The remaining ~296-call
 * gap is structural (shadow pass + pool/pass count) and is NOT closed by
 * this wave; it needs its own pass (shadow-pass diet / pool consolidation)
 * with the user's call. This gate ratchets the settled census so it cannot
 * silently grow: RATCHET = 452 = measured median 446 + streaming noise
 * headroom (±6 observed across runs).
 *
 * SwiftShader frame times are not phone evidence — this gate asserts
 * counts and structure only; on-device fps is unmeasured.
 */
import { test, expect } from '@playwright/test';
import { generateSpec } from '../../src/generator/generate';

const RATCHET_DRAWS = 452;
const BODY_RATCHET = 600; // measured 529 post-fix (2,897 pre-fix)

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

test('F3 ratchet: reference scene settled census on s25 + high', async ({ page }) => {
  test.setTimeout(600_000);
  const spec: any = generateSpec('A cyberpunk rpg shooter', { genre: 'third-person-action' });
  spec.custom = { ...(spec.custom ?? {}), quality: 'high' };
  expect(spec.meta.seed).toBe(2242542926);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${b64url(JSON.stringify(spec))}&test=1&autostart=1&splash=0&tier=s25`);
  await page.waitForFunction(
    () => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__?.engine?.state === 'playing',
    null, { timeout: 180_000 },
  );
  await page.waitForTimeout(20_000);

  const calls: number[] = [];
  for (let i = 0; i < 10; i++) {
    calls.push(await page.evaluate(
      () => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.renderer.info.render.calls,
    ));
    await page.waitForTimeout(1500);
  }
  const census = await page.evaluate(() => {
    const E = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine;
    return {
      bodies: E.physics.world.bodies.length,
      shadow: E.sky.sun ? E.sky.sun.shadow.mapSize.x : -1,
      msaa: (E.postfx as { msaaSamples?: number }).msaaSamples,
    };
  });

  expect(median(calls), `settled draw calls (samples: ${calls.join(',')})`).toBeLessThanOrEqual(RATCHET_DRAWS);
  expect(census.bodies, 'physics body census').toBeLessThanOrEqual(BODY_RATCHET);
  expect(census.shadow, 's25 shadow ceiling').toBe(1024);
  expect(census.msaa, 's25 MSAA ceiling').toBe(2);
  expect(errors).toEqual([]);
});
