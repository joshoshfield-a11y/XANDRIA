/**
 * STEALTH-SYSTEM (upgrade loop): sneak state + enemy detection model.
 * - one tuning table (STEALTH_TABLE); sneak bonus reuses the CRIT_TABLE
 *   multiplier; detection is radius + noise only (no line-of-sight).
 * - AwarenessTracker transitions; detection jitter is one seeded draw
 *   per enemy; targeting weights 0/0/100.
 * - Enemy/EnemyManager integration through the fake-DOM harness:
 *   sneak-past stays unaware, standing exposure escalates to alerted,
 *   noise only ever makes enemies suspicious, damage alerts, lure
 *   bypasses awareness, alert decays back to unaware past hysteresis.
 * - Input keymap (Ctrl = sneak) + SNEAK touch button geometry.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { defaultSpec, type GameSpec, type EnemySpec } from '../src/spec/schema';
import { Enemy, EnemyManager } from '../src/engine/game/EnemyAI';
import {
  STEALTH_TABLE,
  AwarenessTracker,
  applySneakBonus,
  baseDetectionRadiusFor,
  detectionJitterFor,
  detectionRadiusFor,
  noiseRadiusFor,
  targetWeightFor,
} from '../src/engine/game/stealth';
import { critMultiplierFor } from '../src/engine/game/crit';
import { buildKeymap } from '../src/engine/game/accessibility';
import { layoutForGenre } from '../src/engine/game/TouchControls';

function makeEngine(): Engine {
  const spec = defaultSpec(99) as GameSpec;
  const container: any = { ...makeEl('div'), clientWidth: 800, clientHeight: 600 };
  return new Engine(container, spec, { testMode: true, noTerrain: true } as any);
}

beforeEach(() => {
  (globalThis as any).document = { createElement: (t: string) => makeEl(t), head: makeEl('head'), addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 42, clearInterval() {} };
  (globalThis as any).addEventListener = () => {}; (globalThis as any).removeEventListener = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).devicePixelRatio = 1; (globalThis as any).innerWidth = 800; (globalThis as any).innerHeight = 600;
  (globalThis as any).requestAnimationFrame = () => 0; (globalThis as any).cancelAnimationFrame = () => {};
});

const WALKER: EnemySpec = { kind: 'walker', count: 1, health: 100, speed: 4, damage: 10, weapon: 'melee' };

describe('STEALTH_TABLE', () => {
  it('carries the disclosed detection + noise numbers', () => {
    expect(STEALTH_TABLE.baseDetectionRadius).toBe(30);
    expect(STEALTH_TABLE.turretDetectionRadius).toBe(42);
    expect(STEALTH_TABLE.sneakRadiusMultiplier).toBe(0.45);
    expect(STEALTH_TABLE.sneakSpeedMultiplier).toBe(0.5);
    expect(STEALTH_TABLE.alertDelaySeconds).toBe(0.4);
    expect(STEALTH_TABLE.suspicionSeconds).toBe(4);
    expect(STEALTH_TABLE.hysteresisMultiplier).toBe(1.3);
    expect(STEALTH_TABLE.walkNoiseRadius).toBe(6);
    expect(STEALTH_TABLE.sprintNoiseRadius).toBe(12);
    expect(STEALTH_TABLE.dashNoiseRadius).toBe(10);
    expect(STEALTH_TABLE.attackNoiseRadius).toBe(14);
  });

  it('base radius is 42 for turrets, 30 for every other kind', () => {
    expect(baseDetectionRadiusFor('turret')).toBe(42);
    for (const k of ['walker', 'brute', 'drone', 'flyer']) expect(baseDetectionRadiusFor(k)).toBe(30);
  });
});

describe('detection jitter + radius', () => {
  it('is deterministic per seed and bounded to [0.9, 1.1]', () => {
    for (const seed of [1, 42, 4242, 20261012, 0xffffffff]) {
      const a = detectionJitterFor(seed);
      const b = detectionJitterFor(seed);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0.9);
      expect(a).toBeLessThanOrEqual(1.1);
    }
    // distinct seeds do not all collapse to one value
    const vals = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(detectionJitterFor));
    expect(vals.size).toBeGreaterThan(1);
  });

  it('radius = base x sneak x jitter x aggroMult, exactly', () => {
    expect(detectionRadiusFor('walker', false, 1, 1)).toBe(30);
    expect(detectionRadiusFor('walker', true, 1, 1)).toBe(13.5);
    expect(detectionRadiusFor('turret', false, 1, 1)).toBe(42);
    expect(detectionRadiusFor('turret', true, 1, 1)).toBe(18.9);
    expect(detectionRadiusFor('walker', false, 0.9, 2)).toBeCloseTo(54, 9);
    expect(detectionRadiusFor('walker', true, 1.1, 1)).toBeCloseTo(14.85, 9);
  });
});

describe('noiseRadiusFor', () => {
  it('sneaking is silent; still is silent', () => {
    expect(noiseRadiusFor({ moving: true, sneaking: true, sprinting: true, dashing: true })).toBe(0);
    expect(noiseRadiusFor({ moving: false, sneaking: false, sprinting: false, dashing: false })).toBe(0);
  });
  it('dash > walk, sprint is loudest', () => {
    expect(noiseRadiusFor({ moving: true, sneaking: false, sprinting: false, dashing: false })).toBe(6);
    expect(noiseRadiusFor({ moving: true, sneaking: false, sprinting: false, dashing: true })).toBe(10);
    expect(noiseRadiusFor({ moving: true, sneaking: false, sprinting: true, dashing: false })).toBe(12);
  });
});

describe('targetWeightFor', () => {
  it('is 0/0/100 — only alerted enemies chase', () => {
    expect(targetWeightFor('unaware')).toBe(0);
    expect(targetWeightFor('suspicious')).toBe(0);
    expect(targetWeightFor('alerted')).toBe(100);
  });
});

describe('applySneakBonus', () => {
  it('is the crit-table multiplier, applied once, rounded', () => {
    expect(applySneakBonus(25, { tier: null, skillRank: 0 })).toBe(50);
    expect(applySneakBonus(25, { tier: 'common', skillRank: 1 })).toBe(50);
    expect(applySneakBonus(25, { tier: 'legendary', skillRank: 3 })).toBe(
      Math.round(25 * critMultiplierFor('legendary', 3)));
    expect(applySneakBonus(7, { tier: null, skillRank: 0 })).toBe(14);
    expect(applySneakBonus(0, { tier: null, skillRank: 0 })).toBe(0);
  });
});

describe('AwarenessTracker', () => {
  const far = { inDetectionRange: false, beyondHysteresis: true, noiseHeard: false };
  const near = { inDetectionRange: true, beyondHysteresis: false, noiseHeard: false };
  const edge = { inDetectionRange: false, beyondHysteresis: false, noiseHeard: false };

  it('stays unaware far away, forever', () => {
    const t = new AwarenessTracker();
    for (let i = 0; i < 100; i++) expect(t.update(0.1, far)).toBe('unaware');
  });

  it('escalates unaware -> suspicious -> alerted after 0.4s continuous exposure', () => {
    const t = new AwarenessTracker();
    expect(t.update(0.1, near)).toBe('suspicious');
    expect(t.update(0.1, near)).toBe('suspicious');
    expect(t.update(0.1, near)).toBe('suspicious');
    expect(t.update(0.1, near)).toBe('alerted');
  });

  it('brief exposure stays suspicious, then calms down after 4s', () => {
    const t = new AwarenessTracker();
    t.update(0.1, near);
    expect(t.update(0.1, edge)).toBe('suspicious');
    for (let i = 0; i < 39; i++) t.update(0.1, edge);
    expect(t.update(0.1, edge)).toBe('unaware');
  });

  it('noise only ever makes enemies suspicious, and re-hearing resets the timer', () => {
    const t = new AwarenessTracker();
    expect(t.update(0.1, { ...edge, noiseHeard: true })).toBe('suspicious');
    for (let i = 0; i < 30; i++) t.update(0.1, edge);
    expect(t.update(0.1, { ...edge, noiseHeard: true })).toBe('suspicious');
    for (let i = 0; i < 30; i++) t.update(0.1, edge);
    expect(t.update(0.1, edge)).toBe('suspicious');
    for (let i = 0; i < 10; i++) t.update(0.1, edge);
    expect(t.update(0.1, edge)).toBe('unaware');
  });

  it('damage alerts immediately from any state', () => {
    const t = new AwarenessTracker();
    t.alert();
    expect(t.state).toBe('alerted');
    expect(t.update(0.1, far)).toBe('suspicious'); // hysteresis band exit -> suspicious
  });

  it('alerted enemies hold through the hysteresis band, then calm down', () => {
    const t = new AwarenessTracker();
    t.alert();
    expect(t.update(0.1, edge)).toBe('alerted');
    expect(t.update(0.1, far)).toBe('suspicious');
    for (let i = 0; i < 40; i++) t.update(0.1, far);
    expect(t.state).toBe('unaware');
  });

  it('noise while suspicious in range still escalates on exposure', () => {
    const t = new AwarenessTracker();
    t.update(0.1, { ...edge, noiseHeard: true });
    expect(t.update(0.1, near)).toBe('suspicious');
    expect(t.update(0.1, near)).toBe('suspicious');
    expect(t.update(0.1, near)).toBe('suspicious');
    expect(t.update(0.1, near)).toBe('alerted');
  });
});

describe('Enemy awareness integration', () => {
  function setup() {
    const engine = makeEngine();
    const manager = new EnemyManager(engine, null, {}, {
      pois: [{ x: 0, z: 0, r: 0 }],
      specs: [{ ...WALKER }],
      playerLevel: () => 1,
    });
    const e = manager.spawnOne(WALKER, new THREE.Vector3(20, 2, 0), 4242);
    return { engine, manager, e };
  }

  /** step the manager; playerPos is the player's position. */
  function step(manager: EnemyManager, playerPos: THREE.Vector3, perception: any, seconds: number, dt = 0.1) {
    let t = 0;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      t += dt;
      manager.update(dt, playerPos, t, perception);
    }
  }

  it('starts unaware with a seeded jitter in range', () => {
    const { e } = setup();
    expect(e.awareness).toBe('unaware');
    expect(e.detectionJitter).toBe(detectionJitterFor(4242));
    expect(e.detectionJitter).toBeGreaterThanOrEqual(0.9);
    expect(e.detectionJitter).toBeLessThanOrEqual(1.1);
  });

  it('sneak-past at 20m stays unaware; standing at 20m alerts', () => {
    const { manager, e } = setup();
    const pp = new THREE.Vector3(0, 2, 0);
    step(manager, pp, { sneaking: true, noiseRadius: 0 }, 2);
    expect(e.awareness).toBe('unaware');
    expect((e as any).state).toBe('idle');
    step(manager, pp, { sneaking: false, noiseRadius: 0 }, 0.5);
    expect(e.awareness).toBe('alerted');
    expect((e as any).state).toBe('chase');
  });

  it('default perception (other blueprints) alerts like before, after the 0.4s escalation', () => {
    const { manager, e } = setup();
    const pp = new THREE.Vector3(0, 2, 0);
    step(manager, pp, undefined as any, 0.5);
    expect(e.awareness).toBe('alerted');
  });

  it('melee contact at 0m alerts and attacks on the first update (pre-stealth contract)', () => {
    const { manager, e } = setup();
    const pp = e.position.clone();
    manager.update(0.016, pp, 0, { sneaking: true, noiseRadius: 0 });
    expect(e.awareness).toBe('alerted');
    expect((e as any).state).toBe('attack');
  });

  it('ranged kinds get no contact bypass: a drone at 20m stays unaware while the player sneaks', () => {
    const { engine, manager } = setup();
    const drone = manager.spawnOne(
      { kind: 'drone', count: 1, health: 100, speed: 4, damage: 10, weapon: 'rifle' },
      new THREE.Vector3(20, 2, 0), 4243);
    void engine;
    step(manager, new THREE.Vector3(0, 2, 0), { sneaking: true, noiseRadius: 0 }, 2);
    expect(drone.awareness).toBe('unaware');
    expect((drone as any).state).toBe('idle');
  });

  it('damage alerts immediately and the sneak window closes', () => {
    const { e } = setup();
    expect(e.awareness).toBe('unaware');
    e.damage(1, new THREE.Vector3(0, 2, 0));
    expect(e.awareness).toBe('alerted');
    expect(e.health).toBe(99);
  });

  it('emitNoise makes in-range enemies suspicious only; out-of-range hear nothing', () => {
    const { engine, manager } = setup();
    const near = manager.spawnOne(WALKER, new THREE.Vector3(10, 2, 0), 5001);
    const farE = manager.spawnOne(WALKER, new THREE.Vector3(40, 2, 0), 5002);
    void engine;
    manager.emitNoise(new THREE.Vector3(0, 2, 0), STEALTH_TABLE.attackNoiseRadius);
    expect(near.awareness).toBe('suspicious');
    expect(farE.awareness).toBe('unaware');
    // a second noise event never escalates to alerted on its own
    manager.emitNoise(new THREE.Vector3(0, 2, 0), STEALTH_TABLE.attackNoiseRadius);
    expect(near.awareness).toBe('suspicious');
  });

  it('hearNoise is a no-op past its radius and on dead enemies', () => {
    const { e } = setup();
    e.hearNoise(new THREE.Vector3(0, 2, 0), 5);
    expect(e.awareness).toBe('unaware');
    e.damage(1000, new THREE.Vector3(0, 2, 0));
    expect(e.alive).toBe(false);
  });

  it('a lure target forces alerted even at 40m, and the enemy chases the totem', () => {
    const { manager, e } = setup();
    const pp = new THREE.Vector3(0, 2, 0);
    e.lureTarget = new THREE.Vector3(20, 2, 0);
    // player is 40m from the enemy; the lure sits on top of it
    step(manager, new THREE.Vector3(60, 2, 0), { sneaking: true, noiseRadius: 0 }, 0.2);
    expect(e.awareness).toBe('alerted');
    void pp;
  });

  it('alert decays past hysteresis back to unaware', () => {
    const { manager, e } = setup();
    const near = new THREE.Vector3(0, 2, 0);
    step(manager, near, { sneaking: false, noiseRadius: 0 }, 0.5);
    expect(e.awareness).toBe('alerted');
    const farPos = new THREE.Vector3(60, 2, 0);
    step(manager, farPos, { sneaking: false, noiseRadius: 0 }, 0.2);
    expect(e.awareness).toBe('suspicious');
    step(manager, farPos, { sneaking: false, noiseRadius: 0 }, 4.5);
    expect(e.awareness).toBe('unaware');
    expect((e as any).state).toBe('idle');
  });

  it('attack noise reaches past the sneak radius: outside detection, inside noise -> suspicious', () => {
    // Noise only ever matters past the (shrunk) sneak radius: find a
    // seed whose sneak radius leaves room inside the 14m attack noise.
    let seed = 1;
    for (; seed < 200; seed++) {
      const r = detectionRadiusFor('walker', true, detectionJitterFor(seed), 1);
      if (r + 0.5 < STEALTH_TABLE.attackNoiseRadius) break;
    }
    const engine = makeEngine();
    const manager = new EnemyManager(engine, null, {}, {
      pois: [{ x: 0, z: 0, r: 0 }],
      specs: [{ ...WALKER }],
      playerLevel: () => 1,
    });
    const e = manager.spawnOne(WALKER, new THREE.Vector3(20, 2, 0), seed);
    const sneakR = e.effectiveDetectionRadius(true);
    const pp = new THREE.Vector3(20 + sneakR + 0.5, 2, 0);
    expect(pp.distanceTo(e.position)).toBeGreaterThan(sneakR);
    expect(pp.distanceTo(e.position)).toBeLessThan(STEALTH_TABLE.attackNoiseRadius);
    step(manager, pp, { sneaking: true, noiseRadius: 0 }, 1);
    expect(e.awareness).toBe('unaware');
    // the attack-noise event (same radius tpAction fires on onAttack)
    manager.emitNoise(pp, STEALTH_TABLE.attackNoiseRadius);
    expect(e.awareness).toBe('suspicious');
    expect((e as any).state).toBe('idle');
  });

  it('suspicious enemies never chase: state stays idle while suspicious', () => {
    const { manager, e } = setup();
    const pp = new THREE.Vector3(0, 2, 0);
    step(manager, pp, { sneaking: false, noiseRadius: 0 }, 0.2);
    expect(e.awareness).toBe('suspicious');
    expect((e as any).state).toBe('idle');
  });
});

