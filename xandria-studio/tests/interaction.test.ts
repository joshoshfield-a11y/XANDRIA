/**
 * Interaction contracts (inventory wave, coordinator):
 * - InteractionRegistry: register/discover/nearest-eligible
 * - ItemWorld exposes chests as Interactables; activateInteractable routes
 * - Inventory.onChange fires on mutations
 *
 * These are the forward-compatible contracts for the roadmap's Priority 2
 * (Unified interaction framework) — the next wave builds the system on them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { makeEl, FakeWebGLRenderer } = vi.hoisted(() => {
  function makeEl(tag = 'div'): any {
    const el: any = {
      tag, children: [] as any[], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      textContent: '', className: '', dataset: {}, value: '', checked: false, innerHTML: '',
      appendChild(c: any) { el.children.push(c); return c; }, append(...cs: any[]) { for (const c of cs) el.children.push(c); },
      remove() {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
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
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import { InteractionRegistry } from '../src/engine/game/Interaction';
import { ItemWorld } from '../src/engine/game/items/ItemWorld';
import { Inventory } from '../src/engine/game/items/Inventory';

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

const DEFS: any = {
  potion: { name: 'Potion', type: 'consumable', behavior: { effect: 'heal', amount: 10 }, stack: 5 },
  sword: { name: 'Sword', type: 'weapon', slot: 'weapon' },
};

function makeWorld() {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  const engine = new Engine(container, spec, { testMode: true, noTerrain: true } as any);
  const world = new ItemWorld(engine, DEFS);
  return { engine, world };
}

describe('InteractionRegistry', () => {
  it('registers, finds nearest eligible, skips disabled', () => {
    const reg = new InteractionRegistry();
    const discovered: string[] = [];
    reg.events.onDiscover = (i) => discovered.push(i.id);
    reg.register({ id: 'a', type: 'chest', position: new THREE.Vector3(0, 0, 0), radius: 3, enabled: true, prompt: 'Open' });
    reg.register({ id: 'b', type: 'door', position: new THREE.Vector3(10, 0, 0), radius: 3, enabled: false, prompt: 'Open door' });
    expect(discovered).toEqual(['a', 'b']);
    expect(reg.nearestEligible(new THREE.Vector3(1, 0, 0))?.id).toBe('a');
    // disabled door is skipped even in range
    expect(reg.nearestEligible(new THREE.Vector3(10, 0, 0))).toBeNull();
    // re-register with changed enabled fires eligibility change
    let elig: Array<[string, boolean]> = [];
    reg.events.onEligibilityChange = (i, e) => elig.push([i.id, e]);
    reg.register({ id: 'b', type: 'door', position: new THREE.Vector3(10, 0, 0), radius: 3, enabled: true, prompt: 'Open door' });
    expect(elig).toEqual([['b', true]]);
    expect(reg.nearestEligible(new THREE.Vector3(10, 0, 0))?.id).toBe('b');
  });
});

describe('ItemWorld interactables', () => {
  it('chests register as Interactables with the roadmap shape', () => {
    const { world, engine } = makeWorld();
    const chest = world.spawnChest({ pos: [5, 0, 0], loot: ['potion'] });
    expect(chest.id).toBe('chest-0');
    const all = world.interactables();
    expect(all.length).toBe(1);
    const i = all[0];
    expect(i.id).toBe('chest-0');
    expect(i.type).toBe('chest');
    expect(i.position.x).toBeCloseTo(5, 5);
    expect(i.radius).toBeGreaterThan(0);
    expect(i.enabled).toBe(true);
    expect(typeof i.prompt).toBe('string');
    expect(i.produces).toEqual(['potion']);
    engine.dispose();
  });

  it('activateInteractable opens the chest and disables it afterwards', () => {
    const { world, engine } = makeWorld();
    world.spawnChest({ pos: [5, 0, 0], loot: ['potion', 'sword'] });
    const near = world.interactions.nearestEligible(new THREE.Vector3(5, 0, 0));
    expect(near?.id).toBe('chest-0');
    const loot = world.activateInteractable('chest-0');
    expect(loot).toEqual(['potion', 'sword']);
    // opened → disabled; second activation is a no-op
    expect(world.interactions.nearestEligible(new THREE.Vector3(5, 0, 0))).toBeNull();
    expect(world.activateInteractable('chest-0')).toBeNull();
    // unknown id
    expect(world.activateInteractable('door-9')).toBeNull();
    engine.dispose();
  });

  it('locked chests are registered but not eligible', () => {
    const { world, engine } = makeWorld();
    world.spawnChest({ pos: [5, 0, 0], loot: ['potion'], locked: true });
    const i = world.interactables()[0];
    expect(i.enabled).toBe(false);
    expect(i.prompt).toMatch(/locked/i);
    expect(world.interactions.nearestEligible(new THREE.Vector3(5, 0, 0))).toBeNull();
    engine.dispose();
  });
});

describe('Inventory.onChange', () => {
  it('fires on add/remove/equip/unequip/use', () => {
    const inv = new Inventory(DEFS);
    let n = 0;
    inv.onChange = () => n++;
    inv.add('potion', 2); expect(n).toBe(1);
    inv.remove('potion', 1); expect(n).toBe(2);
    inv.add('sword', 1);
    inv.equip('sword'); expect(n).toBeGreaterThanOrEqual(4);
    const before = n;
    inv.unequip('weapon'); expect(n).toBeGreaterThan(before);
    const b2 = n;
    inv.use('potion'); expect(n).toBeGreaterThan(b2);
  });

  it('a throwing onChange never corrupts state', () => {
    const inv = new Inventory(DEFS);
    inv.onChange = () => { throw new Error('boom'); };
    expect(() => inv.add('potion', 1)).not.toThrow();
    expect(inv.count('potion')).toBe(1);
  });
});
