/**
 * UPGRADE LOOP (character-customization): cosmetics defs, Profile persistence,
 * rig application, and the customization panel (DOM-stubbed).
 *
 * Guarantees under test:
 *  - every outfit id in the tuning table resolves to a real built-in skin
 *  - validation drops unknown ids (never stores them) and never throws
 *  - cosmetics persist per save slot (slot-2 never sees slot-1's look)
 *  - the identity selection changes nothing on a rig (zero-regression floor)
 *  - visor / trim / outfit / scarf / hood each land on the rig through the
 *    existing skin + voxel-cape channels, and toggling off restores baseline
 *  - two fresh rigs from the same selection look identical (rebuild = portal
 *    arrival / reload construction path)
 *  - panel controls are >= 28px and the panel is centered (no HUD collisions)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  VISOR_COLORS, TRIM_COLORS, OUTFIT_SKIN_IDS, outfitName,
  defaultCosmetics, validateCosmetics, applyCosmeticsToRig, countRigMeshes,
  type CosmeticSelection,
} from '../src/engine/game/cosmetics';
import {
  BUILT_IN_SKINS,
} from '../src/engine/gfx/Skins';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { makeHumanoid, type CharacterRig } from '../src/engine/gfx/Characters';
import {
  _setProfileStorage, loadProfile, saveProfile, setCosmetics,
  loadSlots, setActiveSlotId, defaultProfile,
} from '../src/engine/game/Profile';
import { CustomizationPanel } from '../src/engine/ui/CustomizationPanel';

/* DOM stub for the canvas textures (same shape as character-custom.test.ts). */
const ctx2d = () => ({
  set fillStyle(_v: string) {},
  get fillStyle() { return '#000'; },
  fillRect(..._a: unknown[]) {},
  beginPath() {},
  moveTo(..._a: unknown[]) {},
  lineTo(..._a: unknown[]) {},
  ellipse(..._a: unknown[]) {},
  fill() {},
  createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  putImageData() {},
});
(globalThis as any).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d() }),
};

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};

const rig = (seed = 11): CharacterRig => makeHumanoid(new MaterialLibrary(testSpec), {}, seed);

const roleMatOrNull = (r: { group: THREE.Object3D }, role: string): THREE.MeshStandardMaterial | null => {
  let hit: THREE.MeshStandardMaterial | null = null;
  r.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || hit) return;
    for (const mm of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[]) {
      if ((mm as THREE.MeshStandardMaterial).userData.role === role) {
        hit = mm as THREE.MeshStandardMaterial; break;
      }
    }
  });
  return hit;
};
const roleMat = (r: { group: THREE.Object3D }, role: string): THREE.MeshStandardMaterial => {
  const hit = roleMatOrNull(r, role);
  if (!hit) throw new Error(`no material with role ${role}`);
  return hit;
};

const capePieceCount = (r: { group: THREE.Object3D }): number => {
  let n = 0;
  r.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as { userData?: Record<string, unknown> }).userData?.capePiece === true) n++;
  });
  return n;
};

const glowEmissives = (r: { group: THREE.Object3D }): number[] => {
  const out: number[] = [];
  r.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mm of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[]) {
      const mat = mm as THREE.MeshStandardMaterial;
      if (mat?.userData?.owned && typeof mat.userData.role !== 'string' &&
        'emissive' in mat && (mat.emissive as THREE.Color).getHex() !== 0x000000) {
        out.push((mat.emissive as THREE.Color).getHex());
      }
    }
  });
  return out;
};

/* In-memory profile storage, reset per test. */
const mem = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
};
beforeEach(() => {
  mem.clear();
  _setProfileStorage(fakeStorage);
});

describe('cosmetics defs', () => {
  it('every outfit id resolves to a built-in skin', () => {
    expect(OUTFIT_SKIN_IDS.length).toBeGreaterThan(0);
    for (const id of OUTFIT_SKIN_IDS) {
      expect(BUILT_IN_SKINS[id], id).toBeDefined();
      expect(outfitName(id)).not.toBe(id); // real display names, not raw ids
    }
    expect(new Set(OUTFIT_SKIN_IDS).size).toBe(OUTFIT_SKIN_IDS.length); // no dupes
    expect(new Set(VISOR_COLORS.map((v) => v.id)).size).toBe(VISOR_COLORS.length);
    expect(new Set(TRIM_COLORS.map((t) => t.id)).size).toBe(TRIM_COLORS.length);
  });

  it('validateCosmetics drops unknown ids and coerces flags, never throws', () => {
    expect(validateCosmetics(null)).toEqual(defaultCosmetics());
    expect(validateCosmetics('nope')).toEqual(defaultCosmetics());
    const v = validateCosmetics({
      visor: 'nope', outfit: 'nope', trim: 'nope', scarf: 1, hood: 'yes',
    });
    expect(v).toEqual({ visor: null, outfit: null, scarf: false, hood: false, trim: null });
    const ok = validateCosmetics({ visor: 'cyan', outfit: 'crimson', scarf: true, hood: false, trim: 'gold' });
    expect(ok).toEqual({ visor: 'cyan', outfit: 'crimson', scarf: true, hood: false, trim: 'gold' });
    expect(() => validateCosmetics({ visor: { x: 1 } })).not.toThrow();
  });
});

