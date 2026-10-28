/**
 * Dialogue-branching wave: data-driven branching NPC dialogue trees.
 *
 * Builds on the quest + factions systems (read their REPORT.md files
 * first) and touches gameplay ONLY through the existing seams:
 *   - quest accept / turn-in ride QuestManager.accept()/turnIn() via
 *     the context callbacks the blueprint wires (the same methods the
 *     quest dialogue buttons already call);
 *   - standing adjustments ride FactionStandings.adjust() via the
 *     context callback (the factions hooks; vendor pricing math in
 *     ShopPanel is untouched — standing moves prices through the
 *     existing tier factors, exactly as kills/trades already do);
 *   - the item-held condition is a read-only Inventory.count() check.
 * No NPC/enemy behavior contract changes; no quest lifecycle changes.
 *
 * Data model (all tuning in the one DIALOGUE_TREES table below):
 *   DialogueTreeDef  — { id, role, start, nodes[] } (one tree per NPC role)
 *   DialogueNodeDef  — { id, speaker, lines, returnLines?, choices[] }
 *   DialogueChoiceDef — { id, label, conditions?, effects? }
 *   DialogueCondition — every present field must pass (AND):
 *     minStanding { factionId, min }, questState { quest, status },
 *     hasItem { itemId, minCount }.
 *     questState.quest is a literal quest id, or the symbol 'first'
 *     (the first def in the manager's roster — the story line head).
 *   DialogueEffect — applied in field order by choose():
 *     standing { factionId, amount }, questAccept ('first-available' =
 *     the first quest the NPC can offer right now, else a literal id),
 *     questTurnIn ('first-complete' / literal id), flag (a persistent
 *     string flag), to (navigate), end (close the dialogue).
 *
 * DialogueState is PLAYER-SCOPED (mirrors QuestManager/FactionStandings):
 * it is owned by the blueprint, never registered in
 * engine.portalEntities, so portal travel leaves it untouched by
 * construction; portalSnapshot()/portalRestore() cover rebuild paths,
 * and the guarded localStorage adapter (keyed by spec seed) covers a
 * full page reload. What it records: visited nodes, chosen choices,
 * flags, and the last node per tree. A node opened again shows its
 * returnLines when present (the player is remembered, state-driven).
 *
 * Determinism: dialogue logic is pure state — no RNG anywhere here.
 * Seeded RNG is never consulted; the same state + same inputs always
 * produce the same node, choices, and lock reasons.
 */

import { FACTION_IDS } from './factions';
import type { QuestStatus } from './quests';

/** The symbol for "the first quest in the manager's roster". */
export const FIRST_QUEST_REF = 'first';

/** Symbolic quest refs the accept/turn-in effects understand. */
export type DialogueQuestRef = 'first-available' | 'first-complete' | string;

export interface DialogueStandingCondition {
  factionId: string;
  min: number;
}

export interface DialogueQuestCondition {
  /** literal quest id, or 'first' (the roster head) */
  quest: string;
  status: QuestStatus;
}

export interface DialogueItemCondition {
  itemId: string;
  /** minimum units held (default 1) */
  minCount?: number;
}

export interface DialogueCondition {
  minStanding?: DialogueStandingCondition;
  questState?: DialogueQuestCondition;
  hasItem?: DialogueItemCondition;
}

export interface DialogueStandingEffect {
  factionId: string;
  amount: number;
}

export interface DialogueEffect {
  /** navigate to this node after applying the other effects */
  to?: string;
  /** close the dialogue after applying the other effects */
  end?: boolean;
  /** accept a quest: 'first-available' or a literal quest id */
  questAccept?: DialogueQuestRef;
  /** turn in a quest: 'first-complete' or a literal quest id */
  questTurnIn?: DialogueQuestRef;
  /** adjust one faction's standing by this amount (clamped by the store) */
  standing?: DialogueStandingEffect;
  /** set a persistent flag on the dialogue state */
  flag?: string;
}

export interface DialogueChoiceDef {
  id: string;
  label: string;
  conditions?: DialogueCondition;
  effects?: DialogueEffect;
}

