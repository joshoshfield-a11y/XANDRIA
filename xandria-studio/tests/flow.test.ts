/**
 * Wave 3A flow tests: Settings persistence, Juice math, new Audio SFX/volume,
 * Physics restart baselines, Rng reseed, HUD title/pause/settings/end screens.
 * DOM is stubbed (no jsdom here) — same pattern as campaign.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Settings } from '../src/engine/game/Settings';
import { Juice } from '../src/engine/game/Juice';
import { AudioEngine } from '../src/engine/core/Audio';
import { Physics } from '../src/engine/core/Physics';
import { Rng } from '../src/engine/core/Rng';
import { HUD } from '../src/engine/game/HUD';
import type { Engine } from '../src/engine/Engine';
import type { GameSpec } from '../src/spec/schema';

/* ---------------- minimal DOM stub ---------------- */
function makeEl(tag = 'div'): any {
  const listeners: Record<string, Function[]> = {};
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as Record<string, string>,
    textContent: '',
    className: '',
    value: '',
    checked: false,
    appendChild(c: any) { el.children.push(c); if (c && typeof c === 'object') c.parent = el; return c; },
    append(...cs: any[]) { for (const c of cs) { el.children.push(c); if (c && typeof c === 'object') c.parent = el; } },
    remove() {
      el.removed = true;
      const p = (el as any).parent;
      if (p && Array.isArray(p.children)) {
        const i = p.children.indexOf(el);
        if (i >= 0) p.children.splice(i, 1);
      }
    },
    setAttribute() {},
    addEventListener(t: string, fn: Function) { (listeners[t] ??= []).push(fn); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    __fire(t: string, e: any = {}) { (listeners[t] ?? []).forEach((fn) => fn(e)); },
    __listeners: listeners,
  };
  return el;
}

function installDom() {
  const head = makeEl('head');
  (globalThis as any).document = {
    createElement: (t: string) => makeEl(t),
    head,
  };
}

function installLocalStorage() {
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    __store: store,
  };
}

const hudSpec = () =>
  ({
    meta: { name: 'Test Game' },
    objective: { description: 'Do the thing' },
  }) as unknown as GameSpec;

const audioSpec = () =>
  ({
    meta: { seed: 1234 },
    audio: { sfxVolume: 0.8, musicVolume: 0.6, music: false, tempo: 100, mode: 'minor', key: 0, mood: 'dark' },
  }) as unknown as GameSpec;

beforeEach(() => {
  installDom();
  installLocalStorage();
});

/* ---------------- Settings ---------------- */
describe('Settings', () => {
  it('has sane defaults', () => {
    const s = new Settings();
    expect(s.data.volume).toBe(0.8);
    expect(s.data.muted).toBe(false);
    expect(s.data.quality).toBe('auto');
  });

  it('persists to localStorage and reloads', () => {
    const s = new Settings();
    s.set({ volume: 0.33, muted: true, quality: 'high' });
    const raw = (globalThis as any).localStorage.__store['xandria.settings.v1'];
    expect(JSON.parse(raw)).toMatchObject({ volume: 0.33, muted: true, quality: 'high' });
    const s2 = new Settings();
    expect(s2.data).toMatchObject({ volume: 0.33, muted: true, quality: 'high' });
  });

  it('clamps volume to 0..1 and rejects bad quality', () => {
    const s = new Settings();
    s.set({ volume: 5 });
    expect(s.data.volume).toBe(1);
    s.set({ volume: -2 });
    expect(s.data.volume).toBe(0);
    s.set({ quality: 'potato' as any });
    expect(s.data.quality).toBe('auto');
  });

  it('survives missing/corrupt storage', () => {
    (globalThis as any).localStorage.getItem = () => { throw new Error('denied'); };
    const s = new Settings();
    expect(s.data.volume).toBe(0.8);
    s.set({ volume: 0.5 }); // must not throw
    expect(s.data.volume).toBe(0.5);
  });
});

