/**
 * itemEditor — visual item editor for basic users: a form for every
 * ItemDef field (name/type/slot/rarity/stats/behavior/stack/value/
 * description), a skin-id field with validation, a model URL field with a
 * Supabase upload button, and a simple mesh preview STUB (rarity-colored
 * box + label).
 *
 * SWAP POINT for the deluxe forge (crew B): replace `buildPreviewStub`
 * below with a real mesh renderer — everything else (form → ItemBuilder →
 * def → onAddToSpec/onPlaceInWorld) stays untouched. The deluxe forge should
 * accept (canvas, def: ItemDef) and return { dispose(): void }.
 *
 * Mount contract:
 *   mountItemEditor(container, { onAddToSpec?, onPlaceInWorld? }) → { dispose() }
 *   onAddToSpec(id, def)      — host commits def to custom.items.defs[id]
 *   onPlaceInWorld({ item, pos, count? }) — host pushes to custom.items.loot
 */
import {
  ITEM_TYPES, EQUIP_SLOTS, ITEM_RARITIES, ITEM_STAT_KEYS,
  type ItemDef, type ItemType, type EquipSlot, type ItemRarity, type ItemStatKey,
} from '@spec';
import { ItemBuilder } from '../../engine/game/items/ItemBuilder';
import { attachUploadButton } from '../uploadUI';

export interface LootSpot {
  item: string;
  pos: [number, number, number];
  count?: number;
}

export interface ItemEditorCtx {
  /** Host adds the finished def to the spec (custom.items.defs[id]). */
  onAddToSpec?: (id: string, def: ItemDef) => void;
  /** Host appends a loot placement to custom.items.loot. */
  onPlaceInWorld?: (spot: LootSpot) => void;
}

export interface ItemEditorHandle {
  dispose(): void;
}

const h = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const RARITY_COLORS: Record<ItemRarity, string> = {
  common: '#9aa4b0', uncommon: '#35c759', rare: '#35a0ff', epic: '#b44dff', legendary: '#ff9a2e',
};

const HEX_ID_RE = /^[a-z0-9_-]+$/;

/**
 * Simple mesh preview stub: a rarity-colored box + the item name label.
 * SWAP POINT — the deluxe item forge replaces this function. Keep the
 * signature (canvas, def) → { dispose(): void } so the swap is one line.
 */
function buildPreviewStub(canvas: HTMLCanvasElement, def: ItemDef): { dispose(): void } {
  let disposed = false;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dispose() { disposed = true; } };
  const W = (canvas.width = 260);
  const H = (canvas.height = 140);
  const color = RARITY_COLORS[def.rarity ?? 'common'];
  let t = 0;
  let raf = 0;
  const tick = (): void => {
    if (disposed || !canvas.isConnected) return;
    t += 0.03;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0e16';
    ctx.fillRect(0, 0, W, H);
    // bobbing rarity-colored box with a soft glow
    const bob = Math.sin(t) * 6;
    const cx = W / 2, cy = H / 2 - 12 + bob;
    ctx.shadowColor = color; ctx.shadowBlur = 18;
    ctx.fillStyle = color;
    const s = 44;
    ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#0a0e16'; ctx.lineWidth = 3;
    ctx.strokeRect(cx - s / 2, cy - s / 2, s, s);
    // label
    ctx.fillStyle = '#dfe6f5';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(def.name || '(unnamed)', cx, H - 26);
    ctx.fillStyle = '#7a8aa8';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`${def.type}${def.rarity ? ` · ${def.rarity}` : ''}`, cx, H - 12);
    raf = requestAnimationFrame(tick);
  };
  tick();
  return { dispose() { disposed = true; cancelAnimationFrame(raf); } };
}

