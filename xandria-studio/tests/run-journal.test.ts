/**
 * Run-journal wave unit tests.
 *
 * - Profile journal store: recordJournalEntry ordering + cap, migrateProfile
 *   storage guard (malformed entries migrated/dropped, never throws).
 * - JournalPanel (fake DOM): renders last-20 rows newest-first, empty state,
 *   Esc close, open/close state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  JOURNAL_CAP,
  _setProfileStorage,
  defaultProfile,
  loadProfile,
  migrateProfile,
  recordJournalEntry,
  saveProfile,
  type RunJournalEntry,
} from '../src/engine/game/Profile';
import { JournalPanel, JOURNAL_PANEL_LIMIT } from '../src/engine/ui/JournalPanel';

function entry(over: Partial<RunJournalEntry> = {}): RunJournalEntry {
  return {
    startUtc: '2026-10-23T15:04:00.000Z',
    seed: 20261012,
    genre: 'third-person-action',
    duration: 754,
    kills: 5,
    deaths: 1,
    portals: 2,
    xpGained: 320,
    bossesKilled: 1,
    result: 'won',
    ...over,
  };
}

describe('run journal store', () => {
  it('recordJournalEntry prepends newest-first', () => {
    const p = defaultProfile();
    recordJournalEntry(p, entry({ seed: 1 }));
    recordJournalEntry(p, entry({ seed: 2 }));
    expect(p.journal.map((e) => e.seed)).toEqual([2, 1]);
  });

  it('caps stored entries at JOURNAL_CAP', () => {
    const p = defaultProfile();
    for (let i = 0; i < JOURNAL_CAP + 10; i++) {
      recordJournalEntry(p, entry({ seed: i, startUtc: `2026-10-23T15:${String(i % 60).padStart(2, '0')}:00.000Z` }));
    }
    expect(p.journal.length).toBe(JOURNAL_CAP);
    expect(p.journal[0].seed).toBe(JOURNAL_CAP + 9); // newest survives
  });

  it('migrateProfile: missing journal defaults to []', () => {
    const p = migrateProfile({ version: 1 });
    expect(p.journal).toEqual([]);
  });

  it('migrateProfile: non-array journal becomes []', () => {
    for (const bad of [null, undefined, 42, 'nope', { length: 2 }]) {
      expect(migrateProfile({ journal: bad }).journal).toEqual([]);
    }
  });

  it('migrateProfile: malformed entries are migrated or dropped, never throws', () => {
    const p = migrateProfile({
      journal: [
        null,
        42,
        'string-entry',
        ['nested', 'array'],
        { startUtc: 123, genre: 'x' }, // startUtc not a string -> dropped
        { startUtc: 't', genre: 7 }, // genre not a string -> dropped
        {
          // salvageable: bad numbers clamped/coerced, result coerced
          startUtc: '2026-10-23T15:04:00.000Z',
          genre: 'fps-arena',
          seed: -5,
          duration: NaN,
          kills: Infinity,
          deaths: '3',
          portals: 1.9,
          xpGained: null,
          bossesKilled: undefined,
          result: 'maybe',
        },
      ],
    });
    expect(p.journal.length).toBe(1);
    const e = p.journal[0];
    expect(e.startUtc).toBe('2026-10-23T15:04:00.000Z');
    expect(e.genre).toBe('fps-arena');
    expect(e.seed).toBe(0);
    expect(e.duration).toBe(0);
    expect(e.kills).toBe(0);
    expect(e.deaths).toBe(0);
    expect(e.portals).toBe(1);
    expect(e.xpGained).toBe(0);
    expect(e.bossesKilled).toBe(0);
    expect(e.result).toBe('lost'); // anything but 'won' -> 'lost'
  });

  it('migrateProfile: garbage top-level input never throws', () => {
    for (const bad of [null, undefined, 0, 'x', [1, 2], '{"unclosed']) {
      expect(() => migrateProfile(bad)).not.toThrow();
    }
  });

  it('save/load round-trips the journal through injected storage', () => {
    const m = new Map<string, string>();
    _setProfileStorage({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } });
    try {
      const p = defaultProfile();
      recordJournalEntry(p, entry({ seed: 99, result: 'lost' }));
      saveProfile(p);
      const q = loadProfile();
      expect(q.journal.length).toBe(1);
      expect(q.journal[0]).toMatchObject({ seed: 99, result: 'lost', kills: 5 });
    } finally {
      _setProfileStorage(undefined);
    }
  });

  it('a corrupt stored journal migrates cleanly on load', () => {
    const m = new Map<string, string>();
    m.set('xandria.profile.v1', JSON.stringify({
      version: 1,
      journal: [{ startUtc: 't', genre: 'g' }, null, 'junk'],
    }));
    _setProfileStorage({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } });
    try {
      const q = loadProfile();
      expect(q.journal.length).toBe(1);
      expect(q.journal[0].result).toBe('lost');
    } finally {
      _setProfileStorage(undefined);
    }
  });
});

// ---------------------------------------------------------------- fake DOM

function makeEl(tag = 'div'): any {
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as any,
    _ownText: '',
    dataset: {} as Record<string, string>,
    parentNode: null,
    _listeners: {} as Record<string, Array<(e: any) => void>>,
    appendChild(c: any) { c.parentNode = el; el.children.push(c); return c; },
    append(...cs: any[]) { for (const c of cs) el.appendChild(c); },
    remove() {
      if (el.parentNode) {
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
        el.parentNode = null;
      }
    },
    setAttribute(k: string, v: string) { el[`attr_${k}`] = v; },
    addEventListener(t: string, fn: (e: any) => void) { (el._listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: (e: any) => void) {
      el._listeners[t] = (el._listeners[t] ?? []).filter((f: (e: any) => void) => f !== fn);
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => '',
    set: () => { el.children = []; },
  });
  // like the real DOM, textContent aggregates descendant text unless set
  Object.defineProperty(el, 'textContent', {
    get: () => el._ownText || el.children.map((c: any) => c.textContent).join(''),
    set: (v: string) => { el._ownText = v; },
  });
  return el;
}

function makeDoc() {
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const doc: any = {
    createElement: (t: string) => makeEl(t),
    addEventListener: (t: string, fn: (e: any) => void) => { (listeners[t] ??= []).push(fn); },
    removeEventListener: (t: string, fn: (e: any) => void) => {
      listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
    },
    keydown(key: string) {
      const e = { key, stopPropagation() {} };
      for (const fn of listeners['keydown'] ?? []) fn(e);
    },
  };
  return doc;
}

describe('JournalPanel', () => {
  it('renders the newest JOURNAL_PANEL_LIMIT rows, newest first', () => {
    const entries = Array.from({ length: 25 }, (_, i) =>
      entry({ seed: i, startUtc: `2026-10-23T15:${String(i).padStart(2, '0')}:00.000Z` }));
    const doc = makeDoc();
    const container = makeEl('div');
    const panel = new JournalPanel({ container, doc, journal: () => entries });
    panel.show();
    expect(panel.isOpen()).toBe(true);
    const root = (panel as unknown as { root: any }).root;
    const rowsEl = root.children[1];
    expect(rowsEl.children.length).toBe(JOURNAL_PANEL_LIMIT);
    // newest first
    expect(rowsEl.children[0].dataset.seed).toBe('0');
    expect(rowsEl.children[0].dataset.startUtc).toBe('2026-10-23T15:00:00.000Z');
    // row stat text carries the observed counts
    expect(rowsEl.children[0].textContent).toContain('K 5');
    expect(rowsEl.children[0].textContent).toContain('D 1');
    expect(rowsEl.children[0].textContent).toContain('P 2');
    expect(rowsEl.children[0].textContent).toContain('+320 XP');
    panel.dispose();
  });

  it('shows the empty state when there are no runs', () => {
    const doc = makeDoc();
    const container = makeEl('div');
    const panel = new JournalPanel({ container, doc, journal: () => [] });
    panel.show();
    const root = (panel as unknown as { root: any }).root;
    expect(root.children[1].textContent).toContain('No runs yet');
    panel.dispose();
  });

  it('Esc closes the panel; a throwing journal getter cannot break open', () => {
    const doc = makeDoc();
    const container = makeEl('div');
    const panel = new JournalPanel({
      container,
      doc,
      journal: () => { throw new Error('boom'); },
    });
    expect(() => panel.show()).not.toThrow();
    expect(panel.isOpen()).toBe(true);
    doc.keydown('Escape');
    expect(panel.isOpen()).toBe(false);
    panel.dispose();
  });

  it('re-reads the journal on every open', () => {
    let entries: RunJournalEntry[] = [];
    const doc = makeDoc();
    const container = makeEl('div');
    const panel = new JournalPanel({ container, doc, journal: () => entries });
    panel.show();
    const root = (panel as unknown as { root: any }).root;
    // empty state: one message div, no data rows
    expect(root.children[1].children.length).toBe(1);
    expect(root.children[1].textContent).toContain('No runs yet');
    panel.hide();
    entries = [entry({ seed: 7 })];
    panel.show();
    expect(root.children[1].children.length).toBe(1);
    expect(root.children[1].children[0].dataset.seed).toBe('7');
    panel.dispose();
  });
});
