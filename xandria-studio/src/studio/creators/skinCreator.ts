/**
 * skinCreator — visual skin creator for basic users: color pickers per
 * palette role, pattern select, emissive/roughness/metalness sliders, and a
 * LIVE 3D turntable preview of a locally-built preview mannequin.
 *
 * The preview mannequin is built in THIS file (simple role-tagged meshes);
 * it deliberately does NOT depend on other crews' in-progress modules.
 * Skin application here mirrors `applySkin` semantics (Skins.ts):
 * palette → per-role colors, roughness/metalness → all owned materials,
 * emissive → accent (character) / glow (item) roles, pattern → named canvas
 * texture on textureRoles (default shirt+pants / primary).
 *
 * Target toggle: character skins (SkinDef, roles skin|shirt|pants|accent)
 * or item skins (ItemSkinDef, roles primary|secondary|glow). The def is
 * produced through SkinBuilder so the visual and code-first paths agree
 * bit-for-bit.
 *
 * Export: download JSON, copy-to-clipboard, and "add to spec" via callback.
 *
 * Mount contract:
 *   mountSkinCreator(container, { getSpec, onAddToSpec? }) → { dispose() }
 *   onAddToSpec(kind: 'character'|'item', id, def) — host wires this to the
 *   working spec (editorPanel commits to custom.characters.skins /
 *   custom.items.skins).
 */
import * as THREE from 'three';
import {
  type GameSpec, type SkinDef, type ItemSkinDef,
  SKIN_TEXTURE_PATTERNS, type SkinTexturePattern,
} from '@spec';
import { makePatternTexture } from '../../engine/gfx/Skins';
import { SkinBuilder } from '../../engine/gfx/SkinBuilder';

export interface SkinCreatorCtx {
  /** Current working spec (clone) or null — used for id-collision warnings. */
  getSpec(): GameSpec | null;
  /** Host adds the finished def to the spec under this id. */
  onAddToSpec?: (kind: 'character' | 'item', id: string, def: SkinDef | ItemSkinDef) => void;
}

export interface SkinCreatorHandle {
  dispose(): void;
}

const CHAR_ROLES = ['skin', 'shirt', 'pants', 'accent'] as const;
const ITEM_ROLES = ['primary', 'secondary', 'glow'] as const;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const h = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

/** Build a small humanoid mannequin with role-tagged owned materials. */
function buildCharacterMannequin(): { group: THREE.Group; roles: Map<string, THREE.MeshStandardMaterial[]> } {
  const group = new THREE.Group();
  const roles = new Map<string, THREE.MeshStandardMaterial[]>();
  const mat = (role: string, color: string) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
    m.userData.role = role;
    if (!roles.has(role)) roles.set(role, []);
    roles.get(role)!.push(m);
    return m;
  };
  const add = (geo: THREE.BufferGeometry, role: string, color: string, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, mat(role, color));
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  // head (skin) + helmet-less face
  add(new THREE.SphereGeometry(0.16, 20, 16), 'skin', '#d9a066', 0, 1.62, 0);
  // torso (shirt), arms (shirt)
  add(new THREE.CapsuleGeometry(0.2, 0.34, 6, 12), 'shirt', '#3f5a78', 0, 1.18, 0);
  add(new THREE.CapsuleGeometry(0.07, 0.3, 4, 8), 'shirt', '#3f5a78', -0.3, 1.18, 0);
  add(new THREE.CapsuleGeometry(0.07, 0.3, 4, 8), 'shirt', '#3f5a78', 0.3, 1.18, 0);
  // legs (pants)
  add(new THREE.CapsuleGeometry(0.09, 0.34, 4, 8), 'pants', '#2e2a26', -0.12, 0.62, 0);
  add(new THREE.CapsuleGeometry(0.09, 0.34, 4, 8), 'pants', '#2e2a26', 0.12, 0.62, 0);
  // accent: chest plate + shoulder pauldrons
  add(new THREE.BoxGeometry(0.24, 0.18, 0.06), 'accent', '#ffd23f', 0, 1.3, 0.18);
  add(new THREE.SphereGeometry(0.1, 12, 10), 'accent', '#ffd23f', -0.3, 1.42, 0);
  add(new THREE.SphereGeometry(0.1, 12, 10), 'accent', '#ffd23f', 0.3, 1.42, 0);
  return { group, roles };
}