export interface DialogueNodeDef {
  id: string;
  speaker: string;
  /** lines shown on first visit (joined with a space for display) */
  lines: string[];
  /** lines shown when the node was visited before (defaults to lines) */
  returnLines?: string[];
  choices: DialogueChoiceDef[];
}

export interface DialogueTreeDef {
  id: string;
  /** NPC role this tree belongs to ('villager', ...) */
  role: string;
  /** node id the dialogue opens on */
  start: string;
  nodes: DialogueNodeDef[];
}

// ---------------------------------------------------------------------------
// The tuning table — every dialogue tree, node, choice, condition, effect.
// ---------------------------------------------------------------------------

/**
 * The settler tree (villagers). One tree only, deliberately: vendor
 * NPCs route to the shop panel (openVendor), never to dialogue, so a
 * vendor tree would be dead content. Roles that never spawn get no tree.
 *
 * Branch map (choice A vs choice B lead to exact distinct outcomes):
 *   greeting --offer-help--> offer --take-job--> accepted (quest accept)
 *   greeting --brush-off--> cold (freeholds -10, flag brushed-off)
 *   greeting --trusted--> trusted (gated: freeholds standing >= 250)
 *   offer --ask-reward--> reward --take-job-reward--> accepted
 *   news --show-token--> token (gated: holding >= 1 mat_scrap)
 *   accepted --job-status--> progress (gated: first quest active)
 *   cold --apologize--> greeting (freeholds +5, the rude path is repairable)
 */
