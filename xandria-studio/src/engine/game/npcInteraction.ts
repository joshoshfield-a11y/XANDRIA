/**
 * NPCs wave (workstream C): NPC interaction registration policy + session.
 *
 * Workstream A exposed `npc.interactable` ({ type: 'npc', prompt:
 * 'Talk to <name>', live position }) but registered nothing. THIS module
 * owns the policy:
 *
 * - On attach: every npc.interactable is registered into
 *   `engine.npcInteractions` (the engine-level InteractionRegistry — NPC
 *   ids live apart from ItemWorld's chest registry, so the chest E path
 *   never sees them).
 * - On detach: unregister FIRST, then npc.dispose() (A's ordering flag).
 * - Re-attach is idempotent: an id already present is skipped, never
 *   double-registered.
 * - `requires`/`produces` stay undefined on NPC interactables — reserved
 *   for the quest wave (see Interaction.ts).
 *
 * NpcInteractionSession is the seam workstream B's NpcManager adopts:
 *   const session = new NpcInteractionSession(engine, npcs);
 *   // per frame:  session.update(dt);
 *   // on map departure: session.dispose(); // unregisters + disposes UI + NPCs
 *
 * Idempotent dispose: safe to call twice (portal transitions can hit
 * despawnAll on an empty roster).
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { InteractionRegistry } from './Interaction';
import { Npc } from './Npc';
import { DialoguePanel } from '../ui/DialoguePanel';
import { InteractionPrompt } from '../ui/InteractionPrompt';

export interface NpcInteractionSessionOpts {
  /** override the UI container (default: engine.container) */
  container?: HTMLElement;
  /** override the player position source (default: portalsPlayerAvatar) */
  getPlayerPos?: () => THREE.Vector3;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** false = headless: register interactables but build no UI */
  enableUi?: boolean;
}

/** Register every NPC's interactable into the engine NPC registry. Idempotent. */
export function registerNpcInteractables(engine: Engine, npcs: readonly Npc[]): void {
  const reg: InteractionRegistry = engine.npcInteractions;
  for (const npc of npcs) {
    if (!reg.get(npc.interactable.id)) reg.register(npc.interactable);
  }
}

/** Unregister every NPC's interactable. Missing ids are ignored. */
export function unregisterNpcInteractables(engine: Engine, npcs: readonly Npc[]): void {
  const reg: InteractionRegistry = engine.npcInteractions;
  for (const npc of npcs) reg.unregister(npc.interactable.id);
}

export class NpcInteractionSession {
  private readonly byId = new Map<string, Npc>();
  private dialogue: DialoguePanel | null = null;
  private prompt: InteractionPrompt | null = null;
  private disposed = false;
  private scratch = new THREE.Vector3();

  constructor(
    private readonly engine: Engine,
    readonly npcs: readonly Npc[],
    private readonly opts: NpcInteractionSessionOpts = {},
  ) {
    registerNpcInteractables(engine, npcs);
    for (const npc of npcs) this.byId.set(npc.interactable.id, npc);

    if (opts.enableUi === false) return;
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container ?? engine.container;
    this.dialogue = new DialoguePanel(container, doc);
    this.prompt = new InteractionPrompt(container, engine.npcInteractions, {
      getPlayerPos: () => this.playerPos(),
      getRival: (pos) => this.chestRival(pos),
      onActivate: (target) => this.openDialogueFor(target.id),
      isModalOpen: () => this.dialogue?.isOpen ?? false,
    }, doc);
  }

  /** NPC the player is currently prompted to talk to (null = none). */
  get promptedNpc(): Npc | null {
    const t = this.prompt?.currentTarget;
    return t ? this.byId.get(t.id) ?? null : null;
  }

  get isDialogueOpen(): boolean {
    return this.dialogue?.isOpen ?? false;
  }

  private playerPos(): THREE.Vector3 {
    const p = this.opts.getPlayerPos?.() ?? this.engine.portalsPlayerAvatar?.ctrl.position;
    return p ? this.scratch.copy(p) : this.scratch.set(0, 0, 0);
  }

  /** The chest registry's nearest eligible — the arbitration rival. */
  private chestRival(pos: THREE.Vector3) {
    const iw = (this.engine as unknown as {
      itemWorld?: { interactions: InteractionRegistry };
    }).itemWorld;
    return iw?.interactions.nearestEligible(pos) ?? null;
  }

  /** Open the dialogue stub for an interactable id. Returns false when unknown. */
  openDialogueFor(interactableId: string): boolean {
    const npc = this.byId.get(interactableId);
    if (!npc || !this.dialogue) return false;
    this.dialogue.show({ name: npc.name, role: npc.role, greeting: npc.greeting });
    return true;
  }

  /** Close the dialogue stub (dismiss). */
  closeDialogue(): void {
    this.dialogue?.hide();
  }

  /** Per-frame: tick NPC behavior + prompt eligibility. */
  update(dt: number): void {
    if (this.disposed) return;
    for (const npc of this.npcs) npc.update(dt);
    this.prompt?.update();
  }

  /**
   * Teardown: unregister interactables FIRST (A's ordering flag), then
   * dispose NPCs, then the UI. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    unregisterNpcInteractables(this.engine, this.npcs);
    for (const npc of this.npcs) npc.dispose();
    this.byId.clear();
    this.prompt?.dispose();
    this.prompt = null;
    this.dialogue?.dispose();
    this.dialogue = null;
  }
}
