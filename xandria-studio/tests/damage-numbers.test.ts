/**
 * DAMAGE-NUMBERS (upgrade loop): floating combat text.
 *
 * - One theme table: every kind formats text/scale/color from
 *   FLOATING_TEXT_THEME, colors resolving through the live colorblind
 *   palette (accessibility themeColor).
 * - Juice pool: cap 20, oldest reused, toggle off clears + suppresses,
 *   idle update does no pool work, mobile-safe clamp math.
 * - Ability crit: display-only top-decile seeded variance roll — damage
 *   values identical to the pre-change formula, kind is the only delta.
 * - Settings: floatingText defaults true, persists through a storage
 *   round-trip (per save slot).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { Juice } from '../src/engine/game/Juice';
import {
  FLOATING_TEXT_THEME,
  formatFloatingText,
  type FloatingTextKind,
} from '../src/engine/game/floatingText';
import {
  THEME_TABLE,
  setCurrentPalette,
} from '../src/engine/game/accessibility';
import {
  ABILITY_SALT,
  AbilityManager,
  CRIT_VARIANCE_CUTOFF,
} from '../src/engine/game/combatAbilities';
import { Rng } from '../src/engine/core/Rng';
import { Settings } from '../src/engine/game/Settings';
import { _setProfileStorage } from '../src/engine/game/Profile';

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

function makeEl(): any {
  const el: any = {
    style: {},
    children: [] as any[],
    appendChild(c: any) { this.children.push(c); return c; },
    set textContent(v: string) { this._t = v; },
    get textContent() { return this._t ?? ''; },
    className: '',
  };
  return el;
}

/* Minimal DOM stub (no jsdom here — same pattern as flow.test.ts). */
function installDom() {
  const head = makeEl();
  (globalThis as any).document = {
    createElement: () => makeEl(),
    head,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}
installDom();

function makeJuice() {
  const container: any = {
    ...makeEl(),
    clientWidth: 360,
    clientHeight: 780,
  };
  const particles: any = { burst: vi.fn(), trail: vi.fn() };
  return new Juice(container, particles);
}

function camera() {
  const c = new THREE.PerspectiveCamera(60, 360 / 780, 0.1, 100);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

describe('floating text theme', () => {
  beforeEach(() => { setCurrentPalette('none'); });

  it('formats all five kinds with distinct text channels', () => {
    const cases: Array<[FloatingTextKind, number, string, number]> = [
      ['playerDamage', 25, '25', 1],
      ['enemyDamage', 12, '−12', 1],
      ['heal', 30, '+30', 1],
      ['crit', 44, '44!', 1.5],
      ['xp', 20, '+20 XP', 0.9],
    ];
    for (const [kind, amount, text, scale] of cases) {
      const f = formatFloatingText(kind, amount);
      expect(f.text).toBe(text);
      expect(f.scale).toBe(scale);
      expect(f.color).toBe(THEME_TABLE.none[FLOATING_TEXT_THEME[kind].role]);
    }
  });

  it('re-themes through the colorblind palette at spawn time', () => {
    setCurrentPalette('protanopia');
    const f = formatFloatingText('enemyDamage', 10);
    expect(f.color).toBe(THEME_TABLE.protanopia.danger);
    expect(f.color).not.toBe(THEME_TABLE.none.danger);
    setCurrentPalette('none');
  });

  it('kinds differ by more than color (grayscale-safe)', () => {
    const texts = (['playerDamage', 'enemyDamage', 'heal', 'crit', 'xp'] as FloatingTextKind[])
      .map((k) => formatFloatingText(k, 25).text);
    expect(new Set(texts).size).toBe(5);
  });
});

describe('Juice floating text pool', () => {
  it('spawnText themes via the table and respects the pool cap', () => {
    const j = makeJuice();
    const cam = camera();
    const wp = new THREE.Vector3(0, 0, -5);
    for (let i = 0; i < 21; i++) j.spawnText(cam, wp, 'playerDamage', i);
    const items = (j as any).items;
    expect(items).toHaveLength(20);
    expect(items[0].el.textContent).toBe('20'); // wrapped around
    expect(items[0].el.style.color).toBe(THEME_TABLE.none.accent);
  });

  it('crit numbers render larger with the crit suffix', () => {
    const j = makeJuice();
    j.spawnText(camera(), new THREE.Vector3(0, 0, -5), 'crit', 44);
    const it = (j as any).items[0];
    expect(it.el.textContent).toBe('44!');
    expect(it.el.style.fontSize).toBe('27px'); // 18 * 1.5
  });

  it('toggle off clears live numbers and suppresses new ones; on resumes', () => {
    const j = makeJuice();
    const cam = camera();
    j.spawnText(cam, new THREE.Vector3(0, 0, -5), 'playerDamage', 10);
    expect((j as any).activeCount).toBe(1);
    j.setFloatingTextEnabled(false);
    expect((j as any).activeCount).toBe(0);
    expect((j as any).items.every((it: any) => it.life === 0)).toBe(true);
    j.spawnText(cam, new THREE.Vector3(0, 0, -5), 'playerDamage', 10);
    expect((j as any).activeCount).toBe(0);
    j.setFloatingTextEnabled(true);
    j.spawnText(cam, new THREE.Vector3(0, 0, -5), 'heal', 30);
    expect((j as any).activeCount).toBe(1);
  });

  it('idle update does no pool work; expiry drains the active count', () => {
    const j = makeJuice();
    const cam = camera();
    j.update(0.016, cam); // idle: must not throw, must not touch items
    expect((j as any).activeCount).toBe(0);
    j.spawnText(cam, new THREE.Vector3(0, 0, -5), 'playerDamage', 10);
    j.update(1.0, cam); // past the 0.9s life
    expect((j as any).activeCount).toBe(0);
    expect((j as any).items.every((it: any) => it.life <= 0)).toBe(true);
  });

  it('mobile-safe clamp keeps numbers out of the tracker/button bands', () => {
    const j = makeJuice();
    const cam = camera();
    // Simulate a measured safe area: tracker occupies the top 208px,
    // touch buttons the bottom 356px of a 780px viewport.
    (j as any).safeTopPx = 200;
    (j as any).safeBottomPx = 348;
    // World y +1.77 at z -5 projects to py ≈ 150 (inside the tracker
    // band) — must clamp to exactly the band edge, 208.
    j.spawnText(cam, new THREE.Vector3(0, 1.77, -5), 'playerDamage', 10);
    expect(parseFloat((j as any).items[0].el.style.top)).toBe(208);
    // World y -2.29 projects to py ≈ 700 (inside the button cluster) —
    // must clamp to exactly 780 - 348 - 8 = 424.
    j.spawnText(cam, new THREE.Vector3(0, -2.29, -5), 'playerDamage', 10);
    expect(parseFloat((j as any).items[1].el.style.top)).toBe(424);
  });

  it('legacy damageNumber still works (color passthrough, base size)', () => {
    const j = makeJuice();
    j.damageNumber(camera(), new THREE.Vector3(0, 0, -5), '12', '#abcdef');
    const it = (j as any).items[0];
    expect(it.el.textContent).toBe('12');
    expect(it.el.style.color).toBe('#abcdef');
    expect(it.el.style.fontSize).toBe('18px');
  });
});

describe('ability crit styling (display only)', () => {
  it('crit kind matches the top-decile seeded roll; damage value unchanged', () => {
    for (const seed of [12345, 7, 99, 20261012]) {
      const u = new Rng(((seed ^ ABILITY_SALT) >>> 0)).next();
      const expectedDmg = Math.round(40 * (0.9 + u * 0.2));
      const expectedCrit = u >= CRIT_VARIANCE_CUTOFF;
      const kinds: Array<string | undefined> = [];
      const numbers: string[] = [];
      const enemy: any = {
        alive: true,
        position: new THREE.Vector3(0, 0, 2),
        damage: vi.fn(),
        body: null,
      };
      const manager = new AbilityManager({
        avatar: { ctrl: { position: new THREE.Vector3(0, 0, 0) } } as any,
        enemies: { enemies: [enemy] },
        seed,
        fx: {
          burst: () => {},
          damageNumber: (_pos, text, _color, kind) => { numbers.push(text); kinds.push(kind); },
          shake: () => {},
        },
      });
      const res = manager.cast('dash-strike', new THREE.Vector3(0, 0, 1));
      expect(res.ok).toBe(true);
      expect(res.damageDealt).toBe(expectedDmg);
      expect(numbers).toEqual([String(expectedDmg)]);
      expect(kinds).toEqual([expectedCrit ? 'crit' : 'playerDamage']);
    }
  });
});

describe('floating text settings persistence', () => {
  beforeEach(() => { _setProfileStorage(memStore() as any); });

  it('defaults true and survives a storage round-trip', () => {
    const s = new Settings();
    expect(s.data.floatingText).toBe(true);
    s.set({ floatingText: false });
    expect(s.data.floatingText).toBe(false);
    const s2 = new Settings();
    expect(s2.data.floatingText).toBe(false);
  });
});
