import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();
const B64 = (() => {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
})();

test('quests-debug: prompt retargets after teleport', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label})`);
      await page.waitForTimeout(2000);
    }
  };
  await waitFor('boot', () => page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    return !!(X?.engine && X?.questTest && X?.blueprint?.quests && X.engine.state === 'playing');
  }), 240_000);
  await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const state = () => page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    const pp = X.engine.portalsPlayerAvatar.ctrl.position;
    const s = X.questTest.liveTalkSession();
    const t = (s as any).prompt?.currentTarget;
    return {
      player: [pp.x.toFixed(1), pp.z.toFixed(1)].join(','),
      target: t ? t.id : null,
      targetType: t ? t.type : null,
      sessionDisposed: (s as any).disposed,
      dialogueOpen: (s as any).dialogue?.isOpen ?? null,
    };
  });

  // hop between 4 far-apart villagers, checking the prompt retargets each time
  for (let hop = 0; hop < 4; hop++) {
    const vid = await page.evaluate((hop) => {
      const X = (window as any).__XANDRIA__;
      const pp = X.engine.portalsPlayerAvatar.ctrl.position;
      const cands = X.blueprint.npcs.npcs
        .filter((n: any) => n.role === 'villager' && n.position.distanceTo(pp) > 15)
        .sort((a: any, b: any) => b.position.distanceTo(pp) - a.position.distanceTo(pp));
      const n = cands[hop % cands.length];
      const p = n.position;
      const V = X.engine.camera.position.constructor;
      X.engine.portalsPlayerAvatar.ctrl.teleport(new V(p.x + 2, p.y + 1, p.z));
      return n.interactable.id;
    }, hop);
    await page.waitForTimeout(4000);
    const st = await state();
    console.log(`[dbg] hop ${hop}: teleported near ${vid.slice(-6)} ->`, JSON.stringify(st));
  }

  // open a dialogue via E, then close via E, verify no reopen
  await page.keyboard.press('e');
  await waitFor('dialogue opens', async () => (await state()).dialogueOpen === true, 30_000);
  console.log('[dbg] dialogue opened');
  await page.keyboard.press('e');
  await page.waitForTimeout(3000);
  const afterClose = await state();
  console.log('[dbg] 3s after E-close:', JSON.stringify(afterClose));
  expect(afterClose.dialogueOpen).toBe(false);
});
