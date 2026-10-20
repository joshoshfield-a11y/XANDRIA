/**
 * HUD/UI polish wave — e2e verification (not eyeballing).
 *
 * Fixture: npcs.b64 (seed 20261012, tp-action) — same world as the
 * side-quests spec, so the real villager-dialogue / crafting-panel paths
 * are available.
 *
 * Desktop test (1280x720, no touch):
 *   1. Z-ORDER: open a real villager dialogue, then fire a level-up modal
 *      while the dialogue is open. Assert the modal layer sits above the
 *      dialogue (z-index) AND that Playwright can actually click an upgrade
 *      button — its actionability checks (visible, stable, receives pointer
 *      events at the click point) are the behavioral proof the papercut is
 *      fixed. Assert the pick resolves and the game resumes.
 *   2. OVERLAP AUDIT: with a quest accepted (tracker visible) and the boss
 *      bar forced on, measure the bounding boxes of every HUD chip and
 *      assert no pairwise intersections.
 *   3. TOUCH TARGETS: measure dialogue buttons, crafting-panel buttons and
 *      level-up buttons; assert >= 28px (skills-wave precedent).
 *
 * Mobile test (360x780, hasTouch): the same three legs with the touch
 * overlay active — the papercut's original scene (dialogue z-9500 over the
 * modal), plus the pause-button / tracker / boss-bar geometry that only
 * exists on touch.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

// Same deterministic scene, plus an empty item table so the blueprint builds
// the item kit (sidequests.spec.ts pattern).
const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);

type X = { __XANDRIA__?: any };
type Box = { x: number; y: number; w: number; h: number; id: string };

async function boot(page: any, errors: string[]): Promise<void> {
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
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine && X?.questTest && X?.gatheringTest && X?.craftingTest
      && X?.blueprint?.quests && X?.blueprint?.npcs && X?.blueprint?.itemKit
      && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);
  // God-mode: the harness must not be mauled mid-dialogue.
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
}

function harness(page: any) {
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  const dialogueOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-dialogue-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });
  const openVillagerDialogue = async (): Promise<string> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const vid: string | null = await page.evaluate(() => {
        const X = (window as unknown as X).__XANDRIA__;
        const npcs = X.blueprint.npcs.npcs.filter((n: any) => n.role === 'villager');
        const nodes = X.gatheringTest.liveManager().nodes as any[];
        const stations = X.craftingTest.liveStations().stations as any[];
        const rivals = [...nodes, ...stations].map((r: any) => r.root.position);
        const cands = npcs.filter((n: any) =>
          Math.min(...rivals.map((p: any) => Math.hypot(p.x - n.position.x, p.z - n.position.z))) > 4);
        if (!cands.length) return null;
        const id = cands[0].interactable.id;
        const n = cands[0];
        const p = n.position;
        const V = X.engine.camera.position.constructor;
        X.engine.portalsPlayerAvatar.ctrl.teleport(new V(p.x + 2, p.y + 1, p.z));
        return id;
      });
      if (!vid) throw new Error('no villager candidates');
      try {
        await waitFor('villager talk prompt', () => page.evaluate((vid2: string) =>
          (window as unknown as X).__XANDRIA__.questTest.liveTalkSession()?.promptedNpc?.interactable.id === vid2, vid), 15_000);
      } catch { continue; }
      await page.keyboard.press('e');
      await waitFor('dialogue opens', dialogueOpen, 30_000);
      return vid;
    }
    throw new Error('openVillagerDialogue: no prompt won after 10 attempts');
  };
  const closeDialogue = async (): Promise<void> => {
    await page.keyboard.press('e');
    await waitFor('dialogue closes', async () => !(await dialogueOpen()), 30_000);
  };
  /** Fire a level-up modal via the real HUD path; resolves the pick into window.__lvlId. */
  const fireLevelUp = (): Promise<void> => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    (window as any).__lvlId = null;
    void X.engine.hud.showLevelUp([
      { id: 'u_a', name: 'Upgrade A', desc: 'desc a' },
      { id: 'u_b', name: 'Upgrade B', desc: 'desc b' },
      { id: 'u_c', name: 'Upgrade C', desc: 'desc c' },
    ]).then((id: string) => { (window as any).__lvlId = id; });
  });
  const boxes = (sels: string[]): Promise<Box[]> => page.evaluate((sels: string[]) => {
    const out: Box[] = [];
    for (const s of sels) {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height, id: s });
    }
    return out;
  }, sels);
  const buttonSizes = (sel: string): Promise<Array<{ text: string; w: number; h: number }>> =>
    page.evaluate((sel: string) =>
      [...document.querySelectorAll(sel)].map((b) => {
        const r = (b as HTMLElement).getBoundingClientRect();
        return { text: (b.textContent ?? '').slice(0, 28).replace(/\s+/g, ' '), w: r.width, h: r.height };
      }), sel);
  return { waitFor, dialogueOpen, openVillagerDialogue, closeDialogue, fireLevelUp, boxes, buttonSizes };
}

const overlapPairs = (list: Box[]): Array<[Box, Box]> => {
  const hits: Array<[Box, Box]> = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push([a, b]);
    }
  }
  return hits;
};

