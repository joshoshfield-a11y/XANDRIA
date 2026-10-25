/**
 * Accessibility pass — unit tests.
 *
 * Covers the pure core (theme table, remap validation, keymap build),
 * the reduced-motion gates (Juice / Particles / camera rig), and the
 * profile persistence round-trip. Real-key behavior (keydown → action)
 * and the settings UI are covered by tests/e2e/accessibility.spec.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  THEME_TABLE, beaconColorForType, BEACON_SHIPPED, buildKeymap,
  clampTextScale, defaultAccessibilitySettings, effectiveActionCodes,
  keyDisplayName, themeColor, tryRemap, validateAccessibilitySettings,
  validateKeybinds,
} from '../src/engine/game/accessibility';
import { Input } from '../src/engine/core/Input';
import { Juice } from '../src/engine/game/Juice';
import { Particles } from '../src/engine/gfx/Particles';
import { makeCameraRig, setCameraReducedMotion, getCameraReducedMotion } from '../src/engine/game/Cameras';
import {
  _setProfileStorage, defaultProfile, loadProfile, migrateProfile, saveProfile,
} from '../src/engine/game/Profile';
import { EventBeacon } from '../src/engine/game/dynamicEvents';

function makeEl(tag = 'div'): any {
  const el: any = {
    tag, children: [] as any[], style: {} as Record<string, string>,
    className: '', textContent: '', clientWidth: 800, clientHeight: 600,
    appendChild(c: any) { el.children.push(c); return c; },
  };
  return el;
}

function stubEl(): any {
  return {
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
}

beforeEach(() => {
  const noop = () => {};
  (globalThis as any).window = { addEventListener: noop, removeEventListener: noop, innerWidth: 800 };
  (globalThis as any).document = {
    addEventListener: noop, removeEventListener: noop,
    createElement: (t: string) => makeEl(t), head: makeEl('head'),
  };
  setCameraReducedMotion(false);
});

afterEach(() => {
  setCameraReducedMotion(false);
  _setProfileStorage(undefined);
});

// ---------------------------------------------------------------- theme table

describe('theme table', () => {
  it("'none' palette is the exact shipped HUD hexes", () => {
    expect(THEME_TABLE.none.accent).toBe('#ffd23f');
    expect(THEME_TABLE.none.coin).toBe('#8fe3a8');
    expect(THEME_TABLE.none.lives).toBe('#ff8a9a');
    expect(THEME_TABLE.none.info).toBe('#7dd3fc');
    expect(THEME_TABLE.none.danger).toBe('#ff4d5e');
  });

  it('protanopia/deuteranopia move danger off red onto blue; tritanopia moves info off cyan onto magenta', () => {
    expect(themeColor('danger', 'protanopia')).toBe('#2f6bff');
    expect(themeColor('danger', 'deuteranopia')).toBe('#2f6bff');
    expect(themeColor('danger', 'tritanopia')).toBe('#ff4d5e');
    expect(themeColor('info', 'tritanopia')).toBe('#e85dff');
    expect(themeColor('info', 'none')).toBe('#7dd3fc');
  });

  it('every palette differs from none on at least one role', () => {
    for (const p of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      const diff = (Object.keys(THEME_TABLE.none) as (keyof typeof THEME_TABLE.none)[])
        .some((r) => THEME_TABLE[p][r] !== THEME_TABLE.none[r]);
      expect(diff).toBe(true);
    }
  });

  it('EventBeacon.recolor updates both materials in place', () => {
    const beacon = new EventBeacon('#ff0000');
    beacon.recolor('#00ff00');
    const gem = (beacon.group.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    const pillar = (beacon.group.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect('#' + gem.color.getHexString()).toBe('#00ff00');
    expect('#' + pillar.color.getHexString()).toBe('#00ff00');
  });

  it('beacon colors: none returns exact shipped hexes, palettes resolve through roles', () => {
    expect(beaconColorForType('ambush', 'none')).toBe(BEACON_SHIPPED.ambush);
    expect(beaconColorForType('merchant', 'none')).toBe('#ffcf7a');
    expect(beaconColorForType('patrol', 'none')).toBe('#c77aff');
    expect(beaconColorForType('ambush', 'protanopia')).toBe('#2f6bff');
    expect(beaconColorForType('cache', 'tritanopia')).toBe('#e85dff');
  });
});

// ---------------------------------------------------------------- remaps

describe('tryRemap / validateKeybinds', () => {
  it('accepts a free key', () => {
    const res = tryRemap({}, 'interact', 'KeyT');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.overrides.interact).toBe('KeyT');
  });

  it('rejects a key bound to another action (primary)', () => {
    const res = tryRemap({}, 'interact', 'KeyW');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/forward/);
  });

  it('rejects a key bound via a secondary binding', () => {
    expect(tryRemap({}, 'jump', 'ArrowUp').ok).toBe(false);
    expect(tryRemap({}, 'jump', 'KeyX').ok).toBe(false); // KeyX = secondary brake
  });

  it('rejects the action’s own current key and malformed input', () => {
    expect(tryRemap({}, 'interact', 'KeyE').ok).toBe(false);
    expect(tryRemap({}, 'interact', '').ok).toBe(false);
    expect(tryRemap({}, 'nope' as never, 'KeyT').ok).toBe(false);
  });

  it('allows remapping onto the action’s own secondary binding', () => {
    expect(tryRemap({}, 'interact', 'KeyF').ok).toBe(true);
  });

  it('a freed key becomes available again', () => {
    const first = tryRemap({}, 'forward', 'KeyJ');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(tryRemap(first.overrides, 'back', 'KeyW').ok).toBe(true);
  });

  it('validateKeybinds drops unknown actions, bad codes, and later conflicts (first-wins)', () => {
    const out = validateKeybinds({ forward: 'KeyJ', back: 'KeyJ', nope: 'KeyT', jump: 42 });
    expect(out).toEqual({ forward: 'KeyJ' });
  });

  it('keyDisplayName strips prefixes', () => {
    expect(keyDisplayName('KeyW')).toBe('W');
    expect(keyDisplayName('Digit1')).toBe('1');
    expect(keyDisplayName('Space')).toBe('SPACE');
    expect(keyDisplayName('ShiftLeft')).toBe('SHIFT');
  });
});

// ---------------------------------------------------------------- keymap build

describe('buildKeymap', () => {
  it('defaults reproduce the old hardcoded KEYMAP exactly', () => {
    const m = buildKeymap({});
    expect(m.KeyW).toEqual(['forward']);
    expect(m.Space).toEqual(['jump', 'boost', 'confirm']);
    expect(m.ShiftLeft).toEqual(['sprint', 'dash']);
    expect(m.ShiftRight).toEqual(['sprint', 'dash']);
    expect(m.KeyE).toEqual(['interact']);
    expect(m.KeyF).toEqual(['interact']);
    expect(m.KeyX).toEqual(['brake']);
    expect(m.KeyP).toEqual(['pause']);
    expect(m.ArrowUp).toEqual(['forward']);
    expect(m.Digit1).toEqual(['weapon1']);
    expect(m.Enter).toEqual(['confirm']);
  });

  it('a remap moves the action: old primary stops, new works, secondaries survive', () => {
    const m = buildKeymap({ interact: 'KeyT' });
    expect(m.KeyT).toEqual(['interact']);
    expect(m.KeyE).toBeUndefined();
    expect(m.KeyF).toEqual(['interact']); // secondary untouched
  });

  it('Input.setKeybinds updates the effective primary codes', () => {
    const input = new Input(stubEl());
    expect(input.getKeybinds().interact).toBe('KeyE');
    input.setKeybinds({ interact: 'KeyT' });
    expect(input.getKeybinds().interact).toBe('KeyT');
    expect(input.getKeybinds().forward).toBe('KeyW');
    input.dispose();
  });
});

// ---------------------------------------------------------------- reduced motion

describe('reduced motion gates', () => {
  it('Juice: shake is a no-op and shakeOffset is zero when reduced', () => {
    const particles = new Particles(new THREE.Scene(), 1234);
    const juice = new Juice(makeEl(), particles);
    juice.reducedMotion = true;
    juice.shake(1);
    expect(juice.trauma).toBe(0);
    const out = new THREE.Vector3(9, 9, 9);
    expect(juice.shakeOffset(out).toArray()).toEqual([0, 0, 0]);
    juice.reducedMotion = false;
    juice.shake(1);
    expect(juice.trauma).toBeGreaterThan(0);
  });

  it('Particles: burst emits nothing when reduced, emits when not', () => {
    const particles = new Particles(new THREE.Scene(), 1234);
    const pos = new THREE.Vector3(0, 0, 0);
    particles.reducedMotion = true;
    particles.burst(pos, { count: 50 });
    particles.explosion(pos, 1);
    expect(particles.aliveCount('additive')).toBe(0);
    expect(particles.aliveCount('normal')).toBe(0);
    particles.reducedMotion = false;
    particles.burst(pos, { count: 50 });
    expect(particles.aliveCount('additive')).toBeGreaterThan(0);
  });

  it('camera rig: shake is a no-op and the speed FOV kick is skipped when reduced', () => {
    const camera = new THREE.PerspectiveCamera(66, 1, 0.1, 1000);
    const rig = makeCameraRig('third-person', camera, { look: { x: 0, y: 0 } } as never);
    const target = new THREE.Vector3(0, 0, 0);
    const fast = new THREE.Vector3(30, 0, 0);
    rig.update(0.016, target, fast, 0);
    expect(camera.fov).toBeCloseTo(75, 5); // 66 + 9 kick
    setCameraReducedMotion(true);
    expect(getCameraReducedMotion()).toBe(true);
    rig.update(0.016, target, fast, 0);
    expect(camera.fov).toBeCloseTo(66, 5); // kick skipped
    rig.shake(1);
    const before = camera.position.clone();
    rig.update(0.016, target, new THREE.Vector3(0, 0, 0), 0);
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------- settings validation + profile

describe('settings validation and profile persistence', () => {
  it('clampTextScale clamps to 0.85..1.5', () => {
    expect(clampTextScale(0.5)).toBe(0.85);
    expect(clampTextScale(2)).toBe(1.5);
    expect(clampTextScale(1.234)).toBe(1.23);
    expect(clampTextScale('x')).toBe(1);
  });

  it('validateAccessibilitySettings falls back per-field, never throws', () => {
    expect(validateAccessibilitySettings(null)).toEqual(defaultAccessibilitySettings());
    const v = validateAccessibilitySettings({ colorblind: 'bogus', reducedMotion: true, hudTextScale: 9, keybinds: { jump: 'KeyJ' } });
    expect(v.colorblind).toBe('none');
    expect(v.reducedMotion).toBe(true);
    expect(v.hudTextScale).toBe(1.5);
    expect(v.keybinds).toEqual({ jump: 'KeyJ' });
  });

  it('profile round-trip preserves accessibility settings', () => {
    const mem = new Map<string, string>();
    _setProfileStorage({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); } });
    const p = defaultProfile();
    p.accessibility = {
      keybinds: { interact: 'KeyT', jump: 'KeyJ' },
      colorblind: 'deuteranopia', reducedMotion: true, hudTextScale: 1.25,
    };
    saveProfile(p);
    const loaded = loadProfile();
    expect(loaded.accessibility).toEqual(p.accessibility);
  });

  it('old profiles without accessibility migrate to defaults', () => {
    const migrated = migrateProfile({ version: 1, merit: 5 });
    expect(migrated.accessibility).toEqual(defaultAccessibilitySettings());
    expect(migrated.merit).toBe(5);
  });

  it('effectiveActionCodes applies overrides over defaults', () => {
    const codes = effectiveActionCodes({ jump: 'KeyJ' });
    expect(codes.jump).toBe('KeyJ');
    expect(codes.forward).toBe('KeyW');
  });
});