export const DIALOGUE_TREES: readonly DialogueTreeDef[] = [
  {
    id: 'settler',
    role: 'villager',
    start: 'greeting',
    nodes: [
      {
        id: 'greeting',
        speaker: 'Settler',
        lines: [
          'You look like you have walked a long way.',
          'The settlement could use hands like yours — or it could do without another mouth to feed. Which is it?',
        ],
        returnLines: [
          'Back again. The offer still stands — if you have the stomach for it.',
        ],
        choices: [
          { id: 'offer-help', label: "I'll help. What needs doing?", effects: { to: 'offer' } },
          { id: 'ask-news', label: "What's the word around here?", effects: { to: 'news' } },
          {
            id: 'trusted',
            label: 'You can trust me — ask anyone.',
            conditions: { minStanding: { factionId: 'freeholds', min: 250 } },
            effects: { to: 'trusted' },
          },
          {
            id: 'brush-off',
            label: 'Not my problem.',
            effects: { standing: { factionId: 'freeholds', amount: -10 }, flag: 'brushed-off', to: 'cold' },
          },
        ],
      },
      {
        id: 'offer',
        speaker: 'Settler',
        lines: [
          'There is work posted for anyone willing. Take a job from the board in your head — I mean, take the job I am about to name — and see it through.',
        ],
        choices: [
          {
            id: 'take-job',
            label: 'Consider it done.',
            effects: { questAccept: 'first-available', flag: 'took-job', to: 'accepted' },
          },
          { id: 'ask-reward', label: "What's in it for me?", effects: { to: 'reward' } },
          { id: 'decline', label: 'Maybe another time.', effects: { to: 'greeting' } },
        ],
      },
      {
        id: 'accepted',
        speaker: 'Settler',
        lines: ['Good. The settlement remembers who keeps their word. Come back when it is done — or sooner, if you need to talk.'],
        returnLines: ['Still on the job? The settlement is counting on you.'],
        choices: [
          {
            id: 'job-status',
            label: 'How am I doing on the job?',
            conditions: { questState: { quest: FIRST_QUEST_REF, status: 'active' } },
            effects: { to: 'progress' },
          },
          { id: 'farewell', label: "I'll be back.", effects: { end: true } },
        ],
      },
      {
        id: 'progress',
        speaker: 'Settler',
        lines: ['You are on the job and the work is not done yet. Keep at it — the tracker on your HUD knows the count better than I do.'],
        choices: [{ id: 'farewell', label: 'On my way.', effects: { end: true } }],
      },
      {
        id: 'reward',
        speaker: 'Settler',
        lines: ['Coin, supplies, and the settlement owing you one. The posted jobs pay in experience and gear — the kind of pay that keeps you alive out there.'],
        choices: [
          {
            id: 'take-job-reward',
            label: 'Fair enough. Consider it done.',
            effects: { questAccept: 'first-available', flag: 'took-job', to: 'accepted' },
          },
          { id: 'decline-reward', label: 'Not worth my time.', effects: { to: 'greeting' } },
        ],
      },
      {
        id: 'news',
        speaker: 'Settler',
        lines: ['Doors between worlds, machines in the rocks, and scrap worth more than coin some days. Folk out there trade in salvage — show me something real and I will know you have been out past the treeline.'],
        choices: [
          {
            id: 'show-token',
            label: 'I found something out there. Here — look.',
            conditions: { hasItem: { itemId: 'mat_scrap', minCount: 1 } },
            effects: { flag: 'showed-token', to: 'token' },
          },
          { id: 'back', label: 'Fair enough.', effects: { to: 'greeting' } },
        ],
      },
      {
        id: 'token',
        speaker: 'Settler',
        lines: ['Scrap, and good scrap too. You have been out past the treeline after all. Keep it — you will need it at the workbench more than I will.'],
        choices: [{ id: 'farewell', label: 'Thanks for the word.', effects: { end: true } }],
      },
      {
        id: 'trusted',
        speaker: 'Settler',
        lines: ['Word travels. The settlement trusts you, and trusted folk hear the real news: the best work never makes the board. Take the job — I will vouch for you myself.'],
        choices: [
          {
            id: 'trusted-job',
            label: "I'll take it.",
            effects: { questAccept: 'first-available', flag: 'took-job', to: 'accepted' },
          },
          { id: 'farewell', label: 'Good to know.', effects: { end: true } },
        ],
      },
      {
        id: 'cold',
        speaker: 'Settler',
        lines: ['Then walk on. The treeline does not care about manners, and neither do I, today.'],
        choices: [
          {
            id: 'apologize',
            label: 'Sorry — rough day. What did you need?',
            effects: { standing: { factionId: 'freeholds', amount: 5 }, to: 'greeting' },
          },
          { id: 'leave', label: 'Walk away.', effects: { end: true } },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Validation (loud on bad content, like validateQuestDef)
// ---------------------------------------------------------------------------

export function validateDialogueTree(tree: DialogueTreeDef, knownFactions: readonly string[] = FACTION_IDS): string[] {
  const errs: string[] = [];
  if (!tree || typeof tree !== 'object') return ['dialogue tree must be an object'];
  if (!tree.id || typeof tree.id !== 'string') errs.push('dialogue tree id must be a non-empty string');
  if (!tree.role || typeof tree.role !== 'string') errs.push(`dialogue tree ${tree.id}: role must be a non-empty string`);
  if (!Array.isArray(tree.nodes) || tree.nodes.length === 0) {
    errs.push(`dialogue tree ${tree.id}: nodes must be a non-empty array`);
    return errs;
  }
  const nodeIds = new Set<string>();
  for (const n of tree.nodes) {
    if (!n.id || typeof n.id !== 'string') { errs.push(`dialogue tree ${tree.id}: node id must be a non-empty string`); continue; }
    if (nodeIds.has(n.id)) errs.push(`dialogue tree ${tree.id}: duplicate node id '${n.id}'`);
    nodeIds.add(n.id);
    if (!n.speaker || typeof n.speaker !== 'string') errs.push(`dialogue tree ${tree.id} node ${n.id}: speaker must be a non-empty string`);
    if (!Array.isArray(n.lines) || n.lines.length === 0 || n.lines.some((l) => typeof l !== 'string' || !l)) {
      errs.push(`dialogue tree ${tree.id} node ${n.id}: lines must be a non-empty string array`);
    }
    if (n.returnLines !== undefined && (!Array.isArray(n.returnLines) || n.returnLines.some((l) => typeof l !== 'string' || !l))) {
      errs.push(`dialogue tree ${tree.id} node ${n.id}: returnLines must be a non-empty string array`);
    }
    if (!Array.isArray(n.choices)) { errs.push(`dialogue tree ${tree.id} node ${n.id}: choices must be an array`); continue; }
    const choiceIds = new Set<string>();
    for (const c of n.choices) {
      if (!c.id || typeof c.id !== 'string') { errs.push(`dialogue tree ${tree.id} node ${n.id}: choice id must be a non-empty string`); continue; }
      if (choiceIds.has(c.id)) errs.push(`dialogue tree ${tree.id} node ${n.id}: duplicate choice id '${c.id}'`);
      choiceIds.add(c.id);
      if (!c.label || typeof c.label !== 'string') errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: label must be a non-empty string`);
      const cond = c.conditions;
      if (cond?.minStanding) {
        if (!knownFactions.includes(cond.minStanding.factionId)) errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: unknown faction '${cond.minStanding.factionId}'`);
        if (!Number.isFinite(cond.minStanding.min)) errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: minStanding.min must be finite`);
      }
      if (cond?.questState) {
        if (!cond.questState.quest || typeof cond.questState.quest !== 'string') errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: questState.quest must be a non-empty string`);
        const statuses: QuestStatus[] = ['locked', 'available', 'active', 'complete', 'turned-in'];
        if (!statuses.includes(cond.questState.status)) errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: questState.status '${cond.questState.status}' is not a quest status`);
      }
      if (cond?.hasItem) {
        if (!cond.hasItem.itemId || typeof cond.hasItem.itemId !== 'string') errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: hasItem.itemId must be a non-empty string`);
        if (cond.hasItem.minCount !== undefined && (!Number.isInteger(cond.hasItem.minCount) || cond.hasItem.minCount < 1)) {
          errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: hasItem.minCount must be an integer >= 1`);
        }
      }
      const eff = c.effects;
      if (eff) {
        if (eff.to !== undefined && eff.end === true) errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: effects must not set both 'to' and 'end'`);
        if (eff.standing && !knownFactions.includes(eff.standing.factionId)) errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: unknown faction '${eff.standing.factionId}' in standing effect`);
        if (eff.standing && !Number.isFinite(eff.standing.amount)) errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: standing.amount must be finite`);
        if (eff.questAccept !== undefined && (typeof eff.questAccept !== 'string' || !eff.questAccept)) errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: questAccept must be a non-empty string`);
        if (eff.questTurnIn !== undefined && (typeof eff.questTurnIn !== 'string' || !eff.questTurnIn)) errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: questTurnIn must be a non-empty string`);
      }
    }
  }
  // second pass: start + every 'to' target must exist (forward refs allowed)
  if (!nodeIds.has(tree.start)) errs.push(`dialogue tree ${tree.id}: start node '${tree.start}' does not exist`);
  for (const n of tree.nodes) {
    for (const c of n.choices ?? []) {
      const to = c.effects?.to;
      if (to !== undefined && !nodeIds.has(to)) errs.push(`dialogue tree ${tree.id} node ${n.id} choice ${c.id}: target node '${to}' does not exist`);
    }
  }
  return errs;
}

