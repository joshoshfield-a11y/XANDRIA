/**
 * itemsPanel — Studio game-author panel for `custom.items`.
 *
 * Sections: item definitions table (add/remove/edit all ItemDef fields),
 * loot placement list, chests editor, starting-inventory picker.
 * Mount contract: `renderItemsPanel(container, ctx)`.
 *
 * HOST CONTRACT (the coordinator mounts this panel):
 * - ctx.getSpec(): GameSpec — the current working spec (read-only view).
 * - ctx.patch(p: unknown): void — applies a DEEP-PARTIAL of GameSpec.
 *   This panel always calls `patch({ custom: { items: <full new ItemsCustom> } })`
 *   with the complete new `custom.items` value (all sub-objects included), so
 *   the host can deep-merge it or replace `custom.items` wholesale — either
 *   satisfies the panel. No other paths are patched.
 * - ctx.refresh(): void — re-renders the panel from the updated spec
 *   (called after every patch so validation + UI stay in sync).
 *
 * Styling is scoped under `.xit-` (mirrors the `.xed-` conventions of
 * editorPanel.ts, which this panel does NOT edit — the coordinator mounts it).
 */
import {
  ITEM_TYPES,
  EQUIP_SLOTS,
  ITEM_RARITIES,
  ITEM_STAT_KEYS,
  type GameSpec,
  type ItemDef,
  type ItemsCustom,
  type ItemLootSpot,
  type ItemChestDef,
  type ItemType,
  type EquipSlot,
  type ItemRarity,
  type ItemStatKey,
  validateSpec,
} from '@spec';
import { cloneSpec } from './editor/specOps';

export interface ItemsPanelCtx {
  getSpec(): GameSpec;
  /** Deep-partial of GameSpec; this panel sends { custom: { items } } only. */
  patch(p: unknown): void;
  /** Re-render the panel from the updated spec. */
  refresh(): void;
}

const CSS = `
.xit-panel { display:flex; flex-direction:column; gap:12px; height:100%; overflow-y:auto; padding-bottom:12px; }
.xit-head { display:flex; align-items:center; gap:8px; }
.xit-head b { font-size:13px; color:#8fa5c8; letter-spacing:.08em; }
.xit-head .sp { flex:1; }
.xit-sec { font-size:10.5px; letter-spacing:.22em; color:#3fd8ff; margin-top:2px; }
.xit-card { background:#111827; border:1px solid #232f4a; border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:8px; }
.xit-cardhead { display:flex; align-items:center; gap:8px; }
.xit-cardhead .id { font-size:12.5px; font-weight:700; color:#7af7ff; }
.xit-cardhead .sp { flex:1; }
.xit-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
.xit-grid2 { display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; }
.xit-field { display:flex; flex-direction:column; gap:3px; min-width:0; }
.xit-flabel { font-size:9.5px; letter-spacing:.16em; color:#5a6a85; }
.xit-field input, .xit-field select { background:#131a2a; color:#e6ecf5; border:1px solid #2a3550;
  border-radius:8px; padding:7px 9px; font-size:12.5px; outline:none; width:100%; }
.xit-field input:focus, .xit-field select:focus { border-color:#3fd8ff; }
.xit-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.xit-row input { min-width:0; }
.xit-btn { background:#1a2438; color:#e6ecf5; border:1px solid #2a3550; border-radius:8px;
  padding:7px 12px; font-size:12px; cursor:pointer; }
.xit-btn:hover { border-color:#3fd8ff; }
.xit-btn.danger { color:#ff9db4; border-color:#5a2436; }
.xit-btn.danger:hover { border-color:#ff9db4; }
.xit-warn { font-size:11.5px; color:#ff9d5a; }
.xit-err { font-size:11.5px; color:#ff9db4; }
.xit-ok { font-size:11px; color:#4f9f6a; letter-spacing:.08em; }
.xit-empty { color:#3a4a65; font-size:12.5px; text-align:center; padding:18px 10px; letter-spacing:.06em; }
.xit-start { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.xit-chip { background:#0f1626; border:1px solid #2a3550; border-radius:16px; padding:5px 8px 5px 12px;
  font-size:12px; display:inline-flex; gap:8px; align-items:center; }
.xit-chip button { background:none; border:none; color:#ff9db4; cursor:pointer; font-size:13px; padding:0 2px; }
`;

