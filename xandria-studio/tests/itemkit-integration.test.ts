/**
 * itemKit integration test (inventory wave, coordinator):
 * builds a real headless Engine + real CharacterRig, wires the full kit,
 * and plays the loop: loot spawn → magnet collect → equip renders on the
 * rig → defense wrap → consumable use → chest interact → spill → collect.
 *
 * Headless harness (no jsdom): copied from tests/items-world.test.ts —
 * real Engine, stubbed WebGLRenderer, hand-stubbed DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const listeners: Record<string, Function[]> = {};
    const el: any = {
      tag,
      children: [] as any[],
      style: {} as Record<string, string>,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '',
      className: '',
      dataset: {} as Record<string, string>,
      value: '',
      checked: false,
      innerHTML: '',
      appendChild(c: any) { el.children.push(c); return c; },
      append(...cs: any[]) { for (const c of cs) el.children.push(c); },
      remove() {},
      setAttribute() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener(t: string, fn: Function) { (listeners[t] ??= []).push(fn); },
      removeEventListener(t: string, fn: Function) {
        const l = listeners[t]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
      },
      querySelector() { return makeEl(); },
      querySelectorAll() { return []; },
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
    };
    return el;
  }
  class FakeWebGLRenderer {
    domElement: any = makeEl('canvas');
    shadowMap: any = {};
    toneMapping: any = null;
    toneMappingExposure = 1;
    setPixelRatio() {}
    setSize() {}
    getPixelRatio() { return 1; }
    getSize() { return { width: 800, height: 600 }; }
    dispose() {}
    render() {}
  }
  return { makeEl, FakeWebGLRenderer };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import { Engine } from '../src/engine/Engine';
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid } from '../src/engine/gfx/Characters';
import { buildItemKit } from '../src/blueprints/itemKit';
import { equippedMesh } from '../src/engine/gfx/EquipRig';
import type { PlayerAvatar } from '../src/blueprints/common';

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

beforeEach(() => {
  const head = makeEl('head');
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head,
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as any).localStorage = memStore();
  (globalThis as any).window = {
    addEventListener() {},
    removeEventListener() {},
    setInterval: vi.fn(() => 42),
    clearInterval: vi.fn(),
  };
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1;
  (globalThis as any).innerWidth = 800;
  (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0;
  (globalThis as any).cancelAnimationFrame = () => {};
});

const ITEMS_SPEC = {
  defs: {
    sword: { name: 'Iron Sword', type: 'weapon', slot: 'weapon', rarity: 'common', stats: { damage: 20 } },
    plate: { name: 'Guard Plate', type: 'armor', slot: 'torso', rarity: 'rare', stats: { defense: 100 } },
    potion: { name: 'Healing Potion', type: 'consumable', behavior: { effect: 'heal', amount: 30 }, stack: 5 },
  },
  loot: [{ item: 'sword', pos: [3, 1, 0] as [number, number, number] }],
  chests: [{ pos: [8, 0, 0] as [number, number, number], loot: ['potion'] }],
  starting: ['plate'],
};

function makeKit() {
  const spec = defaultSpec(99) as GameSpec;
  (spec as any).custom = { ...(spec.custom ?? {}), items: ITEMS_SPEC };
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, spec, { testMode: true, noTerrain: true } as any);
  const rig = makeHumanoid(new MaterialLibrary(spec as any), {}, 7);
  const ctrl: any = {
    position: new THREE.Vector3(0, 2, 0),
    body: engine.physics.capsule(0.42, 1.7, [0, 3, 0], { mass: 70 }),
    rig,
  };
  const avatar = {
    ctrl,
    health: 100,
    maxHealth: 100,
    damage(amount: number) { (this as any).health -= amount; },
    heal(amount: number) { (this as any).health = Math.min((this as any).maxHealth, (this as any).health + amount); },
  } as unknown as PlayerAvatar;
  const kit = buildItemKit(engine, spec, avatar);
  return { engine, spec, kit: kit!, avatar: avatar as any, rig };
}

describe('itemKit integration', () => {
  it('returns null without custom.items', () => {
    const spec = defaultSpec(99) as GameSpec;
    const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
    const engine = new Engine(container, spec, { testMode: true, noTerrain: true } as any);
    expect(buildItemKit(engine, spec, {} as any)).toBeNull();
    engine.dispose();
  });

  it('builds the kit: starting inventory fed, loot spawned', () => {
    const { kit, engine } = makeKit();
    expect(kit).not.toBeNull();
    expect(kit.inventory.count('plate')).toBe(1);
    expect(kit.itemWorld.liveItems.length).toBe(1);
    expect(kit.itemWorld.liveChests.length).toBe(1);
    engine.dispose();
  });

  it('full loop: collect sword → equip renders on rig → defense wraps damage → potion heals', () => {
    const { kit, avatar, rig, engine } = makeKit();
    // walk onto the sword and let the magnet collect it
    avatar.ctrl.position.set(3, 1, 0);
    for (let i = 0; i < 120; i++) kit.update(1 / 60);
    expect(kit.inventory.count('sword')).toBe(1);

    // equip: weapon appears on the rig's weaponMount
    expect(kit.inventory.equip('sword')).not.toBeNull();
    kit.update(1 / 60);
    expect(equippedMesh(rig, 'weapon')).toBeDefined();
    expect(kit.damageMult()).toBeCloseTo(1.2, 5);

    // equip plate (defense 100 → 50% reduction, capped at 60%)
    expect(kit.inventory.equip('plate')).not.toBeNull();
    kit.update(1 / 60);
    avatar.damage(100);
    expect(avatar.health).toBe(50);

    // consumable: use potion heals via onUseEffect
    kit.inventory.add('potion', 1);
    kit.inventory.use('potion');
    expect(avatar.health).toBe(80);
    engine.dispose();
  });

  it('chest interact: openChest spills loot that magnet-collects', () => {
    const { kit, avatar, engine } = makeKit();
    avatar.ctrl.position.set(8, 0.5, 0);
    const chest = kit.itemWorld.tryInteract(avatar.ctrl.position);
    expect(chest).not.toBeNull();
    const ids = kit.itemWorld.openChest(chest!);
    expect(ids).toEqual(['potion']);
    for (let i = 0; i < 240; i++) kit.update(1 / 60);
    expect(kit.inventory.count('potion')).toBeGreaterThanOrEqual(1);
    engine.dispose();
  });

  it('unequip clears the rig mount', () => {
    const { kit, rig, engine } = makeKit();
    kit.inventory.add('sword', 1);
    kit.inventory.equip('sword');
    kit.update(1 / 60);
    expect(equippedMesh(rig, 'weapon')).toBeDefined();
    kit.inventory.unequip('weapon');
    kit.update(1 / 60);
    expect(equippedMesh(rig, 'weapon')).toBeUndefined();
    engine.dispose();
  });
});