/** Validate a whole table: duplicate tree ids / roles are errors. */
export function validateDialogueTrees(trees: readonly DialogueTreeDef[]): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const roles = new Set<string>();
  for (const t of trees) {
    if (ids.has(t.id)) errs.push(`duplicate dialogue tree id '${t.id}'`);
    ids.add(t.id);
    if (roles.has(t.role)) errs.push(`duplicate dialogue tree role '${t.role}'`);
    roles.add(t.role);
    errs.push(...validateDialogueTree(t));
  }
  return errs;
}

// ---------------------------------------------------------------------------
// DialogueState — player-scoped persistence (mirrors FactionStandings)
// ---------------------------------------------------------------------------

export interface DialogueSnapshot {
  version: 1;
  visited: string[];
  choices: string[];
  flags: string[];
  lastNode: Record<string, string>;
}

export interface DialogueStorage {
  load: () => DialogueSnapshot | null;
  save: (snap: DialogueSnapshot) => void;
}

/**
 * Guarded localStorage adapter keyed by spec seed — the reload leg.
 * Any storage failure degrades to a no-op, never a crash (same stance
 * as the factions adapter). In-memory fallback when localStorage is
 * absent (headless/unit tests).
 */
export function localStorageDialogueAdapter(seed: number): DialogueStorage {
  const key = `xandria.dialogue.v1:${seed >>> 0}`;
  const mem = new Map<string, string>();
  const backend = (): { get(k: string): string | null; set(k: string, v: string): void } | null => {
    try {
      if (typeof localStorage === 'undefined') return null;
      return {
        get: (k) => localStorage.getItem(k),
        set: (k, v) => localStorage.setItem(k, v),
      };
    } catch {
      return null;
    }
  };
  return {
    load: () => {
      try {
        const raw = backend()?.get(key) ?? mem.get(key) ?? null;
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<DialogueSnapshot>;
        if (parsed?.version !== 1) return null;
        return {
          version: 1,
          visited: Array.isArray(parsed.visited) ? parsed.visited : [],
          choices: Array.isArray(parsed.choices) ? parsed.choices : [],
          flags: Array.isArray(parsed.flags) ? parsed.flags : [],
          lastNode: parsed.lastNode && typeof parsed.lastNode === 'object' ? parsed.lastNode : {},
        };
      } catch {
        return null;
      }
    },
    save: (snap) => {
      try {
        const raw = JSON.stringify(snap);
        const b = backend();
        if (b) b.set(key, raw);
        else mem.set(key, raw);
      } catch {
        // storage failure is never fatal to gameplay
      }
    },
  };
}

