/**
 * NPCs wave (workstream C): the on-screen interaction prompt pill.
 *
 * Bottom-center `[E] Talk to <name>`, driven per frame from an
 * InteractionRegistry (engine.npcInteractions). The registry is the
 * contract; the prompt is presentation. Activation is delegated to the
 * caller via onActivate so the future InteractionSystem can own policy
 * without touching this file.
 *
 * Chest arbitration: the inventory wave's chests live in a SEPARATE
 * registry (ItemWorld.interactions) with its own E handler. When a chest
 * is strictly nearer than the NPC target, the NPC prompt hides and the
 * event passes through untouched — chests keep their existing behavior
 * and never produce a bogus "nothing inside" toast for NPCs.
 *
 * Key handling runs on the capture phase: when the prompt is visible and
 * wins arbitration, E is consumed (stopPropagation) before the blueprint
 * bubble-phase handlers see it. The `doc` param is injectable for tests.
 */
import * as THREE from 'three';
import type { Interactable, InteractionRegistry } from '../game/Interaction';

export interface InteractionPromptHooks {
  /** live player world position */
  getPlayerPos: () => THREE.Vector3;
  /**
   * Optional rival-registry probe: return the rival's nearest eligible
   * interactable for this player position (chests today), or null when
   * there is no rival. The prompt shows only when the NPC target wins.
   */
  getRival?: (pos: THREE.Vector3) => Interactable | null;
  /**
   * Called on E when a prompt is visible and wins arbitration. Return true
   * when the activation was consumed (dialogue opened); false lets the
   * event continue to other handlers.
   */
  onActivate: (target: Interactable) => boolean;
  /** true while a modal UI (dialogue panel) owns input — the prompt defers */
  isModalOpen?: () => boolean;
}

/**
 * Pure arbitration: which target wins the prompt, NPC or rival. Unit-
 * testable without DOM; the class below is a thin DOM shell around it.
 */
export function arbitratePrompt(
  npcTarget: Interactable | null,
  rival: Interactable | null,
  playerPos: THREE.Vector3,
): Interactable | null {
  if (!npcTarget) return null;
  if (rival && rival.position.distanceTo(playerPos) < npcTarget.position.distanceTo(playerPos)) {
    return null;
  }
  return npcTarget;
}

export class InteractionPrompt {
  private root: HTMLDivElement;
  private onKey: (e: KeyboardEvent) => void;
  private target: Interactable | null = null;
  private disposed = false;
  private scratch = new THREE.Vector3();

  constructor(
    container: HTMLElement,
    private registry: InteractionRegistry,
    private hooks: InteractionPromptHooks,
    private doc: Document = globalThis.document,
  ) {
    const root = doc.createElement('div');
    root.id = 'xandria-interact-prompt';
    root.setAttribute('aria-live', 'polite');
    root.style.cssText = [
      'position:absolute', 'left:50%', 'bottom:6%', 'transform:translateX(-50%)',
      'z-index:9400', 'pointer-events:none',
      'background:rgba(8,10,16,0.82)', 'border:1px solid rgba(255,181,69,0.5)',
      'border-radius:8px', 'padding:8px 16px',
      'font-family:system-ui,-apple-system,sans-serif', 'font-size:14px',
      'color:#f2e7d3', 'letter-spacing:0.03em',
      'display:none', 'white-space:nowrap',
    ].join(';');
    container.appendChild(root);
    this.root = root as HTMLDivElement;

    this.onKey = (e: KeyboardEvent) => {
      if (this.disposed || e.code !== 'KeyE') return;
      if (this.hooks.isModalOpen?.()) return; // the modal's own capture handler owns E
      if (!this.target) return;
      const consumed = this.hooks.onActivate(this.target);
      if (consumed) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const w = (doc as Document & { defaultView?: Window }).defaultView ?? globalThis.window;
    w?.addEventListener('keydown', this.onKey, true);
  }

  /** The target currently shown in the prompt (null = hidden). */
  get currentTarget(): Interactable | null {
    return this.target;
  }

  /** Recompute eligibility + arbitration; call once per frame. */
  update(): void {
    if (this.disposed) return;
    const pos = this.hooks.getPlayerPos();
    const npcTarget = this.registry.nearestEligible(pos);
    const rival = this.hooks.getRival?.(pos) ?? null;
    const winner = this.hooks.isModalOpen?.()
      ? null
      : arbitratePrompt(npcTarget, rival, pos);
    this.target = winner;
    if (winner) {
      this.root.style.display = 'block';
      this.root.textContent = `[E] ${winner.prompt}`;
    } else {
      this.root.style.display = 'none';
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target = null;
    const w = (this.doc as Document & { defaultView?: Window }).defaultView
      ?? (globalThis as any).window;
    w?.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
  }
}