/** Escape for HTML text contexts — item ids/names echo spec content (untrusted). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function h(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

const sanitizeId = (s: string): string =>
  s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '').slice(0, 48);

const STAT_LABELS: Record<ItemStatKey, string> = {
  damage: 'DMG', defense: 'DEF', speed: 'SPD', maxHealth: 'HP',
  crit: 'CRIT', attackSpeed: 'ATK SPD', luck: 'LUCK',
};

const DEFAULT_DEF: ItemDef = {
  name: 'New Item', type: 'material', rarity: 'common', stack: 1, value: 0,
};

export function renderItemsPanel(container: HTMLElement, ctx: ItemsPanelCtx): void {
  if (typeof document !== 'undefined') {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement('div');
  root.className = 'xit-panel';
  container.appendChild(root);

  const getItems = (): ItemsCustom => ctx.getSpec().custom?.items ?? {};
  const getDefs = (): Record<string, ItemDef> => getItems().defs ?? {};

  /** Write the new items object through the host patch contract, then refresh. */
  const commit = (items: ItemsCustom): void => {
    try {
      ctx.patch({ custom: { items } });
    } catch (e) {
      errLine.textContent = `patch failed: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    ctx.refresh();
  };

  const withItems = (fn: (items: ItemsCustom) => ItemsCustom): void => {
    const cur = getItems();
    const next: ItemsCustom = {
      defs: { ...(cur.defs ?? {}) },
      skins: cur.skins ? { ...cur.skins } : undefined,
      loot: cur.loot ? cur.loot.map((l) => ({ ...l })) : undefined,
      chests: cur.chests ? cur.chests.map((c) => ({ ...c, loot: [...c.loot] })) : undefined,
      starting: cur.starting ? [...cur.starting] : undefined,
    };
    commit(fn(next));
  };

  /** Rename an id everywhere it is referenced (defs key + loot/chests/starting). */
  const renameId = (oldId: string, rawNew: string): void => {
    const newId = sanitizeId(rawNew);
    if (!newId || newId === oldId) { render(); return; }
    const defs = getDefs();
    if (defs[newId] && newId !== oldId) { render(); return; } // collision: keep old
    withItems((items) => {
      const d = items.defs!;
      d[newId] = d[oldId];
      delete d[oldId];
      for (const l of items.loot ?? []) if (l.item === oldId) l.item = newId;
      for (const c of items.chests ?? []) c.loot = c.loot.map((id) => (id === oldId ? newId : id));
      if (items.starting) items.starting = items.starting.map((id) => (id === oldId ? newId : id));
      return items;
    });
  };

  const errLine = document.createElement('div');

  // ------------------------------------------------------------ defs table
  function field(label: string, input: HTMLElement): HTMLElement {
    const w = h(`<div class="xit-field"><div class="xit-flabel">${escapeHtml(label)}</div></div>`);
    w.appendChild(input);
    return w;
  }

  function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'text';
    i.value = value;
    i.addEventListener('change', () => onChange(i.value));
    return i;
  }

  function numInput(value: number | undefined, onChange: (v: number | undefined) => void): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'number';
    if (value !== undefined) i.value = String(value);
    i.addEventListener('change', () => {
      const v = i.value === '' ? undefined : Number(i.value);
      onChange(v === undefined || Number.isNaN(v) ? undefined : v);
    });
    return i;
  }

  function selectInput<T extends string>(options: readonly T[], value: T | undefined | '', onChange: (v: T | '') => void, allowEmpty = false): HTMLSelectElement {
    const s = document.createElement('select');
    if (allowEmpty) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '—';
      s.appendChild(o);
    }
    for (const o of options) {
      const el = document.createElement('option');
      el.value = o;
      el.textContent = o;
      s.appendChild(el);
    }
    s.value = value ?? '';
    s.addEventListener('change', () => onChange(s.value as T | ''));
    return s;
  }

  function setDefField(id: string, patch: Partial<ItemDef>): void {
    withItems((items) => {
      const d = { ...(items.defs![id] ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (d as Record<string, unknown>)[k];
        else (d as Record<string, unknown>)[k] = v;
      }
      // drop empties so the spec stays clean
      if (d.stats && Object.keys(d.stats).length === 0) delete d.stats;
      if (d.behavior && d.behavior.effect === undefined) delete d.behavior;
      items.defs![id] = d;
      return items;
    });
  }

  function renderDefCard(id: string, def: ItemDef): HTMLElement {
    const card = h(`<div class="xit-card"></div>`);
    const head = h(`<div class="xit-cardhead"></div>`);
    const idInput = textInput(id, (v) => renameId(id, v));
    idInput.title = 'item id (renames references too)';
    idInput.style.cssText = 'font-weight:700;color:#7af7ff;background:#131a2a;border:1px solid #2a3550;border-radius:8px;padding:6px 9px;font-size:12.5px;width:170px;';
    head.appendChild(idInput);
    const sp = h(`<div class="sp"></div>`);
    head.appendChild(sp);
    const del = h(`<button class="xit-btn danger">remove</button>`);
    del.addEventListener('click', () => {
      withItems((items) => {
        delete items.defs![id];
        return items;
      });
    });
    head.appendChild(del);
    card.appendChild(head);

    const grid = h(`<div class="xit-grid"></div>`);
    grid.appendChild(field('NAME', textInput(def.name ?? '', (v) => setDefField(id, { name: v }))));
    grid.appendChild(field('TYPE', selectInput(ITEM_TYPES, def.type, (v) => {
      const patch: Partial<ItemDef> = { type: v as ItemType };
      // keep slot only where meaningful; validator requires slot for weapon/armor
      setDefField(id, patch);
    })));
    grid.appendChild(field('SLOT', selectInput(EQUIP_SLOTS, def.slot ?? '', (v) => {
      setDefField(id, { slot: (v || undefined) as EquipSlot | undefined });
    }, true)));
    grid.appendChild(field('RARITY', selectInput(ITEM_RARITIES, def.rarity ?? 'common', (v) => {
      setDefField(id, { rarity: v as ItemRarity });
    })));
    grid.appendChild(field('STACK', numInput(def.stack, (v) => {
      setDefField(id, { stack: v === undefined ? undefined : Math.max(1, Math.min(999, Math.round(v))) });
    })));
    grid.appendChild(field('VALUE', numInput(def.value, (v) => {
      setDefField(id, { value: v === undefined ? undefined : Math.max(0, v) });
    })));
    grid.appendChild(field('SKIN ID', textInput(def.skin ?? '', (v) => setDefField(id, { skin: v || undefined }))));
    grid.appendChild(field('MODEL URL', textInput(def.model ?? '', (v) => setDefField(id, { model: v || undefined }))));
    grid.appendChild(field('DESCRIPTION', textInput(def.description ?? '', (v) => setDefField(id, { description: v || undefined }))));
    card.appendChild(grid);

    // stats
    const statsSec = h(`<div class="xit-sec">STATS (equipped)</div>`);
    card.appendChild(statsSec);
    const statsGrid = h(`<div class="xit-grid"></div>`);
    for (const k of ITEM_STAT_KEYS) {
      statsGrid.appendChild(field(STAT_LABELS[k], numInput(def.stats?.[k], (v) => {
        const stats = { ...(def.stats ?? {}) };
        if (v === undefined) delete stats[k];
        else stats[k] = v;
        setDefField(id, { stats });
      })));
    }
    card.appendChild(statsGrid);

    // behavior
    const behSec = h(`<div class="xit-sec">USE BEHAVIOR (consumables)</div>`);
    card.appendChild(behSec);
    const behRow = h(`<div class="xit-grid"></div>`);
    const effects = ['heal', 'restore', 'buff'] as const;
    behRow.appendChild(field('EFFECT', selectInput(effects, def.behavior?.effect ?? '', (v) => {
      setDefField(id, { behavior: v ? { effect: v, amount: def.behavior?.amount, duration: def.behavior?.duration } : undefined });
    }, true)));
    behRow.appendChild(field('AMOUNT', numInput(def.behavior?.amount, (v) => {
      if (def.behavior) setDefField(id, { behavior: { ...def.behavior, amount: v } });
    })));
    behRow.appendChild(field('DURATION s', numInput(def.behavior?.duration, (v) => {
      if (def.behavior) setDefField(id, { behavior: { ...def.behavior, duration: v } });
    })));
    card.appendChild(behRow);

    // inline warnings (mirror the validator's item rules)
    if ((def.type === 'weapon' || def.type === 'armor') && !def.slot) {
      const w = h(`<div class="xit-warn">⚠ weapon/armor items require a slot</div>`);
      card.appendChild(w);
    }
    if (!def.name) {
      const w = h(`<div class="xit-err">⚠ name is required</div>`);
      card.appendChild(w);
    }
    return card;
  }

  // ------------------------------------------------------------ loot / chests / starting
  function xyzInputs(cur: [number, number, number], onChange: (v: [number, number, number]) => void): HTMLElement {
    const row = h(`<div class="xit-row"></div>`);
    (['x', 'y', 'z'] as const).forEach((axis, i) => {
      const inp = numInput(cur[i], (v) => {
        const next: [number, number, number] = [...cur];
        next[i] = v ?? 0;
        onChange(next);
      });
      inp.style.width = '64px';
      inp.title = axis;
      inp.setAttribute('aria-label', axis);
      row.appendChild(inp);
    });
    return row;
  }

  function itemSelect(value: string, onChange: (v: string) => void): HTMLSelectElement {
    const s = document.createElement('select');
    for (const id of Object.keys(getDefs()).sort()) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      s.appendChild(o);
    }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  function renderLoot(spot: ItemLootSpot, index: number): HTMLElement {
    const card = h(`<div class="xit-card"></div>`);
    const row = h(`<div class="xit-row"></div>`);
    row.appendChild(field('ITEM', itemSelect(spot.item, (v) => {
      withItems((items) => { items.loot![index] = { ...spot, item: v }; return items; });
    })));
    row.appendChild(field('POS', xyzInputs(spot.pos, (pos) => {
      withItems((items) => { items.loot![index] = { ...spot, pos }; return items; });
    })));
    row.appendChild(field('COUNT', (() => {
      const i = numInput(spot.count, (v) => {
        withItems((items) => { items.loot![index] = { ...spot, count: v === undefined ? undefined : Math.max(1, Math.round(v)) }; return items; });
      });
      i.style.width = '64px';
      return i;
    })()));
    const del = h(`<button class="xit-btn danger">remove</button>`);
    del.addEventListener('click', () => {
      withItems((items) => { items.loot!.splice(index, 1); return items; });
    });
    row.appendChild(del);
    card.appendChild(row);
    return card;
  }

  function renderChest(def: ItemChestDef, index: number): HTMLElement {
    const card = h(`<div class="xit-card"></div>`);
    const row = h(`<div class="xit-row"></div>`);
    row.appendChild(field('POS', xyzInputs(def.pos, (pos) => {
      withItems((items) => { items.chests![index] = { ...def, pos }; return items; });
    })));
    row.appendChild(field('LOOT (comma-separated ids)', textInput(def.loot.join(', '), (v) => {
      const loot = v.split(',').map((s) => s.trim()).filter(Boolean);
      withItems((items) => { items.chests![index] = { ...def, loot }; return items; });
    })));
    row.appendChild(field('CHEST SKIN', textInput(def.skin ?? '', (v) => {
      withItems((items) => { items.chests![index] = { ...def, skin: v || undefined }; return items; });
    })));
    const lock = h(`<label class="xit-field" style="flex-direction:row;align-items:center;gap:6px"></label>`);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!def.locked;
    cb.addEventListener('change', () => {
      withItems((items) => { items.chests![index] = { ...def, locked: cb.checked || undefined }; return items; });
    });
    lock.append(cb, document.createTextNode('locked'));
    row.appendChild(lock);
    const del = h(`<button class="xit-btn danger">remove</button>`);
    del.addEventListener('click', () => {
      withItems((items) => { items.chests!.splice(index, 1); return items; });
    });
    row.appendChild(del);
    card.appendChild(row);
    // unknown loot ids inline (validator would reject the spec)
    const defs = getDefs();
    const bad = def.loot.filter((id) => !defs[id]);
    if (bad.length) {
      card.appendChild(h(`<div class="xit-err">⚠ unknown item ids: ${escapeHtml(bad.join(', '))}</div>`));
    }
    return card;
  }

  // ------------------------------------------------------------ render
  function addBtn(label: string, fn: () => void): HTMLElement {
    const b = h(`<button class="xit-btn">${escapeHtml(label)}</button>`);
    b.addEventListener('click', fn);
    return b;
  }

  function render(): void {
    root.innerHTML = '';
    const items = getItems();
    const defs = getDefs();
    const ids = Object.keys(defs).sort();

    const head = h(`<div class="xit-head"><b>ITEMS</b><div class="sp"></div></div>`);
    root.appendChild(head);

    // --- defs
    root.appendChild(h(`<div class="xit-sec">DEFINITIONS (${ids.length})</div>`));
    for (const id of ids) root.appendChild(renderDefCard(id, defs[id]));
    if (!ids.length) root.appendChild(h(`<div class="xit-empty">no items yet — add one below</div>`));
    const addRow = h(`<div class="xit-row"></div>`);
    const newId = document.createElement('input');
    newId.type = 'text';
    newId.placeholder = 'new-item-id';
    newId.style.cssText = 'background:#131a2a;color:#e6ecf5;border:1px solid #2a3550;border-radius:8px;padding:7px 9px;font-size:12.5px;width:170px;';
    addRow.appendChild(newId);
    addRow.appendChild(addBtn('+ add item', () => {
      const id = sanitizeId(newId.value);
      if (!id || defs[id]) { render(); return; }
      withItems((it) => { it.defs![id] = { ...DEFAULT_DEF }; return it; });
    }));
    root.appendChild(addRow);

    // --- loot
    root.appendChild(h(`<div class="xit-sec">LOOT PLACEMENT (${(items.loot ?? []).length})</div>`));
    for (const [i, spot] of (items.loot ?? []).entries()) root.appendChild(renderLoot(spot, i));
    root.appendChild(addBtn('+ add loot spot', () => {
      withItems((it) => {
        it.loot = [...(it.loot ?? []), { item: ids[0] ?? '', pos: [0, 0, 0] as [number, number, number] }];
        return it;
      });
    }));

    // --- chests
    root.appendChild(h(`<div class="xit-sec">CHESTS (${(items.chests ?? []).length})</div>`));
    for (const [i, c] of (items.chests ?? []).entries()) root.appendChild(renderChest(c, i));
    root.appendChild(addBtn('+ add chest', () => {
      withItems((it) => {
        it.chests = [...(it.chests ?? []), { pos: [0, 0, 0] as [number, number, number], loot: [] }];
        return it;
      });
    }));

    // --- starting inventory
    root.appendChild(h(`<div class="xit-sec">STARTING INVENTORY (${(items.starting ?? []).length})</div>`));
    const startWrap = h(`<div class="xit-start"></div>`);
    for (const id of items.starting ?? []) {
      const chip = h(`<span class="xit-chip">${escapeHtml(id)}<button title="remove">×</button></span>`);
      chip.querySelector('button')!.addEventListener('click', () => {
        withItems((it) => { it.starting = (it.starting ?? []).filter((s) => s !== id); return it; });
      });
      startWrap.appendChild(chip);
    }
    if (ids.length) {
      const sel = itemSelect(ids[0], () => undefined);
      startWrap.appendChild(sel);
      startWrap.appendChild(addBtn('add', () => {
        withItems((it) => {
          it.starting = [...(it.starting ?? []), sel.value];
          return it;
        });
      }));
    } else {
      startWrap.appendChild(h(`<div class="xit-empty">define an item first</div>`));
    }
    root.appendChild(startWrap);

    // --- validation (items paths only)
    const v = validateSpec(cloneSpec(ctx.getSpec()));
    const itemErrs = v.errors.filter((e) => e.startsWith('custom.items'));
    const vLine = h(`<div></div>`);
    if (itemErrs.length) {
      vLine.innerHTML = itemErrs.slice(0, 6).map((e) => `<div class="xit-err">⚠ ${escapeHtml(e)}</div>`).join('');
    } else {
      vLine.innerHTML = `<div class="xit-ok">✓ items valid</div>`;
    }
    root.appendChild(vLine);
    root.appendChild(errLine);
  }

  render();
}