describe('cosmetics in Profile (per save slot)', () => {
  it('round-trips through save/load and validates on load', () => {
    const p = loadProfile();
    setCosmetics(p, { visor: 'magenta', outfit: 'stealth', scarf: true, trim: 'teal' });
    saveProfile(p);
    const back = loadProfile();
    expect(back.cosmetics).toEqual({ visor: 'magenta', outfit: 'stealth', scarf: true, hood: false, trim: 'teal' });
  });

  it('does not leak across save slots', () => {
    loadSlots(); // creates the default 3 slots
    const p = loadProfile();
    setCosmetics(p, { visor: 'venom', outfit: 'gold', hood: true });
    saveProfile(p);
    expect(setActiveSlotId('slot-2')).toBe(true);
    expect(loadProfile().cosmetics).toEqual(defaultCosmetics());
    expect(setActiveSlotId('slot-1')).toBe(true);
    expect(loadProfile().cosmetics.visor).toBe('venom');
  });

  it('corrupt stored cosmetics migrate to the identity default', () => {
    const raw = { ...defaultProfile(), cosmetics: { visor: 'bogus', outfit: 'bogus', scarf: 'yes' } };
    mem.set('xandria.slots.v1', JSON.stringify({
      version: 1, activeSlotId: 'slot-1', nextSeq: 2,
      slots: [{ id: 'slot-1', name: 'Slot 1', profile: raw, settings: {}, createdAt: 0, updatedAt: 0 }],
    }));
    expect(loadProfile().cosmetics).toEqual(defaultCosmetics());
  });
});

describe('applyCosmeticsToRig', () => {
  it('identity selection changes nothing (materials + mesh count)', () => {
    const r = rig();
    const before = {
      shirt: roleMat(r, 'shirt').color.getHex(),
      pants: roleMat(r, 'pants').color.getHex(),
      accent: roleMat(r, 'accent').color.getHex(),
      accentEm: roleMat(r, 'accent').emissive.getHex(),
      meshes: countRigMeshes(r),
      cape: capePieceCount(r),
    };
    applyCosmeticsToRig(r, defaultCosmetics());
    expect(roleMat(r, 'shirt').color.getHex()).toBe(before.shirt);
    expect(roleMat(r, 'pants').color.getHex()).toBe(before.pants);
    expect(roleMat(r, 'accent').color.getHex()).toBe(before.accent);
    expect(roleMat(r, 'accent').emissive.getHex()).toBe(before.accentEm);
    expect(countRigMeshes(r)).toBe(before.meshes);
    expect(capePieceCount(r)).toBe(before.cape);
    r.dispose();
  });

  it('outfit crimson lands the skin palette', () => {
    const r = rig();
    applyCosmeticsToRig(r, { ...defaultCosmetics(), outfit: 'crimson' });
    expect(roleMat(r, 'shirt').color.getHex()).toBe(0x8a1f1f);
    expect(roleMat(r, 'pants').color.getHex()).toBe(0x241a1a);
    r.dispose();
  });

  it('visor tints the accent emissive; trim recolors the accent role', () => {
    const r = rig();
    applyCosmeticsToRig(r, { ...defaultCosmetics(), visor: 'cyan', trim: 'gold' });
    expect(roleMat(r, 'accent').emissive.getHex()).toBe(0x35e0ff);
    expect(roleMat(r, 'accent').color.getHex()).toBe(0xd8a428);
    // cape cloth mirrors the trim when the seeded plan has a cape
    const ds = roleMatOrNull(r, 'accentDS');
    if (ds) expect(ds.color.getHex()).toBe(0xd8a428);
    r.dispose();
  });

  it('visor re-tints an armor outfit glow slit', () => {
    const r = rig();
    applyCosmeticsToRig(r, { ...defaultCosmetics(), outfit: 'nomad', visor: 'magenta' });
    const glows = glowEmissives(r);
    expect(glows.length).toBeGreaterThan(0);
    expect(glows.every((g) => g === 0xff2fd6)).toBe(true);
    r.dispose();
  });

  it('scarf adds a mantle cape, hood a hooded cape, off restores baseline', () => {
    const r = rig();
    const base = capePieceCount(r);
    applyCosmeticsToRig(r, { ...defaultCosmetics(), scarf: true });
    expect(capePieceCount(r)).toBeGreaterThan(base);
    applyCosmeticsToRig(r, { ...defaultCosmetics(), hood: true });
    expect(capePieceCount(r)).toBeGreaterThan(0); // hooded cowl replaces the mantle
    applyCosmeticsToRig(r, defaultCosmetics());
    expect(capePieceCount(r)).toBe(base);
    r.dispose();
  });

  it('rebuild from the same selection is identical (portal/reload path)', () => {
    const sel: CosmeticSelection = { visor: 'venom', outfit: 'stealth', scarf: true, hood: false, trim: 'teal' };
    const a = rig();
    const b = rig();
    applyCosmeticsToRig(a, sel);
    applyCosmeticsToRig(b, sel);
    for (const role of ['shirt', 'pants', 'accent']) {
      expect(roleMat(b, role).color.getHex()).toBe(roleMat(a, role).color.getHex());
      expect(roleMat(b, role).emissive.getHex()).toBe(roleMat(a, role).emissive.getHex());
    }
    const dsA = roleMatOrNull(a, 'accentDS');
    const dsB = roleMatOrNull(b, 'accentDS');
    if (dsA && dsB) expect(dsB.color.getHex()).toBe(dsA.color.getHex());
    expect(capePieceCount(b)).toBe(capePieceCount(a));
    a.dispose(); b.dispose();
  });

  it('never throws on garbage input or untagged rigs', () => {
    const r = rig();
    expect(() => applyCosmeticsToRig(r, null as never)).not.toThrow();
    expect(() => applyCosmeticsToRig(r, { visor: 42 } as never)).not.toThrow();
    const plain = { group: new THREE.Group() };
    plain.group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    expect(() => applyCosmeticsToRig(plain, { ...defaultCosmetics(), outfit: 'crimson', scarf: true })).not.toThrow();
    r.dispose();
  });
});

