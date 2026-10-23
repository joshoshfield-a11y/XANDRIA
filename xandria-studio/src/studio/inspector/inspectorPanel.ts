/**
 * <xandria-spec-inspector> — self-contained Shadow DOM panel for the v1 edit loop.
 *
 * Zero imports from studio.ts and zero engine imports, so it can land before
 * the studio is rewired. Integration is one line in studio.ts:
 *
 *   import './inspector/inspectorPanel';
 *   const panel = document.createElement('xandria-spec-inspector');
 *   document.body.append(panel);
 *   panel.spec = currentSpec;
 *   panel.addEventListener('xandria-spec-patch', (e) => {
 *     const { spec: next, changed } = applyPatch(currentSpec, e.detail, panel.lockedKeys);
 *     if (changed.length > 0) { currentSpec = next; reloadPreview(currentSpec); }
 *   });
 *
 * The element renders only fields actually present in the spec (via
 * readFields), so it adapts to schema changes without edits.
 */

import {
  readFields,
  type FieldDef,
  type FieldValue,
  type Scalar,
} from './specInspector';

const CSS = `
  :host {
    position: fixed; right: 12px; top: 12px; z-index: 9999;
    font: 12px/1.4 system-ui, sans-serif; color: #e8e8f0;
  }
  .panel {
    width: 220px; background: #14141c; border: 1px solid #2a2a3a;
    border-radius: 8px; padding: 10px; box-shadow: 0 4px 24px #000a;
  }
  .panel.collapsed { width: auto; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  h2 { margin: 0 0 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #9a9ab0; }
  .head h2 { margin: 0; }
  .toggle { background: #1e1e2a; color: inherit; border: 1px solid #2a2a3a; border-radius: 4px;
            width: 22px; height: 22px; line-height: 1; padding: 0; cursor: pointer; flex: 0 0 auto; }
  label { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 6px 0; }
  input[type='range'] { width: 110px; }
  input[type='number'], select { width: 110px; background: #1e1e2a; color: inherit; border: 1px solid #2a2a3a; border-radius: 4px; padding: 2px 4px; }
  input[type='color'] { width: 32px; height: 22px; border: none; background: none; padding: 0; }
  .lock { color: #c8a848; }
  .empty { color: #777; font-style: italic; }
`;

export class XandriaSpecInspector extends HTMLElement {
  #spec: Record<string, unknown> | null = null;
  #locked = new Set<string>(['seed']); // seed locked by default — v1 lock requirement
  #fields: FieldValue[] = [];
  /** F1 (QA 2026-10-22): collapsed = header bar only. The panel is fixed
   *  top-right with no dismiss control pre-fix and covered ~65% of the
   *  game on a phone in landscape. */
  #collapsed = false;
  #collapseInit = false;

  static get observedAttributes(): string[] { return []; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  /** Collapsed state (header only). Settable by the host (studio play mode
   *  hides the panel entirely via CSS; this is the in-studio control). */
  get collapsed(): boolean { return this.#collapsed; }
  set collapsed(v: boolean) { this.#collapsed = v; this.#render(); }

  /** The current spec. Setting it re-renders the panel. */
  set spec(value: Record<string, unknown> | null) {
    this.#spec = value;
    this.#fields = value ? readFields(value) : [];
    this.#render();
  }
  get spec(): Record<string, unknown> | null { return this.#spec; }

  /** Keys the panel refuses to emit patches for (seed lock is UI state). */
  get lockedKeys(): string[] { return [...this.#locked]; }

  setLocked(key: string, locked: boolean): void {
    if (locked) this.#locked.add(key); else this.#locked.delete(key);
    this.#render();
  }

  connectedCallback(): void {
    if (!this.#collapseInit) {
      this.#collapseInit = true;
      // F1: default collapsed on phone-width layouts — the expanded panel
      // would cover most of the game before the user even starts.
      try {
        if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) this.#collapsed = true;
      } catch { /* non-browser hosts: stay expanded */ }
    }
    this.#render();
  }

  #emit(key: string, value: Scalar): void {
    if (this.#locked.has(key)) return;
    this.dispatchEvent(new CustomEvent<Record<string, Scalar>>('xandria-spec-patch', {
      detail: { [key]: value },
      bubbles: true,
      composed: true,
    }));
  }

  #control(def: FieldDef, value: Scalar): HTMLElement {
    const wrap = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = def.label;
    wrap.append(name);

    const locked = this.#locked.has(def.key);
    let input: HTMLElement;

    if (def.kind === 'color') {
      const el = document.createElement('input');
      el.type = 'color';
      el.value = String(value);
      el.disabled = locked;
      el.addEventListener('input', () => this.#emit(def.key, el.value));
      input = el;
    } else if (def.kind === 'select') {
      const el = document.createElement('select');
      for (const opt of def.options ?? []) {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (opt === value) o.selected = true;
        el.append(o);
      }
      el.disabled = locked;
      el.addEventListener('change', () => this.#emit(def.key, el.value));
      input = el;
    } else {
      const el = document.createElement('input');
      el.type = def.kind === 'range' ? 'range' : 'number';
      if (def.min !== undefined) el.min = String(def.min);
      if (def.max !== undefined) el.max = String(def.max);
      if (def.step !== undefined) el.step = String(def.step);
      el.value = String(value);
      el.disabled = locked;
      el.addEventListener('input', () => this.#emit(def.key, Number(el.value)));
      input = el;
    }

    wrap.append(input);

    if (def.key === 'seed') {
      const lock = document.createElement('button');
      lock.className = 'lock';
      lock.textContent = locked ? '🔒' : '🔓';
      lock.title = locked ? 'Unlock seed' : 'Lock seed';
      lock.addEventListener('click', () => this.setLocked('seed', !this.#locked.has('seed')));
      wrap.append(lock);
    }

    return wrap;
  }

  #render(): void {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = CSS;
    this.shadowRoot.append(style);

    const panel = document.createElement('div');
    panel.className = this.#collapsed ? 'panel collapsed' : 'panel';
    const head = document.createElement('div');
    head.className = 'head';
    const h = document.createElement('h2');
    h.textContent = 'Spec Inspector';
    const toggle = document.createElement('button');
    toggle.className = 'toggle';
    toggle.textContent = this.#collapsed ? '+' : '–';
    toggle.title = this.#collapsed ? 'Expand spec inspector' : 'Collapse spec inspector';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.addEventListener('click', () => { this.#collapsed = !this.#collapsed; this.#render(); });
    head.append(h, toggle);
    panel.append(head);

    if (!this.#collapsed) {
      if (this.#fields.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No spec loaded';
        panel.append(empty);
      } else {
        for (const f of this.#fields) panel.append(this.#control(f.def, f.value));
      }
    }

    this.shadowRoot.append(panel);
  }
}

if (!customElements.get('xandria-spec-inspector')) {
  customElements.define('xandria-spec-inspector', XandriaSpecInspector);
}
