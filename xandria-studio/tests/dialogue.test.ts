/**
 * Dialogue-branching wave — unit tests.
 *
 * - The shipped DIALOGUE_TREES table validates clean; broken variants
 *   are caught (duplicate nodes, missing start, dangling targets,
 *   unknown factions, to+end on one choice).
 * - Conditions: minStanding / quest state / item held each gate exactly,
 *   combined conditions AND, lock reasons name the failing condition.
 * - choose(): choice A (help) vs choice B (brush-off) land exact distinct
 *   outcomes; locked choices apply and record nothing; end choices close;
 *   flags + visited + last-node persist through snapshot/restore.
 * - DialogueState: snapshot/restore round-trip, corrupt restores drop
 *   bad entries, storage adapter round-trip (same adapter instance, the
 *   factions-test pattern).
 * - DialoguePanel.showTree: choices render with data attributes, locked
 *   choices disabled with their reason, touch targets >= 28px in style.
 */
import { describe, it, expect } from 'vitest';
import {
  DIALOGUE_TREES,
  DialogueEngine,
  DialogueState,
  FIRST_QUEST_REF,
  localStorageDialogueAdapter,
  validateDialogueTree,
  validateDialogueTrees,
  type DialogueChoiceDef,
  type DialogueContext,
  type DialogueTreeDef,
} from '../src/engine/game/dialogue';
import type { QuestStatus } from '../src/engine/game/quests';
import { DialoguePanel } from '../src/engine/ui/DialoguePanel';
import {
  capturePlayerState,
  applyPlayerState,
  type PortalParts,
} from '../src/engine/world/PortalState';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface FakeCtxState {
  standings: Record<string, number>;
  questStatuses: Record<string, QuestStatus>;
  items: Record<string, number>;
  accepted: string[];
  turnedIn: string[];
  adjusted: Array<{ factionId: string; amount: number }>;
}

function fakeCtx(state: FakeCtxState): DialogueContext {
  return {
    standingOf: (f) => state.standings[f] ?? 0,
    questStatusOf: (ref) => {
      if (ref === FIRST_QUEST_REF) return state.questStatuses['q-first'] ?? 'unknown';
      return state.questStatuses[ref] ?? 'unknown';
    },
    questAccept: (ref) => {
      const id = ref === 'first-available' ? 'q-first' : ref;
      if ((state.questStatuses[id] ?? 'unknown') !== 'available') return false;
      state.accepted.push(id);
      state.questStatuses[id] = 'active';
      return true;
    },
    questTurnIn: (ref) => {
      const id = ref === 'first-complete' ? 'q-first' : ref;
      if ((state.questStatuses[id] ?? 'unknown') !== 'complete') return false;
      state.turnedIn.push(id);
      state.questStatuses[id] = 'turned-in';
      return true;
    },
    itemCount: (id) => state.items[id] ?? 0,
    adjustStanding: (f, amt) => {
      state.adjusted.push({ factionId: f, amount: amt });
      state.standings[f] = (state.standings[f] ?? 0) + amt;
    },
  };
}

function freshState(): FakeCtxState {
  return {
    standings: { freeholds: 0, ironfangs: 0, ember_order: 0 },
    questStatuses: { 'q-first': 'available' },
    items: {},
    accepted: [],
    turnedIn: [],
    adjusted: [],
  };
}

// Minimal DOM stub with parent-tracked remove() + firstChild (the
// factions-test makeEl pattern, extended for the panel's rebuild loops).
function makeEl(tag = 'div'): any {
  const el: any = {
    tag, children: [] as any[], style: {}, textContent: '', id: '',
    disabled: false, attrs: new Map<string, string>(), _handlers: {} as Record<string, (...a: any[]) => void>,
    appendChild(c: any) { el.children.push(c); c._parent = el; return c; },
    append(...cs: any[]) { for (const c of cs) { el.children.push(c); c._parent = el; } },
    remove() { const p = el._parent; if (p) p.children = p.children.filter((c: any) => c !== el); },
    setAttribute(k: string, v: string) { el.attrs.set(k, v); },
    getAttribute(k: string) { return el.attrs.get(k) ?? null; },
    removeAttribute(k: string) { el.attrs.delete(k); },
    addEventListener(t: string, h: (...a: any[]) => void) { el._handlers[t] = h; },
    removeEventListener() {},
    click() { el._handlers.click?.({}); },
  };
  Object.defineProperty(el, 'firstChild', { get() { return el.children[0] ?? null; } });
  return el;
}

