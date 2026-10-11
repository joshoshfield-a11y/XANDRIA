/**
 * editorPanel — Studio editor for basic (non-coder) users: point, click, tweak, play.
 *
 * Six tabs (Story / World / Player / Enemies / Pickups / Assets) mutate a working
 * GameSpec copy. Every edit re-validates with the existing validator; validation
 * errors show inline and Play is gated on a valid spec. No external UI libraries;
 * styling is scoped under `.xed-` to coexist with the Studio shell.
 */
import {
  MOODS, ENVIRONMENTS, OBJECTIVES, ENEMY_KINDS, WEAPONS, ABILITIES,
  CHARACTER_PIVOTS,
  type GameSpec, type ObjectiveStage, type EnemySpec, type Weapon,
  type CharacterPivot,
} from '@spec';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fitModelToHeight, resolvePivots } from '../../engine/gfx/RigAdapter';
import {
  cloneSpec, getAtPath,
  validateEditable,
  getStages, inStageMode, addStage, removeStage, moveStage, setStageField,
  ensureStageIds, stageIdOptions, setStageNext,
  addChoice, removeChoice, setChoiceField,
  enemyKindEnabled, setEnemyKindEnabled,
  applyEnemyMultipliers, snapshotEnemies, type EnemyMultipliers,
  PICKUP_KEYS, setPickupEnabled, ensureProgression,
  PALETTE_SWATCHES, applyPaletteSwatch,
  fogSliderToWeather, weatherToFogSlider, fogTierLabel,
  ASSET_GROUPS, applyAssetControl,
  reskinNamespaces, getReskinOverride, setReskinOverride,
  clearCustomAssets, customAssetsShape, reskinOverridesPresent, isDefaultReskin,
  projectFromJson,
  listSkinIds, getCharacterSlot, setCharacterSlot, setBoneMapEntry,
  type AssetControl, type AssetOverride,
} from './specOps';

export interface EditorCallbacks {
  getSpec(): GameSpec | null;
  /** Boot the preview iframe with the edited spec (host validates defensively). */
  play(spec: GameSpec): void;
  /** Assign a fresh random seed, keeping all other edits. Returns the new spec. */
  regenerate(): GameSpec | null;
  saveProject(spec: GameSpec): void;
  loadProject(file: File): Promise<GameSpec>;
}