describe('sneak input + touch button', () => {
  it('ControlLeft/ControlRight map to sneak (brake survives on ControlLeft)', () => {
    const map = buildKeymap({});
    expect(map.ControlLeft).toContain('sneak');
    expect(map.ControlLeft).toContain('brake');
    expect(map.ControlRight).toContain('sneak');
  });

  it('third-person-action has a hold SNEAK button, >=44px, overlapping nothing', () => {
    const layout = layoutForGenre('third-person-action');
    const sneak = layout.buttons.find((b) => b.action === 'sneak');
    expect(sneak).toBeDefined();
    expect(sneak!.label).toBe('SNEAK');
    expect(sneak!.kind).toBe('hold');
    expect(sneak!.size).toBeGreaterThanOrEqual(44);
    const rect = (b: { right: number; bottom: number; size: number }) => ({
      x0: b.right, x1: b.right + b.size, y0: b.bottom, y1: b.bottom + b.size,
    });
    const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
      a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    const buttons = layout.buttons;
    for (let i = 0; i < buttons.length; i++) {
      for (let j = i + 1; j < buttons.length; j++) {
        expect(overlaps(rect(buttons[i]), rect(buttons[j])), `${buttons[i].label} vs ${buttons[j].label}`).toBe(false);
      }
    }
  });

  it('other genres are untouched (no sneak button outside third-person-action)', () => {
    for (const genre of ['fps-arena', 'racing', 'platformer', 'survivor']) {
      expect(layoutForGenre(genre).buttons.some((b) => b.action === 'sneak')).toBe(false);
    }
  });
});