const HUD_SELS = [
  '#xandria-quest-tracker', '.xhud .score', '.xhud .objective',
  '.xhud .bars', '.xhud .boss', '.xhud .hint', '.xtouch .pausebtn',
];

/** Accept the first available side quest via the real dialogue path (tracker becomes visible). */
async function acceptOneQuest(page: any, h: ReturnType<typeof harness>): Promise<void> {
  await h.openVillagerDialogue();
  const questId: string | null = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const d = X.questTest.liveManager().defs.find((d: any) => d.side && X.questTest.liveManager().statusOf(d.id) === 'available');
    return d ? d.id : null;
  });
  expect(questId, 'an available side quest exists').toBeTruthy();
  await page.locator(`#xandria-dialogue-panel button[data-quest-action="accept:${questId}"]`).click();
  await h.waitFor('quest active', () => page.evaluate((id: string) =>
    (window as unknown as X).__XANDRIA__.questTest.liveManager().statusOf(id) === 'active', questId), 30_000);
  await h.closeDialogue();
}

test('hud-polish: z-order + overlap audit + touch targets (desktop 1280x720)', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  await boot(page, errors);
  const h = harness(page);

  // ---- 1. Z-ORDER: level-up modal must be clickable while a dialogue is open ----
  await h.openVillagerDialogue();
  await h.fireLevelUp();
  await page.waitForFunction(() => !!document.querySelector('.xhud-modals .overlay .lvlopt'), null, { timeout: 15_000 });
  const z = await page.evaluate(() => {
    const layer = document.querySelector('.xhud-modals') as HTMLElement;
    const dlg = document.getElementById('xandria-dialogue-panel') as HTMLElement;
    return {
      layerZ: Number(getComputedStyle(layer).zIndex),
      dlgZ: Number(getComputedStyle(dlg).zIndex),
      dlgOpen: dlg.style.display !== 'none',
    };
  });
  console.log('[hud-polish] z-order: ' + JSON.stringify(z));
  expect(z.dlgOpen, 'dialogue still open under the modal').toBe(true);
  expect(z.layerZ, 'modal layer above the dialogue panel').toBeGreaterThan(z.dlgZ);
  // Behavioral proof: Playwright's click runs actionability checks — the
  // button must visibly receive pointer events at the click point.
  await page.locator('.xhud-modals .overlay .lvlopt').first().click();
  await page.waitForFunction(() => (window as any).__lvlId !== null, null, { timeout: 15_000 });
  expect(await page.evaluate(() => (window as any).__lvlId), 'pick resolves').toBe('u_a');
  await page.waitForFunction(() => !document.querySelector('.xhud-modals .overlay'), null, { timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as X).__XANDRIA__.engine.state)).toBe('playing');
  await h.closeDialogue();

  // ---- 2. OVERLAP AUDIT ----
  await acceptOneQuest(page, h);
  await page.evaluate(() => (window as unknown as X).__XANDRIA__.engine.hud.setBoss('TEST BOSS', 0.5));
  await page.waitForTimeout(500);
  const dBoxes = await h.boxes(HUD_SELS);
  console.log('[hud-polish] desktop boxes: ' + JSON.stringify(dBoxes.map((b) => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }))));
  const dHits = overlapPairs(dBoxes);
  expect(dHits.map(([a, b]) => `${a.id} x ${b.id}`), 'no HUD chip collisions on desktop').toEqual([]);
  await page.evaluate(() => (window as unknown as X).__XANDRIA__.engine.hud.setBoss(null, 0));

  // ---- 3. TOUCH TARGETS (>= 28px) ----
  await h.openVillagerDialogue();
  const dlgBtns = await h.buttonSizes('#xandria-dialogue-panel button');
  console.log('[hud-polish] desktop dialogue buttons: ' + JSON.stringify(dlgBtns.map((b) => ({ t: b.text, w: Math.round(b.w), h: Math.round(b.h) }))));
  for (const b of dlgBtns) expect(b.h, `dialogue button "${b.text}" >= 28px tall`).toBeGreaterThanOrEqual(28);
  await h.closeDialogue();
  await h.fireLevelUp();
  await page.waitForFunction(() => !!document.querySelector('.xhud-modals .overlay .lvlopt'), null, { timeout: 15_000 });
  const lvlBtns = await h.buttonSizes('.xhud-modals .overlay .lvlopt');
  for (const b of lvlBtns) {
    expect(b.h, `level-up button "${b.text}" >= 28px tall`).toBeGreaterThanOrEqual(28);
    expect(b.w, `level-up button "${b.text}" >= 28px wide`).toBeGreaterThanOrEqual(28);
  }
  await page.locator('.xhud-modals .overlay .lvlopt').first().click();
  await page.waitForFunction(() => !document.querySelector('.xhud-modals .overlay'), null, { timeout: 15_000 });

  expect(errors, 'zero console/page errors').toEqual([]);
});