export interface EditorPanel {
  root: HTMLElement;
  setSpec(spec: GameSpec | null): void;
  getSpec(): GameSpec | null;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const roman = (i: number): string => ROMAN[i] ?? `${i + 1}`;

const WEAPON_DAMAGE: Record<Weapon, string> = {
  sword: '≈25 (melee)', blaster: '≈9 / shot', rifle: '≈8 / shot',
  shotgun: '≈16 × pellets', none: 'unarmed',
};

/** Which validation-error prefixes belong to which tab (for ⚠ badges). */
const TAB_ERROR_PREFIXES: Record<string, string[]> = {
  story: ['objective', 'meta.name', 'narrative'],
  world: ['theme', 'world'],
  player: ['player'],
  enemies: ['enemies'],
  pickups: ['pickups', 'progression'],
  assets: ['custom'],
};

const TABS = ['story', 'world', 'player', 'enemies', 'pickups', 'assets'] as const;
type TabId = (typeof TABS)[number];
const TAB_LABELS: Record<TabId, string> = {
  story: 'Story', world: 'World', player: 'Player',
  enemies: 'Enemies', pickups: 'Pickups', assets: 'Assets',
};

const css = `
.xed-panel { display:flex; flex-direction:column; gap:10px; height:100%; }
.xed-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.xed-toolbar button { flex:1; min-width:0; padding:9px 6px; font-size:12px; }
.xed-seed { font-size:10.5px; color:#5a6a85; letter-spacing:.08em; white-space:nowrap; }
.xed-errors { background:#2a1420; border:1px solid #8a2f4a; border-radius:10px; padding:10px 12px;
  font-size:12px; color:#ff9db4; display:none; max-height:130px; overflow:auto; }
.xed-errors.show { display:block; }
.xed-errors .xed-err { margin:2px 0; }
.xed-errors .xed-err b { color:#ffc4d1; }
.xed-ok { font-size:11px; color:#4f9f6a; letter-spacing:.1em; }
.xed-tabbar { display:flex; gap:4px; flex-wrap:wrap; }
.xed-tabbar button { flex:1; padding:8px 4px; font-size:11.5px; border-radius:8px; font-weight:600; }
.xed-tabbar button.active { background:linear-gradient(180deg,#1f6d8a,#144256); border-color:#3fd8ff; }
.xed-tabbar button .xed-warn { color:#ff9d5a; }
.xed-body { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:10px; padding-bottom:12px; }
.xed-field { display:flex; flex-direction:column; gap:4px; }
.xed-flabel { font-size:10px; letter-spacing:.18em; color:#5a6a85; }
.xed-field input[type=text], .xed-field input[type=number], .xed-field textarea, .xed-field select {
  width:100%; background:#131a2a; color:#e6ecf5; border:1px solid #2a3550; border-radius:8px;
  padding:8px 10px; font-size:13px; outline:none; }
.xed-field input:focus, .xed-field textarea:focus, .xed-field select:focus { border-color:#3fd8ff; }
.xed-field textarea { min-height:64px; resize:vertical; }
.xed-sliderow { display:flex; align-items:center; gap:10px; }
.xed-sliderow input[type=range] { flex:1; accent-color:#3fd8ff; }
.xed-sliderval { font-size:12px; color:#8fa5c8; min-width:52px; text-align:right; font-variant-numeric:tabular-nums; }
.xed-colorrow { display:flex; align-items:center; gap:10px; }
.xed-colorrow input[type=color] { width:44px; height:30px; padding:2px; background:#131a2a; border:1px solid #2a3550; border-radius:8px; cursor:pointer; }
.xed-checkrow { display:flex; align-items:center; gap:8px; font-size:13px; padding:4px 0; }
.xed-checkrow input[type=checkbox] { width:16px; height:16px; accent-color:#3fd8ff; }
.xed-card { background:#111827; border:1px solid #232f4a; border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:10px; }
.xed-cardhead { display:flex; align-items:center; gap:8px; }
.xed-cardhead b { font-size:13px; color:#8fa5c8; letter-spacing:.06em; }
.xed-cardhead .xed-badge { font-size:10px; background:#1a2438; border-radius:6px; padding:2px 8px; color:#7af7ff; }
.xed-cardhead .xed-sp { flex:1; }
.xed-iconbtn { padding:5px 9px; font-size:12px; border-radius:8px; }
.xed-stageerr { font-size:11.5px; color:#ff9db4; }
.xed-chrow { display:flex; gap:8px; align-items:center; }
.xed-chrow input { flex:1; min-width:0; }
.xed-chrow select { flex:1; min-width:0; }
.xed-swatches { display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; }
.xed-sw { display:flex; flex-direction:column; align-items:center; gap:4px; padding:6px 4px; border-radius:8px; font-size:9.5px; color:#8fa5c8; }
.xed-sw .xed-dots { display:flex; gap:3px; }
.xed-sw .xed-dot { width:14px; height:14px; border-radius:50%; border:1px solid #0006; }
.xed-ns { font-size:10px; letter-spacing:.22em; color:#3fd8ff; margin-top:4px; }
.xed-hint { font-size:11px; color:#5a6a85; line-height:1.5; }
.xed-asset { background:#0f1626; border:1px solid #1e2a45; border-radius:10px; padding:10px; display:flex; flex-direction:column; gap:8px; }
.xed-asset > .xed-aname { font-size:12.5px; color:#a9bcd8; font-weight:600; }
.xed-empty { color:#3a4a65; font-size:12.5px; text-align:center; padding:30px 10px; letter-spacing:.06em; line-height:1.8; }
`;

let styleInjected = false;

/**
 * Escape for HTML text contexts. Validator errors embed raw spec strings
 * (stage ids, descriptions), and load errors echo project-file content —
 * both are untrusted, so they must never reach innerHTML raw (QA N9).
 * Pure and unit-testable; the panel has no DOM test harness.
 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** One validator-error row: `<path>: <detail>`, both halves escaped. */
export function errorRowHtml(e: string): string {
  const i = e.indexOf(':');
  const path = escapeHtml(i >= 0 ? e.slice(0, i) : e);
  const rest = escapeHtml(i >= 0 ? e.slice(i) : '');
  return `<div class="xed-err"><b>${path}</b>${rest}</div>`;
}

function h(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

export function createEditorPanel(cb: EditorCallbacks): EditorPanel {
  if (!styleInjected) {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    styleInjected = true;
  }

  let working: GameSpec | null = null;
  let activeTab: TabId = 'story';
  let enemyBase: EnemySpec[] = [];
  let tabWarns: Record<string, number> = {};

  const root = h(`<div class="xed-panel"></div>`);
  const toolbar = h(`<div class="xed-toolbar"></div>`);
  const errBox = h(`<div class="xed-errors"></div>`);
  const okLine = h(`<div class="xed-ok">✓ SPEC VALID</div>`);
  const tabbar = h(`<div class="xed-tabbar"></div>`);
  const body = h(`<div class="xed-body"></div>`);
  const fileInput = h(`<input type="file" accept=".json,application/json" style="display:none">`) as HTMLInputElement;

  const playBtn = h(`<button class="primary">▶ PLAY</button>`) as HTMLButtonElement;
  const regenBtn = h(`<button title="New random seed, keeps all edits">🎲 SEED</button>`) as HTMLButtonElement;
  const saveBtn = h(`<button title="Download .xandria.json project">💾 SAVE</button>`) as HTMLButtonElement;
  const loadBtn = h(`<button title="Upload .xandria.json project">📂 LOAD</button>`) as HTMLButtonElement;
  const seedBadge = h(`<span class="xed-seed"></span>`);

  toolbar.append(playBtn, regenBtn, saveBtn, loadBtn, seedBadge);
  root.append(toolbar, errBox, okLine, tabbar, body, fileInput);

  // ---------------------------------------------------------- helpers
  function refreshValidation(): boolean {
    if (!working) { errBox.classList.remove('show'); okLine.style.display = 'none'; playBtn.disabled = true; return false; }
    const v = validateEditable(working);
    tabWarns = {};
    for (const t of TABS) tabWarns[t] = 0;
    if (!v.ok) {
      errBox.innerHTML = v.errors.slice(0, 12).map(errorRowHtml).join('');
      errBox.classList.add('show');
      okLine.style.display = 'none';
      for (const e of v.errors) {
        for (const t of TABS) {
          if (TAB_ERROR_PREFIXES[t].some((p) => e === p || e.startsWith(p + '.') || e.startsWith(p + '['))) tabWarns[t]++;
        }
      }
    } else {
      errBox.classList.remove('show');
      okLine.style.display = 'block';
    }
    playBtn.disabled = !v.ok;
    renderTabbar();
    return v.ok;
  }

  /** Mutate the working spec, then refresh validation; re-render the tab when structure changed. */
  function commit(mut: (s: GameSpec) => void, structural = false): void {
    if (!working) return;
    mut(working);
    refreshValidation();
    if (structural) renderTab();
  }

  function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const f = h(`<div class="xed-field"><div class="xed-flabel">${label}</div></div>`);
    f.appendChild(control);
    if (hint) f.appendChild(h(`<div class="xed-hint">${hint}</div>`));
    return f;
  }

  // Simpler: text inputs commit a setter closure
  function textField(value: string, set: (s: GameSpec, v: string) => void): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'text'; i.value = value;
    i.addEventListener('input', () => commit((s) => set(s, i.value), false));
    return i;
  }