function fakeDoc(): any {
  return { createElement: (tag: string) => makeEl(tag) };
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

describe('dialogue table validation', () => {
  it('the shipped DIALOGUE_TREES table validates clean', () => {
    expect(validateDialogueTrees(DIALOGUE_TREES)).toEqual([]);
    expect(DIALOGUE_TREES.length).toBe(1);
    expect(DIALOGUE_TREES[0].role).toBe('villager');
  });

  it('rejects duplicate node ids, a missing start, and dangling targets', () => {
    const dup: DialogueTreeDef = {
      id: 't', role: 'r', start: 'a',
      nodes: [
        { id: 'a', speaker: 'S', lines: ['hi'], choices: [] },
        { id: 'a', speaker: 'S', lines: ['hi'], choices: [] },
      ],
    };
    expect(validateDialogueTree(dup).join(' ')).toContain('duplicate node id');
    const noStart: DialogueTreeDef = {
      id: 't', role: 'r', start: 'missing',
      nodes: [{ id: 'a', speaker: 'S', lines: ['hi'], choices: [] }],
    };
    expect(validateDialogueTree(noStart).join(' ')).toContain("start node 'missing'");
    const dangling: DialogueTreeDef = {
      id: 't', role: 'r', start: 'a',
      nodes: [{ id: 'a', speaker: 'S', lines: ['hi'], choices: [{ id: 'c', label: 'go', effects: { to: 'nope' } }] }],
    };
    expect(validateDialogueTree(dangling).join(' ')).toContain("target node 'nope'");
  });

  it('rejects unknown factions and to+end on one choice', () => {
    const bad: DialogueTreeDef = {
      id: 't', role: 'r', start: 'a',
      nodes: [{
        id: 'a', speaker: 'S', lines: ['hi'],
        choices: [
          { id: 'c1', label: 'x', conditions: { minStanding: { factionId: 'nope', min: 1 } } },
          { id: 'c2', label: 'y', effects: { to: 'a', end: true } },
        ],
      }],
    };
    const errs = validateDialogueTree(bad).join(' ');
    expect(errs).toContain("unknown faction 'nope'");
    expect(errs).toContain("must not set both 'to' and 'end'");
  });

  it('rejects duplicate tree ids / roles across the table', () => {
    const [t] = DIALOGUE_TREES;
    const errs = validateDialogueTrees([t, { ...t }]).join(' ');
    expect(errs).toContain('duplicate dialogue tree id');
    expect(errs).toContain('duplicate dialogue tree role');
  });
});

// ---------------------------------------------------------------------------
// engine: conditions + choose
// ---------------------------------------------------------------------------

describe('DialogueEngine conditions', () => {
  const engine = new DialogueEngine();
  const tree = engine.treeForRole('villager')!;
  const greeting = engine.nodeOf(tree, 'greeting')!;

  it('resolves the villager tree and its start node', () => {
    expect(tree.id).toBe('settler');
    expect(tree.start).toBe('greeting');
    expect(engine.treeForRole('vendor')).toBeNull();
    expect(engine.nodeOf(tree, 'nope')).toBeNull();
  });

  it('the standing-gated choice is locked at 0 and unlocked at 250', () => {
    const trusted = greeting.choices.find((c) => c.id === 'trusted')!;
    const s = freshState();
    expect(engine.evaluateChoice(trusted, fakeCtx(s)).locked).toBe(true);
    s.standings.freeholds = 249;
    expect(engine.evaluateChoice(trusted, fakeCtx(s)).locked).toBe(true);
    s.standings.freeholds = 250;
    const view = engine.evaluateChoice(trusted, fakeCtx(s));
    expect(view.locked).toBe(false);
    expect(view.lockReasons).toEqual([]);
  });

  it('lock reasons name the failing condition', () => {
    const trusted = greeting.choices.find((c) => c.id === 'trusted')!;
    const view = engine.evaluateChoice(trusted, fakeCtx(freshState()));
    expect(view.lockReasons).toEqual(['Requires freeholds standing 250 (have 0)']);
  });

  it('the item-gated choice needs mat_scrap held', () => {
    const news = engine.nodeOf(tree, 'news')!;
    const show = news.choices.find((c) => c.id === 'show-token')!;
    const s = freshState();
    expect(engine.evaluateChoice(show, fakeCtx(s)).locked).toBe(true);
    s.items['mat_scrap'] = 1;
    expect(engine.evaluateChoice(show, fakeCtx(s)).locked).toBe(false);
    expect(engine.evaluateChoice(show, fakeCtx(s)).lockReasons).toEqual([]);
  });

  it('the quest-state choice needs the first quest active', () => {
    const accepted = engine.nodeOf(tree, 'accepted')!;
    const status = accepted.choices.find((c) => c.id === 'job-status')!;
    const s = freshState();
    expect(engine.evaluateChoice(status, fakeCtx(s)).locked).toBe(true);
    s.questStatuses['q-first'] = 'active';
    expect(engine.evaluateChoice(status, fakeCtx(s)).locked).toBe(false);
  });

  it('displayText uses lines first, returnLines on revisit', () => {
    const state = new DialogueState();
    expect(engine.displayText(tree, greeting, state)).toContain('walked a long way');
    state.recordVisit(tree.id, greeting.id);
    expect(engine.displayText(tree, greeting, state)).toContain('Back again');
  });
});

describe('DialogueEngine choose()', () => {
  const engine = new DialogueEngine();
  const tree = engine.treeForRole('villager')!;

  it('choice A (help) navigates to offer, then take-job accepts the quest', () => {
    const s = freshState();
    const ctx = fakeCtx(s);
    const state = new DialogueState();
    const greeting = engine.nodeOf(tree, 'greeting')!;
    const r1 = engine.choose(tree, greeting, 'offer-help', ctx, state);
    expect(r1).toMatchObject({ nextNodeId: 'offer', ended: false, locked: false });
    expect(state.hasVisited(tree.id, 'greeting')).toBe(true);
    const offer = engine.nodeOf(tree, 'offer')!;
    const r2 = engine.choose(tree, offer, 'take-job', ctx, state);
    expect(r2.nextNodeId).toBe('accepted');
    expect(s.accepted).toEqual(['q-first']);
    expect(s.questStatuses['q-first']).toBe('active');
    expect(state.hasFlag('took-job')).toBe(true);
    expect(state.hasChosen(tree.id, 'offer', 'take-job')).toBe(true);
    expect(r2.applied).toContain('questAccept:first-available:true');
  });

  it('choice B (brush-off) drops standing, sets the flag, lands on cold', () => {
    const s = freshState();
    const ctx = fakeCtx(s);
    const state = new DialogueState();
    const greeting = engine.nodeOf(tree, 'greeting')!;
    const r = engine.choose(tree, greeting, 'brush-off', ctx, state);
    expect(r.nextNodeId).toBe('cold');
    expect(s.standings.freeholds).toBe(-10);
    expect(s.adjusted).toEqual([{ factionId: 'freeholds', amount: -10 }]);
    expect(state.hasFlag('brushed-off')).toBe(true);
    expect(s.accepted).toEqual([]);
  });

  it('the cold path is repairable: apologize restores +5 and returns to greeting', () => {
    const s = freshState();
    const ctx = fakeCtx(s);
    const state = new DialogueState();
    const greeting = engine.nodeOf(tree, 'greeting')!;
    engine.choose(tree, greeting, 'brush-off', ctx, state);
    const cold = engine.nodeOf(tree, 'cold')!;
    const r = engine.choose(tree, cold, 'apologize', ctx, state);
    expect(r.nextNodeId).toBe('greeting');
    expect(s.standings.freeholds).toBe(-5);
  });

  it('a locked choice applies nothing and records nothing', () => {
    const s = freshState();
    const ctx = fakeCtx(s);
    const state = new DialogueState();
    const greeting = engine.nodeOf(tree, 'greeting')!;
    const r = engine.choose(tree, greeting, 'trusted', ctx, state);
    expect(r.locked).toBe(true);
    expect(r.nextNodeId).toBe('greeting');
    expect(s.adjusted).toEqual([]);
    expect(state.hasChosen(tree.id, 'greeting', 'trusted')).toBe(false);
  });

  it('an end choice ends the dialogue and still records the visit', () => {
    const s = freshState();
    const state = new DialogueState();
    const cold = engine.nodeOf(tree, 'cold')!;
    const r = engine.choose(tree, cold, 'leave', fakeCtx(s), state);
    expect(r.ended).toBe(true);
    expect(r.nextNodeId).toBeNull();
    expect(state.hasVisited(tree.id, 'cold')).toBe(true);
  });

  it('an unknown choice id is a no-op that stays on the node', () => {
    const state = new DialogueState();
    const greeting = engine.nodeOf(tree, 'greeting')!;
    const r = engine.choose(tree, greeting, 'nope', fakeCtx(freshState()), state);
    expect(r).toMatchObject({ nextNodeId: 'greeting', ended: false, locked: false, applied: [] });
  });

  it('the trusted branch unlocks with standing and accepts the quest', () => {
    const s = freshState();
    s.standings.freeholds = 300;
    const ctx = fakeCtx(s);
    const state = new DialogueState();
    const greeting = engine.nodeOf(tree, 'greeting')!;
    const r1 = engine.choose(tree, greeting, 'trusted', ctx, state);
    expect(r1.nextNodeId).toBe('trusted');
    const trusted = engine.nodeOf(tree, 'trusted')!;
    const r2 = engine.choose(tree, trusted, 'trusted-job', ctx, state);
    expect(r2.nextNodeId).toBe('accepted');
    expect(s.accepted).toEqual(['q-first']);
  });
});

// ---------------------------------------------------------------------------
// state persistence
// ---------------------------------------------------------------------------

describe('DialogueState persistence', () => {
  it('snapshot/restore round-trips visited, choices, flags, lastNode', () => {
    const a = new DialogueState();
    a.recordVisit('settler', 'greeting');
    a.recordChoice('settler', 'greeting', 'brush-off', 'brushed-off');
    a.recordVisit('settler', 'cold');
    const snap = a.portalSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.lastNode).toEqual({ settler: 'cold' });
    const b = new DialogueState();
    b.portalRestore(snap);
    expect(b.hasVisited('settler', 'greeting')).toBe(true);
    expect(b.hasChosen('settler', 'greeting', 'brush-off')).toBe(true);
    expect(b.hasFlag('brushed-off')).toBe(true);
    expect(b.lastNodeFor('settler')).toBe('cold');
    expect(b.portalSnapshot()).toEqual(snap);
  });

  it('corrupt restores drop bad entries and never throw', () => {
    const state = new DialogueState();
    state.portalRestore({
      version: 1,
      visited: ['settler:greeting', 42 as any, null as any],
      choices: ['ok', undefined as any],
      flags: [123 as any, 'brushed-off'],
      lastNode: { settler: 'cold', bad: 7 as any },
    } as any);
    expect(state.hasVisited('settler', 'greeting')).toBe(true);
    expect(state.hasFlag('brushed-off')).toBe(true);
    expect(state.lastNodeFor('settler')).toBe('cold');
    expect(state.lastNodeFor('bad')).toBeNull();
    state.portalRestore(null);
    expect(state.hasVisited('settler', 'greeting')).toBe(true);
    state.portalRestore({ version: 2 } as any);
    expect(state.hasVisited('settler', 'greeting')).toBe(true);
  });

  it('persists through the storage adapter', () => {
    const adapter = localStorageDialogueAdapter(12345);
    const a = new DialogueState(adapter);
    a.recordVisit('settler', 'greeting');
    a.recordChoice('settler', 'greeting', 'offer-help');
    const b = new DialogueState(adapter);
    expect(b.hasVisited('settler', 'greeting')).toBe(true);
    expect(b.hasChosen('settler', 'greeting', 'offer-help')).toBe(true);
    expect(b.lastNodeFor('settler')).toBe('greeting');
  });

  it('a fresh state with no storage starts empty', () => {
    const state = new DialogueState();
    expect(state.portalSnapshot()).toEqual({ version: 1, visited: [], choices: [], flags: [], lastNode: {} });
  });
});