/** Build a stylized sword mannequin with role-tagged owned materials. */
function buildItemMannequin(): { group: THREE.Group; roles: Map<string, THREE.MeshStandardMaterial[]> } {
  const group = new THREE.Group();
  const roles = new Map<string, THREE.MeshStandardMaterial[]>();
  const mat = (role: string, color: string) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.4 });
    m.userData.role = role;
    if (!roles.has(role)) roles.set(role, []);
    roles.get(role)!.push(m);
    return m;
  };
  const add = (geo: THREE.BufferGeometry, role: string, color: string, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, mat(role, color));
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  // blade (primary)
  add(new THREE.BoxGeometry(0.1, 1.0, 0.03), 'primary', '#9aa4b0', 0, 0.95, 0);
  add(new THREE.ConeGeometry(0.07, 0.18, 4), 'primary', '#9aa4b0', 0, 1.54, 0);
  // guard + grip (secondary)
  add(new THREE.BoxGeometry(0.36, 0.06, 0.06), 'secondary', '#5a3a22', 0, 0.42, 0);
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 10), 'secondary', '#5a3a22', 0, 0.24, 0);
  // pommel gem + guard runes (glow)
  add(new THREE.SphereGeometry(0.06, 12, 10), 'glow', '#ff7700', 0, 0.06, 0);
  add(new THREE.SphereGeometry(0.045, 10, 8), 'glow', '#ff7700', -0.14, 0.42, 0.035);
  add(new THREE.SphereGeometry(0.045, 10, 8), 'glow', '#ff7700', 0.14, 0.42, 0.035);
  return { group, roles };
}

