/**
 * Interaction contracts — forward-compatible sketch for the roadmap's
 * Priority 2 (Unified interaction framework).
 *
 * The interaction SYSTEM (InteractionSystem.ts: discovery, eligibility,
 * activation, events) is the designated NEXT wave. This module defines the
 * data contracts now so the inventory wave's world objects (chests, and
 * later doors/switches/NPCs) plug into it without a rewrite:
 *
 *   Interactable: { id, type, position, radius, enabled, prompt }
 *
 * Roadmap mapping (UPGRADE-ROADMAP.md Priority 2):
 * - `type` is an open string: 'chest' | 'door' | 'switch' | 'terminal' |
 *   'vehicle' | 'npc' | 'node' | 'hazard' | 'quest' | 'checkpoint' | ...
 * - Genre-specific discovery (approach+button, camera raycast, contact
 *   triggers) is the NEXT wave's job; the data shape is genre-agnostic.
 * - Priority 3's WorldObjectSpec interaction {type, radius, requires[],
 *   produces[]} maps onto Interactable + the optional `requires`/`produces`
 *   fields below.
 */
import * as THREE from 'three';

/** A world object the player can interact with. */
export interface Interactable {
  /** stable unique id, e.g. 'chest-3' */
  id: string;
  /** open type string — see module doc for the known set */
  type: string;
  /** world position (center of the interaction volume) */
  position: THREE.Vector3;
  /** activation radius in meters */
  radius: number;
  /** false = visible but not currently activatable (locked, spent, disabled) */
  enabled: boolean;
  /** short imperative prompt, e.g. 'Open chest' (key hint added by the UI layer) */
  prompt: string;
  /** prerequisite item/flag ids (Priority 3: requires[]) — all must be satisfied */
  requires?: string[];
  /** ids produced on activation, for quests/world-state (Priority 3: produces[]) */
  produces?: string[];
}

/** Event hooks the future InteractionSystem will own; emitted by producers today. */
export interface InteractionEvents {
  onDiscover?: (i: Interactable) => void;
  onActivate?: (i: Interactable) => void;
  onEligibilityChange?: (i: Interactable, eligible: boolean) => void;
}

/**
 * Minimal registry + discovery helpers. The next wave's InteractionSystem
 * replaces the discovery/activation POLICY; the Interactable SHAPE stays.
 */
export class InteractionRegistry {
  private readonly map = new Map<string, Interactable>();
  readonly events: InteractionEvents = {};

  register(i: Interactable): void {
    const prev = this.map.get(i.id);
    this.map.set(i.id, i);
    if (!prev) this.events.onDiscover?.(i);
    else if (prev.enabled !== i.enabled) this.events.onEligibilityChange?.(i, i.enabled);
  }

  unregister(id: string): void {
    this.map.delete(id);
  }

  get(id: string): Interactable | undefined {
    return this.map.get(id);
  }

  /** All interactables within `maxRadius` of `pos`, nearest first. */
  near(pos: THREE.Vector3, maxRadius: number): Interactable[] {
    const out: Array<{ i: Interactable; d: number }> = [];
    for (const i of this.map.values()) {
      const d = i.position.distanceTo(pos);
      if (d <= Math.max(maxRadius, i.radius)) out.push({ i, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.map((e) => e.i);
  }

  /** Nearest ENABLED interactable whose own radius contains `pos`. */
  nearestEligible(pos: THREE.Vector3): Interactable | null {
    let best: Interactable | null = null;
    let bestD = Infinity;
    for (const i of this.map.values()) {
      if (!i.enabled) continue;
      const d = i.position.distanceTo(pos);
      if (d <= i.radius && d < bestD) { best = i; bestD = d; }
    }
    return best;
  }

  get size(): number {
    return this.map.size;
  }
}