describe('DialogueState portal snapshot slice', () => {
  it('capturePlayerState carries the dialogue slice and applyPlayerState restores it', () => {
    const engine: any = { hud: { setHealth: () => {}, setLives: () => {} }, spec: { custom: {} } };
    const state = new DialogueState();
    state.recordVisit('settler', 'greeting');
    state.recordChoice('settler', 'greeting', 'brush-off', 'brushed-off');
    state.recordVisit('settler', 'cold');
    const parts: PortalParts = {
      avatar: null,
      inventory: null,
      progression: null,
      dialogue: state,
      getBuff: () => null,
      setBuff: () => {},
    };
    const snap = capturePlayerState(engine, parts);
    expect(snap.dialogue).toEqual(state.portalSnapshot());
    expect(snap.dialogue?.flags).toEqual(['brushed-off']);
    // mutate everything the slice covers, then restore from the snapshot
    state.recordVisit('settler', 'offer');
    state.setFlag('took-job');
    expect(state.hasVisited('settler', 'offer')).toBe(true);
    applyPlayerState(engine, parts, snap);
    expect(state.hasVisited('settler', 'offer')).toBe(false);
    expect(state.hasFlag('took-job')).toBe(false);
    expect(state.hasFlag('brushed-off')).toBe(true);
    expect(state.lastNodeFor('settler')).toBe('cold');
    expect(state.portalSnapshot()).toEqual(snap.dialogue);
  });

  it('snapshots without a dialogue part carry a null dialogue slice', () => {
    const engine: any = { hud: { setHealth: () => {}, setLives: () => {} }, spec: { custom: {} } };
    const parts: PortalParts = {
      avatar: null, inventory: null, progression: null,
      getBuff: () => null, setBuff: () => {},
    };
    expect(capturePlayerState(engine, parts).dialogue).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// panel rendering
// ---------------------------------------------------------------------------

describe('DialoguePanel.showTree', () => {
  it('renders choices with ids, locks disabled choices with reasons, keeps quest actions', () => {
    const container = makeEl('div');
    const panel = new DialoguePanel(container, fakeDoc());
    const clicked: string[] = [];
    panel.showTree({
      name: 'Mara', role: 'villager', text: 'Hello.', nodeId: 'greeting',
      choices: [
        { id: 'help', label: 'Help', locked: false },
        { id: 'trusted', label: 'Trust me', locked: true, lockReason: 'Requires freeholds standing 250 (have 0)' },
      ],
      actions: [{ id: 'accept:q1', label: 'Accept: Quest' }],
      onChoice: (id) => clicked.push(id),
      onAction: () => {},
    });
    expect(panel.isOpen).toBe(true);
    // root children: name, line, choices, actions, dismiss
    const choicesEl = container.children[0].children[2];
    expect(choicesEl.children.length).toBe(2);
    const [helpBtn, lockedBtn] = choicesEl.children;
    expect(helpBtn.getAttribute('data-dialogue-choice')).toBe('help');
    expect(helpBtn.disabled).toBe(false);
    expect(lockedBtn.getAttribute('data-dialogue-choice')).toBe('trusted');
    expect(lockedBtn.getAttribute('data-dialogue-locked')).toBe('true');
    expect(lockedBtn.disabled).toBe(true);
    expect(lockedBtn.textContent).toContain('Requires freeholds standing 250');
    const actionsEl = container.children[0].children[3];
    expect(actionsEl.children.length).toBe(1);
    expect(actionsEl.children[0].getAttribute('data-quest-action')).toBe('accept:q1');
    helpBtn.click();
    expect(clicked).toEqual(['help']);
    // choice buttons meet the 28px touch floor in style
    expect(helpBtn.style.cssText).toContain('min-height:28px');
    expect(helpBtn.style.cssText).toContain('padding:8px 12px');
    // re-rendering replaces choices (no stale buttons)
    panel.showTree({
      name: 'Mara', role: 'villager', text: 'Again.', nodeId: 'offer',
      choices: [{ id: 'take', label: 'Take it', locked: false }],
    });
    expect(choicesEl.children.length).toBe(1);
    expect(container.children[0].getAttribute('data-dialogue-node')).toBe('offer');
    panel.dispose();
    // dispose() removes the root from the DOM (its isOpen flag is stale
    // by the panel's pre-existing dispose-then-hide ordering — the DOM
    // removal is the contract under test here).
    expect(container.children.length).toBe(0);
  });

  it('show() clears stale tree choices', () => {
    const container = makeEl('div');
    const panel = new DialoguePanel(container, fakeDoc());
    panel.showTree({
      name: 'Mara', text: 'Hi.', nodeId: 'greeting',
      choices: [{ id: 'help', label: 'Help', locked: false }],
    });
    const choicesEl = container.children[0].children[2];
    expect(choicesEl.children.length).toBe(1);
    panel.show({ name: 'Mara', greeting: 'Plain greeting.' });
    expect(choicesEl.children.length).toBe(0);
    expect(container.children[0].getAttribute('data-dialogue-node')).toBeNull();
    panel.dispose();
  });
});

describe('DialogueChoiceDef shape', () => {
  it('every shipped choice has an id and a label', () => {
    for (const tree of DIALOGUE_TREES) {
      for (const node of tree.nodes) {
        for (const choice of node.choices as DialogueChoiceDef[]) {
          expect(choice.id.length).toBeGreaterThan(0);
          expect(choice.label.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
