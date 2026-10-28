/**
 * Quest wave: the [E] Talk prompt + quest dialogue for NPC villagers.
 *
 * Mirrors GatheringInteractionSession (manager-based, per-frame refresh, the
 * one-live-session-per-engine stale guard). The NPC roster is map-local and
 * respawns on portal travel; this session re-reads the manager's live roster
 * every frame, so arrivals need no special handling — and an open dialogue
 * whose NPC vanished (portal departure) closes itself honestly.
 *
 * Quest wiring into the interaction registry (the requires/produces seam
 * reserved in npcInteraction.ts / Interaction.ts):
 * - Every villager interactable is stamped with
 *   produces: ['quest:accept:<id>' | 'quest:turnin:<id>', ...] for the
 *   quests this NPC can offer, and
 *   requires: ['quest:turned-in:<id>', ...] for the still-locked quests'
 *   prerequisites. requires is informational here — the villager stays
 *   talkable; the dialogue filters which quest actions it offers.
 * - Talk objectives advance when the dialogue opens (onTalk), not on the
 *   prompt: the player actually spoke to the villager.
 *
 * The prompt shares engine.npcInteractions with the node/station sessions;
 * onActivate dispatches 'npc' ids only and returns false for everything
 * else so E passes through to the other handlers.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { InteractionRegistry, Interactable } from './Interaction';
import type { NpcManager } from './NpcManager';
import type { Npc } from './Npc';
import { DialoguePanel, type DialogueQuestAction } from '../ui/DialoguePanel';
import { InteractionPrompt } from '../ui/InteractionPrompt';
import { QuestManager, questRequiresFor, questProducesFor } from './quests';
import {
  DialogueEngine,
  DialogueState,
  type DialogueContext,
  type DialogueNodeDef,
  type DialogueTreeDef,
} from './dialogue';

export interface QuestTalkSessionOpts {
  /** override the UI container (default: engine.container) */
  container?: HTMLElement;
  /** override the player position source (default: portalsPlayerAvatar) */
  getPlayerPos?: () => THREE.Vector3;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** false = headless: register interactables but build no UI */
  enableUi?: boolean;
  /**
   * vendor-economy wave: when an NPC with a vendorId is activated, this
   * opens the shop panel instead of the quest dialogue. Return true when
   * consumed (the dialogue stays closed); false falls through to the
   * dialogue. Undefined = vendors open the dialogue like villagers.
   */
  openVendor?: (npc: Npc) => boolean;
  /**
   * Dialogue-branching wave: the tree engine + player-scoped state +
   * live-context thunk (standings, quest manager, inventory — wired by
   * the blueprint). When present, villagers with a tree for their role
   * render the tree above the quest actions; roles without a tree keep
   * the quest-only dialogue exactly as before.
   */
  dialogue?: {
    engine: DialogueEngine;
    state: DialogueState;
    context: () => DialogueContext;
  };
}

/** Stale-session guard: one live session per engine (mirrors the other sessions). */
const liveSessions = new WeakMap<Engine, QuestTalkSession>();

export class QuestTalkSession {
  private readonly byId = new Map<string, Npc>();
  private readonly managers: readonly NpcManager[];
  private dialogue: DialoguePanel | null = null;
  private prompt: InteractionPrompt | null = null;
  private disposed = false;
  private scratch = new THREE.Vector3();
  /** interactable id the open dialogue belongs to (null = none) */
  private openNpcId: string | null = null;
  /** dialogue-branching wave: the tree node the open dialogue shows (null = quest-only) */
  private openTree: { treeId: string; nodeId: string } | null = null;

  constructor(
    private readonly engine: Engine,
    npcManagers: NpcManager | readonly NpcManager[],
    private readonly quests: QuestManager,
    private readonly opts: QuestTalkSessionOpts = {},
  ) {
    // vendor-economy wave: the session can cover several rosters (the
    // villager manager + the vendor manager) — one prompt pill, one
    // dialogue, both rosters registered in engine.npcInteractions.
    this.managers = Array.isArray(npcManagers) ? npcManagers : [npcManagers];
    // replace any stale session from a blueprint rebuild (one prompt pill, one dialogue)
    liveSessions.get(engine)?.dispose();
    liveSessions.set(engine, this);

    this.refresh();
    if (opts.enableUi === false) return;
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container ?? engine.container;
    this.dialogue = new DialoguePanel(container, doc);
    this.prompt = new InteractionPrompt(container, engine.npcInteractions, {
      getPlayerPos: () => this.playerPos(),
      getRival: (pos) => this.chestRival(pos),
      onActivate: (target) => this.openDialogue(target.id),
      isModalOpen: () => this.dialogue?.isOpen ?? false,
    }, doc);
  }