export function mountSkinCreator(container: HTMLElement, ctx: SkinCreatorCtx): SkinCreatorHandle {
  let disposed = false;

  const root = h(`<div class="xed-asset"><div class="xed-aname">SKIN CREATOR</div></div>`);
  const hint = h(`<div class="xed-hint">Paint a character skin or an item skin, watch it spin, then download the JSON or drop it straight into your spec.</div>`);
  root.appendChild(hint);

  // ---- target toggle
  let target: 'character' | 'item' = 'character';
  const toggleRow = h(`<div style="display:flex;gap:6px;margin:8px 0"></div>`);
  const tChar = h(`<button class="xed-iconbtn">CHARACTER</button>`) as HTMLButtonElement;
  const tItem = h(`<button class="xed-iconbtn">ITEM</button>`) as HTMLButtonElement;
  toggleRow.append(tChar, tItem);
  root.appendChild(toggleRow);

  // ---- id + name
  const idInput = document.createElement('input');
  idInput.type = 'text'; idInput.placeholder = 'ember'; idInput.value = 'ember';
  idInput.style.width = '120px';
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.placeholder = 'Ember Warden'; nameInput.value = 'Ember Warden';
  nameInput.style.flex = '1';
  const idRow = h(`<div style="display:flex;gap:6px;margin-bottom:8px"></div>`);
  idRow.append(idInput, nameInput);
  root.appendChild(idRow);

  // ---- palette pickers (rebuilt on target toggle)
  const paletteBox = h(`<div></div>`);
  root.appendChild(paletteBox);
  const palette: Record<string, string> = {};
  const pickers: Record<string, HTMLInputElement> = {};
  const defaultPalette = (): Record<string, string> =>
    target === 'character'
      ? { skin: '#d9a066', shirt: '#3f5a78', pants: '#2e2a26', accent: '#ffd23f' }
      : { primary: '#9aa4b0', secondary: '#5a3a22', glow: '#ff7700' };
  function buildPickers(): void {
    paletteBox.innerHTML = '';
    for (const k of Object.keys(pickers)) delete pickers[k];
    Object.assign(palette, defaultPalette());
    const roles = target === 'character' ? CHAR_ROLES : ITEM_ROLES;
    for (const role of roles) {
      const row = h(`<div style="display:flex;align-items:center;gap:8px;margin:4px 0"></div>`);
      const label = h(`<span style="width:80px;font-size:11px;opacity:.8">${role.toUpperCase()}</span>`);
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = palette[role] ?? '#888888';
      picker.addEventListener('input', () => { palette[role] = picker.value; applyLive(); });
      pickers[role] = picker;
      row.append(label, picker);
      paletteBox.appendChild(row);
    }
  }

  // ---- pattern select + texture roles
  const patternSelect = document.createElement('select');
  {
    const none = document.createElement('option');
    none.value = ''; none.textContent = '(no pattern)';
    patternSelect.appendChild(none);
    for (const p of SKIN_TEXTURE_PATTERNS) {
      const o = document.createElement('option');
      o.value = p; o.textContent = p;
      patternSelect.appendChild(o);
    }
  }
  const patternRow = h(`<div style="display:flex;align-items:center;gap:8px;margin:6px 0"></div>`);
  patternRow.append(h(`<span style="width:80px;font-size:11px;opacity:.8">PATTERN</span>`), patternSelect);
  root.appendChild(patternRow);
  patternSelect.addEventListener('change', () => applyLive());

  // ---- emissive / roughness / metalness
  const emisColor = document.createElement('input');
  emisColor.type = 'color'; emisColor.value = '#ff7700';
  const slider = (
    label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void,
  ): HTMLElement => {
    const wrap = h(`<div class="xed-sliderow"></div>`);
    const lab = h(`<span style="width:110px;font-size:11px;opacity:.8">${label}</span>`);
    const i = document.createElement('input');
    i.type = 'range'; i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(value);
    i.style.flex = '1';
    const val = h(`<span class="xed-sliderval">${value}</span>`);
    i.addEventListener('input', () => {
      const v = parseFloat(i.value);
      val.textContent = String(v);
      onInput(v);
    });
    wrap.append(lab, i, val);
    root.appendChild(wrap);
    return wrap;
  };
  const emisRow = h(`<div style="display:flex;align-items:center;gap:8px;margin:6px 0"></div>`);
  emisRow.append(h(`<span style="width:80px;font-size:11px;opacity:.8">EMISSIVE</span>`), emisColor);
  root.appendChild(emisRow);
  let emisIntensity = 1.2;
  let roughness = 0.6;
  let metalness = 0.2;
  emisColor.addEventListener('input', () => applyLive());
  slider('EMISSIVE INTENSITY', 0, 5, 0.1, emisIntensity, (v) => { emisIntensity = v; applyLive(); });
  slider('ROUGHNESS', 0, 1, 0.05, roughness, (v) => { roughness = v; applyLive(); });
  slider('METALNESS', 0, 1, 0.05, metalness, (v) => { metalness = v; applyLive(); });

  // ---- live 3D turntable (dedicated small renderer)
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:220px;border-radius:8px;background:#0a0e16;display:block;margin:8px 0';
  root.appendChild(canvas);

  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let pivot: THREE.Group | null = null;
  let roleMats: Map<string, THREE.MeshStandardMaterial[]> = new Map();
  let raf = 0;

  function buildPreview(): void {
    disposePreview();
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(canvas.clientWidth || 260, 220, false);
      scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xdfeaff, 0x1a2030, 1.1));
      const dir = new THREE.DirectionalLight(0xffffff, 1.6);
      dir.position.set(2, 4, 3);
      scene.add(dir);
      const cam = new THREE.PerspectiveCamera(38, (canvas.clientWidth || 260) / 220, 0.1, 50);
      cam.position.set(0, 1.05, 3.2);
      cam.lookAt(0, 1.0, 0);
      pivot = new THREE.Group();
      const { group, roles } = target === 'character' ? buildCharacterMannequin() : buildItemMannequin();
      roleMats = roles;
      pivot.add(group);
      scene.add(pivot);
      const tick = (): void => {
        if (disposed || !canvas.isConnected) { disposePreview(); return; }
        pivot!.rotation.y += 0.014;
        renderer!.render(scene!, cam);
        raf = requestAnimationFrame(tick);
      };
      tick();
      applyLive();
    } catch {
      // Preview is decorative — the form still works without WebGL.
      const note = h(`<div class="xed-hint">3D preview unavailable in this browser — the JSON below is still exact.</div>`);
      canvas.replaceWith(note);
    }
  }

  function disposePreview(): void {
    cancelAnimationFrame(raf);
    renderer?.dispose();
    renderer = null; scene = null; pivot = null;
  }

  /** Mirror of applySkin semantics for the local mannequin. */
  function applyLive(): void {
    if (!roleMats.size) return;
    try {
      for (const [role, hex] of Object.entries(palette)) {
        if (!HEX_RE.test(hex)) continue;
        for (const m of roleMats.get(role) ?? []) m.color.set(hex);
      }
      for (const mats of roleMats.values()) for (const m of mats) {
        m.roughness = THREE.MathUtils.clamp(roughness, 0, 1);
        m.metalness = THREE.MathUtils.clamp(metalness, 0, 1);
      }
      const glowRoles = target === 'character' ? ['accent'] : ['glow'];
      const ec = emisColor.value;
      for (const m of glowRoles.flatMap((r) => roleMats.get(r) ?? [])) {
        if (HEX_RE.test(ec)) { m.emissive.set(ec); m.emissiveIntensity = emisIntensity; }
      }
      const pattern = patternSelect.value as SkinTexturePattern | '';
      const texRoles = target === 'character' ? ['shirt', 'pants'] : ['primary'];
      const tex = pattern ? makePatternTexture(pattern) : null;
      for (const mats of roleMats.values()) for (const m of mats) m.map = null;
      if (tex) {
        for (const m of texRoles.flatMap((r) => roleMats.get(r) ?? [])) { m.map = tex; m.needsUpdate = true; }
      } else {
        for (const mats of roleMats.values()) for (const m of mats) m.needsUpdate = true;
      }
    } catch { /* preview-only, never blocks */ }
  }

  tChar.addEventListener('click', () => {
    if (target === 'character') return;
    target = 'character';
    tChar.classList.add('active'); tItem.classList.remove('active');
    buildPickers(); buildPreview();
  });
  tItem.addEventListener('click', () => {
    if (target === 'item') return;
    target = 'item';
    tItem.classList.add('active'); tChar.classList.remove('active');
    buildPickers(); buildPreview();
  });
  tChar.classList.add('active');
  buildPickers();
  buildPreview();

  // ---- build def through the builder (visual path == code-first path)
  function buildDef(): { id: string; def: SkinDef | ItemSkinDef; errors: string[] } {
    const id = idInput.value.trim() || 'custom-skin';
    const name = nameInput.value.trim() || id;
    const pattern = patternSelect.value as SkinTexturePattern | '';
    if (target === 'character') {
      const b = new SkinBuilder(id)
        .displayName(name)
        .palette({
          ...(palette.skin ? { skin: palette.skin } : {}),
          ...(palette.shirt ? { shirt: palette.shirt } : {}),
          ...(palette.pants ? { pants: palette.pants } : {}),
          ...(palette.accent ? { accent: palette.accent } : {}),
        })
        .emissive(emisColor.value, emisIntensity)
        .roughness(roughness)
        .metalness(metalness);
      if (pattern) b.pattern(pattern);
      const def = b.build();
      return { id, def, errors: b.validate() };
    }
    const b = new SkinBuilder(id).displayName(name).forItem()
      .palette({
        ...(palette.primary ? { primary: palette.primary } : {}),
        ...(palette.secondary ? { secondary: palette.secondary } : {}),
        ...(palette.glow ? { glow: palette.glow } : {}),
      })
      .emissive(emisColor.value, emisIntensity)
      .roughness(roughness)
      .metalness(metalness);
    if (pattern) b.pattern(pattern);
    const def = b.build();
    return { id, def, errors: b.validate() };
  }

  // ---- errors + export buttons
  const errBox = h(`<div class="xed-errors"></div>`);
  root.appendChild(errBox);
  const msgBox = h(`<div class="xed-hint"></div>`);
  root.appendChild(msgBox);

  function showErrors(errors: string[]): boolean {
    if (errors.length) {
      errBox.innerHTML = errors.map((e) => `<div class="xed-err">${e}</div>`).join('');
      errBox.classList.add('show');
      return false;
    }
    errBox.classList.remove('show');
    errBox.innerHTML = '';
    return true;
  }

  const btnRow = h(`<div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0"></div>`);
  const dlBtn = h(`<button class="xed-iconbtn">⬇ DOWNLOAD JSON</button>`) as HTMLButtonElement;
  const copyBtn = h(`<button class="xed-iconbtn">⧉ COPY</button>`) as HTMLButtonElement;
  const addBtn = h(`<button class="xed-iconbtn">➕ ADD TO SPEC</button>`) as HTMLButtonElement;
  btnRow.append(dlBtn, copyBtn, addBtn);
  root.appendChild(btnRow);

  dlBtn.addEventListener('click', () => {
    const { id, def, errors } = buildDef();
    if (!showErrors(errors)) return;
    const blob = new Blob([JSON.stringify({ [id]: def }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${id}.skin.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    msgBox.textContent = `downloaded ${id}.skin.json`;
  });
  copyBtn.addEventListener('click', () => {
    const { id, def, errors } = buildDef();
    if (!showErrors(errors)) return;
    const text = JSON.stringify({ [id]: def }, null, 2);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => { msgBox.textContent = 'copied to clipboard'; },
        () => { msgBox.textContent = 'copy failed — use DOWNLOAD JSON instead'; },
      );
    } else {
      msgBox.textContent = 'clipboard unavailable — use DOWNLOAD JSON instead';
    }
  });
  addBtn.addEventListener('click', () => {
    const { id, def, errors } = buildDef();
    if (!showErrors(errors)) return;
    if (!ctx.onAddToSpec) { msgBox.textContent = 'not connected to a spec (standalone mode)'; return; }
    // Id-collision warning, not a block — custom skins merge over built-ins.
    const s = ctx.getSpec();
    const existing = target === 'character' ? s?.custom?.characters?.skins : s?.custom?.items?.skins;
    const note = existing && id in existing ? ` (overwrites existing "${id}")` : '';
    ctx.onAddToSpec(target, id, def);
    msgBox.textContent = `added "${id}" to spec${note}`;
  });

  container.appendChild(root);
  return {
    dispose() {
      disposed = true;
      disposePreview();
    },
  };
}
