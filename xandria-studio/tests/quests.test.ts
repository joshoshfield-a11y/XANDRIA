/**
 * Quest wave: unit tests for the quest system.
 * - QUEST_SALT distinctness (never collides with another wave's stream)
 * - buildQuestPool: determinism, 3-5 count, chaining, def validity,
 *   filters (crafting off, portals off, includeTalk false), questCount override
 * - QuestManager: accept/progress/complete/turnIn, rewards (xp + items,
 *   missing-def skip), chain unlock, requiresSatisfied, actionsForNpc,
 *   portalSnapshot/portalRestore (incl. corrupt input), multi-objective
 * - QuestTalkSession (headless): requires/produces stamping on NPC
 *   interactables; locked quests advertise quest:turned-in requires
 * - DialoguePanel: quest action buttons render + click through
 * - QuestTracker: renders snapshot, hides when empty
 */
import { describe, it, expect } from 'vitest';
import { defaultSpec, type GameSpec } from '../src/spec/schema';
import {
  QUEST_SALT,
  buildQuestPool,
  validateQuestDef,
  resolveQuestsEnabled,
  questRequiresFor,
  questProducesFor,
  QuestManager,
  type QuestDef,
} from '../src/engine/game/quests';
import { NPC_SALT } from '../src/engine/game/Npc';
import { ENEMY_SALT } from '../src/engine/game/EnemyAI';
import { CRAFT_SALT, MAT_ORE, MAT_FIBER, MAT_SCRAP, buildRecipePool } from '../src/engine/game/crafting';
import { STATION_SALT } from '../src/engine/game/stations';
import { GATHER_SALT } from '../src/engine/game/gathering';
import { QuestTalkSession } from '../src/engine/game/questTalk';
import { InteractionRegistry } from '../src/engine/game/Interaction';
import { DialoguePanel } from '../src/engine/ui/DialoguePanel';
import { QuestTracker } from '../src/engine/ui/QuestTracker';

// --- fake DOM (mirrors tests/crafting-panel.test.ts) ---

function makeEl(tag = 'div'): any {
  const el: any = {
    tag,
    children: [] as any[],
    style: {} as any,
    textContent: '',
    className: '',
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
    setAttribute() {},
    addEventListener(t: string, fn: (e: any) => void) { (el._listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: (e: any) => void) {
      el._listeners[t] = (el._listeners[t] ?? []).filter((f: (e: any) => void) => f !== fn);
    },
    click() { for (const fn of el._listeners['click'] ?? []) fn({}); },
  };
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] ?? null });
  return el;
}

