/**
 * UPGRADE LOOP (character-customization): the player customization panel.
 *
 * DOM pattern follows JournalPanel (absolute in the engine container,
 * self-contained inline styles, native buttons for touch). Placement is a
 * CENTERED modal — it cannot collide with the quest tracker (top-right),
 * the objective panel (top-left), the score panel, or the bars (bottom
 * left), per the hud-polish audit. Every control is >= 28px (skills-wave
 * touch-target precedent: buttons min-height 32px, swatches 32x32).
 *
 * Sections: VISOR (glow swatches), OUTFIT (skin buttons), ACCESSORIES
 * (scarf / hood toggles + trim swatches). Changes write through Profile
 * (loadProfile → setCosmetics → saveProfile, per save slot) immediately,
 * re-render the live preview rig, and call applyToLiveAvatar so the
 * in-game figure updates without a reload.
 *
 * Preview: the existing voxel render path — a real makeHumanoid rig with
 * applyCosmeticsToRig, rendered by a small WebGLRenderer that only runs
 * while the panel is open. When WebGL is unavailable (headless unit tests),
 * the canvas hides and the panel still works; the swatch rows carry the
 * color truth. Close: × / Esc. Rows carry data-testid attributes for e2e.
 *
 * The `doc` param is injectable so unit tests can pass a minimal DOM stub.
 * The preview rig factory is injectable for the same reason (tests pass a
 * stub rig; production passes the real makeHumanoid path via `previewRig`).
 */
import * as THREE from 'three';
import { loadProfile, saveProfile, setCosmetics } from '../game/Profile';
import {
  VISOR_COLORS, TRIM_COLORS, OUTFIT_SKIN_IDS, outfitName,
  defaultCosmetics, type CosmeticSelection,
} from '../game/cosmetics';
import { applyCosmeticsToRig } from '../game/cosmetics';
import { makeHumanoid, type CharacterRig } from '../gfx/Characters';
import type { MaterialLibrary } from '../gfx/Materials';

export interface CustomizationPanelOpts {
  container: HTMLElement;
  doc?: Document;
  /** material library for the preview rig (engine.mats in production) */
  mats?: MaterialLibrary;
  /** world seed for the preview rig (spec.meta.seed in production) */
  seed?: number;
  /** re-apply hook for the live in-game avatar (Engine wires this) */
  applyToLiveAvatar?: (c: CosmeticSelection) => void;
  /** test seam: build the preview rig instead of makeHumanoid */
  previewRig?: () => { group: THREE.Object3D; dispose?: () => void } | null;
}