function visitedKey(treeId: string, nodeId: string): string {
  return `${treeId}:${nodeId}`;
}

function choiceKey(treeId: string, nodeId: string, choiceId: string): string {
  return `${treeId}:${nodeId}:${choiceId}`;
}

/**
 * Player-scoped dialogue state. Pure data + a guarded storage adapter;
 * no DOM, no RNG — unit-testable. The engine holds the live instance;
 * choose() records through it and persists on every mutation.
 */
export class DialogueState {
  /** Fired after every recorded mutation. Never throws. */
  onChange: (() => void) | null = null;

  private visited = new Set<string>();
  private choices = new Set<string>();
  private flags = new Set<string>();
  private lastNode = new Map<string, string>();

  constructor(private readonly storage: DialogueStorage | null = null) {
    if (storage) this.restore(storage.load());
  }

  hasVisited(treeId: string, nodeId: string): boolean {
    return this.visited.has(visitedKey(treeId, nodeId));
  }

  hasChosen(treeId: string, nodeId: string, choiceId: string): boolean {
    return this.choices.has(choiceKey(treeId, nodeId, choiceId));
  }

  hasFlag(flag: string): boolean {
    return this.flags.has(flag);
  }

  lastNodeFor(treeId: string): string | null {
    return this.lastNode.get(treeId) ?? null;
  }

  /** Record a node visit (idempotent). Persists when it changes state. */
  recordVisit(treeId: string, nodeId: string): void {
    const key = visitedKey(treeId, nodeId);
    const changed = !this.visited.has(key) || this.lastNode.get(treeId) !== nodeId;
    this.visited.add(key);
    this.lastNode.set(treeId, nodeId);
    if (changed) this.persist();
  }

  /** Record a chosen choice + an optional flag (idempotent per choice). */
  recordChoice(treeId: string, nodeId: string, choiceId: string, flag?: string): void {
    const key = choiceKey(treeId, nodeId, choiceId);
    const changed = !this.choices.has(key) || (flag !== undefined && !this.flags.has(flag));
    this.choices.add(key);
    if (flag !== undefined) this.flags.add(flag);
    if (changed) this.persist();
  }

  /** Set a flag directly (used by tests / future seams). */
  setFlag(flag: string): void {
    if (this.flags.has(flag)) return;
    this.flags.add(flag);
    this.persist();
  }