  function textArea(value: string, set: (s: GameSpec, v: string) => void): HTMLTextAreaElement {
    const t = document.createElement('textarea');
    t.value = value;
    t.addEventListener('input', () => commit((s) => set(s, t.value), false));
    return t;
  }

  function numberField(value: number, set: (s: GameSpec, v: number) => void, opts: { min?: number; max?: number; step?: number } = {}): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'number'; i.value = String(value);
    if (opts.min !== undefined) i.min = String(opts.min);
    if (opts.max !== undefined) i.max = String(opts.max);
    if (opts.step !== undefined) i.step = String(opts.step);
    i.addEventListener('change', () => {
      const v = parseFloat(i.value);
      if (!Number.isFinite(v)) { i.value = String(value); return; }
      commit((s) => set(s, v), false);
    });
    return i;
  }

  function slider(value: number, min: number, max: number, step: number, set: (s: GameSpec, v: number) => void, fmt?: (v: number) => string): HTMLElement {
    const wrap = h(`<div class="xed-sliderow"></div>`);
    const i = document.createElement('input');
    i.type = 'range'; i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(value);
    const val = h(`<span class="xed-sliderval">${(fmt ?? String)(value)}</span>`);
    i.addEventListener('input', () => {
      const v = parseFloat(i.value);
      val.textContent = (fmt ?? String)(v);
      commit((s) => set(s, v), false);
    });
    wrap.append(i, val);
    return wrap;
  }

  function select(options: readonly string[], value: string, set: (s: GameSpec, v: string) => void, structural = false): HTMLSelectElement {
    const s = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o; opt.selected = o === value;
      s.appendChild(opt);
    }
    s.addEventListener('change', () => commit((sp) => set(sp, s.value), structural));
    return s;
  }

  /** Chapter-successor selector: blank = default (next chapter in array order). */
  function stageNextSelect(s: GameSpec, index: number): HTMLSelectElement {
    const sel = document.createElement('select');
    const cur = s.objective.stages?.[index]?.next?.[0] ?? '';
    const addOpt = (value: string, label: string) => {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = label; opt.selected = value === cur;
      sel.appendChild(opt);
    };
    addOpt('', 'default — next chapter in order');
    for (const o of stageIdOptions(s, index)) addOpt(o.id, `→ ${o.label}`);
    if (cur && ![...sel.options].some((o) => o.value === cur)) addOpt(cur, `⚠ ${cur} (missing)`);
    sel.addEventListener('change', () => commit((sp) => setStageNext(sp, index, sel.value || undefined), true));
    return sel;
  }

  function colorField(value: string, set: (s: GameSpec, v: string) => void): HTMLElement {
    const wrap = h(`<div class="xed-colorrow"></div>`);
    const i = document.createElement('input');
    i.type = 'color'; i.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#ffffff';
    const hex = h(`<span class="xed-sliderval">${i.value}</span>`);
    i.addEventListener('input', () => { hex.textContent = i.value; commit((s) => set(s, i.value), false); });
    wrap.append(i, hex);
    return wrap;
  }

  function checkbox(label: string, checked: boolean, set: (s: GameSpec, v: boolean) => void, structural = false): HTMLElement {
    const row = h(`<label class="xed-checkrow"></label>`);
    const i = document.createElement('input');
    i.type = 'checkbox'; i.checked = checked;
    i.addEventListener('change', () => commit((s) => set(s, i.checked), structural));
    row.append(i, document.createTextNode(label));
    return row;
  }

  function card(title: string, badge?: string): { card: HTMLElement; head: HTMLElement; body: HTMLElement } {
    const card = h(`<div class="xed-card"></div>`);
    const head = h(`<div class="xed-cardhead"><b>${title}</b>${badge ? `<span class="xed-badge">${badge}</span>` : ''}<span class="xed-sp"></span></div>`);
    const bodyEl = h(`<div style="display:flex;flex-direction:column;gap:10px"></div>`);
    card.append(head, bodyEl);
    return { card, head, body: bodyEl };
  }

  function iconBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = h(`<button class="xed-iconbtn" title="${title}">${label}</button>`) as HTMLButtonElement;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------------------------------------------------------- tabs
  function renderTabbar(): void {
    tabbar.innerHTML = '';
    for (const t of TABS) {
      const b = h(`<button class="${t === activeTab ? 'active' : ''}">${TAB_LABELS[t]}${tabWarns[t] ? ' <span class="xed-warn">⚠</span>' : ''}</button>`) as HTMLButtonElement;
      b.addEventListener('click', () => { activeTab = t; renderTabbar(); renderTab(); });
      tabbar.appendChild(b);
    }
  }

  function stageErrors(index: number): string[] {
    if (!working) return [];
    const v = validateEditable(working);
    const prefix = `objective.stages[${index}]`;
    return v.errors.filter((e) => e.startsWith(prefix));
  }

  function renderStory(s: GameSpec, host: HTMLElement): void {
    s.narrative = s.narrative ?? { premise: '', winText: '', loseText: '' };
    host.appendChild(field('GAME NAME', textField(s.meta.name, (sp, v) => { sp.meta.name = v; })));
    host.appendChild(field('PREMISE — intro card (1–2 sentences)', textArea(s.narrative.premise, (sp, v) => { sp.narrative!.premise = v; })));
    host.appendChild(field('VICTORY TEXT', textArea(s.narrative.winText, (sp, v) => { sp.narrative!.winText = v; })));
    host.appendChild(field('DEFEAT TEXT', textArea(s.narrative.loseText, (sp, v) => { sp.narrative!.loseText = v; })));

    const stages = getStages(s);
    const head = h(`<div class="xed-ns">QUEST CHAPTERS — ${stages.length || 'single objective'}</div>`);
    host.appendChild(head);

    if (!inStageMode(s)) {
      const { card: c, body } = card('Objective', s.objective.type);
      body.appendChild(field('TYPE', select(OBJECTIVES, s.objective.type, (sp, v) => { sp.objective.type = v as ObjectiveStage['type']; })));
      body.appendChild(field('COUNT', numberField(s.objective.count, (sp, v) => { sp.objective.count = Math.max(0, Math.round(v)); })));
      body.appendChild(field('TIME LIMIT (s, 0 = none)', numberField(s.objective.timeLimit, (sp, v) => { sp.objective.timeLimit = Math.max(0, Math.round(v)); })));
      body.appendChild(field('DESCRIPTION', textField(s.objective.description, (sp, v) => { sp.objective.description = v; })));
      host.appendChild(c);
      const conv = h(`<button>＋ CONVERT TO QUEST CHAIN</button>`) as HTMLButtonElement;
      conv.addEventListener('click', () => commit((sp) => { addStage(sp); }, true));
      host.appendChild(conv);
    } else {
      stages.forEach((st, i) => {
        const { card: c, head: hd, body } = card(`Chapter ${roman(i)}`, st.type);
        hd.append(
          iconBtn('↑', 'Move chapter up', () => commit((sp) => moveStage(sp, i, -1), true)),
          iconBtn('↓', 'Move chapter down', () => commit((sp) => moveStage(sp, i, 1), true)),
          iconBtn('✕', 'Delete chapter', () => commit((sp) => removeStage(sp, i), true)),
        );
        body.appendChild(field('TYPE', select(OBJECTIVES, st.type, (sp, v) => setStageField(sp, i, 'type', v))));
        body.appendChild(field('COUNT', numberField(st.count, (sp, v) => setStageField(sp, i, 'count', v))));
        body.appendChild(field('TIME LIMIT (s, 0 = none)', numberField(st.timeLimit, (sp, v) => setStageField(sp, i, 'timeLimit', v))));
        body.appendChild(field('DESCRIPTION', textField(st.description, (sp, v) => setStageField(sp, i, 'description', v))));
        body.appendChild(field('STAGE ID', textField(st.id ?? '', (sp, v) => setStageField(sp, i, 'id', v)),
          'Used by branch targets. Keep unique.'));
        body.appendChild(field('NEXT — explicit successor', stageNextSelect(s, i),
          'Blank = next chapter in order. The campaign ends in victory on a chapter with no successor.'));
        body.appendChild(field('VICTORY TEXT — if the run ends here', textField(st.winText ?? '', (sp, v) => setStageField(sp, i, 'winText', v)),
          'Falls back to the campaign victory text when empty.'));
        // branch choices
        const nch = st.choices?.length ?? 0;
        body.appendChild(h(`<div class="xed-ns">BRANCH CHOICES${nch ? ` — ${nch}` : ' — none (linear)'}</div>`));
        (st.choices ?? []).forEach((c, ci) => {
          const row = h(`<div class="xed-chrow"></div>`);
          const lab = textField(c.label, (sp, v) => setChoiceField(sp, i, ci, 'label', v));
          lab.placeholder = 'Choice label';
          lab.title = 'Button label shown to the player';
          const sel = document.createElement('select');
          sel.title = 'Chapter this choice leads to';
          const cur = c.next;
          const targets = stageIdOptions(s, i);
          if (!targets.some((o) => o.id === cur)) {
            const bad = document.createElement('option');
            bad.value = cur; bad.textContent = cur ? `⚠ ${cur} (missing)` : '— pick a chapter —';
            sel.appendChild(bad);
          }
          for (const o of targets) {
            const opt = document.createElement('option');
            opt.value = o.id; opt.textContent = `→ ${o.label}`; opt.selected = o.id === cur;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', () => commit((sp) => setChoiceField(sp, i, ci, 'next', sel.value), true));
          row.append(lab, sel, iconBtn('✕', 'Delete choice', () => commit((sp) => removeChoice(sp, i, ci), true)));
          body.appendChild(row);
        });
        const addCh = h(`<button>+ ADD CHOICE</button>`) as HTMLButtonElement;
        addCh.addEventListener('click', () => commit((sp) => addChoice(sp, i), true));
        body.appendChild(addCh);
        body.appendChild(h(`<div class="xed-hint">When a chapter with choices is completed, the game pauses and the player picks a path (click or 1–9).</div>`));
        for (const e of stageErrors(i)) body.appendChild(h(`<div class="xed-stageerr">⚠ ${e}</div>`));
        host.appendChild(c);
      });
      const add = h(`<button>＋ ADD CHAPTER</button>`) as HTMLButtonElement;
      add.addEventListener('click', () => commit((sp) => { addStage(sp); }, true));
      host.appendChild(add);
      host.appendChild(h(`<div class="xed-hint">Delete every chapter to return to single-objective mode. Counts are checked against spawned enemies / pickups — errors appear above.</div>`));
    }
  }

  function renderWorld(s: GameSpec, host: HTMLElement): void {
    host.appendChild(field('MOOD (music)', select(MOODS, s.audio.mood, (sp, v) => { sp.audio.mood = v as GameSpec['audio']['mood']; })));
    host.appendChild(field('ENVIRONMENT', select(ENVIRONMENTS, s.theme.environment, (sp, v) => {
      sp.theme.environment = v as GameSpec['theme']['environment'];
    }, true)));

    host.appendChild(h(`<div class="xed-ns">PALETTE — APPLY ENVIRONMENT LOOK</div>`));
    const sw = h(`<div class="xed-swatches"></div>`);
    for (const env of ENVIRONMENTS) {
      const p = PALETTE_SWATCHES[env];
      const b = h(`<button class="xed-sw" title="${env}"><span class="xed-dots">${(['primary', 'secondary', 'accent', 'sky'] as const).map((k) => `<span class="xed-dot" style="background:${p[k]}"></span>`).join('')}</span>${env}</button>`) as HTMLButtonElement;
      b.addEventListener('click', () => commit((sp) => applyPaletteSwatch(sp, env), true));
      sw.appendChild(b);
    }
    host.appendChild(sw);

    const pal = s.theme.palette;
    host.appendChild(field('SKY — TOP', colorField(pal.sky, (sp, v) => { sp.theme.palette.sky = v; })));
    host.appendChild(field('SKY — HORIZON', colorField(pal.horizon, (sp, v) => { sp.theme.palette.horizon = v; })));
    host.appendChild(field('FOG COLOR', colorField(pal.fog, (sp, v) => { sp.theme.palette.fog = v; })));

    const w0 = weatherToFogSlider(s.theme.weather);
    host.appendChild(field(
      `FOG DENSITY — ${fogTierLabel(s.theme.weather)} (${s.theme.weather})`,
      slider(w0, 0, 100, 1, (sp, v) => { sp.theme.weather = fogSliderToWeather(v); }, (v) => `${Math.round(v)}`),
      'Fog is engine-derived from weather: light = clear, medium = storm, heavy = fog.',
    ));
  }

  function renderPlayer(s: GameSpec, host: HTMLElement): void {
    host.appendChild(field('MOVE SPEED (m/s)', slider(s.player.speed, 1, 60, 0.5, (sp, v) => { sp.player.speed = v; })));
    host.appendChild(field('MAX HEALTH', slider(s.player.health, 1, 10000, 50, (sp, v) => { sp.player.health = Math.round(v); })));
    host.appendChild(field('JUMP', slider(s.player.jump, 0, 40, 0.5, (sp, v) => { sp.player.jump = v; })));
    host.appendChild(field(
      `WEAPON — damage ${WEAPON_DAMAGE[s.player.weapon]}`,
      select(WEAPONS, s.player.weapon, (sp, v) => { sp.player.weapon = v as Weapon; }, true),
      'Damage comes from the weapon table — pick the weapon for the damage you want.',
    ));
    const ab = h(`<div class="xed-ns">ABILITIES</div>`);
    host.appendChild(ab);
    for (const a of ABILITIES) {
      host.appendChild(checkbox(a, s.player.abilities.includes(a), (sp, v) => {
        sp.player.abilities = v ? [...sp.player.abilities, a] : sp.player.abilities.filter((x) => x !== a);
      }));
    }
  }

  function renderEnemies(s: GameSpec, host: HTMLElement): void {
    host.appendChild(h(`<div class="xed-ns">ENEMY KINDS</div>`));
    for (const kind of ENEMY_KINDS) {
      const n = s.enemies.filter((e) => e.kind === kind).reduce((a, e) => a + e.count, 0);
      host.appendChild(checkbox(
        `${kind}${enemyKindEnabled(s, kind) ? ` — ${n} spawned` : ''}`,
        enemyKindEnabled(s, kind),
        (sp, v) => { setEnemyKindEnabled(sp, kind, v); enemyBase = snapshotEnemies(sp); },
        true,
      ));
    }
    host.appendChild(h(`<div class="xed-ns">MULTIPLIERS (applied to loaded values)</div>`));
    const mult: EnemyMultipliers = { count: 1, hp: 1, speed: 1 };
    const applyMult = () => commit((sp) => applyEnemyMultipliers(sp, enemyBase, mult), false);
    host.appendChild(field('COUNT ×', slider(1, 0, 3, 0.1, (sp, v) => { mult.count = v; applyMult(); })));
    host.appendChild(field('HEALTH ×', slider(1, 0.25, 3, 0.05, (sp, v) => { mult.hp = v; applyMult(); })));
    host.appendChild(field('SPEED ×', slider(1, 0.25, 2, 0.05, (sp, v) => { mult.speed = v; applyMult(); })));
    const reset = h(`<button class="xed-iconbtn">RESET ×1</button>`) as HTMLButtonElement;
    reset.addEventListener('click', () => commit((sp) => applyEnemyMultipliers(sp, enemyBase, { count: 1, hp: 1, speed: 1 }), true));
    host.appendChild(reset);

    host.appendChild(h(`<div class="xed-ns">GLOBAL MODS</div>`));
    const em = s.custom?.enemyMods;
    host.appendChild(field('SIZE SCALE', slider(em?.size ?? 1, 0.5, 2.5, 0.1, (sp, v) => {
      sp.custom = sp.custom ?? {}; sp.custom.enemyMods = { ...sp.custom.enemyMods, size: v };
    })));
    host.appendChild(field('GLOW COLOR', colorField(em?.glow ?? '#ff5533', (sp, v) => {
      sp.custom = sp.custom ?? {}; sp.custom.enemyMods = { ...sp.custom.enemyMods, glow: v };
    })));
  }

  function renderPickups(s: GameSpec, host: HTMLElement): void {
    host.appendChild(h(`<div class="xed-ns">SPAWNED PICKUPS</div>`));
    for (const k of PICKUP_KEYS) {
      host.appendChild(checkbox(
        `${k} — ${s.pickups[k]} placed`,
        s.pickups[k] > 0,
        (sp, v) => setPickupEnabled(sp, k, v),
        true,
      ));
    }
    const prg = ensureProgression(s);
    host.appendChild(h(`<div class="xed-ns">PROGRESSION</div>`));
    host.appendChild(checkbox('XP / levels enabled', prg.enabled, (sp, v) => { ensureProgression(sp).enabled = v; }));
    host.appendChild(field('XP PER KILL', slider(prg.xpPerKill, 1, 200, 1, (sp, v) => { ensureProgression(sp).xpPerKill = Math.round(v); })));
    host.appendChild(field('XP PER PICKUP', slider(prg.xpPerPickup, 1, 100, 1, (sp, v) => { ensureProgression(sp).xpPerPickup = Math.round(v); })));
  }

  function renderAssetControl(s: GameSpec, control: AssetControl, host: HTMLElement): void {
    const cur = getAtPath(s, control.path);
    if (control.kind === 'color') {
      host.appendChild(field(control.label, colorField(typeof cur === 'string' ? cur : '#ffffff', (sp, v) => applyAssetControl(sp, control, v))));
    } else if (control.kind === 'slider') {
      host.appendChild(field(control.label, slider(
        typeof cur === 'number' ? cur : control.min ?? 0,
        control.min ?? 0, control.max ?? 1, control.step ?? 0.1,
        (sp, v) => applyAssetControl(sp, control, v),
      )));
    } else if (control.kind === 'select' && control.options) {
      host.appendChild(field(control.label, select(control.options, typeof cur === 'string' ? cur : control.options[0], (sp, v) => applyAssetControl(sp, control, v))));
    } else if (control.kind === 'toggle') {
      host.appendChild(checkbox(control.label, cur === true, (sp, v) => applyAssetControl(sp, control, v)));
    }
  }

  /**
   * Characters section (workstream D+E): skin chooser dropdowns for the player
   * + every enemy kind, GLB model-URL inputs (player + walker/brute), a live
   * preview pane, and bone-remap dropdowns — all writing into
   * spec.custom.characters. Skins are procedural-only; an explicit skin wins
   * over the palette-derived colors; model URLs always fall back to the
   * procedural rig on any failure (online-only).
   */
  function renderCharacters(s: GameSpec, host: HTMLElement): void {
    host.appendChild(h(`<div class="xed-ns">CHARACTERS</div>`));
    host.appendChild(h(`<div class="xed-hint">Skins recolor the procedural hero. A GLB/GLTF model URL (https) replaces the procedural rig — preview it here first. Writes to <b>custom.characters</b>.</div>`));

    const skinSelect = (cur: string | undefined, which: 'player' | string): HTMLSelectElement => {
      const sel = document.createElement('select');
      const add = (v: string, label: string) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = label; o.selected = v === (cur ?? '');
        sel.appendChild(o);
      };
      add('', '(procedural default)');
      for (const id of listSkinIds(s)) add(id, id);
      sel.addEventListener('change', () =>
        commit((sp) => setCharacterSlot(sp, which, { skin: sel.value || undefined }), false));
      return sel;
    };

    // ---- player card
    const player = getCharacterSlot(s, 'player');
    const pcard = h(`<div class="xed-asset"><div class="xed-aname">PLAYER</div></div>`);
    pcard.appendChild(field('SKIN', skinSelect(player.skin, 'player'),
      'An explicit skin wins over the palette-derived colors.'));
    const purl = document.createElement('input');
    purl.type = 'text'; purl.value = player.model ?? ''; purl.placeholder = 'https://…/hero.glb';
    purl.addEventListener('change', () =>
      commit((sp) => setCharacterSlot(sp, 'player', { model: purl.value.trim() || undefined }), false));
    pcard.appendChild(field('MODEL URL (.glb/.gltf, https)', purl,
      'Empty = procedural rig. Supabase Storage upload ships in phase 2 — paste a hosted URL for now.'));
    const prevStatus = h(`<div class="xed-hint">No model loaded — enter a URL above, then preview.</div>`);
    const prevCanvas = document.createElement('canvas');
    prevCanvas.style.cssText = 'width:100%;height:180px;border-radius:8px;background:#0a0e16;display:none';
    const remapBox = h(`<div style="display:none;flex-direction:column;gap:6px;margin-top:6px"></div>`);
    const prevBtn = h(`<button class="xed-iconbtn">▶ PREVIEW MODEL</button>`) as HTMLButtonElement;
    prevBtn.addEventListener('click', () =>
      void previewCharacterModel(purl.value.trim(), { status: prevStatus, canvas: prevCanvas, remapBox }));
    const prevBox = h(`<div class="xed-card" style="padding:8px"></div>`);
    prevBox.append(prevStatus, prevCanvas, prevBtn, remapBox);
    pcard.appendChild(prevBox);
    host.appendChild(pcard);

    // ---- enemies card
    const ecard = h(`<div class="xed-asset"><div class="xed-aname">ENEMIES</div></div>`);
    for (const kind of ENEMY_KINDS) {
      const slot = getCharacterSlot(s, kind);
      const row = h(`<div style="display:flex;flex-direction:column;gap:6px;padding:6px 0;border-top:1px solid #1e2a45"></div>`);
      row.appendChild(h(`<div class="xed-flabel">${kind.toUpperCase()}</div>`));
      row.appendChild(field('SKIN', skinSelect(slot.skin, kind)));
      if (kind === 'walker' || kind === 'brute') {
        const eurl = document.createElement('input');
        eurl.type = 'text'; eurl.value = slot.model ?? ''; eurl.placeholder = 'https://…/enemy.glb';
        eurl.addEventListener('change', () =>
          commit((sp) => setCharacterSlot(sp, kind, { model: eurl.value.trim() || undefined }), false));
        row.appendChild(field('MODEL URL', eurl));
      }
      ecard.appendChild(row);
    }
    ecard.appendChild(h(`<div class="xed-hint">Model import applies to walker/brute only — drone/flyer/turret keep their forged builds. Custom skins are authored in the spec JSON under <b>custom.characters.skins</b> (built-ins: default, crimson, stealth, gold).</div>`));
    host.appendChild(ecard);
  }

  /** Live GLB preview pane (phase 1): turntable render + node list → bone-remap dropdowns. */
  async function previewCharacterModel(
    url: string,
    ui: { status: HTMLElement; canvas: HTMLCanvasElement; remapBox: HTMLElement },
  ): Promise<void> {
    const prev = (ui.canvas as unknown as { __preview?: { stop(): void } }).__preview;
    prev?.stop();
    if (!url) { ui.status.textContent = 'Enter a model URL first.'; return; }
    ui.status.textContent = 'loading…';
    ui.canvas.style.display = 'block';
    let renderer: THREE.WebGLRenderer | null = null;
    let raf = 0;
    let alive = true;
    const stop = () => { alive = false; cancelAnimationFrame(raf); renderer?.dispose(); };
    (ui.canvas as unknown as { __preview: { stop(): void } }).__preview = { stop };
    try {
      const gltf = await Promise.race([
        new GLTFLoader().loadAsync(url),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout after 20s')), 20000)),
      ]);
      if (!alive) return;
      fitModelToHeight(gltf.scene); // same normalization the engine applies
      renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, alpha: true });
      renderer.setSize(ui.canvas.clientWidth || 300, 180, false);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
      const dir = new THREE.DirectionalLight(0xffffff, 1.5);
      dir.position.set(2, 4, 3);
      scene.add(dir);
      const pivot = new THREE.Group();
      pivot.add(gltf.scene);
      scene.add(pivot);
      const cam = new THREE.PerspectiveCamera(40, (ui.canvas.clientWidth || 300) / 180, 0.05, 100);
      cam.position.set(0, 1.1, 3.4);
      cam.lookAt(0, 0.9, 0);
      const names: string[] = [];
      gltf.scene.traverse((o) => { if (o.name && !names.includes(o.name)) names.push(o.name); });
      names.sort();
      const resolved = resolvePivots(gltf.scene);
      buildBoneRemap(ui.remapBox, names, resolved);
      ui.status.textContent = `✓ loaded — ${names.length} named nodes. If the pose looks wrong in-game, remap pivots below.`;
      const tick = () => {
        if (!alive || !ui.canvas.isConnected) { stop(); return; }
        pivot.rotation.y += 0.012;
        renderer!.render(scene, cam);
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      if (!alive) return;
      ui.canvas.style.display = 'none';
      ui.status.textContent = `✗ preview failed: ${e instanceof Error ? e.message : String(e)} — the game keeps the procedural rig.`;
    }
  }

  /** Bone-remap dropdowns (phase 1): pivot → node name, written into the player slot's boneMap. */
  function buildBoneRemap(
    box: HTMLElement,
    names: string[],
    resolved: Partial<Record<CharacterPivot, THREE.Object3D>>,
  ): void {
    box.innerHTML = '';
    box.style.display = 'flex';
    const cur = working ? getCharacterSlot(working, 'player').boneMap ?? {} : {};
    box.appendChild(h(`<div class="xed-flabel">BONE REMAP (pivot → model node)</div>`));
    for (const pivot of CHARACTER_PIVOTS) {
      const auto = resolved[pivot]?.name;
      const sel = document.createElement('select');
      const add = (v: string, label: string) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = label; o.selected = v === (cur[pivot] ?? '');
        sel.appendChild(o);
      };
      add('', auto ? `(auto: ${auto})` : '(auto: not found)');
      for (const n of names) add(n, n);
      sel.addEventListener('change', () =>
        commit((sp) => setBoneMapEntry(sp, 'player', pivot, sel.value), false));
      const row = h(`<div class="xed-chrow"></div>`);
      row.appendChild(h(`<span class="xed-flabel" style="min-width:64px">${pivot}</span>`));
      row.appendChild(sel);
      box.appendChild(row);
    }
  }

  function renderAssets(s: GameSpec, host: HTMLElement): void {
    renderCharacters(s, host);
    renderReskins(s, host);
    host.appendChild(h(`<div class="xed-ns">MODEL &amp; WORLD TWEAKS</div>`));
    host.appendChild(h(`<div class="xed-hint">These write to <b>custom.*</b> paths the engine honors today — what you set is what Play shows.</div>`));
    for (const group of ASSET_GROUPS) {
      if (group.namespace === 'packs') continue; // packs live in the Generate view's online options
      host.appendChild(h(`<div class="xed-ns">${group.label.toUpperCase()}</div>`));
      for (const asset of group.assets) {
        const box = h(`<div class="xed-asset"><div class="xed-aname">${asset.label}</div>${asset.hint ? `<div class="xed-hint">${asset.hint}</div>` : ''}</div>`);
        for (const c of asset.controls) renderAssetControl(s, c, box);
        host.appendChild(box);
      }
    }
  }

  /**
   * Reskin grid: the engine's named asset registry (ASSET_IDS), one row per id
   * with color + scale + visible. Writes the override-record contract to
   * spec.custom.assets.
   */
  function renderReskins(s: GameSpec, host: HTMLElement): void {
    host.appendChild(h(`<div class="xed-ns">RESKIN OVERRIDES</div>`));
    const shape = customAssetsShape(s);

    if (shape === 'packs') {
      const warn = h(`<div class="xed-card"><div class="xed-hint" style="color:#ff9d5a">⚠ Asset packs are enabled — the engine ignores per-asset reskins while packs are on.</div></div>`);
      const btn = h(`<button class="xed-iconbtn">REMOVE PACKS &amp; USE RESKINS</button>`) as HTMLButtonElement;
      btn.addEventListener('click', () => commit((sp) => clearCustomAssets(sp), true));
      warn.appendChild(btn);
      host.appendChild(warn);
      return;
    }

    if (reskinOverridesPresent(s)) {
      const note = h(`<div class="xed-card"><div class="xed-hint" style="color:#ff9d5a">⚠ Reskin overrides are saved into your spec and your <b>.xandria.json</b> projects, but the engine schema update that applies them at boot is still landing — <b>Play is gated until then</b>. Everything else in the editor works.</div></div>`);
      const row = h(`<div class="xed-toolbar"></div>`);
      const playBare = h(`<button class="xed-iconbtn">▶ PLAY WITHOUT RESKINS</button>`) as HTMLButtonElement;
      playBare.title = 'Boots the game with reskin overrides stripped (your working spec keeps them)';
      playBare.addEventListener('click', () => {
        if (!working) return;
        const stripped = cloneSpec(working);
        clearCustomAssets(stripped);
        if (validateEditable(stripped).ok) cb.play(stripped);
      });
      const clear = h(`<button class="xed-iconbtn">CLEAR RESKINS</button>`) as HTMLButtonElement;
      clear.addEventListener('click', () => commit((sp) => clearCustomAssets(sp), true));
      row.append(playBare, clear);
      note.appendChild(row);
      host.appendChild(note);
    } else {
      host.appendChild(h(`<div class="xed-hint">Tint, resize, or hide any named asset — player, enemies, pickups, world. Overrides are visual-only (never touch physics or AI) and apply deterministically.</div>`));
    }

    for (const ns of reskinNamespaces()) {
      const det = document.createElement('details');
      det.className = 'xed-asset';
      const sum = document.createElement('summary');
      sum.style.cssText = 'cursor:pointer;font-size:12.5px;color:#a9bcd8;font-weight:600;letter-spacing:.06em';
      const refreshSummary = () => {
        const n = working ? ns.ids.filter((id) => getReskinOverride(working!, id) !== undefined).length : 0;
        sum.textContent = `${ns.label} — ${ns.ids.length} assets${n ? ` (${n} overridden)` : ''}`;
      };
      refreshSummary();
      det.appendChild(sum);
      for (const id of ns.ids) {
        det.appendChild(reskinRow(s, id, refreshSummary));
      }
      host.appendChild(det);
    }
  }

  /** One reskin row: color picker + scale slider + visible toggle. */
  function reskinRow(s: GameSpec, id: string, refreshSummary: () => void): HTMLElement {
    const row = h(`<div class="xed-asset" style="padding:8px"></div>`);
    row.appendChild(h(`<div class="xed-aname" style="font-size:12px">${id}</div>`));
    const cur = getReskinOverride(s, id) ?? {};
    const set = (patch: Partial<AssetOverride>) => {
      commit((sp) => {
        const next: AssetOverride = { ...getReskinOverride(sp, id), ...patch };
        // drop channels sitting at their defaults so the spec stays clean
        if ((next.color ?? '') === '') delete next.color;
        if ((next.scale ?? 1) === 1) delete next.scale;
        if ((next.visible ?? true) === true) delete next.visible;
        setReskinOverride(sp, id, isDefaultReskin(next) ? undefined : next);
      }, false);
      refreshSummary();
    };
    const grid = h(`<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"></div>`);
    grid.appendChild(field('COLOR', colorField(cur.color ?? '#ffffff', (_sp, v) => { set({ color: v }); })));
    const scaleWrap = h(`<div class="xed-field"><div class="xed-flabel">SCALE</div></div>`);
    scaleWrap.appendChild(slider(cur.scale ?? 1, 0.05, 10, 0.05, (_sp, v) => { set({ scale: Math.round(v * 100) / 100 }); }, (v) => `${v.toFixed(2)}×`));
    grid.appendChild(scaleWrap);
    const vis = h(`<label class="xed-checkrow"></label>`);
    const vi = document.createElement('input');
    vi.type = 'checkbox'; vi.checked = cur.visible ?? true;
    vi.addEventListener('change', () => set({ visible: vi.checked }));
    vis.append(vi, document.createTextNode('visible'));
    grid.appendChild(vis);
    const reset = iconBtn('reset', 'Clear this asset\'s override', () => commit((sp) => setReskinOverride(sp, id, undefined), true));
    grid.appendChild(reset);
    row.appendChild(grid);
    return row;
  }

  function renderTab(): void {
    body.innerHTML = '';
    if (!working) {
      body.appendChild(h(`<div class="xed-empty">✦<br/>GENERATE A GAME FIRST,<br/>THEN EDIT IT HERE</div>`));
      return;
    }
    const s = working;
    if (activeTab === 'story') renderStory(s, body);
    else if (activeTab === 'world') renderWorld(s, body);
    else if (activeTab === 'player') renderPlayer(s, body);
    else if (activeTab === 'enemies') renderEnemies(s, body);
    else if (activeTab === 'pickups') renderPickups(s, body);
    else renderAssets(s, body);
  }

  // ---------------------------------------------------------- wiring
  playBtn.addEventListener('click', () => {
    if (!working) return;
    if (!refreshValidation()) return; // never play an invalid spec
    cb.play(cloneSpec(working));
  });

  regenBtn.addEventListener('click', () => {
    const next = cb.regenerate();
    if (next) panel.setSpec(next);
  });

  saveBtn.addEventListener('click', () => {
    if (!working || !refreshValidation()) return;
    cb.saveProject(cloneSpec(working));
  });

  loadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const spec = await cb.loadProject(f);
      panel.setSpec(spec);
    } catch (e) {
      // The message echoes project-file content (spec strings) — escape it.
      const msg = escapeHtml(e instanceof Error ? e.message : String(e)).replace(/\n/g, '<br/>');
      errBox.innerHTML = `<div class="xed-err"><b>load</b>: ${msg}</div>`;
      errBox.classList.add('show');
      // R3-N2: the working spec is stale after a failed load — never leave
      // PLAY armed on it. It re-arms on the next successful load (setSpec ->
      // refreshValidation) or once the user edits the spec back to validity.
      playBtn.disabled = true;
      okLine.style.display = 'none';
    }
  });

  const panel: EditorPanel = {
    root,
    setSpec(spec: GameSpec | null) {
      working = spec ? cloneSpec(spec) : null;
      enemyBase = working ? snapshotEnemies(working) : [];
      seedBadge.textContent = working ? `seed ${working.meta.seed}` : '';
      refreshValidation();
      renderTab();
    },
    getSpec() {
      return working ? cloneSpec(working) : null;
    },
  };

  renderTabbar();
  renderTab();
  refreshValidation();
  return panel;
}

/** Convenience: validate + parse an uploaded project file (used by the host). */
export async function readProjectFile(file: File): Promise<GameSpec> {
  const text = await file.text();
  return projectFromJson(text);
}