const GOLD = '#ffd76a';
const PANEL_BG = 'rgba(8,10,16,0.96)';
const TEXT = '#e8ecf4';
const DIM = '#9aa4b8';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class CustomizationPanel {
  private root: HTMLElement;
  private sectionsEl: HTMLElement;
  private previewCanvas: HTMLCanvasElement;
  private previewFallback: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private pivot: THREE.Group | null = null;
  private rig: { group: THREE.Object3D; dispose?: () => void } | null = null;
  private raf = 0;
  private alive = false;

  constructor(private readonly opts: CustomizationPanelOpts) {
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container;

    const root = el(doc, 'div', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9700', 'width:min(520px,94vw)', 'max-height:86vh',
      'display:none', 'flex-direction:column',
      `background:${PANEL_BG}`, `border:1px solid ${GOLD}73`, 'border-radius:12px',
      'font-family:system-ui,-apple-system,sans-serif', `color:${TEXT}`,
      'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
    ].join(';'));
    root.id = 'xandria-customization-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Character customization');
    root.setAttribute('data-testid', 'customization-panel');

    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${GOLD}33`,
    ].join(';'));
    head.append(
      el(doc, 'div', `font-size:15px;font-weight:700;color:${GOLD};letter-spacing:0.05em`, '✦ CUSTOMIZE'),
      (() => {
        const close = el(doc, 'button', [
          'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
          'border-radius:6px', 'width:32px', 'height:32px', 'font-size:16px',
          'cursor:pointer', 'font-family:inherit', 'line-height:1',
        ].join(';'), '×');
        close.setAttribute('aria-label', 'Close customization');
        close.setAttribute('data-testid', 'customization-close');
        close.addEventListener('click', () => this.hide());
        return close;
      })(),
    );

    // preview canvas (WebGL when available; fallback swatch row otherwise)
    this.previewCanvas = doc.createElement('canvas') as HTMLCanvasElement;
    this.previewCanvas.style.cssText = 'width:100%;height:190px;border-radius:8px;background:#0a0e16;display:block';
    this.previewCanvas.setAttribute('data-testid', 'customization-preview');
    this.previewFallback = el(doc, 'div', [
      'display:none', 'padding:10px 12px', `font-size:12px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'Preview unavailable here — your picks still apply to the in-game figure.');

    this.sectionsEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 12px 12px', 'display:flex',
      'flex-direction:column', 'gap:14px',
    ].join(';'));

    const foot = el(doc, 'div', [
      'padding:8px 14px 10px', `font-size:11px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'Cosmetics only — no stats, hitboxes, or behavior change. Esc to close.');
    root.append(head, this.previewCanvas, this.previewFallback, this.sectionsEl, foot);
    container.appendChild(root);
    this.root = root;

    this.onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.open_) { e.stopPropagation(); this.hide(); }
    };
    doc.addEventListener('keydown', this.onKey, true);
  }

  isOpen(): boolean { return this.open_; }

  show(): void {
    if (this.disposed || this.open_) return;
    this.open_ = true;
    this.root.style.display = 'flex';
    this.renderSections();
    this.startPreview();
  }

  hide(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.root.style.display = 'none';
    this.stopPreview();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPreview();
    try { (this.opts.doc ?? globalThis.document).removeEventListener('keydown', this.onKey, true); } catch { /* noop */ }
    try { this.root.remove(); } catch { /* noop */ }
  }

  /** Current selection from the profile (fresh on every render). */
  private current(): CosmeticSelection {
    try {
      const p = loadProfile();
      return p.cosmetics ?? defaultCosmetics();
    } catch {
      return defaultCosmetics();
    }
  }

  /** Persist a partial change, refresh the panel + preview + live avatar. */
  private applyChange(partial: Partial<CosmeticSelection>): void {
    try {
      const p = loadProfile();
      setCosmetics(p, partial);
      saveProfile(p);
    } catch { /* storage failure must not break the panel */ }
    const cur = this.current();
    this.renderSections();
    this.refreshPreviewRig(cur);
    try { this.opts.applyToLiveAvatar?.(cur); } catch { /* live apply is best-effort */ }
  }

  private sectionTitle(doc: Document, text: string): HTMLElement {
    return el(doc, 'div', `font-size:11px;font-weight:700;letter-spacing:0.18em;color:${GOLD}`, text);
  }

  private swatchButton(
    doc: Document, testid: string, bg: string, label: string, selected: boolean,
    onClick: () => void,
  ): HTMLElement {
    const b = el(doc, 'button', [
      'width:32px', 'height:32px', 'min-width:32px', 'min-height:32px',
      'border-radius:8px', 'cursor:pointer', 'padding:0',
      `background:${bg}`, selected ? `outline:2px solid ${GOLD};outline-offset:2px` : 'border:1px solid rgba(154,164,184,0.4)',
    ].join(';'));
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('data-testid', testid);
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    b.addEventListener('click', onClick);
    return b;
  }

  private textButton(
    doc: Document, testid: string, label: string, selected: boolean,
    onClick: () => void,
  ): HTMLElement {
    const b = el(doc, 'button', [
      'min-height:32px', 'padding:6px 12px', 'border-radius:8px', 'cursor:pointer',
      'font-family:inherit', 'font-size:13px',
      selected ? `background:${GOLD};color:#10131a;border:1px solid ${GOLD}` : 'background:rgba(255,255,255,0.06);color:#e8ecf4;border:1px solid rgba(154,164,184,0.4)',
    ].join(';'));
    b.textContent = label;
    b.setAttribute('data-testid', testid);
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    b.addEventListener('click', onClick);
    return b;
  }

  private renderSections(): void {
    const doc = this.opts.doc ?? globalThis.document;
    const cur = this.current();
    const wrap = this.sectionsEl;
    wrap.innerHTML = '';

    const row = (css: string) => el(doc, 'div', css);

    // VISOR
    const visorSec = row('display:flex;flex-direction:column;gap:8px');
    visorSec.appendChild(this.sectionTitle(doc, 'VISOR GLOW'));
    const visorRow = row('display:flex;flex-wrap:wrap;gap:8px;align-items:center');
    const visorDefault = this.textButton(doc, 'visor-default', 'Outfit default', cur.visor === null,
      () => this.applyChange({ visor: null }));
    visorRow.appendChild(visorDefault);
    for (const v of VISOR_COLORS) {
      visorRow.appendChild(this.swatchButton(doc, `visor-${v.id}`, v.hex, `Visor ${v.name}`,
        cur.visor === v.id, () => this.applyChange({ visor: v.id })));
    }
    visorSec.appendChild(visorRow);
    wrap.appendChild(visorSec);

    // OUTFIT
    const outfitSec = row('display:flex;flex-direction:column;gap:8px');
    outfitSec.appendChild(this.sectionTitle(doc, 'OUTFIT'));
    const outfitRow = row('display:flex;flex-wrap:wrap;gap:8px');
    outfitRow.appendChild(this.textButton(doc, 'outfit-default', 'Spec default', cur.outfit === null,
      () => this.applyChange({ outfit: null })));
    for (const id of OUTFIT_SKIN_IDS) {
      outfitRow.appendChild(this.textButton(doc, `outfit-${id}`, outfitName(id),
        cur.outfit === id, () => this.applyChange({ outfit: id })));
    }
    outfitSec.appendChild(outfitRow);
    wrap.appendChild(outfitSec);

    // ACCESSORIES
    const accSec = row('display:flex;flex-direction:column;gap:8px');
    accSec.appendChild(this.sectionTitle(doc, 'ACCESSORIES'));
    const accRow = row('display:flex;flex-wrap:wrap;gap:8px;align-items:center');
    accRow.appendChild(this.textButton(doc, 'acc-scarf', 'Scarf', cur.scarf,
      () => this.applyChange({ scarf: !cur.scarf })));
    accRow.appendChild(this.textButton(doc, 'acc-hood', 'Hood', cur.hood,
      () => this.applyChange({ hood: !cur.hood })));
    accSec.appendChild(accRow);
    accSec.appendChild(this.sectionTitle(doc, 'PAULDRON TRIM'));
    const trimRow = row('display:flex;flex-wrap:wrap;gap:8px;align-items:center');
    trimRow.appendChild(this.textButton(doc, 'trim-default', 'Outfit default', cur.trim === null,
      () => this.applyChange({ trim: null })));
    for (const t of TRIM_COLORS) {
      trimRow.appendChild(this.swatchButton(doc, `trim-${t.id}`, t.hex, `Trim ${t.name}`,
        cur.trim === t.id, () => this.applyChange({ trim: t.id })));
    }
    accSec.appendChild(trimRow);
    wrap.appendChild(accSec);
  }

  // ---- preview rig (existing voxel render path) ----

  private refreshPreviewRig(cur: CosmeticSelection): void {
    if (!this.scene || !this.pivot) return;
    try {
      if (this.rig) {
        try { this.rig.dispose?.(); } catch { /* noop */ }
        this.pivot.clear();
        this.rig = null;
      }
      const rig = this.opts.previewRig
        ? this.opts.previewRig()
        : (this.opts.mats ? makeHumanoid(this.opts.mats, {}, this.opts.seed ?? 1) as CharacterRig : null);
      if (!rig) return;
      applyCosmeticsToRig(rig, cur);
      this.pivot.add(rig.group);
      this.rig = rig;
      this.renderPreviewFrame();
    } catch { /* preview failure never breaks the panel */ }
  }

  private renderPreviewFrame(): void {
    if (!this.renderer || !this.scene || !this.camera || !this.pivot) return;
    try {
      this.pivot.rotation.y += 0.012;
      this.renderer.render(this.scene, this.camera);
    } catch { /* noop */ }
  }

  private startPreview(): void {
    const cur = this.current();
    if (this.renderer) {
      this.refreshPreviewRig(cur);
      this.alive = true;
      const tick = () => {
        if (!this.alive || !this.open_) return;
        this.renderPreviewFrame();
        this.raf = requestAnimationFrame(tick);
      };
      tick();
      return;
    }
    // First open: build the renderer (WebGL may be unavailable headless).
    try {
      const canvas = this.previewCanvas;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setSize(canvas.clientWidth || 300, 190, false);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
      const dir = new THREE.DirectionalLight(0xffffff, 1.5);
      dir.position.set(2, 4, 3);
      scene.add(dir);
      const pivot = new THREE.Group();
      scene.add(pivot);
      const cam = new THREE.PerspectiveCamera(40, (canvas.clientWidth || 300) / 190, 0.05, 100);
      cam.position.set(0, 0.72, 2.3);
      cam.lookAt(0, 0.55, 0);
      this.renderer = renderer;
      this.scene = scene;
      this.camera = cam;
      this.pivot = pivot;
      this.refreshPreviewRig(cur);
      this.alive = true;
      const tick = () => {
        if (!this.alive || !this.open_) return;
        this.renderPreviewFrame();
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // No WebGL here: hide the canvas, show the fallback note.
      try {
        this.previewCanvas.style.display = 'none';
        this.previewFallback.style.display = 'block';
      } catch { /* noop */ }
    }
  }

  private stopPreview(): void {
    this.alive = false;
    try { cancelAnimationFrame(this.raf); } catch { /* noop */ }
  }
}