  /** Freeze for a portal snapshot / save. Pure data copy. */
  portalSnapshot(): DialogueSnapshot {
    return {
      version: 1,
      visited: [...this.visited],
      choices: [...this.choices],
      flags: [...this.flags],
      lastNode: Object.fromEntries(this.lastNode),
    };
  }

  /** Persist the current snapshot through the storage adapter (if any). */
  save(): void {
    this.storage?.save(this.portalSnapshot());
  }

  /**
   * Restore a snapshot. Defensive: only string arrays / string maps
   * survive; anything else is dropped, never thrown. Unknown tree/node
   * ids are harmless (they simply never match a live lookup).
   */
  restore(snap: DialogueSnapshot | null | undefined): void {
    if (!snap || snap.version !== 1) return;
    this.visited.clear();
    this.choices.clear();
    this.flags.clear();
    this.lastNode.clear();
    if (Array.isArray(snap.visited)) for (const v of snap.visited) if (typeof v === 'string') this.visited.add(v);
    if (Array.isArray(snap.choices)) for (const c of snap.choices) if (typeof c === 'string') this.choices.add(c);
    if (Array.isArray(snap.flags)) for (const f of snap.flags) if (typeof f === 'string') this.flags.add(f);
    if (snap.lastNode && typeof snap.lastNode === 'object') {
      for (const [k, v] of Object.entries(snap.lastNode)) {
        if (typeof k === 'string' && typeof v === 'string') this.lastNode.set(k, v);
      }
    }
    this.emitChange();
  }

  /** portalRestore alias (mirrors QuestManager/FactionStandings naming). */
  portalRestore(snap: DialogueSnapshot | null | undefined): void {
    this.restore(snap);
  }

  private persist(): void {
    this.save();
    this.emitChange();
  }

  private emitChange(): void {
    try { this.onChange?.(); } catch (e) { console.warn('[dialogue] onChange threw', e); }
  }
}

// ---------------------------------------------------------------------------
// DialogueEngine — pure condition/effect evaluation over the defs
// ---------------------------------------------------------------------------

/**
 * The live-game context the engine reads effects through. The blueprint
 * wires each callback to the real systems (standings store, quest
 * manager, inventory); unit tests pass fakes. Nothing here touches the
 * DOM or the scene.
 */
export interface DialogueContext {
  standingOf: (factionId: string) => number;
  /** 'unknown' when the quest id is not in the manager's roster */
  questStatusOf: (questRef: string) => QuestStatus | 'unknown';
  /** accept a quest; false when not acceptable (already the manager's rule) */
  questAccept: (questRef: string) => boolean;
  /** turn in a quest; false when not turn-in-able */
  questTurnIn: (questRef: string) => boolean;
  /** units of an item held (backpack + equipped) */
  itemCount: (itemId: string) => number;
  /** adjust one faction's standing (the store clamps) */
  adjustStanding: (factionId: string, amount: number) => void;
}

export interface DialogueChoiceView {
  def: DialogueChoiceDef;
  /** true when at least one condition fails — the button renders disabled */
  locked: boolean;
  /** human lock reasons, one per failed condition (empty when unlocked) */
  lockReasons: string[];
}

export interface DialogueChooseResult {
  /** the node to render next, or null when the dialogue ended */
  nextNodeId: string | null;
  ended: boolean;
  /** true when the choice was locked — nothing was applied or recorded */
  locked: boolean;
  /** effect summaries in application order (for tests / logging) */
  applied: string[];
}

export class DialogueEngine {
  private readonly byRole = new Map<string, DialogueTreeDef>();
  private readonly byId = new Map<string, DialogueTreeDef>();

  constructor(trees: readonly DialogueTreeDef[] = DIALOGUE_TREES) {
    for (const t of trees) {
      this.byRole.set(t.role, t);
      this.byId.set(t.id, t);
    }
  }

  treeForRole(role: string): DialogueTreeDef | null {
    return this.byRole.get(role) ?? null;
  }

