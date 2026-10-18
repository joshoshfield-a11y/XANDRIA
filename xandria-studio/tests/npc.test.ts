/**
 * NPC core (workstream A):
 * - deterministic names/palettes/greetings given the same seed
 * - update(dt) deterministic given the same dt sequence
 * - dispose() removes the physics body + scene graph, idempotent
 * - interactable contract for the interaction wave
 * - per-NPC mesh (draw-call) bound
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
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import { Npc, spawnNpcsForMap, NPC_SALT } from '../src/engine/game/Npc';
import { generateNpcName, generateNpcGreeting, NPC_GREETINGS } from '../src/engine/game/npcNames';
import { Rng } from '../src/engine/core/Rng';

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

function meshCount(npc: Npc): number {
  let n = 0;
  npc.rig!.group.traverse((o: any) => { if (o.isMesh) n++; });
  return n;
}

describe('npcNames', () => {
  it('same seed -> same name and greeting', () => {
    const a = generateNpcName(new Rng(12345));
    const b = generateNpcName(new Rng(12345));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(2);
    const ga = generateNpcGreeting(new Rng(12345));
    const gb = generateNpcGreeting(new Rng(12345));
    expect(ga).toBe(gb);
    expect(NPC_GREETINGS).toContain(ga);
  });

  it('produces variety across seeds (fixed spot-check set)', () => {
    const names = new Set(Array.from({ length: 16 }, (_, i) => generateNpcName(new Rng(1000 + i))));
    expect(names.size).toBeGreaterThan(12);
  });
});

describe('Npc determinism', () => {
  it('same seed -> same name, greeting and palette', () => {
    const engine = makeEngine();
    const spawn = new THREE.Vector3(10, 0, 20);
    const a = new Npc(engine, {}, spawn, 777);
    const b = new Npc(engine, {}, spawn, 777);
    expect(a.name).toBe(b.name);
    expect(a.greeting).toBe(b.greeting);
    expect(a.palette).toEqual(b.palette);
    expect(a.position.distanceTo(b.position)).toBeLessThan(1e-6);
    a.dispose(); b.dispose();
    engine.dispose();
  });

  it('same seed + same dt sequence -> same trajectory', () => {
    const engine = makeEngine();
    // different spawns: the two instances share one physics world, so keep
    // them far apart to avoid body-on-body contact; compare displacement
    // from home instead of absolute position.
    const a = new Npc(engine, { wanderRadius: 5, speed: 1.5 }, new THREE.Vector3(0, 0, 0), 4242);
    const b = new Npc(engine, { wanderRadius: 5, speed: 1.5 }, new THREE.Vector3(80, 0, 80), 4242);
    for (let i = 0; i < 600; i++) {
      const dt = 1 / 60;
      a.update(dt);
      b.update(dt);
      engine.physics.step(dt);
    }
    const da = a.position.clone().sub(a.home);
    const db = b.position.clone().sub(b.home);
    expect(da.distanceTo(db)).toBeLessThan(1e-3);
    a.dispose(); b.dispose();
    engine.dispose();
  });

  it('different seeds -> different identities', () => {
    const engine = makeEngine();
    const names = new Set<string>();
    const palettes = new Set<string>();
    const npcs = Array.from({ length: 8 }, (_, i) =>
      new Npc(engine, {}, new THREE.Vector3(i * 5, 0, 0), 9000 + i));
    for (const n of npcs) {
      names.add(n.name);
      palettes.add(JSON.stringify(n.palette));
    }
    expect(names.size).toBeGreaterThan(5);
    expect(palettes.size).toBeGreaterThan(5);
    for (const n of npcs) n.dispose();
    engine.dispose();
  });

  it('explicit spec name/palette override the generator', () => {
    const engine = makeEngine();
    const n = new Npc(engine, { name: 'Fixed Fiona', palette: { cloth: '#123456' } }, new THREE.Vector3(0, 0, 0), 5);
    expect(n.name).toBe('Fixed Fiona');
    expect(n.palette.cloth).toBe('#123456');
    n.dispose();
    engine.dispose();
  });
});

describe('Npc lifecycle', () => {
  it('dispose() removes body from physics, rig from scene, and is idempotent', () => {
    const engine = makeEngine();
    const bodiesBefore = engine.physics.world.bodies.length;
    const n = new Npc(engine, {}, new THREE.Vector3(0, 0, 0), 31337);
    const group = n.rig!.group;
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore + 1);
    expect(engine.scene.children).toContain(group);
    n.dispose();
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    expect(engine.scene.children).not.toContain(group);
    expect(n.body).toBeNull();
    expect(n.rig).toBeNull();
    expect(() => n.dispose()).not.toThrow(); // idempotent
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    engine.dispose();
  });
});

describe('Npc interactable contract', () => {
  it('exposes type npc with a Talk to <name> prompt', () => {
    const engine = makeEngine();
    const n = new Npc(engine, { name: 'Mira Fell' }, new THREE.Vector3(3, 0, 4), 42);
    const i = n.interactable;
    expect(i.type).toBe('npc');
    expect(i.prompt).toBe('Talk to Mira Fell');
    expect(i.radius).toBeGreaterThan(0);
    expect(i.enabled).toBe(true);
    expect(i.position.x).toBeCloseTo(3, 3);
    // position tracks the NPC as it wanders
    n.update(1 / 60);
    expect(i.position.distanceTo(n.position)).toBeLessThan(2);
    n.dispose();
    engine.dispose();
  });
});

describe('Npc perf budget', () => {
  it('mesh count per NPC stays within budget (one draw call per mesh)', () => {
    const engine = makeEngine();
    const counts = Array.from({ length: 6 }, (_, i) => {
      const n = new Npc(engine, {}, new THREE.Vector3(i * 8, 0, 0), 500 + i);
      const c = meshCount(n);
      n.dispose();
      return c;
    });
    const max = Math.max(...counts);
    console.log('npc mesh counts:', counts.join(','));
    // measured 46..54 (rig + full nomad/raider/plate armor set + amber clasp);
    // bound guards against regressions, not a per-tier budget (C measures that).
    expect(max).toBeLessThanOrEqual(60);
    engine.dispose();
  });
});

describe('spawnNpcsForMap', () => {
  it('deterministic roster from mapSeed alone; zero NPC left after dispose', () => {
    const engine = makeEngine();
    const bodiesBefore = engine.physics.world.bodies.length;
    const mk = () => spawnNpcsForMap(engine, 20261012 ^ NPC_SALT, {
      count: 5, pois: [new THREE.Vector3(100, 0, 100)],
    });
    const a = mk(), b = mk();
    expect(a.length).toBe(5);
    expect(b.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(a[i].name).toBe(b[i].name);
      expect(a[i].palette).toEqual(b[i].palette);
      expect(a[i].position.distanceTo(b[i].position)).toBeLessThan(1e-6);
      expect(a[i].interactable.id).not.toBe(b[i].interactable.id); // unique ids even when identical
    }
    for (const n of [...a, ...b]) n.dispose();
    expect(engine.physics.world.bodies.length).toBe(bodiesBefore);
    engine.dispose();
  });
});
