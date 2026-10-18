/**
 * NPCs workstream C: spawn via A's API (spawnNpcsForMap), register the
 * interactables manually through the C registration policy, then verify:
 * approaching an NPC surfaces the `Talk to <name>` prompt, pressing E
 * opens the dialogue stub (seeded name + greeting), Escape dismisses it —
 * on desktop AND 360x780, with zero console/page errors.
 *
 * The perf harness (scripts/measure-npc-draws.mjs) covers draw calls; this
 * spec covers the interaction contract.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

interface NpcInfo { name: string; greeting: string; }

test('npcs: spawn, prompt, dialogue stub, zero errors, desktop + mobile', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);

  // NOTE: page.waitForFunction's RAF polling proved unreliable in this
  // environment (see portal-traverse.spec.ts) — poll from Node instead.
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
    return !!(X?.engine && X?.npcTest && X?.engine?.portalsPlayerAvatar && X.engine.state === 'playing');
  }), 240_000);

  // Spawn 4 NPCs near the player via A's API; register through C's policy;
  // tick the session on the engine's persistent update hook.
  // Deterministic interaction setup: freeze behavior (idle, infinite
  // stateT) and spread the NPCs 20m apart so prompts never cross. The
  // prompt/dialogue contract doesn't depend on wander; a wandering +
  // repulsion-fleeing NPC races the 2s Node polls under SwiftShader
  // (stale prompt -> E lands with target cleared -> 30s timeout flake).
  const roster: NpcInfo[] = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any; __NPCS__?: any }).__XANDRIA__!;
    const E = X.engine;
    const T = X.npcTest;
    const av = E.portalsPlayerAvatar;
    const p = av.ctrl.position.clone();
    const npcs = T.spawnNpcsForMap(E, X.spec.meta.seed, { count: 4, pois: [p] });
    npcs.forEach((n: any, k: number) => {
      n.state = 'idle';
      n.stateT = 1e9;
      const pos = n.position;
      n.body.position.set(k * 20, pos.y, 0);
      n.body.velocity.set(0, 0, 0);
    });
    const session = new T.NpcInteractionSession(E, npcs);
    E.onUpdatePersistent((dt: number) => session.update(dt));
    (window as unknown as { __NPCS__?: any }).__NPCS__ = { npcs, session };
    return npcs.map((n: any) => ({ name: n.name, greeting: n.greeting }));
  });
  expect(roster).toHaveLength(4);

  const registrySize = (): Promise<number> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.npcInteractions.size);
  expect(await registrySize()).toBe(4);

  /** teleport the avatar to 2m from NPC i (inside the 3m prompt
   *  radius, outside the 1.8m repulsion keep-out; NPCs are frozen apart) */
  const approach = (i: number): Promise<void> => page.evaluate((i) => {
    const X = (window as unknown as { __XANDRIA__?: any; __NPCS__?: any }).__XANDRIA__!;
    const { npcs } = (window as unknown as { __NPCS__?: any }).__NPCS__;
    const pos = npcs[i].position.clone();
    pos.x += 2;
    X.engine.portalsPlayerAvatar.ctrl.teleport(pos);
  }, i);

  const promptText = (): Promise<string | null> => page.evaluate(() => {
    const el = document.getElementById('xandria-interact-prompt') as HTMLElement | null;
    if (!el || el.style.display !== 'block') return null;
    return el.textContent;
  });

  const dialogueShown = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-dialogue-panel') as HTMLElement | null;
    return !!el && el.style.display === 'block';
  });

  const dialogueText = (): Promise<string> => page.evaluate(() =>
    (document.getElementById('xandria-dialogue-panel') as HTMLElement | null)?.textContent ?? '');

  /** full prompt -> E -> dialogue -> Escape cycle for NPC i */
  const talkCycle = async (i: number) => {
    await approach(i);
    await waitFor(`prompt for npc ${i}`, async () => {
      const t = await promptText();
      return t === `[E] Talk to ${roster[i].name}`;
    }, 60_000);
    await page.keyboard.press('e');
    await waitFor(`dialogue for npc ${i}`, dialogueShown, 30_000);
    const text = await dialogueText();
    expect(text).toContain(roster[i].name);
    expect(text).toContain(roster[i].greeting);
    await page.screenshot({ path: `/tmp/npcs-dialogue-${i}.png` });
    await page.keyboard.press('Escape');
    await waitFor(`dialogue dismissed for npc ${i}`, async () => !(await dialogueShown()), 30_000);
  };

  // ---- desktop leg: talk to NPC 0 ----
  await talkCycle(0);

  // ---- mobile leg: 360x780, talk to NPC 1 ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await talkCycle(1);

  expect(errors).toEqual([]);
});
