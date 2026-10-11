/**
 * Polish wave (LOOK crew): before/after beauty shots for the color grade +
 * living-light pass. HUD hidden, quality forced to 'high' via ?spec= so the
 * grade pass and LightLife are live. Specs are generated in Node
 * (scripts/polish-grade-specs.ts -> /tmp/grade-specs/*.b64) so each genre
 * boots with a SINGLE goto.
 *
 * Run with GRADE_BEFORE=1 for the pre-change baseline (writes -before shots);
 * without it for the after shots at the deliverable paths
 * (tests/e2e/shots/polish-grade-<genre>.png).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const GENRES = [
  { name: 'tp-action', expect: 'third-person-action' },
  { name: 'fps-arena', expect: 'fps-arena' },
  { name: 'racing', expect: 'racing' },
  { name: 'platformer', expect: 'platformer' },
  { name: 'topdown', expect: 'top-down-shooter' },
];

const BEFORE = !!process.env.GRADE_BEFORE;

for (const g of GENRES) {
  test(`polish-grade ${g.name}${BEFORE ? ' (before)' : ''}`, async ({ page }) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

    const b64 = readFileSync(`/tmp/grade-specs/${g.name}.b64`, 'utf8').trim();
    await page.goto(`/player.html?test=1&spec=${b64}`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 240000 });

    // hide HUD for the beauty shot
    await page.addStyleTag({ content: '.xhud{display:none!important}' });

    // same framing procedure as the playability shots: drive forward briefly
    const moved = await page.evaluate(async () => {
      const X = (window as any).__XANDRIA__;
      X.engine.input.inject(['forward', 'sprint'], { lx: 0, ly: -1 });
      await new Promise((r) => setTimeout(r, 2500));
      X.engine.input.inject([], null);
      return {
        genre: X.spec.meta.genre,
        quality: X.engine.effectiveQuality(),
        gradeActive: !!X.engine.postfx.gradeActive,
        poolSize: X.engine.sky.lightLife ? X.engine.sky.lightLife.poolSize : -1,
        errors: X.errors.length,
      };
    });
    expect(moved.genre).toBe(g.expect);
    expect(moved.quality).toBe('high');
    if (!BEFORE) {
      expect(moved.gradeActive).toBe(true);
      expect(moved.poolSize).toBe(3);
    }
    expect(moved.errors).toBe(0);

    await page.screenshot({ path: `tests/e2e/shots/polish-grade-${g.name}${BEFORE ? '-before' : ''}.png` });
    expect(errors).toEqual([]);
  });
}