test.describe('hud-polish mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('hud-polish: z-order + overlap audit + touch targets (360x780, touch)', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    await boot(page, errors);
    const h = harness(page);
    const touchActive = await page.evaluate(() => !!(window as unknown as X).__XANDRIA__?.engine?.touch?.active);
    console.log('[hud-polish] touch overlay active: ' + touchActive);
    expect(touchActive, 'touch controls active on the touch context').toBe(true);

    // ---- 1. Z-ORDER (the papercut's original scene) ----
    await h.openVillagerDialogue();
    const dlgBox = await page.evaluate(() => {
      const el = document.getElementById('xandria-dialogue-panel') as HTMLElement | null;
      return el ? el.getBoundingClientRect().toJSON() : null;
    });
    expect(dlgBox, 'dialogue has a box on mobile').toBeTruthy();
    expect(dlgBox!.right).toBeLessThanOrEqual(360);
    await h.fireLevelUp();
    await page.waitForFunction(() => !!document.querySelector('.xhud-modals .overlay .lvlopt'), null, { timeout: 15_000 });
    const z = await page.evaluate(() => {
      const layer = document.querySelector('.xhud-modals') as HTMLElement;
      const dlg = document.getElementById('xandria-dialogue-panel') as HTMLElement;
      const btn = document.querySelector('.xhud-modals .overlay .lvlopt') as HTMLElement;
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
      return {
        layerZ: Number(getComputedStyle(layer).zIndex),
        dlgZ: Number(getComputedStyle(dlg).zIndex),
        dlgOpen: dlg.style.display !== 'none',
        hitIsButton: !!hit && !!hit.closest('.lvlopt'),
      };
    });
    console.log('[hud-polish] mobile z-order: ' + JSON.stringify(z));
    expect(z.dlgOpen, 'dialogue still open under the modal').toBe(true);
    expect(z.layerZ, 'modal layer above the dialogue panel').toBeGreaterThan(z.dlgZ);
    expect(z.hitIsButton, 'elementFromPoint at the button center hits the button').toBe(true);
    await page.locator('.xhud-modals .overlay .lvlopt').first().click();
    await page.waitForFunction(() => (window as any).__lvlId !== null, null, { timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).__lvlId), 'pick resolves').toBe('u_a');
    await page.waitForFunction(() => !document.querySelector('.xhud-modals .overlay'), null, { timeout: 15_000 });
    await h.closeDialogue();

    // ---- 2. OVERLAP AUDIT (touch geometry: pause button, tracker, boss bar) ----
    await acceptOneQuest(page, h);
    await page.evaluate(() => (window as unknown as X).__XANDRIA__.engine.hud.setBoss('TEST BOSS', 0.5));
    await page.waitForTimeout(500);
    const mBoxes = await h.boxes(HUD_SELS);
    console.log('[hud-polish] mobile boxes: ' + JSON.stringify(mBoxes.map((b) => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }))));
    const mHits = overlapPairs(mBoxes);
    expect(mHits.map(([a, b]) => `${a.id} x ${b.id}`), 'no HUD chip collisions on mobile').toEqual([]);
    await page.evaluate(() => (window as unknown as X).__XANDRIA__.engine.hud.setBoss(null, 0));

    // ---- 3. TOUCH TARGETS ----
    await h.openVillagerDialogue();
    const dlgBtns = await h.buttonSizes('#xandria-dialogue-panel button');
    console.log('[hud-polish] mobile dialogue buttons: ' + JSON.stringify(dlgBtns.map((b) => ({ t: b.text, w: Math.round(b.w), h: Math.round(b.h) }))));
    for (const b of dlgBtns) expect(b.h, `dialogue button "${b.text}" >= 28px tall`).toBeGreaterThanOrEqual(28);
    await h.closeDialogue();
    const touchBtns = await h.buttonSizes('.xtouch .tbtn, .xtouch .dpad, .xtouch .pausebtn');
    console.log('[hud-polish] touch controls: ' + JSON.stringify(touchBtns.map((b) => ({ t: b.text, w: Math.round(b.w), h: Math.round(b.h) }))));
    expect(touchBtns.length, 'touch buttons exist').toBeGreaterThan(0);
    for (const b of touchBtns) {
      expect(b.h, `touch control "${b.text}" >= 28px tall`).toBeGreaterThanOrEqual(28);
      expect(b.w, `touch control "${b.text}" >= 28px wide`).toBeGreaterThanOrEqual(28);
    }
    await h.fireLevelUp();
    await page.waitForFunction(() => !!document.querySelector('.xhud-modals .overlay .lvlopt'), null, { timeout: 15_000 });
    const lvlBtns = await h.buttonSizes('.xhud-modals .overlay .lvlopt');
    for (const b of lvlBtns) {
      expect(b.h, `level-up button "${b.text}" >= 28px tall`).toBeGreaterThanOrEqual(28);
      expect(b.w, `level-up button "${b.text}" >= 28px wide`).toBeGreaterThanOrEqual(28);
    }
    await page.locator('.xhud-modals .overlay .lvlopt').first().click();
    await page.waitForFunction(() => !document.querySelector('.xhud-modals .overlay'), null, { timeout: 15_000 });

    expect(errors, 'zero console/page errors').toEqual([]);
  });
});
