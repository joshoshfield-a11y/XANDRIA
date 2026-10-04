/**
 * Modding surface tests: hook taps, custom enemy kinds, custom upgrades.
 * Uses real cannon-es Physics + real THREE rigs (no renderer needed);
 * DOM is stubbed for MaterialLibrary canvas textures.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Modding } from '../src/engine/game/Modding';
import { EnemyManager } from '../src/engine/game/EnemyAI';
import { Progression } from '../src/engine/game/Progression';
import { Physics } from '../src/engine/core/Physics';
import { Rng } from '../src/engine/core/Rng';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import type { Engine } from '../src/engine/Engine';
import type { EnemyKind } from '../src/spec/schema';

/* minimal DOM stub (MaterialLibrary builds canvas textures lazily) */
function installDom() {
  const canvasStub: any = {
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData() {},
    }),
  };
  (globalThis as any).document = { createElement: () => canvasStub };
}
installDom();

function modEngine(seed = 7) {
  const hooks = new Modding({} as Engine);
  const spec: any = {
    meta: { seed, name: 'Test', genre: 'fps-arena' },
    custom: {},
    objective: { type: 'eliminate', count: 5, timeLimit: 0, description: 'Kill' },
    theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
    world: { gravity: -20 },
    progression: { enabled: true, xpPerKill: 20, xpPerPickup: 5 },
  };
  return {
    hooks,
    spec,
    rng: new Rng(seed),
    physics: new Physics(-20),
    mats: new MaterialLibrary(spec),
    scene: { add() {}, remove() {} },
    audio: { play() {} },
    particles: { explosion() {}, magic() {} },
    juice: { shake() {} },
    terrain: null,
  };
}

const stalkerSpec = (kind: string) =>
  ({ kind: kind as EnemyKind, count: 1, health: 50, speed: 5, damage: 10, weapon: 'melee' }) as any;

describe('Modding — hook taps', () => {
  it('tap/emit/untap round-trips with typed payloads', () => {
    const hooks = new Modding({} as Engine);
    const seen: string[] = [];
    hooks.tap('onWin', ({ stats }) => seen.push(`win:${(stats as any).kills ?? 0}`));
    hooks.tap('onTick', ({ dt }) => seen.push(`tick:${dt}`));
    const untap = hooks.tap('onLose', () => seen.push('lose'));
    expect(hooks.tapCount('onWin')).toBe(1);
    hooks.emit('onWin', { stats: { kills: 3 } });
    hooks.emit('onTick', { dt: 0.016, t: 1 });
    untap();
    hooks.emit('onLose', { reason: 'x', stats: {} });
    expect(seen).toEqual(['win:3', 'tick:0.016']);
  });

  it('emit with no taps is a safe no-op', () => {
    const hooks = new Modding({} as Engine);
    expect(() => hooks.emit('onPhase', { enemy: {} as any, phase: 1 })).not.toThrow();
  });

  it('duplicate registrations throw', () => {
    const hooks = new Modding({} as Engine);
    const kind = { base: 'walker' as EnemyKind, name: 'X' };
    hooks.registerEnemyKind('x', kind);
    expect(() => hooks.registerEnemyKind('x', kind)).toThrow();
    const up = { id: 'u', name: 'U', desc: 'd', apply: () => {} };
    hooks.registerUpgrade(up);
    expect(() => hooks.registerUpgrade(up)).toThrow();
  });
});

describe('Modding — custom enemy kinds', () => {
  it('registered kind spawns through EnemyManager with base body + tint', () => {
    const eng = modEngine();
    let overlayCalls = 0;
    eng.hooks.registerEnemyKind('stalker', {
      base: 'walker',
      name: 'Stalker',
      tint: { shirt: '#00ff00', pants: '#001100', accent: '#00ffcc' },
      update: () => { overlayCalls++; },
    });
    const mgr = new EnemyManager(eng as unknown as Engine, null, {});
    mgr.spawnAll([stalkerSpec('stalker')], () => new THREE.Vector3(0, 0, 0));
    expect(mgr.enemies).toHaveLength(1);
    const e = mgr.enemies[0];
    expect(e.alive).toBe(true);
    expect(e.isBoss).toBe(false);
    // base walker behavior runs (wanders without exploding), then the overlay
    mgr.update(1 / 60, new THREE.Vector3(100, 0, 100), 0);
    expect(overlayCalls).toBe(1);
  });

  it('onKill hook fires through the manager death pipeline', () => {
    const eng = modEngine();
    const kills: string[] = [];
    eng.hooks.tap('onKill', ({ enemy }) => kills.push(enemy.spec.kind as string));
    const mgr = new EnemyManager(eng as unknown as Engine, null, {});
    mgr.spawnAll([stalkerSpec('walker')], () => new THREE.Vector3(0, 0, 0));
    const e = mgr.enemies[0];
    e.damage(99999);
    expect(e.alive).toBe(false);
    expect(kills).toEqual(['walker']);
    expect(mgr.enemies).toHaveLength(0); // roster cleanup still works
  });
});

describe('Modding — custom upgrades', () => {
  it('registered upgrade appears in level-up choices and applies', () => {
    const eng = modEngine();
    let applied = 0;
    eng.hooks.registerUpgrade({
      id: 'vampire',
      name: 'Vampire Rounds',
      desc: 'Heal 5 on every kill',
      apply: () => { applied++; },
    });
    // sweep seeds: the custom def must surface in the 3-choice pool
    let seen = false;
    for (let s = 0; s < 30 && !seen; s++) {
      const p = new Progression({ ...eng, rng: new Rng(s) } as unknown as Engine, {
        enabled: true, xpPerKill: 20, xpPerPickup: 5,
      });
      seen = p.getUpgradeChoices().some((c) => c.id === 'vampire');
    }
    expect(seen).toBe(true);

    const p = new Progression(eng as unknown as Engine, { enabled: true, xpPerKill: 20, xpPerPickup: 5 });
    p.applyUpgrade('vampire', { maxHealth: 100, heal: vi.fn() } as any);
    expect(applied).toBe(1);
    expect(p.upgradeCount('vampire')).toBe(1);
  });

  it('onLevelUp hook fires from addXp', () => {
    const eng = modEngine();
    const levels: number[] = [];
    eng.hooks.tap('onLevelUp', ({ level }) => levels.push(level));
    const p = new Progression(eng as unknown as Engine, { enabled: true, xpPerKill: 20, xpPerPickup: 5 });
    expect(p.addXp(100)).toBe(true); // 100 XP = exactly level 2
    expect(levels).toEqual([2]);
    expect(p.level).toBe(2);
  });

  it('built-in upgrades still apply unchanged', () => {
    const eng = modEngine();
    const p = new Progression(eng as unknown as Engine, { enabled: true, xpPerKill: 20, xpPerPickup: 5 });
    const avatar = { maxHealth: 100, heal: vi.fn() } as any;
    p.applyUpgrade('maxhp', avatar);
    expect(avatar.maxHealth).toBe(115);
    expect(p.damageMult()).toBe(1);
    p.applyUpgrade('damage', avatar);
    expect(p.damageMult()).toBe(1.25);
  });
});