export function mountItemEditor(container: HTMLElement, ctx: ItemEditorCtx): ItemEditorHandle {
  let disposed = false;
  let preview: { dispose(): void } | null = null;

  const root = h(`<div class="xed-asset"><div class="xed-aname">ITEM EDITOR</div></div>`);
  root.appendChild(h(`<div class="xed-hint">Author an item definition, sanity-check it, and either drop it into the spec or place it in the world as loot.</div>`));

  const field = (label: string, control: HTMLElement, hint?: string): HTMLElement => {
    const f = h(`<div class="xed-field"><div class="xed-flabel">${label}</div></div>`);
    f.appendChild(control);
    if (hint) f.appendChild(h(`<div class="xed-hint">${hint}</div>`));
    return f;
  };
  const select = (options: readonly string[], value: string): HTMLSelectElement => {
    const s = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o; opt.selected = o === value;
      s.appendChild(opt);
    }
    return s;
  };

  const idInput = document.createElement('input');
  idInput.type = 'text'; idInput.value = 'ember_blade'; idInput.placeholder = 'ember_blade';
  root.appendChild(field('ITEM ID', idInput, 'lowercase letters, digits, _ and - (used in custom.items.defs)'));

  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.value = 'Ember Blade'; nameInput.placeholder = 'Ember Blade';
  root.appendChild(field('NAME', nameInput));

  const typeSel = select(ITEM_TYPES, 'weapon');
  const slotSel = select(['', ...EQUIP_SLOTS], 'weapon');
  const typeRow = h(`<div style="display:flex;gap:6px"></div>`);
  const typeWrap = field('TYPE', typeSel);
  const slotWrap = field('EQUIP SLOT', slotSel, 'required for weapon/armor');
  typeRow.append(typeWrap, slotWrap);
  root.appendChild(typeRow);

  const raritySel = select(ITEM_RARITIES, 'rare');
  root.appendChild(field('RARITY', raritySel, 'drives the world-item glow color'));

  // stats
  const statsBox = h(`<div></div>`);
  const statInputs: Partial<Record<ItemStatKey, HTMLInputElement>> = {};
  const statsRow = h(`<div class="xed-flabel">STATS (equip bonuses, additive)</div>`);
  root.appendChild(statsRow);
  for (const key of ITEM_STAT_KEYS) {
    const row = h(`<div style="display:flex;align-items:center;gap:8px;margin:3px 0"></div>`);
    const lab = h(`<span style="width:90px;font-size:11px;opacity:.8">${key}</span>`);
    const i = document.createElement('input');
    i.type = 'number'; i.placeholder = '0'; i.step = '1'; i.style.width = '80px';
    i.addEventListener('input', () => refreshPreview());
    statInputs[key] = i;
    row.append(lab, i);
    statsBox.appendChild(row);
  }
  root.appendChild(statsBox);

  // behavior
  const behSel = select(['(none)', 'heal', 'restore', 'buff'], '(none)');
  const behAmt = document.createElement('input');
  behAmt.type = 'number'; behAmt.placeholder = 'amount'; behAmt.style.width = '80px';
  const behDur = document.createElement('input');
  behDur.type = 'number'; behDur.placeholder = 'secs'; behDur.style.width = '80px';
  const behRow = h(`<div style="display:flex;gap:6px;align-items:end"></div>`);
  behRow.append(field('USE EFFECT', behSel), field('AMOUNT', behAmt), field('DURATION', behDur));
  root.appendChild(behRow);

  // stack / value / description
  const stackInput = document.createElement('input');
  stackInput.type = 'number'; stackInput.value = '1'; stackInput.min = '1'; stackInput.max = '999';
  const valueInput = document.createElement('input');
  valueInput.type = 'number'; valueInput.value = '0'; valueInput.min = '0';
  const numRow = h(`<div style="display:flex;gap:6px"></div>`);
  numRow.append(field('STACK SIZE', stackInput, '1..999'), field('VALUE (coins)', valueInput));
  root.appendChild(numRow);
  const descInput = document.createElement('textarea');
  descInput.rows = 2; descInput.maxLength = 280;
  descInput.placeholder = 'Flavor text (≤ 280 chars)';
  root.appendChild(field('DESCRIPTION', descInput));

  // skin id + validate
  const skinRow = h(`<div style="display:flex;gap:6px;align-items:end"></div>`);
  const skinInput = document.createElement('input');
  skinInput.type = 'text'; skinInput.placeholder = 'ember (optional)';
  const skinCheck = h(`<button class="xed-iconbtn">CHECK</button>`) as HTMLButtonElement;
  skinRow.append(field('SKIN ID', skinInput, 'item-skin id (built-in or custom.items.skins)'), skinCheck);
  root.appendChild(skinRow);

  // model url + upload
  const modelInput = document.createElement('input');
  modelInput.type = 'text'; modelInput.placeholder = 'https://…/sword.glb';
  root.appendChild(field('MODEL URL (.glb/.gltf, https)', modelInput,
    'Empty = procedural mesh. Use ⬆ UPLOAD to push a file to Supabase Storage.'));

  // preview stub
  const previewLabel = h(`<div class="xed-flabel" style="margin-top:8px">MESH PREVIEW (stub)</div>`);
  root.appendChild(previewLabel);
  const previewCanvas = document.createElement('canvas');
  previewCanvas.style.cssText = 'width:100%;height:140px;border-radius:8px;display:block';
  root.appendChild(previewCanvas);
  root.appendChild(h(`<div class="xed-hint">Stub preview only — the deluxe item forge (crew B) replaces buildPreviewStub; this file's SWAP POINT comment marks the spot.</div>`));

  // place-in-world
  const posInputs = [0, 1, 2].map(() => {
    const i = document.createElement('input');
    i.type = 'number'; i.value = '0'; i.step = '1'; i.style.width = '60px';
    return i;
  });
  const countInput = document.createElement('input');
  countInput.type = 'number'; countInput.value = '1'; countInput.min = '1'; countInput.style.width = '60px';
  const placeRow = h(`<div style="display:flex;gap:6px;align-items:end"></div>`);
  const posFields = h(`<div style="display:flex;gap:4px;align-items:end"></div>`);
  posFields.append(field('X', posInputs[0]), field('Y', posInputs[1]), field('Z', posInputs[2]), field('COUNT', countInput));
  placeRow.append(posFields);
  root.appendChild(field('PLACE IN WORLD (appends to custom.items.loot)', placeRow));

  const errBox = h(`<div class="xed-errors"></div>`);
  root.appendChild(errBox);
  const msgBox = h(`<div class="xed-hint"></div>`);
  root.appendChild(msgBox);

  function buildDef(): { id: string; def: ItemDef; errors: string[] } {
    const id = idInput.value.trim() || 'item';
    const b = new ItemBuilder(id).named(nameInput.value.trim() || id);
    b.type(typeSel.value as ItemType);
    const slot = slotSel.value as EquipSlot | '';
    if (slot) b.slot(slot);
    b.rarity(raritySel.value as ItemRarity);
    for (const key of ITEM_STAT_KEYS) {
      const raw = statInputs[key]?.value.trim();
      if (raw) {
        const v = parseFloat(raw);
        if (Number.isFinite(v)) b.stat(key, v);
      }
    }
    const effect = behSel.value;
    if (effect !== '(none)') {
      const amt = parseFloat(behAmt.value);
      const dur = parseFloat(behDur.value);
      b.behavior(
        effect as 'heal' | 'restore' | 'buff',
        Number.isFinite(amt) ? amt : undefined,
        Number.isFinite(dur) ? dur : undefined,
      );
    }
    const stack = parseInt(stackInput.value, 10);
    if (Number.isFinite(stack)) b.stackable(stack);
    const value = parseFloat(valueInput.value);
    if (Number.isFinite(value)) b.value(value);
    if (descInput.value.trim()) b.description(descInput.value.trim());
    if (skinInput.value.trim()) b.skin(skinInput.value.trim());
    if (modelInput.value.trim()) b.model(modelInput.value.trim());
    const errors: string[] = [];
    if (!HEX_ID_RE.test(id)) errors.push(`item id "${id}": must be lowercase letters, digits, _ or -`);
    errors.push(...b.validate());
    return { id, def: b.build(), errors };
  }

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

  function refreshPreview(): void {
    preview?.dispose();
    preview = disposed ? null : buildPreviewStub(previewCanvas, buildDef().def);
  }

  typeSel.addEventListener('change', () => {
    // auto-suggest the right slot field visibility hint for weapon/armor
    slotWrap.style.opacity = (typeSel.value === 'weapon' || typeSel.value === 'armor') ? '1' : '0.45';
    refreshPreview();
  });
  slotSel.addEventListener('change', () => refreshPreview());
  raritySel.addEventListener('change', () => refreshPreview());
  nameInput.addEventListener('input', () => refreshPreview());

  skinCheck.addEventListener('click', () => {
    const id = skinInput.value.trim();
    if (!id) { msgBox.textContent = 'skin id is empty (optional field)'; return; }
    const { errors } = buildDef();
    const skinErrors = errors.filter((e) => e.includes('.skin'));
    if (skinErrors.length) {
      errBox.innerHTML = skinErrors.map((e) => `<div class="xed-err">${e}</div>`).join('');
      errBox.classList.add('show');
    } else {
      errBox.classList.remove('show');
      msgBox.textContent = `skin id "${id}" looks valid (format check — id must also exist in custom.items.skins or built-ins at runtime)`;
    }
  });

  attachUploadButton(modelInput, {
    accept: '.glb,.gltf,.png,.jpg,.jpeg,.webp',
    onUrl: (url) => {
      modelInput.value = url;
      msgBox.textContent = 'model URL set from upload ✓';
    },
  });

  const btnRow = h(`<div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0"></div>`);
  const dlBtn = h(`<button class="xed-iconbtn">⬇ DOWNLOAD JSON</button>`) as HTMLButtonElement;
  const copyBtn = h(`<button class="xed-iconbtn">⧉ COPY</button>`) as HTMLButtonElement;
  const addBtn = h(`<button class="xed-iconbtn">➕ ADD TO SPEC</button>`) as HTMLButtonElement;
  const placeBtn = h(`<button class="xed-iconbtn">📍 PLACE IN WORLD</button>`) as HTMLButtonElement;
  btnRow.append(dlBtn, copyBtn, addBtn, placeBtn);
  root.appendChild(btnRow);

  dlBtn.addEventListener('click', () => {
    const { id, def, errors } = buildDef();
    if (!showErrors(errors)) return;
    const blob = new Blob([JSON.stringify({ [id]: def }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${id}.item.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    msgBox.textContent = `downloaded ${id}.item.json`;
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
    ctx.onAddToSpec(id, def);
    msgBox.textContent = `added "${id}" to spec (custom.items.defs)`;
  });
  placeBtn.addEventListener('click', () => {
    const { id, def, errors } = buildDef();
    if (!showErrors(errors)) return;
    if (!ctx.onPlaceInWorld) { msgBox.textContent = 'not connected to a spec (standalone mode)'; return; }
    const pos = posInputs.map((i) => parseFloat(i.value)) as [number, number, number];
    if (!pos.every(Number.isFinite)) { msgBox.textContent = 'position must be numbers'; return; }
    const count = parseInt(countInput.value, 10);
    const spot: LootSpot = { item: id, pos, ...(Number.isInteger(count) && count >= 1 ? { count } : {}) };
    // The placed item must exist in custom.items.defs for the spec to
    // validate — ensure it, then place.
    ctx.onAddToSpec?.(id, def);
    ctx.onPlaceInWorld(spot);
    msgBox.textContent = `placed "${id}" at (${pos.join(', ')})`;
  });

  refreshPreview();
  container.appendChild(root);
  return {
    dispose() {
      disposed = true;
      preview?.dispose();
    },
  };
}