/* ---- minimal fake DOM for the panel ---- */
class FakeEl {
  tag: string;
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners: Record<string, Array<() => void>> = {};
  text = '';
  attrs: Record<string, string> = {};
  clientWidth = 300;
  constructor(tag: string) { this.tag = tag; }
  set textContent(v: string) { this.text = v; }
  get textContent() { return this.text; }
  set innerHTML(_v: string) { this.children = []; }
  get innerHTML() { return ''; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k]; }
  addEventListener(t: string, fn: () => void) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener() {}
  append(...els: FakeEl[]) { this.children.push(...els); }
  appendChild(el: FakeEl) { this.children.push(el); return el; }
  remove() {}
  clear() { this.children = []; }
  click() { for (const fn of this.listeners.click ?? []) fn(); }
  query(testid: string): FakeEl | null {
    if (this.attrs['data-testid'] === testid) return this;
    for (const c of this.children) { const hit = c.query(testid); if (hit) return hit; }
    return null;
  }
  allButtons(): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl) => {
      if (e.tag === 'button') out.push(e);
      for (const c of e.children) walk(c);
    };
    walk(this);
    return out;
  }
}
const fakeDoc: any = {
  createElement: (tag: string) => new FakeEl(tag),
  addEventListener() {},
  removeEventListener() {},
};
const px = (css: string, prop: string): number => {
  const m = css.match(new RegExp(`${prop}\\s*:\\s*(\\d+)px`));
  return m ? parseInt(m[1], 10) : NaN;
};

describe('CustomizationPanel (fake DOM)', () => {
  it('opens centered, persists picks to the profile, and keeps touch targets >= 28px', () => {
    const container = new FakeEl('div');
    const live: CosmeticSelection[] = [];
    const panel = new CustomizationPanel({
      container: container as unknown as HTMLElement,
      doc: fakeDoc,
      applyToLiveAvatar: (c) => { live.push(c); },
    });
    panel.show();
    expect(panel.isOpen()).toBe(true);
    const root = container.children[0];
    expect(root.attrs['data-testid']).toBe('customization-panel');
    // centered modal (not docked over any HUD chip) — styles land in cssText
    const css = (root.style as Record<string, string>).cssText ?? '';
    expect(css).toContain('translate(-50%,-50%)');
    expect(css).toContain('left:50%');
    // pick a visor + outfit + scarf through the buttons
    root.query('visor-cyan')!.click();
    root.query('outfit-stealth')!.click();
    root.query('acc-scarf')!.click();
    const saved = loadProfile().cosmetics;
    expect(saved.visor).toBe('cyan');
    expect(saved.outfit).toBe('stealth');
    expect(saved.scarf).toBe(true);
    expect(live[live.length - 1]).toEqual(saved);
    // every button meets the 28px touch floor
    for (const b of root.allButtons()) {
      const styleText = Object.values(b.style).join(' ');
      const w = px(styleText, 'width');
      const h = px(styleText, 'min-height');
      expect(Math.min(isNaN(w) ? 32 : w, isNaN(h) ? 32 : h)).toBeGreaterThanOrEqual(28);
    }
    panel.hide();
    expect(panel.isOpen()).toBe(false);
    panel.dispose();
  });
});
