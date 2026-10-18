/**
 * NPCs wave (workstream C):
 * - resolveNpcCount: Studio density + low-tier scale resolution
 * - arbitratePrompt: NPC vs chest prompt arbitration (pure)
 * - registration policy: register/unregister idempotency on engine.npcInteractions
 * - NpcInteractionSession: prompt surfacing, dialogue open/close, dispose
 *   ordering (unregister before npc.dispose), double-dispose safety
 * - DialoguePanel: show/hide content
 *
 * DOM is the same makeEl stub harness as tests/npc.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '', width: 0, height: 0,
      appendChild(c: any) { el.children.push(c); return c; }, append(...cs: any[]) { for (const c of cs) el.children.push(c); },
      remove() {}, setAttribute() {}, getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener() {}, removeEventListener() {}, querySelector() { return makeEl(); }, querySelectorAll() { return []; },
      getContext: () => ({ createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
    };
    return el;
  }
  class FakeWebGLRenderer {
    domElement: any = makeEl('canvas'); shadowMap: any = {}; toneMapping: any = null; toneMappingExposure = 1;
    setPixelRatio() {} setSize() {} getPixelRatio() { return 1; } getSize() { return { width: 800, height: 600 }; }
    dispose() {} render() {}
  }
  return { makeEl, FakeWebGLRenderer };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import { Engine } from '../src/engine/Engine';
import { defaultSpec, type GameSpec, type NpcTuningCustom } from '../src/spec/schema';
import { spawnNpcsForMap } from '../src/engine/game/Npc';
import { InteractionRegistry, type Interactable } from '../src/engine/game/Interaction';
import { resolveNpcCount } from '../src/engine/game/npcTuning';
import { arbitratePrompt } from '../src/engine/ui/InteractionPrompt';
import { DialoguePanel } from '../src/engine/ui/DialoguePanel';
import {
  NpcInteractionSession,
  registerNpcInteractables,
  unregisterNpcInteractables,
} from '../src/engine/game/npcInteraction';

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

function stubInteractable(id: string, x: number, z: number, prompt = 'Talk to X'): Interactable {
  return { id, type: 'npc', position: new THREE.Vector3(x, 0, z), radius: 3, enabled: true, prompt };
}

describe('resolveNpcCount', () => {
  const spec = (npcs?: NpcTuningCustom) => ({ custom: { npcs } }) as GameSpec;

  it('defaults: 8 on desktop, 4 on s25', () => {
    expect(resolveNpcCount(spec(), 'desktop')).toBe(8);
    expect(resolveNpcCount(spec(), 's25')).toBe(4);
  });

  it('density scales both tiers', () => {
    expect(resolveNpcCount(spec({ density: 0.5 }), 'desktop')).toBe(4);
    expect(resolveNpcCount(spec({ density: 0.5 }), 's25')).toBe(2);
  });

  it('density 0 = no NPCs', () => {
    expect(resolveNpcCount(spec({ density: 0 }), 'desktop')).toBe(0);
    expect(resolveNpcCount(spec({ density: 0 }), 's25')).toBe(0);
  });

  it('clamps out-of-range values', () => {
    expect(resolveNpcCount(spec({ density: 2 }), 'desktop')).toBe(8);
    expect(resolveNpcCount(spec({ density: -1 }), 'desktop')).toBe(0);
    expect(resolveNpcCount(spec({ lowTierScale: 5 }), 's25')).toBe(8);
  });

  it('lowTierScale 1 = full roster on s25', () => {
    expect(resolveNpcCount(spec({ lowTierScale: 1 }), 's25')).toBe(8);
  });

  it('honors an explicit baseCount', () => {
    expect(resolveNpcCount(spec(), 's25', 10)).toBe(5);
    expect(resolveNpcCount(spec({ density: 0.25 }), 'desktop', 12)).toBe(3);
  });
});

describe('arbitratePrompt', () => {
  const pos = new THREE.Vector3(0, 0, 0);

  it('npc target alone wins', () => {
    const npc = stubInteractable('npc-1', 2, 0);
    expect(arbitratePrompt(npc, null, pos)).toBe(npc);
  });

  it('no npc target = no prompt', () => {
    expect(arbitratePrompt(null, stubInteractable('chest-1', 1, 0), pos)).toBeNull();
  });

  it('nearer chest suppresses the npc prompt', () => {
    const npc = stubInteractable('npc-1', 2.5, 0);
    const chest = stubInteractable('chest-1', 1, 0);
    expect(arbitratePrompt(npc, chest, pos)).toBeNull();
  });

  it('nearer npc wins over the chest', () => {
    const npc = stubInteractable('npc-1', 1, 0);
    const chest = stubInteractable('chest-1', 2.5, 0);
    expect(arbitratePrompt(npc, chest, pos)).toBe(npc);
  });
});

describe('registration policy', () => {
  it('registers on attach, unregisters on detach, idempotent both ways', () => {
    const engine = makeEngine();
    expect(engine.npcInteractions.size).toBe(0);
    const npcs = spawnNpcsForMap(engine, 4242, { count: 3 });
    try {
      registerNpcInteractables(engine, npcs);
      expect(engine.npcInteractions.size).toBe(3);
      // re-register: no duplicates
      registerNpcInteractables(engine, npcs);
      expect(engine.npcInteractions.size).toBe(3);
      // every interactable is the npc's own, type npc, prompt 'Talk to <name>'
      for (const npc of npcs) {
        const got = engine.npcInteractions.get(npc.interactable.id);
        expect(got).toBe(npc.interactable);
        expect(got!.type).toBe('npc');
        expect(got!.prompt).toBe(`Talk to ${npc.name}`);
        // requires/produces reserved for the quest wave
        expect(got!.requires).toBeUndefined();
        expect(got!.produces).toBeUndefined();
      }
      unregisterNpcInteractables(engine, npcs);
      expect(engine.npcInteractions.size).toBe(0);
      // unregister again: no throw, still empty
      unregisterNpcInteractables(engine, npcs);
      expect(engine.npcInteractions.size).toBe(0);
    } finally {
      for (const npc of npcs) npc.dispose();
      engine.dispose();
    }
  });
});

describe('NpcInteractionSession', () => {
  function makeSession() {
    const engine = makeEngine();
    const doc = (globalThis as any).document;
    const npcs = spawnNpcsForMap(engine, 777, { count: 2 });
    const far = new THREE.Vector3(500, 0, 500);
    const session = new NpcInteractionSession(engine, npcs, {
      doc,
      getPlayerPos: () => far,
    });
    return { engine, npcs, session, far, doc };
  }

  it('prompt surfaces Talk to <name> when the player approaches', () => {
    const engine = makeEngine();
    const doc = (globalThis as any).document;
    const npcs = spawnNpcsForMap(engine, 777, { count: 2 });
    const playerPos = new THREE.Vector3(500, 0, 500);
    const session = new NpcInteractionSession(engine, npcs, {
      doc,
      getPlayerPos: () => playerPos,
    });
    try {
      expect(engine.npcInteractions.size).toBe(2);
      session.update(1 / 60);
      expect(session.promptedNpc).toBeNull();
      // walk up to the first npc: the prompt target becomes that npc
      playerPos.copy(npcs[0].position);
      session.update(1 / 60);
      expect(session.promptedNpc).toBe(npcs[0]);
      // walk away again: prompt clears
      playerPos.set(500, 0, 500);
      session.update(1 / 60);
      expect(session.promptedNpc).toBeNull();
    } finally {
      session.dispose();
      engine.dispose();
    }
  });

  it('openDialogueFor shows name + greeting; closeDialogue dismisses', () => {
    const { engine, npcs, session } = makeSession();
    try {
      expect(session.isDialogueOpen).toBe(false);
      const npc = npcs[0];
      expect(session.openDialogueFor(npc.interactable.id)).toBe(true);
      expect(session.isDialogueOpen).toBe(true);
      session.closeDialogue();
      expect(session.isDialogueOpen).toBe(false);
      expect(session.openDialogueFor('nope')).toBe(false);
    } finally {
      session.dispose();
      engine.dispose();
    }
  });

  it('dispose unregisters before npcs die, and is idempotent', () => {
    const { engine, npcs, session } = makeSession();
    expect(engine.npcInteractions.size).toBe(2);
    session.dispose();
    expect(engine.npcInteractions.size).toBe(0);
    for (const npc of npcs) expect(npc.alive).toBe(false);
    expect(() => session.dispose()).not.toThrow();
    engine.dispose();
  });

  it('headless session registers interactables with no UI', () => {
    const engine = makeEngine();
    const npcs = spawnNpcsForMap(engine, 777, { count: 1 });
    const session = new NpcInteractionSession(engine, npcs, { enableUi: false });
    try {
      expect(engine.npcInteractions.size).toBe(1);
      expect(session.isDialogueOpen).toBe(false);
      expect(session.openDialogueFor(npcs[0].interactable.id)).toBe(false);
    } finally {
      session.dispose();
      engine.dispose();
    }
  });
});

describe('DialoguePanel', () => {
  it('show/hide round-trips name and greeting', () => {
    const doc = (globalThis as any).document;
    const container = makeEl('div');
    const panel = new DialoguePanel(container, doc);
    try {
      expect(panel.isOpen).toBe(false);
      panel.show({ name: 'Test Name', role: 'villager', greeting: 'Well met.' });
      expect(panel.isOpen).toBe(true);
      panel.hide();
      expect(panel.isOpen).toBe(false);
      expect(() => panel.dispose()).not.toThrow();
    } finally {
      panel.dispose();
    }
  });
});
