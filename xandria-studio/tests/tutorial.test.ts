/**
 * Tutorial wave — data-driven first-run tutorial.
 *
 * - TUTORIAL_STEPS: table integrity (7 steps, fixed order, unique ids,
 *   non-empty prompts, sane tuning).
 * - resolveTutorialMode: defaults + validation.
 * - TutorialManager: observation-only state machine — step advance via the
 *   hook seams (onAttack/onPickup/onCraftComplete/onPortalArrive) and via
 *   polled state (move/look/equip) on onTick; auto-skip rules for genres
 *   where a step can't be performed; skip() and completion both persist
 *   Profile.tutorialSeen so the tutorial never replays.
 * - Profile: tutorialSeen round-trips through save/load and migrates from
 *   old shapes as false.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  TUTORIAL_STEPS,
  resolveTutorialMode,
  TutorialManager,
} from '../src/engine/game/Tutorial';
import { Modding } from '../src/engine/game/Modding';
import {
  _setProfileStorage,
  defaultProfile,
  loadProfile,
  saveProfile,
  migrateProfile,
} from '../src/engine/game/Profile';
import { EQUIP_SLOTS } from '../src/spec/schema';

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    _map: m,
  };
}

interface FakeEngine {
  hooks: Modding;
  hud: { showTutorialCard: (...a: unknown[]) => void; hideTutorialCard: () => void; toast: (s: string) => void };
  spec: Record<string, unknown>;
  state: string;
  camera: { quaternion: THREE.Quaternion };
  portalManager: unknown;
  portalsPlayerAvatar: unknown;
  touch: { active: boolean };
}

function fakeEngine(custom: Record<string, unknown> = {}, weapon: string = 'sword'): FakeEngine {
  const engine = {} as unknown as FakeEngine;
  engine.hooks = new Modding(engine as never);
  engine.hud = {
    shown: [] as Array<{ label: string; prompt: string }>,
    showTutorialCard(label: string, prompt: string) {
      (this as unknown as { shown: Array<{ label: string; prompt: string }> }).shown.push({ label: String(label), prompt: String(prompt) });
    },
    hideTutorialCard() {},
    toast() {},
  } as unknown as FakeEngine['hud'];
  engine.spec = {
    player: { weapon },
    custom,
  };
  engine.state = 'playing';
  engine.camera = { quaternion: new THREE.Quaternion() };
  engine.portalManager = null;
  engine.portalsPlayerAvatar = null;
  engine.touch = { active: false };
  return engine;
}

function fakeAvatar(x = 0, z = 0) {
  const position = new THREE.Vector3(x, 0, z);
  return { ctrl: { position } };
}

function fakeInventory(equipped: Record<string, string> = {}) {
  return {
    getEquipped: (slot: string) => equipped[slot] ?? null,
  };
}

beforeEach(() => {
  _setProfileStorage(memStore());
});

describe('TUTORIAL_STEPS table', () => {
  it('has the 7 steps in the mandated order with unique ids', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual([
      'move', 'look', 'attack', 'loot', 'equip', 'craft', 'portal',
    ]);
    expect(new Set(TUTORIAL_STEPS.map((s) => s.id)).size).toBe(7);
  });

  it('every step has prompts, trigger, completion, skip rule and sane tuning', () => {
    for (const s of TUTORIAL_STEPS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.prompt.length).toBeGreaterThan(5);
      expect(s.promptTouch.length).toBeGreaterThan(5);
      expect(s.trigger.length).toBeGreaterThan(5);
      expect(s.completeWhen.length).toBeGreaterThan(5);
      expect(s.skipWhen.length).toBeGreaterThan(5);
    }
    const move = TUTORIAL_STEPS[0];
    expect(move.moveMeters).toBeGreaterThan(0);
    const look = TUTORIAL_STEPS[1];
    expect(look.lookRadians).toBeGreaterThan(0);
  });
});

describe('resolveTutorialMode', () => {
  it('defaults to auto, validates the enum, ignores garbage', () => {
    expect(resolveTutorialMode({} as never)).toBe('auto');
    expect(resolveTutorialMode({ custom: { tutorial: { mode: 'force' } } } as never)).toBe('force');
    expect(resolveTutorialMode({ custom: { tutorial: { mode: 'skip' } } } as never)).toBe('skip');
    expect(resolveTutorialMode({ custom: { tutorial: { mode: 'party' } } } as never)).toBe('auto');
    expect(resolveTutorialMode({ custom: { tutorial: 'force' } } as never)).toBe('auto');
  });
});

describe('TutorialManager lifecycle', () => {
  it('auto mode starts on a fresh profile; skip mode never starts', () => {
    const auto = new TutorialManager(fakeEngine() as never);
    expect(auto.active).toBe(true);
    expect(auto.done).toBe(false);
    expect(auto.stepIndex).toBe(0);

    const skip = new TutorialManager(fakeEngine({}, 'sword') as never);
    // mode resolved from spec; force skip via custom
    const skip2 = new TutorialManager(
      fakeEngine({ tutorial: { mode: 'skip' } }) as never,
    );
    expect(skip2.active).toBe(false);
    expect(skip2.done).toBe(true);
    expect(skip.active).toBe(true); // sanity: default is auto, not skip
  });

  it('auto mode stays dormant when the profile already saw the tutorial', () => {
    const p = defaultProfile();
    p.tutorialSeen = true;
    saveProfile(p);
    const m = new TutorialManager(fakeEngine() as never);
    expect(m.active).toBe(false);
    expect(m.done).toBe(true);
  });

  it('force mode starts even when the profile saw the tutorial', () => {
    const p = defaultProfile();
    p.tutorialSeen = true;
    saveProfile(p);
    const m = new TutorialManager(
      fakeEngine({ tutorial: { mode: 'force' } }) as never,
    );
    expect(m.active).toBe(true);
    expect(m.done).toBe(false);
  });

  it('shows the card on the first playing tick, not before', () => {
    const e = fakeEngine();
    e.state = 'ready';
    const m = new TutorialManager(e as never);
    m['onTick']();
    expect((e.hud as unknown as { shown: unknown[] }).shown.length).toBe(0);
    e.state = 'playing';
    m['onTick']();
    const shown = (e.hud as unknown as { shown: Array<{ label: string; prompt: string }> }).shown;
    expect(shown.length).toBe(1);
    expect(shown[0].label).toContain('STEP 1/7');
    expect(shown[0].prompt).toContain('WASD');
  });
});

describe('TutorialManager step advancement (observation only)', () => {
  function started(custom: Record<string, unknown> = {}, weapon = 'sword') {
    const e = fakeEngine(custom, weapon);
    const m = new TutorialManager(e as never);
    m['onTick'](); // first playing tick -> card for step 0
    return { e, m };
  }

  it('move completes after 6 m of real displacement; teleports do not count', () => {
    const { e, m } = started();
    const av = fakeAvatar();
    e.portalsPlayerAvatar = av;
    m['onTick'](); // latch start pos
    av.ctrl.position.set(3, 0, 0);
    m['onTick']();
    expect(m.stepId).toBe('move');
    av.ctrl.position.set(6.5, 0, 0);
    m['onTick']();
    expect(m.stepId).toBe('look');
  });

  it('a single 100 m teleport jump does not complete the move step', () => {
    const { e, m } = started();
    const av = fakeAvatar();
    e.portalsPlayerAvatar = av;
    m['onTick']();
    av.ctrl.position.set(100, 0, 100);
    m['onTick']();
    expect(m.stepId).toBe('move');
  });

  it('look completes after 0.6 rad of camera rotation', () => {
    const { e, m } = started();
    m['advance'](); // -> look
    expect(m.stepId).toBe('look');
    const q = new THREE.Quaternion();
    // latch at 0.4 rad yaw, then +0.4: 0.4 total < 0.6 — not enough
    q.setFromEuler(new THREE.Euler(0, 0.4, 0, 'YXZ'));
    e.camera.quaternion.copy(q);
    m['onTick'](); // latch
    q.setFromEuler(new THREE.Euler(0, 0.8, 0, 'YXZ'));
    e.camera.quaternion.copy(q);
    m['onTick']();
    expect(m.stepId).toBe('look');
    // another 0.4 rad: 0.8 total >= 0.6 — completes
    q.setFromEuler(new THREE.Euler(0, 1.2, 0, 'YXZ'));
    e.camera.quaternion.copy(q);
    m['onTick']();
    expect(m.stepId).toBe('attack');
  });

  it('attack completes on the onAttack hook (melee or ranged)', () => {
    const { m } = started();
    m['advance'](); // look
    m['advance'](); // attack
    expect(m.stepId).toBe('attack');
    // emit through the real hook bus
    const bus = (m as unknown as { engine: FakeEngine }).engine.hooks;
    bus.emit('onAttack', { kind: 'ranged' });
    expect(m.stepId).toBe('loot');
  });

  it('attack auto-skips when the spec has no player weapon (racing)', () => {
    const { m } = started({}, 'none');
    m['advance'](); // look
    m['advance'](); // would be attack -> auto-skip
    expect(m.stepId).toBe('loot');
  });

  it('loot completes on the onPickup hook', () => {
    const { m } = started();
    m.setInventory(() => fakeInventory() as never); // equip must not auto-skip
    for (let i = 0; i < 3; i++) m['advance']();
    expect(m.stepId).toBe('loot');
    const bus = (m as unknown as { engine: FakeEngine }).engine.hooks;
    bus.emit('onPickup', { pickup: {} as never });
    expect(m.stepId).toBe('equip');
  });

  it('equip completes when any slot fills; auto-skips with no inventory', () => {
    // no inventory registered -> auto-skip to craft
    const { m } = started();
    for (let i = 0; i < 4; i++) m['advance']();
    expect(m.stepId).toBe('craft');

    // with inventory: poll completes the step
    const { e, m: m2 } = started();
    m2.setInventory(() => fakeInventory() as never);
    for (let i = 0; i < 4; i++) m2['advance']();
    expect(m2.stepId).toBe('equip');
    m2['onTick']();
    expect(m2.stepId).toBe('equip');
    m2.setInventory(() => fakeInventory({ weapon: 'sword_01' }) as never);
    m2['onTick']();
    expect(m2.stepId).toBe('craft');
    expect(e).toBeTruthy();
  });

  it('craft completes on onCraftComplete; auto-skips when crafting disabled', () => {
    const { m } = started({ crafting: { enabled: false } });
    for (let i = 0; i < 5; i++) m['advance']();
    // equip auto-skips (no inventory), craft auto-skips (disabled),
    // portal auto-skips (no portal manager) -> tutorial done
    expect(m.done).toBe(true);

    _setProfileStorage(memStore()); // fresh profile: the finish above persisted tutorialSeen
    const { m: m2 } = started();
    for (let i = 0; i < 4; i++) m2['advance']();
    expect(m2.stepId).toBe('craft');
    const bus = (m2 as unknown as { engine: FakeEngine }).engine.hooks;
    bus.emit('onCraftComplete', { recipeId: 'r1' });
    // portal auto-skips (no portal manager) -> done
    expect(m2.done).toBe(true);
  });

  it('portal completes on onPortalArrive; auto-skips with no portal manager', () => {
    const { m } = started();
    for (let i = 0; i < 6; i++) m['advance']();
    // portal auto-skips (fake engine has no portalManager) -> tutorial done
    expect(m.done).toBe(true);
    expect(m.active).toBe(false);

    _setProfileStorage(memStore()); // the finish above persisted tutorialSeen
    const e = fakeEngine();
    e.portalManager = {}; // portals enabled
    const m2 = new TutorialManager(e as never);
    m2['onTick']();
    // 5 advances: look, attack, loot, equip(auto-skip), craft, portal
    for (let i = 0; i < 5; i++) m2['advance']();
    expect(m2.stepId).toBe('portal');
    e.hooks.emit('onPortalArrive', { mapSeed: 123 });
    expect(m2.done).toBe(true);
  });

  it('completing the last step persists tutorialSeen (never replays)', () => {
    const e = fakeEngine();
    e.portalManager = {};
    const m = new TutorialManager(e as never);
    m['onTick']();
    for (let i = 0; i < 5; i++) m['advance']();
    expect(m.stepId).toBe('portal');
    e.hooks.emit('onPortalArrive', { mapSeed: 1 });
    expect(m.done).toBe(true);
    expect(loadProfile().tutorialSeen).toBe(true);
    // a fresh manager on the same stored profile stays dormant
    const m2 = new TutorialManager(fakeEngine() as never);
    expect(m2.active).toBe(false);
  });

  it('skip() dismisses and persists the seen flag', () => {
    const { m } = started();
    m.skip();
    expect(m.done).toBe(true);
    expect(m.active).toBe(false);
    expect(loadProfile().tutorialSeen).toBe(true);
  });

  it('out-of-order hook events do not advance the wrong step', () => {
    const { e, m } = started(); // on 'move'
    e.hooks.emit('onPickup', { pickup: {} as never });
    e.hooks.emit('onAttack', { kind: 'melee' });
    e.hooks.emit('onCraftComplete', { recipeId: 'r' });
    expect(m.stepId).toBe('move');
  });
});

describe('Profile tutorialSeen', () => {
  it('defaults false, round-trips, migrates from legacy shapes as false', () => {
    expect(defaultProfile().tutorialSeen).toBe(false);
    const p = defaultProfile();
    p.tutorialSeen = true;
    saveProfile(p);
    expect(loadProfile().tutorialSeen).toBe(true);

    const legacy = migrateProfile({ version: 1, merit: 5 });
    expect(legacy.tutorialSeen).toBe(false);
    expect(migrateProfile({ tutorialSeen: 'yes' }).tutorialSeen).toBe(false);
    expect(migrateProfile(null).tutorialSeen).toBe(false);
  });

  it('EQUIP_SLOTS covers the slots the tutorial polls', () => {
    expect([...EQUIP_SLOTS]).toEqual(['weapon', 'head', 'torso', 'legs', 'accessory']);
  });
});