function makeDoc(): any {
  const win: any = {
    _listeners: {} as Record<string, Array<(e: any) => void>>,
    addEventListener(t: string, fn: (e: any) => void) { (this._listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: (e: any) => void) {
      this._listeners[t] = (this._listeners[t] ?? []).filter((f: (e: any) => void) => f !== fn);
    },
  };
  return { createElement: (t: string) => makeEl(t), defaultView: win };
}

// --- quest manager harness ---

function makeManager(defs: QuestDef[], opts: Record<string, any> = {}) {
  const toasts: string[] = [];
  const inv = new Map<string, number>();
  const xpCalls: number[] = [];
  let leveledUp = 0;
  const mgr = new QuestManager({
    defs,
    inventory: () => ({
      add: (id: string, n = 1) => { inv.set(id, (inv.get(id) ?? 0) + n); return 0; },
    }),
    defsTable: () => ({ [MAT_ORE]: { id: MAT_ORE } as any, [MAT_FIBER]: { id: MAT_FIBER } as any, [MAT_SCRAP]: { id: MAT_SCRAP } as any }),
    progression: {
      addXp: (n: number) => { xpCalls.push(n); return false; },
      addXpEx: (n: number) => { xpCalls.push(n); return { leveled: false, gain: null }; },
    } as any,
    toast: (m: string) => toasts.push(m),
    onLevelUp: () => { leveledUp++; },
    ...opts,
  });
  return { mgr, toasts, inv, xpCalls, get leveledUp() { return leveledUp; } };
}

function specWith(seed: number, mut: (s: GameSpec) => void = () => {}): GameSpec {
  const spec = defaultSpec(seed) as GameSpec;
  mut(spec);
  return spec;
}

describe('QUEST_SALT', () => {
  it('is distinct from every other wave salt', () => {
    const salts = [NPC_SALT, ENEMY_SALT, CRAFT_SALT, STATION_SALT, GATHER_SALT];
    for (const s of salts) expect(QUEST_SALT).not.toBe(s);
    expect(new Set(salts).size).toBe(salts.length);
  });
});

describe('buildQuestPool', () => {
  it('is deterministic: same spec -> identical pool', () => {
    const a = buildQuestPool(specWith(20261012));
    const b = buildQuestPool(specWith(20261012));
    expect(a).toEqual(b);
  });

  it('varies with the seed', () => {
    const a = JSON.stringify(buildQuestPool(specWith(1)));
    const b = JSON.stringify(buildQuestPool(specWith(2)));
    expect(a).not.toBe(b);
  });

  it('holds 3-5 quests, chained, all defs valid', () => {
    for (const seed of [20261012, 7, 99, 123456]) {
      const pool = buildQuestPool(specWith(seed));
      expect(pool.length).toBeGreaterThanOrEqual(3);
      expect(pool.length).toBeLessThanOrEqual(5);
      pool.forEach((d, i) => {
        expect(validateQuestDef(d)).toEqual([]);
        if (i > 0) expect(d.requiresQuests).toEqual([pool[i - 1].id]);
        else expect(d.requiresQuests ?? []).toEqual([]);
      });
      const ids = pool.map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('filters gather/craft quests when crafting is disabled', () => {
    const pool = buildQuestPool(specWith(20261012, (s) => {
      s.custom = s.custom ?? {};
      s.custom.crafting = { enabled: false };
    }));
    expect(pool.length).toBeGreaterThanOrEqual(1);
    for (const d of pool) {
      for (const o of d.objectives) {
        expect(o.kind).not.toBe('gather');
        expect(o.kind).not.toBe('craft');
      }
    }
  });

  it('excludes the talk quest when includeTalk is false', () => {
    const pool = buildQuestPool(specWith(20261012), { includeTalk: false });
    for (const d of pool) {
      for (const o of d.objectives) expect(o.kind).not.toBe('talk');
    }
  });

  it('excludes the explore quest when portals are disabled', () => {
    const pool = buildQuestPool(specWith(20261012));
    for (const d of pool) {
      for (const o of d.objectives) expect(o.kind).not.toBe('explore');
    }
  });

  it('includes the explore quest when portals are enabled', () => {
    // seed 20261014 (the portal fixture seed) should surface wayfarer often;
    // assert across several seeds that at least one pool contains it.
    let found = false;
    for (const seed of [20261014, 3, 5, 11, 42]) {
      const pool = buildQuestPool(specWith(seed, (s) => {
        s.world.portals = { enabled: true } as any;
      }));
      if (pool.some((d) => d.objectives.some((o) => o.kind === 'explore'))) found = true;
    }
    expect(found).toBe(true);
  });

  it('honors the Studio questCount override (clamped)', () => {
    const pool = buildQuestPool(specWith(20261012, (s) => {
      s.custom = s.custom ?? {};
      s.custom.quests = { questCount: 2 };
    }));
    expect(pool.length).toBe(2);
  });

  it('quest targets reference real spec content', () => {
    const spec = specWith(20261012);
    const pool = buildQuestPool(spec);
    const kinds = new Set((spec.enemies ?? []).map((e) => e.kind));
    for (const d of pool) {
      for (const o of d.objectives) {
        if (o.kind === 'kill') expect(kinds.has(o.target as never)).toBe(true);
        if (o.kind === 'craft') {
          expect(buildRecipePool(spec).some((r) => r.id === o.target)).toBe(true);
        }
      }
    }
  });
});

describe('resolveQuestsEnabled', () => {
  it('defaults true, honors the toggle', () => {
    expect(resolveQuestsEnabled(specWith(1))).toBe(true);
    expect(resolveQuestsEnabled(specWith(1, (s) => {
      s.custom = s.custom ?? {};
      s.custom.quests = { enabled: false };
    }))).toBe(false);
  });
});

describe('QuestManager lifecycle', () => {
  const defs: QuestDef[] = [
    {
      id: 'q1', name: 'First', giver: 'villager', brief: 'b1',
      objectives: [{ id: 'o1', kind: 'kill', desc: 'Defeat 3 walkers', target: 'walker', count: 3 }],
      rewards: { xp: 60, items: [{ id: MAT_ORE, count: 2 }] },
    },
    {
      id: 'q2', name: 'Second', giver: 'villager', brief: 'b2',
      objectives: [{ id: 'o1', kind: 'gather', desc: 'Gather 5 materials', target: 'any', count: 5 }],
      rewards: { xp: 80, items: [{ id: MAT_FIBER, count: 3 }] },
      requiresQuests: ['q1'],
    },
  ];

  it('accept -> progress -> complete -> turnIn -> chain unlock', () => {
    const h = makeManager(defs);
    expect(h.mgr.statusOf('q1')).toBe('available');
    expect(h.mgr.statusOf('q2')).toBe('locked');
    expect(h.mgr.accept('q2')).toBe(false); // locked
    expect(h.mgr.accept('q1')).toBe(true);
    expect(h.mgr.statusOf('q1')).toBe('active');
    h.mgr.onKill('walker');
    h.mgr.onKill('walker');
    expect(h.mgr.statusOf('q1')).toBe('active');
    expect(h.mgr.progressOf('q1')).toEqual([2]);
    h.mgr.onKill('drone'); // wrong kind: no progress
    expect(h.mgr.progressOf('q1')).toEqual([2]);
    h.mgr.onKill('walker');
    expect(h.mgr.statusOf('q1')).toBe('complete');
    expect(h.mgr.turnIn('q1')).toBe(true);
    expect(h.mgr.statusOf('q1')).toBe('turned-in');
    expect(h.mgr.statusOf('q2')).toBe('available'); // chain unlocked
    expect(h.xpCalls).toEqual([60]);
    expect(h.inv.get(MAT_ORE)).toBe(2);
  });

  it('turnIn before completion fails; double accept fails', () => {
    const h = makeManager(defs);
    expect(h.mgr.turnIn('q1')).toBe(false);
    expect(h.mgr.accept('q1')).toBe(true);
    expect(h.mgr.accept('q1')).toBe(false);
  });

  it('gather counts any material; talk matches role', () => {
    const h = makeManager(defs);
    h.mgr.accept('q1');
    h.mgr.turnIn('q1'); // not complete -> false; accept q2 path instead
    expect(h.mgr.statusOf('q2')).toBe('locked');
    // complete q1 properly
    h.mgr.onKill('walker'); h.mgr.onKill('walker'); h.mgr.onKill('walker');
    h.mgr.turnIn('q1');
    h.mgr.accept('q2');
    h.mgr.onHarvest(MAT_ORE, 2);
    h.mgr.onHarvest('mat_unknown', 3); // 'any' still counts
    expect(h.mgr.progressOf('q2')).toEqual([5]);
    expect(h.mgr.statusOf('q2')).toBe('complete');
  });

  it('skips reward items with no def (never grants blind)', () => {
    const bad: QuestDef[] = [{
      id: 'q1', name: 'X', giver: 'villager', brief: 'b',
      objectives: [{ id: 'o', kind: 'talk', desc: 'Talk', target: 'any', count: 1 }],
      rewards: { xp: 10, items: [{ id: 'nope_missing', count: 5 }] },
    }];
    const h = makeManager(bad);
    h.mgr.accept('q1');
    h.mgr.onTalk('villager');
    expect(h.mgr.statusOf('q1')).toBe('complete');
    h.mgr.turnIn('q1');
    expect(h.inv.get('nope_missing') ?? 0).toBe(0);
    expect(h.xpCalls).toEqual([10]);
  });

  it('multi-objective quests complete only when all objectives are done', () => {
    const multi: QuestDef[] = [{
      id: 'qm', name: 'Multi', giver: 'villager', brief: 'b',
      objectives: [
        { id: 'a', kind: 'kill', desc: 'Kill 2', target: 'walker', count: 2 },
        { id: 'b', kind: 'gather', desc: 'Gather 3', target: 'any', count: 3 },
      ],
      rewards: { xp: 10, items: [] },
    }];
    const h = makeManager(multi);
    h.mgr.accept('qm');
    h.mgr.onKill('walker'); h.mgr.onKill('walker');
    expect(h.mgr.statusOf('qm')).toBe('active');
    h.mgr.onHarvest(MAT_SCRAP, 3);
    expect(h.mgr.statusOf('qm')).toBe('complete');
  });

  it('autoAccept genres: accept + turn-in happen automatically', () => {
    const h = makeManager(defs, { autoAccept: true });
    expect(h.mgr.statusOf('q1')).toBe('active'); // accepted at construction
    h.mgr.onKill('walker'); h.mgr.onKill('walker'); h.mgr.onKill('walker');
    expect(h.mgr.statusOf('q1')).toBe('turned-in'); // auto turned in
    expect(h.mgr.statusOf('q2')).toBe('active'); // chain continued
    expect(h.xpCalls).toEqual([60]);
  });

  it('explore objectives advance on portal transitions', () => {
    const ex: QuestDef[] = [{
      id: 'qe', name: 'Way', giver: 'villager', brief: 'b',
      objectives: [{ id: 'o', kind: 'explore', desc: 'Portals', target: 'portals', count: 2 }],
      rewards: { xp: 10, items: [] },
    }];
    let t = 0;
    const h = makeManager(ex, { getTransitions: () => t });
    h.mgr.accept('qe');
    h.mgr.update(0.016);
    expect(h.mgr.progressOf('qe')).toEqual([0]);
    t = 1;
    h.mgr.update(0.016);
    expect(h.mgr.progressOf('qe')).toEqual([1]);
    t = 3;
    h.mgr.update(0.016);
    expect(h.mgr.statusOf('qe')).toBe('complete');
  });

  it('onLevelUp fires when a quest reward levels the player', () => {
    const h = makeManager(defs, {
      progression: { addXp: (n: number) => true, addXpEx: (n: number) => ({ leveled: true, gain: { from: 1, to: 2 } }) } as any,
    });
    h.mgr.accept('q1');
    h.mgr.onKill('walker'); h.mgr.onKill('walker'); h.mgr.onKill('walker');
    h.mgr.turnIn('q1');
    expect(h.leveledUp).toBe(1);
  });
});

describe('QuestManager portal persistence', () => {
  const defs: QuestDef[] = [
    {
      id: 'q1', name: 'First', giver: 'villager', brief: 'b1',
      objectives: [{ id: 'o1', kind: 'kill', desc: 'Defeat 3 walkers', target: 'walker', count: 3 }],
      rewards: { xp: 60, items: [] },
    },
  ];

  it('portalSnapshot/portalRestore round-trips exactly', () => {
    const h = makeManager(defs);
    h.mgr.accept('q1');
    h.mgr.onKill('walker'); h.mgr.onKill('walker');
    const snap = h.mgr.portalSnapshot();
    expect(snap.version).toBe(1);
    const h2 = makeManager(defs);
    h2.mgr.portalRestore(snap);
    expect(h2.mgr.statusOf('q1')).toBe('active');
    expect(h2.mgr.progressOf('q1')).toEqual([2]);
  });

  it('portalRestore is defensive: corrupt input clamps, unknown ids drop', () => {
    const h = makeManager(defs);
    h.mgr.portalRestore({
      version: 1,
      states: {
        q1: { status: 'nonsense' as any, progress: [999, -5] },
        qX: { status: 'active', progress: [1] },
      },
    });
    expect(h.mgr.statusOf('q1')).toBe('locked');
    // corrupt progress [999, -5] clamps to the objective count (3) for the
    // single objective; unknown quest ids are dropped
    expect(h.mgr.progressOf('q1')).toEqual([3]);
    h.mgr.portalRestore(null);
    h.mgr.portalRestore({ version: 2 } as any);
    expect(h.mgr.statusOf('q1')).toBe('locked'); // untouched
  });
});

describe('requires/produces seam', () => {
  it('builds the Interactable token strings', () => {
    const d: QuestDef = {
      id: 'quest_story_2_x', name: 'X', giver: 'villager', brief: 'b',
      objectives: [{ id: 'o', kind: 'kill', desc: 'd', target: 'walker', count: 1 }],
      rewards: { xp: 0, items: [] },
      requiresQuests: ['quest_story_1_y'],
    };
    expect(questRequiresFor(d)).toEqual(['quest:turned-in:quest_story_1_y']);
    expect(questProducesFor('accept', d)).toBe('quest:accept:quest_story_2_x');
    expect(questProducesFor('turnin', d)).toBe('quest:turnin:quest_story_2_x');
    expect(questRequiresFor({ ...d, requiresQuests: undefined })).toEqual([]);
  });
});

describe('QuestTalkSession (headless)', () => {
  function makeSession() {
    const pool = buildQuestPool(specWith(20261012), { includeTalk: true });
    const h = makeManager(pool);
    const engine: any = { npcInteractions: new InteractionRegistry() };
    const mkNpc = (id: string, role: string) => ({
      role,
      interactable: {
        id, type: 'npc', position: { distanceTo: () => 0 }, radius: 3, enabled: true, prompt: 'Talk',
        produces: undefined as string[] | undefined, requires: undefined as string[] | undefined,
      },
    });
    const npcs = [mkNpc('npc-0', 'villager'), mkNpc('npc-1', 'villager')];
    const manager: any = { npcs };
    const session = new QuestTalkSession(engine, manager, h.mgr, { enableUi: false });
    return { session, engine, npcs, h, pool };
  }

  it('stamps produces on available quests, requires on locked ones', () => {
    const { npcs, pool } = makeSession();
    const i0 = npcs[0].interactable;
    // q1 available -> produces accept; q2+ locked -> requires turned-in:q1
    expect(i0.produces).toContain(`quest:accept:${pool[0].id}`);
    expect(i0.requires).toContain(`quest:turned-in:${pool[0].id}`);
    expect(i0.requires!.length).toBeGreaterThan(0);
  });

  it('after turn-in, the next quest becomes producible', () => {
    const { npcs, pool, h, session } = makeSession();
    h.mgr.accept(pool[0].id);
    // complete q1 via its objective kind
    const o = pool[0].objectives[0];
    if (o.kind === 'kill') for (let i = 0; i < o.count; i++) h.mgr.onKill(o.target);
    else if (o.kind === 'gather') h.mgr.onHarvest(o.target === 'any' ? MAT_ORE : o.target, o.count);
    else if (o.kind === 'craft') h.mgr.onCraft(o.target);
    else if (o.kind === 'talk') for (let i = 0; i < o.count; i++) h.mgr.onTalk('villager');
    expect(h.mgr.statusOf(pool[0].id)).toBe('complete');
    h.mgr.turnIn(pool[0].id);
    session.update(0); // per-frame refresh re-stamps requires/produces
    const i0 = npcs[0].interactable;
    expect(i0.produces).toContain(`quest:accept:${pool[1].id}`);
    expect(i0.produces).not.toContain(`quest:accept:${pool[0].id}`);
    session.dispose();
  });
});

describe('DialoguePanel quest actions', () => {
  it('renders action buttons and routes clicks', () => {
    const doc = makeDoc();
    const container = makeEl('div');
    const panel = new DialoguePanel(container, doc);
    const seen: string[] = [];
    panel.show(
      { name: 'Asha', role: 'villager', greeting: 'Hello.' },
      [{ id: 'accept:q1', label: 'Accept: First Blood' }],
      (id) => seen.push(id),
    );
    expect(panel.isOpen).toBe(true);
    const actionsEl = (panel as any).actionsEl;
    expect(actionsEl.children.length).toBe(1);
    expect(actionsEl.children[0].textContent).toBe('Accept: First Blood');
    actionsEl.children[0].click();
    expect(seen).toEqual(['accept:q1']);
    // re-show without actions clears the buttons (no stale actions)
    panel.show({ name: 'Asha', greeting: 'Hi.' });
    expect(actionsEl.children.length).toBe(0);
    panel.dispose();
  });

  it('E/Escape while open stops the event immediately (no prompt reopen)', () => {
    const doc = makeDoc();
    const panel = new DialoguePanel(makeEl('div'), doc);
    panel.show({ name: 'Asha', greeting: 'Hello.' });
    const handlers = doc.defaultView._listeners['keydown'] ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    const calls: string[] = [];
    const fakeEvent = {
      code: 'KeyE',
      stopPropagation: () => calls.push('stopPropagation'),
      stopImmediatePropagation: () => calls.push('stopImmediatePropagation'),
      preventDefault: () => calls.push('preventDefault'),
    };
    // the panel's own capture handler is registered in the constructor;
    // find it (a later-registered prompt handler would run after it)
    for (const h of handlers) h(fakeEvent);
    // must use stopImmediatePropagation: plain stopPropagation does NOT
    // stop same-node capture listeners, so a prompt registered after the
    // panel would see isModalOpen===false and reopen the dialogue.
    expect(calls).toContain('stopImmediatePropagation');
    expect(calls).not.toContain('stopPropagation');
    expect(panel.isOpen).toBe(false);
    panel.dispose();
  });

  it('legacy show(line) still works with no actions', () => {
    const doc = makeDoc();
    const panel = new DialoguePanel(makeEl('div'), doc);
    panel.show({ name: 'Bex', greeting: 'Yo.' });
    expect(panel.isOpen).toBe(true);
    expect((panel as any).actionsEl.children.length).toBe(0);
    panel.hide();
    expect(panel.isOpen).toBe(false);
    panel.dispose();
  });
});

describe('QuestTracker', () => {
  it('renders active quests and hides when empty', () => {
    const doc = makeDoc();
    const container = makeEl('div');
    const tracker = new QuestTracker(container, doc);
    tracker.render([]);
    expect((tracker as any).root.style.display).toBe('none');
    tracker.render([{
      name: 'First Blood', status: 'active',
      lines: ['• Defeat 6 walkers (2/6)'],
    }]);
    expect((tracker as any).root.style.display).toBe('block');
    const listEl = (tracker as any).listEl;
    expect(listEl.children.length).toBe(1);
    expect(listEl.children[0].children[0].textContent).toBe('First Blood');
    expect(listEl.children[0].children[1].textContent).toContain('(2/6)');
    tracker.dispose();
  });
});