/* ---------------- Juice ---------------- */
describe('Juice', () => {
  const makeJuice = () => {
    const container: any = { ...makeEl(), clientWidth: 800, clientHeight: 600 };
    const particles: any = { burst: vi.fn(), trail: vi.fn() };
    return new Juice(container, particles);
  };
  const camera = () => {
    const c = new THREE.PerspectiveCamera(60, 1.33, 0.1, 100);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  };

  it('shakeOffset is zero with no trauma, nonzero after shake, decays away', () => {
    const j = makeJuice();
    const out = new THREE.Vector3();
    j.shakeOffset(out);
    expect(out.length()).toBe(0);
    j.shake(0.6);
    expect(j.trauma).toBeCloseTo(0.6);
    j.shakeOffset(out);
    expect(out.length()).toBeGreaterThan(0);
    j.update(10, camera()); // long dt drains trauma
    expect(j.trauma).toBe(0);
    j.shakeOffset(out);
    expect(out.length()).toBe(0);
  });

  it('trauma stacks but caps at 1', () => {
    const j = makeJuice();
    j.shake(0.7);
    j.shake(0.7);
    expect(j.trauma).toBe(1);
  });

  it('hitStop is active only during its window', async () => {
    const j = makeJuice();
    expect(j.hitStopActive()).toBe(false);
    j.hitStop(30);
    expect(j.hitStopActive()).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(j.hitStopActive()).toBe(false);
  });

  it('damage numbers pool at 20 and reuse the oldest', () => {
    const j = makeJuice();
    const cam = camera();
    const wp = new THREE.Vector3(0, 0, -5);
    for (let i = 0; i < 21; i++) j.damageNumber(cam, wp, `n${i}`);
    const items = (j as any).items;
    expect(items).toHaveLength(20);
    expect(items[0].el.textContent).toBe('n20'); // wrapped around
    expect(items[1].el.textContent).toBe('n1');
  });

  it('reset clears trauma and numbers', () => {
    const j = makeJuice();
    j.shake(0.8);
    j.damageNumber(camera(), new THREE.Vector3(0, 0, -5), '12');
    j.reset();
    expect(j.trauma).toBe(0);
    expect((j as any).items.every((it: any) => it.life === 0)).toBe(true);
  });
});

/* ---------------- Audio ---------------- */
describe('AudioEngine additions', () => {
  it('new sfx names are accepted (no ctx = silent no-op)', () => {
    const a = new AudioEngine(audioSpec());
    for (const sfx of ['kill', 'levelup', 'chapter', 'roar', 'shoot', 'win', 'lose'] as const) {
      expect(() => a.play(sfx)).not.toThrow();
    }
  });

  it('setVolume clamps 0..1, setMuted toggles flag', () => {
    const a = new AudioEngine(audioSpec());
    a.setVolume(1.5);
    expect(a.volume).toBe(1);
    a.setVolume(-1);
    expect(a.volume).toBe(0);
    a.setVolume(0.4);
    expect(a.volume).toBe(0.4);
    a.setMuted(true);
    expect(a.muted).toBe(true);
    a.setMuted(false);
    expect(a.muted).toBe(false);
  });

  it('setIntensity clamps', () => {
    const a = new AudioEngine(audioSpec());
    expect(() => a.setIntensity(2)).not.toThrow();
    expect(() => a.setIntensity(-1)).not.toThrow();
  });
});

/* ---------------- Physics baselines ---------------- */
describe('Physics restart baselines', () => {
  it('resetToBaseline removes bodies/handlers added after the baseline', () => {
    const p = new Physics(-20);
    const bodies0 = p.bodyBaseline();
    const cons0 = p.constraintBaseline();
    p.box([1, 1, 1], [0, 5, 0], { mass: 1 });
    p.box([2, 2, 2], [3, 5, 0], { mass: 1 });
    let steps = 0;
    p.addStepHandler(() => { steps++; });
    expect(p.world.bodies.length).toBe(bodies0 + 2);
    p.resetToBaseline(bodies0, cons0);
    expect(p.world.bodies.length).toBe(bodies0);
    expect((p as any).onStep.length).toBe(0);
    p.step(1 / 60);
    expect(steps).toBe(0);
  });
});

/* ---------------- Rng ---------------- */
describe('Rng reseed', () => {
  it('reproduces the exact sequence after reseed (restart determinism)', () => {
    const r = new Rng(777);
    const a = [r.next(), r.next(), r.gaussian(), r.int(0, 100)];
    r.reseed(777);
    const b = [r.next(), r.next(), r.gaussian(), r.int(0, 100)];
    expect(b).toEqual(a);
  });
});