  /** The NPC currently shown in the prompt (null = none or a non-NPC target). */
  get promptedNpc(): Npc | null {
    const t = this.prompt?.currentTarget;
    return t && t.type === 'npc' ? this.byId.get(t.id) ?? null : null;
  }

  /** True while the quest dialogue owns input (blueprints chain this into other prompts). */
  get isDialogueOpen(): boolean {
    return this.dialogue?.isOpen ?? false;
  }

  /** Dialogue-branching wave: the tree node id the open dialogue shows (null = none / quest-only). */
  get currentDialogueNode(): string | null {
    return this.openTree?.nodeId ?? null;
  }

  /**
   * Open the quest dialogue for an interactable id. Talk objectives advance
   * here (the player actually spoke). Vendors (vendor-economy wave) open
   * the shop panel instead — via opts.openVendor — and skip onTalk, since
   * trading is not talking. Returns true when the activation was consumed;
   * false lets E continue to other handlers.
   */
  openDialogue(interactableId: string): boolean {
    const npc = this.byId.get(interactableId);
    if (!npc || !this.dialogue) return false;
    if (npc.vendorId && this.opts.openVendor && this.opts.openVendor(npc)) return true;
    this.openNpcId = npc.interactable.id;
    this.quests.onTalk(npc.role);
    this.showFor(npc);
    return true;
  }

  /** Close the dialogue (dismiss). */
  closeDialogue(): void {
    this.openNpcId = null;
    this.openTree = null;
    this.dialogue?.hide();
  }

  /**
   * Re-render the open dialogue (quest state changed underneath it — e.g.
   * a talk objective completed on open, or a turn-in elsewhere). No-op when
   * no dialogue is open. Does NOT fire onTalk (that belongs to activation).
   */
  refreshOpenDialogue(): void {
    if (!this.openNpcId || !this.dialogue?.isOpen) return;
    const npc = this.byId.get(this.openNpcId);
    if (npc) this.showFor(npc);
  }

  private showFor(npc: Npc): void {
    if (!this.dialogue) return;
    const acts = this.quests.actionsForNpc(npc.role);
    const actions: DialogueQuestAction[] = [
      ...acts.turnIn.map((d) => ({ id: `turnin:${d.id}`, label: `Turn in: ${d.name}` })),
      ...acts.accept.map((d) => ({ id: `accept:${d.id}`, label: `Accept: ${d.name} — ${d.brief}` })),
      // timed-quests wave: a failed timed quest can be retried from
      // the giver — same reaccept() the timed board's Try again uses.
      ...acts.failed.map((d) => ({ id: `retry:${d.id}`, label: `Retry: ${d.name} — the clock ran out` })),
    ];
    // Dialogue-branching wave: a tree for this role renders above the
    // quest actions (same panel, same z-order, same dismiss control).
    // The dialogue always opens on the tree's start node; a node opened
    // again shows its returnLines (state-driven, via recordVisit below).
    const dlg = this.opts.dialogue;
    const tree = dlg?.engine.treeForRole(npc.role) ?? null;
    if (dlg && tree) {
      const nodeId = this.openTree?.treeId === tree.id ? this.openTree.nodeId : tree.start;
      const node = dlg.engine.nodeOf(tree, nodeId) ?? dlg.engine.nodeOf(tree, tree.start);
      if (node) {
        // text BEFORE the visit is recorded: first render shows lines,
        // later renders (same conversation or a later visit) show
        // returnLines when the node defines them.
        const text = dlg.engine.displayText(tree, node, dlg.state);
        dlg.state.recordVisit(tree.id, node.id);
        const choices = dlg.engine.choicesFor(tree, node, dlg.context()).map((v) => ({
          id: v.def.id,
          label: v.def.label,
          locked: v.locked,
          lockReason: v.lockReasons.join('; '),
        }));
        this.openTree = { treeId: tree.id, nodeId: node.id };
        this.dialogue.showTree({
          name: npc.name,
          role: npc.role,
          text,
          nodeId: node.id,
          choices,
          actions,
          onChoice: (id) => this.onTreeChoice(npc, tree, node, id),
          onAction: (id) => this.onQuestAction(npc, id),
        });
        return;
      }
    }
    this.openTree = null;
    let greeting = npc.greeting;
    if (acts.turnIn.length > 0) {
      greeting = `So it's done. ${acts.turnIn[0].name} — the settlement owes you.`;
    } else if (acts.accept.length > 0) {
      greeting = acts.accept[0].brief;
    } else if (acts.failed.length > 0) {
      greeting = `${acts.failed[0].name} — the clock ran out. Try again, and be quick about it.`;
    }
    this.dialogue.show(
      { name: npc.name, role: npc.role, greeting },
      actions,
      (id) => this.onQuestAction(npc, id),
    );
  }

