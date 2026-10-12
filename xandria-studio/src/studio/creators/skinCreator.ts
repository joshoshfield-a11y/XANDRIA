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
  VOXEL_ARMOR_SET_IDS,
} from '@spec';
import { makePatternTexture } from '../../engine/gfx/Skins';
import { SkinBuilder } from '../../engine/gfx/SkinBuilder';
import {
  applyVoxelArmor, clearVoxelArmor, VOXEL_ARMOR_SETS, pickVoxelArmorSetId,
  applyVoxelCape, clearVoxelCape, VOXEL_CAPE_VARIANTS,
  type VoxelCapeVariant,
} from '../../engine/gfx/VoxelArmor';
import type { CharacterRig } from '../../engine/gfx/Characters';

export interface SkinCreatorCtx {
  /** Current working spec (clone) or null — used for id-collision warnings. */
  getSpec(): GameSpec | null;
  /** Host adds the finished def to the spec under this id. */
  onAddToSpec?: (kind: 'character' | 'item', id: string, def: SkinDef | ItemSkinDef) => void;
  /**
   * Opt-in seeded auto-armor toggle (worker E): host writes the flag to
   * `custom.armor.auto`. The checkbox below also previews the seeded pick.
   */
  onAutoArmor?: (enabled: boolean) => void;
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

/**
 * Build a small humanoid mannequin with role-tagged owned materials.
 * Also returns minimal rig pivots (head/torso meshes double as their own
 * pivots, like the real CharacterRig; arms get group pivots) so the Studio
 * armor picker can mount real voxel armor pieces on the live preview via
 * applyVoxelArmor. Missing pivots (elbows/knees) skip their pieces silently.
 */
function buildCharacterMannequin(): {
  group: THREE.Group;
  roles: Map<string, THREE.MeshStandardMaterial[]>;
  limbs: { head: THREE.Object3D; torso: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D };
} {
  const group = new THREE.Group();
  const roles = new Map<string, THREE.MeshStandardMaterial[]>();
  const mat = (role: string, color: string) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
    m.userData.role = role;
    if (!roles.has(role)) roles.set(role, []);
    roles.get(role)!.push(m);
    return m;
  };
  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, role: string, color: string, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, mat(role, color));
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  // head (skin) — the mesh doubles as the head pivot
  const head = add(group, new THREE.SphereGeometry(0.16, 20, 16), 'skin', '#d9a066', 0, 1.62, 0);
  // torso (shirt) — the mesh doubles as the torso pivot
  const torso = add(group, new THREE.CapsuleGeometry(0.2, 0.34, 6, 12), 'shirt', '#3f5a78', 0, 1.18, 0);
  // arms: group pivots at the shoulders, capsule mesh as child
  const armL = new THREE.Group(); armL.position.set(-0.3, 1.18, 0); group.add(armL);
  const armR = new THREE.Group(); armR.position.set(0.3, 1.18, 0); group.add(armR);
  add(armL, new THREE.CapsuleGeometry(0.07, 0.3, 4, 8), 'shirt', '#3f5a78', 0, 0, 0);
  add(armR, new THREE.CapsuleGeometry(0.07, 0.3, 4, 8), 'shirt', '#3f5a78', 0, 0, 0);
  // legs (pants) — no knee pivots on the preview mannequin, greaves skip
  add(group, new THREE.CapsuleGeometry(0.09, 0.34, 4, 8), 'pants', '#2e2a26', -0.12, 0.62, 0);
  add(group, new THREE.CapsuleGeometry(0.09, 0.34, 4, 8), 'pants', '#2e2a26', 0.12, 0.62, 0);
  // accent: chest plate + shoulder pauldrons
  add(group, new THREE.BoxGeometry(0.24, 0.18, 0.06), 'accent', '#ffd23f', 0, 1.3, 0.18);
  add(group, new THREE.SphereGeometry(0.1, 12, 10), 'accent', '#ffd23f', -0.3, 1.42, 0);
  add(group, new THREE.SphereGeometry(0.1, 12, 10), 'accent', '#ffd23f', 0.3, 1.42, 0);
  return { group, roles, limbs: { head, torso, armL, armR } };
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

  // ---- voxel armor set picker (character target only) — sits next to the
  // skin palette/pattern pickers; the choice lands in the exported SkinDef
  // (`armor` + optional `visor` override) and applySkin renders it on the rig.
  let armorSet = '';
  let visorIntensity = 2.2;
  let visorTouched = false; // only an explicit visor tweak becomes a def override
  // worker E: opt-in seeded auto-armor flag mirror — skins with no explicit
  // armor get a deterministic set from the spec seed (custom.armor.auto)
  let autoArmor = ctx.getSpec()?.custom?.armor?.auto === true;
  const armorBox = h(`<div></div>`);
  const armorRow = h(`<div style="display:flex;align-items:center;gap:8px;margin:6px 0"></div>`);
  armorRow.append(h(`<span style="width:80px;font-size:11px;opacity:.8">ARMOR SET</span>`));
  const armorSelect = document.createElement('select');
  armorSelect.style.flex = '1';
  {
    const none = document.createElement('option');
    none.value = ''; none.textContent = '(no armor — procedural look)';
    armorSelect.appendChild(none);
    for (const id of VOXEL_ARMOR_SET_IDS) {
      const o = document.createElement('option');
      o.value = id; o.textContent = `${VOXEL_ARMOR_SETS[id]?.name ?? id} (${id})`;
      armorSelect.appendChild(o);
    }
  }
  const diceBtn = h(`<button class="xed-iconbtn" title="Pick an armor set deterministically from the working spec's seed — same seed, same set.">🎲</button>`) as HTMLButtonElement;
  armorRow.append(armorSelect, diceBtn);
  armorBox.appendChild(armorRow);
  // ---- standalone voxel cape picker (follow-up wave A, preview-only): variant
  // select sits under the armor set; the cape is NOT part of the exported
  // SkinDef (armor sets are) — it previews the seeded cloth piece on the
  // mannequin. Variant geometry is seeded from the working spec's seed.
  let capeVariant: VoxelCapeVariant | '' = '';
  const capeRow = h(`<div style="display:flex;align-items:center;gap:8px;margin:6px 0"></div>`);
  capeRow.append(h(`<span style="width:80px;font-size:11px;opacity:.8">CAPE</span>`));
  const capeSelect = document.createElement('select');
  capeSelect.style.flex = '1';
  capeSelect.title = 'Standalone voxel cape piece (preview only — not exported into the skin)';
  {
    const none = document.createElement('option');
    none.value = ''; none.textContent = '(no cape)';
    capeSelect.appendChild(none);
    for (const v of VOXEL_CAPE_VARIANTS) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      capeSelect.appendChild(o);
    }
  }
  capeRow.append(capeSelect);
  armorBox.appendChild(capeRow);
  capeSelect.addEventListener('change', () => { capeVariant = capeSelect.value as VoxelCapeVariant | ''; applyLiveArmor(); });
  const visorRow = h(`<div style="display:flex;align-items:center;gap:8px;margin:6px 0"></div>`);
  const visorColorEl = document.createElement('input');
  visorColorEl.type = 'color'; visorColorEl.value = '#ffd23f';
  visorColorEl.title = 'Emissive visor slit color on the armor helm (overrides the set default)';
  const visorIntInput = document.createElement('input');
  visorIntInput.type = 'range'; visorIntInput.min = '0'; visorIntInput.max = '5';
  visorIntInput.step = '0.1'; visorIntInput.value = String(visorIntensity);
  visorIntInput.style.flex = '1';
  const visorIntVal = h(`<span class="xed-sliderval">${visorIntensity}</span>`);
  visorRow.append(
    h(`<span style="width:80px;font-size:11px;opacity:.8">VISOR</span>`),
    visorColorEl,
    h(`<span style="font-size:11px;opacity:.8">GLOW</span>`),
    visorIntInput, visorIntVal,
  );
  armorBox.appendChild(visorRow);
  // worker E: opt-in seeded auto-armor toggle — writes custom.armor.auto via
  // the host and previews the seeded pick on the mannequin when no explicit
  // set is chosen (explicit choice always wins, same as applySkin)
  const autoRow = h(`<div style="display:flex;align-items:center;gap:8px;margin:6px 0"></div>`);
  const autoCheck = document.createElement('input');
  autoCheck.type = 'checkbox';
  autoCheck.checked = autoArmor;
  autoCheck.title = 'When on, skins with no explicit armor set get one picked deterministically from the spec seed (writes custom.armor.auto). Off by default — legacy skins stay armor-free.';
  autoRow.append(autoCheck, h(`<span style="font-size:11px;opacity:.8">AUTO (SEEDED) armor — no explicit set → deterministic pick from seed</span>`));
  armorBox.appendChild(autoRow);
  autoCheck.addEventListener('change', () => {
    autoArmor = autoCheck.checked;
    try { ctx.onAutoArmor?.(autoArmor); } catch { /* host wiring is optional */ }
    applyLiveArmor();
  });
  armorBox.appendChild(h(`<div class="xed-hint">Armor renders on the live preview below (helm, chest plate, belt, pauldrons, scarf/hood — greaves need a full rig). The exported skin carries the set + visor; applySkin renders it on player and enemies.</div>`));
  root.appendChild(armorBox);

  /** Sync the visor pickers to the chosen set's default slit, then re-mount armor on the preview. */
  function onArmorChange(): void {
    visorTouched = false;
    const def = armorSet ? VOXEL_ARMOR_SETS[armorSet] : undefined;
    if (def) {
      visorColorEl.value = def.visor.color;
      visorIntensity = def.visor.intensity;
      visorIntInput.value = String(visorIntensity);
      visorIntVal.textContent = String(visorIntensity);
    }
    applyLiveArmor();
  }
  armorSelect.addEventListener('change', () => { armorSet = armorSelect.value; onArmorChange(); });
  diceBtn.addEventListener('click', () => {
    const seed = ctx.getSpec()?.meta?.seed ?? 1;
    armorSelect.value = pickVoxelArmorSetId(seed);
    armorSet = armorSelect.value;
    onArmorChange();
  });
  visorColorEl.addEventListener('input', () => { visorTouched = true; applyLiveArmor(); });
  visorIntInput.addEventListener('input', () => {
    visorIntensity = parseFloat(visorIntInput.value);
    visorIntVal.textContent = String(visorIntensity);
    visorTouched = true; applyLiveArmor();
  });
  const syncArmorVisibility = (): void => {
    armorBox.style.display = target === 'character' ? '' : 'none';
  };

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
  /** minimal rig view over the character mannequin — armor mounts here for the live preview */
  let armorRig: CharacterRig | null = null;
  let raf = 0;

  /** Mount (or clear) the chosen armor set + standalone cape on the preview mannequin. Preview-only, never blocks. */
  function applyLiveArmor(): void {
    if (!armorRig) return;
    try {
      clearVoxelArmor(armorRig);
      clearVoxelCape(armorRig);
      if (target !== 'character') return;
      // worker E: when no explicit set is chosen and AUTO (SEEDED) is on,
      // preview the deterministic seeded pick (set default visor)
      let effSet = armorSet;
      let vColor = visorColorEl.value;
      let vInt = visorIntensity;
      if (!effSet && autoArmor) {
        effSet = pickVoxelArmorSetId(ctx.getSpec()?.meta?.seed ?? 1);
        const def = VOXEL_ARMOR_SETS[effSet];
        if (def) { vColor = def.visor.color; vInt = def.visor.intensity; }
      }
      if (effSet && HEX_RE.test(vColor)) {
        applyVoxelArmor(armorRig, effSet, {
          visorColor: vColor,
          visorIntensity: THREE.MathUtils.clamp(vInt, 0, 5),
          origin: 'skin',
        });
      }
      if (target === 'character' && capeVariant) {
        // seeded from the working spec's seed — same seed, same cape variant
        applyVoxelCape(armorRig, { variant: capeVariant, seed: ctx.getSpec()?.meta?.seed ?? 1, origin: 'skin' });
      }
    } catch { /* preview-only, never blocks */ }
  }

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
      if (target === 'character') {
        const m = buildCharacterMannequin();
        roleMats = m.roles;
        pivot.add(m.group);
        armorRig = { group: pivot, limbs: m.limbs } as unknown as CharacterRig;
      } else {
        const m = buildItemMannequin();
        roleMats = m.roles;
        pivot.add(m.group);
        armorRig = null;
      }
      scene.add(pivot);
      const tick = (): void => {
        if (disposed || !canvas.isConnected) { disposePreview(); return; }
        pivot!.rotation.y += 0.014;
        renderer!.render(scene!, cam);
        raf = requestAnimationFrame(tick);
      };
      tick();
      applyLive();
      applyLiveArmor();
    } catch {
      // Preview is decorative — the form still works without WebGL.
      const note = h(`<div class="xed-hint">3D preview unavailable in this browser — the JSON below is still exact.</div>`);
      canvas.replaceWith(note);
    }
  }

  function disposePreview(): void {
    cancelAnimationFrame(raf);
    try { if (armorRig) { clearVoxelArmor(armorRig); clearVoxelCape(armorRig); } } catch { /* preview-only */ }
    armorRig = null;
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
    buildPickers(); syncArmorVisibility(); buildPreview();
  });
  tItem.addEventListener('click', () => {
    if (target === 'item') return;
    target = 'item';
    tItem.classList.add('active'); tChar.classList.remove('active');
    buildPickers(); syncArmorVisibility(); buildPreview();
  });
  tChar.classList.add('active');
  buildPickers();
  syncArmorVisibility();
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
      if (armorSet) {
        b.armor(armorSet);
        if (visorTouched && HEX_RE.test(visorColorEl.value)) {
          b.visor(visorColorEl.value, THREE.MathUtils.clamp(visorIntensity, 0, 5));
        }
      }
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