  treeById(id: string): DialogueTreeDef | null {
    return this.byId.get(id) ?? null;
  }

  nodeOf(tree: DialogueTreeDef, nodeId: string): DialogueNodeDef | null {
    return tree.nodes.find((n) => n.id === nodeId) ?? null;
  }

  /** Display text for a node: returnLines when visited before, else lines. */
  displayText(tree: DialogueTreeDef, node: DialogueNodeDef, state: DialogueState): string {
    const lines = state.hasVisited(tree.id, node.id) && node.returnLines ? node.returnLines : node.lines;
    return lines.join(' ');
  }

  /** Evaluate one choice's conditions against the live context. */
  evaluateChoice(choice: DialogueChoiceDef, ctx: DialogueContext): DialogueChoiceView {
    const reasons: string[] = [];
    const cond = choice.conditions;
    if (cond?.minStanding) {
      const have = ctx.standingOf(cond.minStanding.factionId);
      if (!(have >= cond.minStanding.min)) {
        reasons.push(`Requires ${cond.minStanding.factionId} standing ${cond.minStanding.min} (have ${have})`);
      }
    }
    if (cond?.questState) {
      const status = ctx.questStatusOf(cond.questState.quest);
      if (status !== cond.questState.status) {
        reasons.push(`Requires quest ${cond.questState.quest} to be ${cond.questState.status} (is ${status})`);
      }
    }
    if (cond?.hasItem) {
      const need = cond.hasItem.minCount ?? 1;
      const have = ctx.itemCount(cond.hasItem.itemId);
      if (have < need) {
        reasons.push(`Requires ${need}× ${cond.hasItem.itemId} (have ${have})`);
      }
    }
    return { def: choice, locked: reasons.length > 0, lockReasons: reasons };
  }

  /** All choices of a node with their lock state (locked choices stay visible). */
  choicesFor(tree: DialogueTreeDef, node: DialogueNodeDef, ctx: DialogueContext): DialogueChoiceView[] {
    return node.choices.map((c) => this.evaluateChoice(c, ctx));
  }

  /**
   * Apply a choice: locked choices apply nothing and record nothing.
   * Otherwise, in order: standing effect, quest accept, quest turn-in,
   * flag + choice record (persisted by the state), then navigation
   * (to) or end. The current node is recorded visited here (idempotent
   * with the renderer's own recordVisit) so ending choices persist too.
   */
  choose(
    tree: DialogueTreeDef,
    node: DialogueNodeDef,
    choiceId: string,
    ctx: DialogueContext,
    state: DialogueState,
  ): DialogueChooseResult {
    const choice = node.choices.find((c) => c.id === choiceId);
    if (!choice) return { nextNodeId: node.id, ended: false, locked: false, applied: [] };
    const view = this.evaluateChoice(choice, ctx);
    if (view.locked) return { nextNodeId: node.id, ended: false, locked: true, applied: [] };
    state.recordVisit(tree.id, node.id);
    const applied: string[] = [];
    const eff = choice.effects;
    if (eff?.standing) {
      ctx.adjustStanding(eff.standing.factionId, eff.standing.amount);
      applied.push(`standing:${eff.standing.factionId}:${eff.standing.amount}`);
    }
    if (eff?.questAccept !== undefined) {
      const ok = ctx.questAccept(eff.questAccept);
      applied.push(`questAccept:${eff.questAccept}:${ok}`);
    }
    if (eff?.questTurnIn !== undefined) {
      const ok = ctx.questTurnIn(eff.questTurnIn);
      applied.push(`questTurnIn:${eff.questTurnIn}:${ok}`);
    }
    state.recordChoice(tree.id, node.id, choice.id, eff?.flag);
    if (eff?.flag) applied.push(`flag:${eff.flag}`);
    if (eff?.end === true) return { nextNodeId: null, ended: true, locked: false, applied };
    if (eff?.to !== undefined) return { nextNodeId: eff.to, ended: false, locked: false, applied };
    // a choice with no navigation ends the dialogue (no dangling node)
    return { nextNodeId: null, ended: true, locked: false, applied };
  }
}