  /** Dialogue-branching wave: apply a tree choice, navigate or close. */
  private onTreeChoice(npc: Npc, tree: DialogueTreeDef, node: DialogueNodeDef, choiceId: string): void {
    const dlg = this.opts.dialogue;
    if (!dlg) return;
    const res = dlg.engine.choose(tree, node, choiceId, dlg.context(), dlg.state);
    if (res.ended) {
      this.closeDialogue();
      return;
    }
    if (res.nextNodeId) this.openTree = { treeId: tree.id, nodeId: res.nextNodeId };
    // re-show: the node (and its quest-action list, which a questAccept
    // choice may have changed) is re-read fresh
    this.showFor(npc);
  }

  private onQuestAction(npc: Npc, id: string): void {
    const sep = id.indexOf(':');
    const action = id.slice(0, sep);
    const questId = id.slice(sep + 1);
    if (action === 'accept') this.quests.accept(questId);
    else if (action === 'retry') this.quests.reaccept(questId);
    else if (action === 'turnin') {
      // UPGRADE LOOP (audio-system): observe-only turn-in seam — the
      // audio wiring taps this for the quest SFX; gameplay is untouched.
      if (this.quests.turnIn(questId)) {
        this.engine.hooks.emit('onQuestTurnIn', { questId });
      }
    }
    // re-show: the action lists (and the greeting) changed
    this.showFor(npc);
  }

  /** Per-frame: pick up respawns after spawnForMap, tick the prompt. */
  update(_dt: number): void {
    if (this.disposed) return;
    this.refresh();
    this.prompt?.update();
  }

  /** Teardown: kill the prompt + dialogue. NPC lifecycle stays with the manager. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.prompt?.dispose();
    this.prompt = null;
    this.dialogue?.dispose();
    this.dialogue = null;
    this.openNpcId = null;
    this.openTree = null;
    this.byId.clear();
    if (liveSessions.get(this.engine) === this) liveSessions.delete(this.engine);
  }

  /**
   * Stamp requires/produces onto the live roster's interactables and
   * (re-)register them. Idempotent; safe to call every frame.
   */
  private refresh(): void {
    const reg: InteractionRegistry = this.engine.npcInteractions;
    this.byId.clear();
    for (const mgr of this.managers) {
      for (const npc of mgr.npcs) {
        const acts = this.quests.actionsForNpc(npc.role);
        const produces = [
          ...acts.accept.map((d) => questProducesFor('accept', d)),
          ...acts.turnIn.map((d) => questProducesFor('turnin', d)),
        ];
        const requires = [...new Set(acts.locked.flatMap((d) => questRequiresFor(d)))];
        // mutate in place: the registry holds the same object reference, and
        // the NPC wave's register is idempotent (skips present ids)
        npc.interactable.produces = produces.length > 0 ? produces : undefined;
        npc.interactable.requires = requires.length > 0 ? requires : undefined;
        if (!reg.get(npc.interactable.id)) reg.register(npc.interactable);
        this.byId.set(npc.interactable.id, npc);
      }
    }
    // the dialogue's NPC left the roster (portal departure): close honestly
    if (this.dialogue?.isOpen && this.openNpcId && !this.byId.has(this.openNpcId)) {
      this.closeDialogue();
    }
  }

  private playerPos(): THREE.Vector3 {
    const p = this.opts.getPlayerPos?.() ?? this.engine.portalsPlayerAvatar?.ctrl.position;
    return p ? this.scratch.copy(p) : this.scratch.set(0, 0, 0);
  }

  /** The chest registry's nearest eligible — the arbitration rival (same as NPCs). */
  private chestRival(pos: THREE.Vector3): Interactable | null {
    const iw = (this.engine as unknown as {
      itemWorld?: { interactions: InteractionRegistry };
    }).itemWorld;
    return iw?.interactions.nearestEligible(pos) ?? null;
  }

  /** Visible for tests: live session count for this engine (0 or 1). */
  static liveFor(engine: Engine): boolean {
    return liveSessions.has(engine);
  }
}
