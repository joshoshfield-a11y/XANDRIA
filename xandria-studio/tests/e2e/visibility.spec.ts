/**
 * Visibility regression: no generated game may render an effectively black
 * framebuffer. Guards the color-management fixes in Terrain/Materials (vertex
 * colors and canvas textures were ~10x darker than authored) and the night
 * lighting floor in Sky. A night neon-city top-down game once shipped pure
 * black with only the HUD visible.
 */
import { test, expect, type Page } from '@playwright/test';

/** Mean brightness (0..1) of the central 3D viewport region, HUD excluded. */
async function centerBrightness(page: Page, shot: Buffer): Promise<number> {
  return page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 160; c.height = 90;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, 160, 90);
    // center region only: x 48..112, y 27..63 (avoids HUD cards/edges)
    const d = ctx.getImageData(48, 27, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4) / 255;
  }, shot.toString('base64'));
}

const DARK_COMBOS: [string, string][] = [
  ['night neon-city top-down', 'top-down twin stick shooter in a neon city at night'],
  ['night space-station fps', 'fps arena shooter on a space station at night'],
];

for (const [name, intent] of DARK_COMBOS) {
  test(`visibility: ${name} renders a lit scene`, async ({ page }) => {
    await page.goto(`/player.html?test=1&intent=${encodeURIComponent(intent)}`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 30000 });
    await page.waitForTimeout(5000); // let lighting settle over a few frames
    const shot = await page.screenshot();
    const bright = await centerBrightness(page, shot);
    console.log(`[visibility] ${name}: center brightness ${bright.toFixed(4)}`);
    // The black-framebuffer bug measured ~0.002 here; a lit night scene is >0.05.
    expect(bright).toBeGreaterThan(0.03);
  });
}