/* ---------------- HUD screens ---------------- */
describe('HUD flow screens', () => {
  const fakeEng = () => ({
    settings: new Settings(),
    applySettings: vi.fn(),
    audio: { play: vi.fn() },
    juice: { shake: vi.fn() },
    togglePause: vi.fn(),
    restart: vi.fn(),
    toTitle: vi.fn(),
  });

  const makeHud = () => {
    const container = makeEl();
    const hud = new HUD(container, hudSpec());
    const eng = fakeEng();
    hud.attachEngine(eng as unknown as Engine);
    return { hud, eng, container, root: (hud as any).root };
  };

  const findOverlay = (root: any) =>
    root.children.find((c: any) => typeof c.className === 'string' && c.className.includes('overlay'));

  it('showTitle renders name/premise/controls and fires onStart once', () => {
    const { hud, root } = makeHud();
    const onStart = vi.fn();
    hud.showTitle({ name: 'NEON QUEST', premise: 'Save the grid.', controls: ['WASD — move'], onStart });
    const ov = findOverlay(root);
    expect(ov).toBeTruthy();
    const texts = JSON.stringify(ov.children.map((c: any) => c.textContent));
    expect(texts).toContain('NEON QUEST');
    expect(texts).toContain('Save the grid.');
    const controls = ov.children.find((c: any) => c.className === 'controls');
    expect(controls.children[0].textContent).toBe('WASD — move');
    const btn = ov.children.find((c: any) => c.className?.includes('start-btn'));
    btn.__fire('click', { stopPropagation() {} });
    ov.__fire('click');
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('showPause has RESUME/RESTART/SETTINGS/QUIT buttons wired to the engine', () => {
    const { hud, eng, root } = makeHud();
    hud.showPause();
    const ov = findOverlay(root);
    const btnWrap = ov.children[ov.children.length - 1];
    const labels = btnWrap.children.map((b: any) => b.textContent);
    expect(labels).toEqual(['RESUME', 'RESTART', 'SETTINGS', 'QUIT TO TITLE']);
    btnWrap.children[0].__fire('click');
    expect(eng.togglePause).toHaveBeenCalled();
    expect(eng.audio.play).toHaveBeenCalledWith('click');
    btnWrap.children[1].__fire('click');
    expect(eng.restart).toHaveBeenCalled();
    btnWrap.children[3].__fire('click');
    expect(eng.toTitle).toHaveBeenCalled();
  });

  it('settings panel edits volume/quality/mute and applies them', () => {
    const { hud, eng, root } = makeHud();
    hud.showPause();
    const ov = findOverlay(root);
    const btnWrap = ov.children[ov.children.length - 1];
    btnWrap.children[2].__fire('click'); // SETTINGS
    const wrap = ov.children.find((c: any) => c.className === 'settings');
    expect(wrap.children).toHaveLength(3);
    const vslider = wrap.children[0].children[1];
    vslider.value = '25';
    vslider.__fire('input');
    expect(eng.settings.data.volume).toBeCloseTo(0.25);
    expect(eng.applySettings).toHaveBeenCalled();
    const mcheck = wrap.children[2].children[1];
    mcheck.checked = true;
    mcheck.__fire('change');
    expect(eng.settings.data.muted).toBe(true);
    // persisted
    const raw = (globalThis as any).localStorage.__store['xandria.settings.v1'];
    expect(JSON.parse(raw).muted).toBe(true);
  });

  it('showEnd has RESTART and TITLE buttons', () => {
    const { hud, eng, root } = makeHud();
    hud.showEnd(true, { score: 100, time: 60, kills: 5, level: 3, stagesCleared: 2 });
    const ov = findOverlay(root);
    const btnWrap = ov.children[ov.children.length - 1];
    const labels = btnWrap.children.map((b: any) => b.textContent);
    expect(labels).toEqual(['RESTART', 'TITLE']);
    btnWrap.children[0].__fire('click');
    expect(eng.restart).toHaveBeenCalled();
    btnWrap.children[1].__fire('click');
    expect(eng.toTitle).toHaveBeenCalled();
  });

  it('resetRun clears overlays and restores bars', () => {
    const { hud, root } = makeHud();
    hud.showPause();
    expect(findOverlay(root)).toBeTruthy();
    hud.damageFlash();
    hud.setLowHp(true);
    hud.resetRun();
    expect(findOverlay(root)).toBeFalsy();
    expect((hud as any).lowHp).toBe(false);
  });

  it('damageFlash shakes the camera via juice', () => {
    const { hud, eng } = makeHud();
    hud.damageFlash();
    expect(eng.juice.shake).toHaveBeenCalledWith(0.35);
  });
});
